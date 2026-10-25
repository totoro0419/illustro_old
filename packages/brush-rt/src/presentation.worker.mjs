import {GpuRenderer} from '@rt/renderer';
import {uploadTilePages,ATLAS_SIZE} from '@rt/presentation-tiles';

// The display worker owns both high-resolution GPU rendering and retained
// 512px document groups. Never create one DOM canvas or transferable bitmap
// for every 128px history tile on the input thread.
let renderer,view,epoch=0,running=false,again=false,version=0,documentWidth=0,documentHeight=0,refreshTimer=null;
const groups=new Map,metrics={uploads:0,uploadCpuMaxMs:0,renderCpuMaxMs:0,frames:0,displayGroups:0};
const fail=error=>postMessage({type:'fault',error:String(error)});
function refresh(){
 if(refreshTimer!==null)clearTimeout(refreshTimer);
 // Seamless wrapping and reference views cannot use the retained-paper
 // fallback. Refresh those precise images immediately, without the debounce.
 if(view&&(view[12]>.5||view[14]>.5)){refreshTimer=null;void draw();return;}
 refreshTimer=setTimeout(()=>{refreshTimer=null;void draw();},120);
}
async function draw(){
 if(running||!renderer||!view)return;running=true;
 try{do{again=false;const b=renderer.backend,v=Array.from(view),generation=version,contentEpoch=epoch;
  b.setViewTransform(v);b.navigationPresentation=false;
  const started=performance.now(),done=b.presentCurrent(true);metrics.renderCpuMaxMs=Math.max(metrics.renderCpuMaxMs,performance.now()-started);
  // Take ownership of the completed backing before yielding a WebGPU task.
  const bitmap=b.canvas.transferToImageBitmap();
  // Clone in the display worker, never Canvas2D.drawImage(bitmaprenderer) on
  // the input thread. Navigation retains a separate already-published image.
  let standbyBitmap=null;
  try{standbyBitmap=await createImageBitmap(bitmap);}
  catch(error){metrics.standbyCloneErrors=(metrics.standbyCloneErrors??0)+1;}
  try{await done;}catch(error){standbyBitmap?.close();bitmap.close();throw error;}
  metrics.frames++;
  postMessage({type:'image',bitmap,standbyBitmap,view:v,epoch:contentEpoch,version:generation,performance:{...metrics}},
   standbyBitmap?[bitmap,standbyBitmap]:[bitmap]);
 }while(again);
 }catch(error){fail(error);}finally{running=false;}
}
function groupFor(t){
 const x=Math.floor(t.x/ATLAS_SIZE)*ATLAS_SIZE,y=Math.floor(t.y/ATLAS_SIZE)*ATLAS_SIZE,key=x+','+y;
 let group=groups.get(key);
 if(!group){
  const w=Math.min(ATLAS_SIZE,documentWidth-x),h=Math.min(ATLAS_SIZE,documentHeight-y);
  if(w<=0||h<=0)throw Error('Document group outside bounds');
  const canvas=new OffscreenCanvas(w,h),context=canvas.getContext('2d',{alpha:true});
  if(!context)throw Error('Retained document 2D context unavailable');
  context.imageSmoothingEnabled=false;group={key,x,y,w,h,canvas,context};groups.set(key,group);metrics.displayGroups=groups.size;
 }
 return group;
}
self.onmessage=({data:m})=>{Promise.resolve().then(async()=>{
 if(m.method==='init'){
  documentWidth=m.documentWidth;documentHeight=m.documentHeight;
  renderer=await GpuRenderer.create(new OffscreenCanvas(m.width,m.height),documentWidth,documentHeight,m.backend,{strokeHandoff:true,tileHistory:false});
  postMessage({type:'ready',info:renderer.info});
 }else if(m.method==='view'){view=m.view;again=true;if(refreshTimer!==null){clearTimeout(refreshTimer);refreshTimer=null;}void draw();}
 else if(m.method==='tiles'){
  const started=performance.now(),changed=new Map;
  // Copy only the changed 128px areas into persistent 512px groups.
  // Unchanged pixels survive; clearing each changed rectangle also preserves erasure.
  for(const page of m.pages)for(const t of page.tiles){
   const g=groupFor(t),dx=t.x-g.x,dy=t.y-g.y;
   g.context.clearRect(dx,dy,t.w,t.h);
   g.context.drawImage(page.bitmap,t.sx,t.sy,t.w,t.h,dx,dy,t.w,t.h);
   changed.set(g.key,g);
  }
  uploadTilePages(renderer.backend,m.pages);metrics.uploads+=m.pages.length;
  const tiles=await Promise.all([...changed.values()].map(async g=>({key:g.key,x:g.x,y:g.y,w:g.w,h:g.h,bitmap:await createImageBitmap(g.canvas)})));
  metrics.uploadCpuMaxMs=Math.max(metrics.uploadCpuMaxMs,performance.now()-started);epoch=m.epoch;version=m.version;
  postMessage({type:'document',tiles,epoch,version,request:m.request},tiles.map(t=>t.bitmap));
  again=true;refresh();
 }else if(m.method==='read'){
  const pixels=await renderer.backend.readViewport();postMessage({type:'read',request:m.request,pixels},[pixels.buffer]);
 }else if(m.method==='destroy'){if(refreshTimer!==null)clearTimeout(refreshTimer);for(const g of groups.values())g.canvas.width=g.canvas.height=1;groups.clear();renderer?.destroy();close();}
 else throw Error('Unknown presentation method');
 }).catch(fail);};
