import {CANONICAL_TILE_SIZE,CoreDocument,type DirtyTileHint,type LayerId} from '@illustro/core';
import type {StrokeRecord} from '@illustro/brush-rt';
import type {DocumentPort,DrawingTarget,StrokeCommitResult} from './ports';

type Bounds={x0:number;y0:number;x1:number;y1:number};
type Accum={bounds:Bounds;commands:number[]};
export class EmptyStrokeError extends Error{}
export class CoreStrokeDocumentPort implements DocumentPort{
  constructor(readonly document:CoreDocument,private readonly selectedLayer:()=>LayerId=()=>document.defaultRasterLayerId){}
  target():DrawingTarget{
    const root=this.document.root,layer=root.getLayer(this.selectedLayer());
    if(layer.kind!=='raster')throw new Error('選択中のレイヤーには描けません。');
    if(layer.locked)throw new Error('選択中のレイヤーはロックされています。');
    return Object.freeze({documentId:root.documentId,layerId:layer.id,surfaceId:layer.surface.descriptor.surfaceId,width:root.width,height:root.height,baseRevision:this.document.head});
  }
  async commitStroke(target:DrawingTarget,record:StrokeRecord,additional:readonly StrokeRecord[]=[]):Promise<StrokeCommitResult>{
    const root=this.document.root;if(root.documentId!==target.documentId)throw new Error('描画先の文書が変わりました。');
    if(this.document.head!==target.baseRevision)throw new Error('描画中に作品の状態が変わりました。');
    const layer=root.getLayer(target.layerId);if(layer.kind!=='raster'||layer.surface.descriptor.surfaceId!==target.surfaceId)throw new Error('描画先のレイヤーが変わりました。');
    if(layer.locked)throw new Error('描画先のレイヤーはロックされています。');
    const records=[record,...additional],dirtyByRecord:DirtyTileHint[][]=[];
    // This preparation runs on the editor's main thread. Yield before a large
    // stroke can starve later touchstart events until formal completion.
    for(const item of records){
      await shallowRecordGuard(item);
      const dirty=await dirtyTiles(item);
      dirtyByRecord.push(dirty.filter(h=>h.tileX>=0&&h.tileY>=0&&h.tileX*CANONICAL_TILE_SIZE<target.width&&h.tileY*CANONICAL_TILE_SIZE<target.height));
    }
    if(!dirtyByRecord[0]?.length)throw new EmptyStrokeError('確定できる線がありません。');
    // The UI can now process gestures/history between preparation chunks.
    // Revalidate the captured target before starting the single atomic tx.
    if(this.document.head!==target.baseRevision||this.document.root.documentId!==target.documentId)
      throw new Error('描画中に作品の状態が変わりました。');
    const current=this.document.root.getLayer(target.layerId);
    if(current.kind!=='raster'||current.surface.descriptor.surfaceId!==target.surfaceId||current.locked)
      throw new Error('描画先のレイヤーが変わりました。');
    const tx=this.document.begin('Brush stroke');
    let operationKey:StrokeCommitResult['operationKey']|null=null,dirtyTileCount=0;
    for(let i=0;i<records.length;i++){const item=records[i]!,dirty=dirtyByRecord[i]!;
      if(!dirty.length)continue;
      const key=tx.recordRasterOperation(target.layerId,{
        kind:'brush.stroke',schemaVersion:1,parameters:Object.freeze({strokeRecord:item,strokeRecordVersion:item.version,engine:item.engine,brushId:brushId(item),action:item.preset.blend==='erase'?'erase':'paint',...(i>0?{seamlessCopy:true}:{} )}),
        algorithmVersionRefs:Object.freeze([`engine:${item.engine}`,`reconstruction:${item.smoothing}`,`prng:${item.random}`,`stroke-schema:${item.version}`]),sourceRevisionIds:Object.freeze([target.baseRevision]),
      },dirty);
      if(i===0)operationKey=key;
      dirtyTileCount+=dirty.length;
    }
    if(!operationKey)throw new Error('確定できる線がありません。');
    const receipt=tx.commit();return Object.freeze({revisionId:receipt.revision.id,operationKey,dirtyTileCount,persistence:receipt.persistence});
  }
}
async function shallowRecordGuard(record:StrokeRecord){
  if((record.version!==2&&record.version!==3)||record.random!=='philox4x32-10'||!Array.isArray(record.commands)||!Array.isArray(record.raw)||record.raw.length>500000)throw new Error('未対応の線データです。');
  let sliceStarted=performance.now(),lastYieldAt=0;
  for(let i=0;i<record.raw.length;i++){
    if(record.raw[i]?.predicted)throw new Error('予測入力は作品データに確定できません。');
    if((i&255)===255&&(performance.now()-sliceStarted>=3||i-lastYieldAt>=2048)){
      await new Promise<void>(resolve=>setTimeout(resolve,0));
      sliceStarted=performance.now();lastYieldAt=i;
    }
  }
  if('releaseInput' in record&&record.releaseInput?.predicted)throw new Error('予測入力は作品データに確定できません。');
}
function brushId(record:StrokeRecord){return record.version===3?record.foundation.id:record.preset.id;}
async function dirtyTiles(record:StrokeRecord):Promise<DirtyTileHint[]>{
  const map=new Map<string,Accum>();
  let sliceStarted=performance.now(),lastYieldAt=0;
  for(let index=0;index<record.commands.length;index++){const c=record.commands[index];if(!c||c.length<20)throw new Error('壊れた線データです。');
    const required=[c[0],c[1],c[2],c[16],c[17],c[18],c[19]];if(required.some(v=>v===undefined||!Number.isFinite(v)))throw new Error('壊れた線データです。');
    const solid=(c[19]??0)>0,r=Math.max((c[2]??0)/2,c[18]??0)*(solid?1:Math.SQRT2)+2,ax=solid?(c[16]??c[0]??0):(c[0]??0),ay=solid?(c[17]??c[1]??0):(c[1]??0);
    addBounds(map,{x0:Math.min(c[0]??0,ax)-r,y0:Math.min(c[1]??0,ay)-r,x1:Math.max(c[0]??0,ax)+r,y1:Math.max(c[1]??0,ay)+r},index);
    // A single long brush stroke can contain thousands of stamps. The
    // accumulated bounds remain identical; only scheduling is different.
    if((index&63)===63&&(performance.now()-sliceStarted>=3||index-lastYieldAt>=256)){
      await new Promise<void>(resolve=>setTimeout(resolve,0));
      sliceStarted=performance.now();lastYieldAt=index;
    }
  }
  const result:DirtyTileHint[]=[];
  let tileIndex=0;
  for(const [key,value]of map.entries()){
    const [tileX,tileY]=key.split(',').map(Number) as [number,number],ox=tileX*CANONICAL_TILE_SIZE,oy=tileY*CANONICAL_TILE_SIZE;
    const bounds=Object.freeze({x0:Math.max(0,Math.floor(value.bounds.x0-ox)),y0:Math.max(0,Math.floor(value.bounds.y0-oy)),x1:Math.min(CANONICAL_TILE_SIZE,Math.ceil(value.bounds.x1-ox)),y1:Math.min(CANONICAL_TILE_SIZE,Math.ceil(value.bounds.y1-oy))});
    result.push(Object.freeze({tileX,tileY,bounds,workUnits:Math.max(1,value.commands.length),commandIndices:Object.freeze(value.commands)}));
    if((++tileIndex&127)===0&&performance.now()-sliceStarted>=3){
      await new Promise<void>(resolve=>setTimeout(resolve,0));
      sliceStarted=performance.now();
    }
  }
  return result;
}
function addBounds(map:Map<string,Accum>,bounds:Bounds,index:number){
  if(!(bounds.x1>bounds.x0&&bounds.y1>bounds.y0))return;const minX=Math.floor(bounds.x0/CANONICAL_TILE_SIZE),maxX=Math.ceil(bounds.x1/CANONICAL_TILE_SIZE)-1,minY=Math.floor(bounds.y0/CANONICAL_TILE_SIZE),maxY=Math.ceil(bounds.y1/CANONICAL_TILE_SIZE)-1;
  const tileCount=(maxX-minX+1)*(maxY-minY+1);if(!Number.isSafeInteger(tileCount)||tileCount>65536)throw new Error('線の範囲が大きすぎます。');
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){const key=`${x},${y}`,current=map.get(key);if(current){current.bounds.x0=Math.min(current.bounds.x0,bounds.x0);current.bounds.y0=Math.min(current.bounds.y0,bounds.y0);current.bounds.x1=Math.max(current.bounds.x1,bounds.x1);current.bounds.y1=Math.max(current.bounds.y1,bounds.y1);current.commands.push(index);}else map.set(key,{bounds:{...bounds},commands:[index]});}
}
