import {viewAffine} from '@rt/stroke-overlay';
import {DocumentPresentation} from '@rt/document-presentation';
import {ViewportScene} from '@rt/viewport-scene';


// Window-side port: no brush reconstruction, pixel evaluation or GPU commands.
// One current view transforms all immutable pictures, including old pictures
// arriving after a more recent pan/zoom/rotation. Worker messages never own it.
export class DrawingHost {
 static async create(canvas,width,height,backend,options,workerUrl,canonicalUrl,diagnostics=false,presentationUrl){
  const host=new DrawingHost(canvas,workerUrl,presentationUrl);host.documentPresentation=new DocumentPresentation(canvas,width,height);host.documentVersion=0;try{
   host.update(await host.call('init',{width:canvas.width,height:canvas.height,documentWidth:width,documentHeight:height,backend,options,canonicalUrl,diagnostics,timeOrigin:performance.timeOrigin}));
   host.presentation.postMessage({method:'init',width:canvas.width,height:canvas.height,documentWidth:width,documentHeight:height,backend:host.info.selection.selected});await host.presentationReady;return host;
  }catch(error){host.destroy();throw error;}
 }
 constructor(canvas,url,presentationUrl){this.remote=true;
  // Split retained document uploads into browser tasks in the real editor.
  // The temporary stroke stays visible until all exact tiles are installed.
  // This must not be gated on a QA URL: real touch inputs need CPU time while
  // the previous stroke is still waiting for formal GPU presentation.
  this.inputFirstProbe=true;
  this.pendingDocumentInstall=Promise.resolve();
  this.preferRetainedDocument=false;
  this.canvas=canvas;this.context=canvas.getContext('bitmaprenderer');if(!this.context)throw Error('ImageBitmap presentation unavailable');this.uploadSamples=[];this.viewportScene=new ViewportScene(canvas);
  this.presentation=new Worker(presentationUrl,{type:'module'});this.presentationRequests=new Map;this.presentationRequestId=0;this.presentationVersion=0;this.preciseWaiters=[];this.uncoveredVersion=0;this.pendingCoverage=new Map;this.pendingRetirements=new Map;
  this.display={backend:{readViewport:()=>new Promise((resolve,reject)=>{const request=++this.presentationRequestId;this.presentationRequests.set(request,{resolve,reject,read:true});this.presentation.postMessage({method:'read',request});})}};
  this.presentationReady=new Promise((resolve,reject)=>{this.presentationResolve=resolve;this.presentationReject=reject;});
  this.presentation.onmessage=({data:m})=>{
   if(this.disposed){m.bitmap?.close();for(const t of m.tiles??[])t.bitmap.close();return;}
   if(m.type==='ready'){this.presentationResolve();return;}
   if(m.type==='fault'){this.presentationReject(Error(m.error));this.fault(m.error);return;}
   if(m.type==='document'){
    const accepted=m.epoch===this.epoch&&m.version>=this.documentVersion;
    const complete=()=>{
     if(accepted&&!this.disposed){
      this.documentVersion=m.version;
      const coverage=this.pendingCoverage.get(m.version);
      if(!coverage?.covered)this.uncoveredVersion=Math.max(this.uncoveredVersion,m.version);
      this.pendingCoverage.delete(m.version);
      this.documentPresentation.update(this.viewportScene.baseView??this.backend.viewTransform);
      this.syncVisibility();
     }
     const request=this.presentationRequests.get(m.request);
     this.presentationRequests.delete(m.request);
     request?.resolve({accepted:accepted&&!this.disposed});
    };
    if(!accepted){for(const t of m.tiles)t.bitmap.close();complete();return;}
    if(this.inputFirstProbe){
     // Avoid a long sequence of bitmap uploads on the touch event thread.
     // Each group is exact. ACK only after all groups are installed.
     this.pendingDocumentInstall=this.pendingDocumentInstall.then(async()=>{
      if(this.disposed||m.epoch!==this.epoch){
       for(const t of m.tiles)t.bitmap.close();
       const request=this.presentationRequests.get(m.request);
       this.presentationRequests.delete(m.request);request?.resolve({accepted:false});
       return;
      }
      await this.documentPresentation.applyCooperatively(m.tiles);
      complete();
     }).catch(error=>{
      const request=this.presentationRequests.get(m.request);
      this.presentationRequests.delete(m.request);request?.reject(error);
      this.fault(String(error));
     });
     return;
    }
    this.documentPresentation.apply(m.tiles);complete();return;
   }
   if(m.type==='read'){const r=this.presentationRequests.get(m.request);this.presentationRequests.delete(m.request);r?.resolve(m.pixels);return;}
   if(m.type==='image'){this.presentationMetrics=m.performance;
    if(this.inputFirstProbe&&!this.viewportScene.active&&m.view?.[12]<.5&&m.view?.[14]<.5){
     // A complete retained document is an accurate ordinary-paper picture.
     // Prefer it to uploading a second full GPU bitmap to the main thread.
     void this.pendingDocumentInstall.then(()=>{
      if(this.disposed){m.bitmap.close();return;}
      const stillValid=m.epoch===this.epoch&&m.version>=this.presentationVersion;
      if(!stillValid){m.bitmap.close();return;}
      const retainedReady=m.version<=this.documentVersion&&this.documentPresentation.tiles.size>0;
      if(retainedReady){m.bitmap.close();this.preferRetainedDocument=true;}
      else{
       if(this.canvas.width!==m.bitmap.width)this.canvas.width=m.bitmap.width;
       if(this.canvas.height!==m.bitmap.height)this.canvas.height=m.bitmap.height;
       this.context.transferFromImageBitmap(m.bitmap);
       this.preferRetainedDocument=false;
      }
      this.presentationView=m.view;this.presentationVersion=m.version;
      this.retireOverlays(m.version);this.reproject();this.syncVisibility();
      this.releasePreciseWaiters(m.epoch,m.version);
      this.onPresentation?.({kind:'display-image',at:performance.now(),accepted:true});
     }).catch(error=>this.fault(String(error)));
     return;
    }
    this.preferRetainedDocument=false;
    if(this.viewportScene.active){m.bitmap.close();return;}
    const accepted=m.epoch===this.epoch&&m.version>=this.presentationVersion&&m.version>=this.documentVersion;
    if(accepted){
     // Never expose an empty bitmap: install the complete image, then retire
     // covered previews and choose the visible base as one browser task.
     if(this.canvas.width!==m.bitmap.width)this.canvas.width=m.bitmap.width;
     if(this.canvas.height!==m.bitmap.height)this.canvas.height=m.bitmap.height;
     this.context.transferFromImageBitmap(m.bitmap);this.presentationView=m.view;this.presentationVersion=m.version;
     this.retireOverlays(m.version);this.reproject();this.syncVisibility();this.releasePreciseWaiters(m.epoch,m.version);
    }else m.bitmap.close();
    this.onPresentation?.({kind:'display-image',at:performance.now(),accepted});
   }
  };this.presentation.onerror=e=>{this.presentationReject(Error(e.message));this.fault(e.message);};
  this.worker=new Worker(url,{type:'module'});this.requests=new Map;this.requestId=0;this.sequence=0;this.epoch=0;this.hiddenStrokeIds=new Set;this.layers=new Map;this.localFaults=[];this.errors=[];this.info={};this.completions=[];this.document={jobs:{length:0},count:0};this.backend={canvas,tiles:new Map,viewTransform:null,read:key=>this.read(key),readViewport:()=>this.call('readViewport'),readTiles:requests=>this.call('readTiles',requests)};
  this.proxy={prepare:p=>this.send('prepare',p),setEnabled:value=>this.send('overlayEnabled',value),invalidate:()=>this.send('overlayInvalidate'),pending:{size:0},finalizations:{size:0},footprints:{size:0}};this.session=new DrawingSessionPort(this);this.worker.onmessage=({data:m})=>{
   if(this.disposed){closePicture(m);return;}if(m.state)this.update(m.state);
   if(m.type==='picture'){this.picture(m).catch(e=>this.fault(e.message));return;}if(m.type==='fault'){this.fault(m.message);return;}
   const request=this.requests.get(m.request);if(!request)return;this.requests.delete(m.request);if(m.error)request.reject(Error(m.error));else request.resolve(m.result);
  };this.worker.onerror=e=>this.fault(e.message||'Drawing worker failed');this.worker.onmessageerror=()=>this.fault('Drawing worker message could not be decoded');
 }
 fault(message){for(const waiter of this.preciseWaiters)waiter.resolve(false);this.preciseWaiters=[];this.localFaults.push(message);this.errors.push(message);for(const request of this.requests.values())request.reject(Error(message));this.requests.clear();for(const request of this.presentationRequests.values())request.reject(Error(message));this.presentationRequests.clear();}
 send(method,args){if(!this.disposed)this.worker.postMessage({method,args});}
 call(method,args){if(this.disposed)return Promise.reject(Error('Drawing host disposed'));const request=++this.requestId;return new Promise((resolve,reject)=>{this.requests.set(request,{resolve,reject});this.worker.postMessage({method,args,request});});}
 update(s){if(!s)return;this.info=s.info;this.errors=[...(s.errors??[]),...this.localFaults];this.completions=s.completions;this.summary=s.performance;
  Object.assign(this.document,{width:s.document.width,height:s.document.height,count:s.document.count});this.document.jobs.length=s.document.jobs;
  for(const key of ['inflight','needsFrame','viewPending','historyPreparing','guardPreparing'])this[key]=s[key];this.backend.presentationHeld=s.presentationHeld;
  for(const [key,size]of [['pending',s.proxy.pending],['finalizations',s.proxy.finalizations],['footprints',s.proxy.footprints]])this.proxy[key].size=size;
  this.proxy.error=s.proxy.error;const sessionId=this.session.id;Object.assign(this.session,s.session);this.session.id=Math.max(sessionId,s.session.id);if(s.tiles)this.backend.tiles=new Map(s.tiles.map(t=>[t.surfaceKey+'\u0000'+t.key,t]));
  if(s.recordIds)for(const [token,id]of s.recordIds){const r=this.session.recordsByToken.get(token);if(r&&id!==undefined)this.session.recordIds.set(r,id);}
 }
 async picture(m){if(m.sequence<=this.sequence||m.epoch!==this.epoch){closePicture(m);this.send('pictureAck',{sequence:m.sequence,accepted:false});return;}this.sequence=m.sequence;
  // The browser paints after this task, so the exact base swap and retirement
  // of its corresponding CPU pictures are one visible change.
  if(m.pages?.length){
   // The old precise frame plus the still-visible temporary ink is complete.
   // Preserve both until the NEW precise bitmap is installed; switching the
   // document background on every stroke caused visible flashing.
   const covered=m.retired.length>0&&m.retired.every(id=>(this.layers.has(id)||m.layers.some(layer=>layer.id===id))&&!this.hiddenStrokeIds.has(id));
   this.pendingCoverage.set(m.sequence,{covered});
   if(covered)for(const id of m.retired)this.pendingRetirements.set(id,m.sequence);
   const request=++this.presentationRequestId;
   const shown=new Promise((resolve,reject)=>this.presentationRequests.set(request,{resolve,reject}));
   this.presentation.postMessage({method:'tiles',pages:m.pages,epoch:m.epoch,version:m.sequence,request},m.pages.map(p=>p.bitmap));
   await shown;
   if(this.disposed||m.epoch!==this.epoch){for(const l of m.layers)l.bitmap.close();this.send('pictureAck',{sequence:m.sequence,accepted:false});return;}
   // Seamless and reference views have no retained-paper fallback; they must
   // observe the full precise GPU image before the formal picture is complete.
   if(this.backend.viewTransform?.[12]>.5||this.backend.viewTransform?.[14]>.5){
    await this.waitPrecise(m.sequence,m.epoch);
    if(this.disposed||m.epoch!==this.epoch){for(const l of m.layers)l.bitmap.close();this.send('pictureAck',{sequence:m.sequence,accepted:false});return;}
   }
  }
  for(const id of m.retired){if(this.pendingRetirements.has(id))continue;const layer=this.layers.get(id);layer?.element.remove();this.layers.delete(id);}
  const originX=this.canvas.offsetLeft,originY=this.canvas.offsetTop;
  for(const data of m.layers){let layer=this.layers.get(data.id);if(!layer){const element=document.createElement('canvas');element.className='illustro-stroke-overlay';element.setAttribute('aria-hidden','true');Object.assign(element.style,{position:'absolute',pointerEvents:'none',transformOrigin:'0 0',background:'transparent',aspectRatio:'auto'});layer={element,context:element.getContext('2d',{alpha:true})};if(!layer.context){element.remove();data.bitmap.close();this.fault('Transparent stroke preview Canvas2D unavailable');continue;}const next=[...this.layers].filter(([id])=>id>data.id).sort(([a],[b])=>a-b)[0]?.[1];if(next)next.element.before(element);else ([...this.layers].sort(([a],[b])=>a-b).at(-1)?.[1].element??this.canvas).after(element);this.layers.set(data.id,layer);}
   layer.view=data.view;layer.rect=data.rect;layer.scale=data.scale;layer.polygon=data.polygon;if(layer.element.width!==data.bitmap.width)layer.element.width=data.bitmap.width;if(layer.element.height!==data.bitmap.height)layer.element.height=data.bitmap.height;/* Preview pixels need their original alpha. BitmapRenderer can present an opaque black backing on some mobile compositors. */layer.context.clearRect(0,0,layer.element.width,layer.element.height);layer.context.drawImage(data.bitmap,0,0);data.bitmap.close();
   const [x,y]=data.rect;Object.assign(layer.element.style,{left:originX+x+'px',top:originY+y+'px',width:layer.element.width/data.scale+'px',height:layer.element.height/data.scale+'px',display:this.hiddenStrokeIds.has(data.id)?'none':'block',clipPath:'polygon('+data.polygon.map(p=>(p.x-x)+'px '+(p.y-y)+'px').join(',')+')'});
  }
  this.retireOverlays(this.presentationVersion);this.reproject();this.send('pictureAck',{sequence:m.sequence,accepted:true});this.onPresentation?.({kind:'picture',at:performance.now(),sequence:m.sequence});
 }
 waitPrecise(version,epoch){
  if(this.presentationVersion>=version)return Promise.resolve(true);
  return new Promise(resolve=>this.preciseWaiters.push({version,epoch,resolve}));
 }
 releasePreciseWaiters(epoch,version){
  this.preciseWaiters=this.preciseWaiters.filter(waiter=>{
   if(waiter.epoch!==epoch||waiter.version>version)return true;
   waiter.resolve(true);return false;
  });
 }
 retireOverlays(version){
  for(const [id,requiredVersion]of this.pendingRetirements){
   if(requiredVersion>version)continue;
   const layer=this.layers.get(id);layer?.element.remove();this.layers.delete(id);
   this.pendingRetirements.delete(id);
  }
 }
 syncVisibility(){
  const v=this.backend.viewTransform,ordinary=!!v&&v[12]<.5&&v[14]<.5;
  // An old reference/seamless framebuffer is NOT ordinary white paper.
  // Do not show its colored pixels when switching to an ordinary blank view;
  // the retained document backdrop already provides correct white paper.
  const modeChanged=!!v&&!!this.presentationView&&
   ((v[12]>.5)!==(this.presentationView[12]>.5)||(v[14]>.5)!==(this.presentationView[14]>.5));
  // Keep the precise M08 image visible if the latest stroke is fully covered
  // by its temporary ink. Only unrepresented edits require the fallback scene.
  this.canvas.style.opacity=this.preferRetainedDocument&&ordinary||modeChanged||ordinary&&this.presentationVersion<this.uncoveredVersion?'0':'1';
 }
 reproject(){const to=this.viewportScene.baseView??this.backend.viewTransform;if(!to)return;this.documentPresentation?.update(to);
  if(this.presentationView?.length){const from=this.presentationView,[a,b,c,d,e,f]=viewAffine(from,to),x=from[2]/to[2],y=from[3]/to[3];Object.assign(this.canvas.style,{transformOrigin:'0 0',imageRendering:to[13]>.5?'pixelated':'auto',transform:`matrix(${[a*x,b*x,c*y,d*y,e,f].join(',')})`});}
  for(const layer of this.layers.values()){const [a,b,c,d,e,f]=viewAffine(layer.view,to),[x,y]=layer.rect;layer.element.style.imageRendering=to[13]>.5?'pixelated':'auto';layer.element.style.transform=`matrix(${a},${b},${c},${d},${e+a*x+c*y-x},${f+b*x+d*y-y})`;}
 }
 setViewTransform(view){
  const old=this.backend.viewTransform;
  if(old&&view.every((n,i)=>n===old[i]))return;
  this.backend.viewTransform=Array.from(view);
  if(this.viewportScene.active){
   // No Worker messages, GPU calls or await on the live gesture path.
   this.viewportScene.move(view);
  }else{
   this.reproject();this.presentation.postMessage({method:'view',view});
   this.send('view',view);this.syncVisibility();
  }
  (this.viewSamples??=[]).push(0);
  if(this.viewSamples.length>240)this.viewSamples.shift();
  this.onPresentation?.({kind:'view-transform',at:performance.now()});
 }
 beginViewportNavigation(){
  if(!this.viewportScene.active)this.viewportScene.begin(this.backend.viewTransform);
 }
 endViewportNavigation(){
  if(!this.viewportScene.active)return;
  const view=this.backend.viewTransform,base=this.viewportScene.baseView;
  this.viewportScene.baseView=null;
  try{this.reproject();}finally{this.viewportScene.baseView=base;}
  this.viewportScene.complete();this.syncVisibility();
  if(view){this.presentation.postMessage({method:'view',view});this.send('view',view);}
 }
 setSurfaceStack(keys){this.send('stack',keys);}
 setSurfaceStyles(styles){this.send('styles',styles);}
 setSeamlessPreview(active){this.send('seamless',active);}
 clearSeamlessPreviews(id){this.send('clearSeamless',id);}
 hideStrokePreview(id){for(const waiter of this.preciseWaiters)waiter.resolve(false);this.preciseWaiters=[];this.hiddenStrokeIds.add(id);const layer=this.layers.get(id);if(layer)layer.element.style.display='none';this.send('hide',{id,epoch:++this.epoch});}
 restoreStrokePreview(id){for(const waiter of this.preciseWaiters)waiter.resolve(false);this.preciseWaiters=[];this.hiddenStrokeIds.delete(id);const layer=this.layers.get(id);if(layer)layer.element.style.display='block';this.send('show',{id,epoch:++this.epoch});}
 prepareHistory(){return this.call('prepareHistory');}
 resumeHistory(){this.send('resumeHistory');}
 async waitStroke(ids){return this.call('waitStroke',ids);}
 async drain(finalFrame=true){this.update(await this.call('drain',finalFrame));}
 read(surfaceKey='default'){return this.call('read',surfaceKey);}
 readPixel(x,y,surfaceKey){return this.call('pixel',{x,y,surfaceKey});}
 setPerformanceEnabled(enabled){this.send('measure',enabled);}
 performanceSummary(){const samples=this.viewSamples??[],sorted=[...samples].sort((a,b)=>a-b);return {...(this.summary??{}),viewTransforms:samples.length,viewComputeP95Ms:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null,displayWorker:this.presentationMetrics??null,retainedDocumentTiles:this.documentPresentation?.tiles.size??0,retainedDocumentGroups:this.documentPresentation?.tiles.size??0,deferredStrokePictures:this.pendingRetirements.size,retainedDocumentBytes:this.documentPresentation?.bytes??0};}
 frame(){return false;}
 async inspect(){const state=await this.call('inspect');this.update(state);return state;}
 destroy(){if(this.disposed)return;this.disposed=true;for(const waiter of this.preciseWaiters)waiter.resolve(false);this.preciseWaiters=[];this.pendingCoverage.clear();this.pendingRetirements.clear();this.worker.terminate();for(const request of this.requests.values())request.reject(Error('Drawing host disposed'));this.requests.clear();for(const l of this.layers.values())l.element.remove();this.layers.clear();this.documentPresentation?.destroy();this.presentation.terminate();this.viewportScene.destroy(this.canvas);for(const request of this.presentationRequests.values())request.reject(Error('Display host disposed'));this.presentationRequests.clear();}
}
function closePicture(m){for(const p of m.pages??[])p.bitmap?.close();for(const l of m.layers??[])l.bitmap?.close();}

class DrawingSessionPort {
 constructor(host){this.renderer=host;this.prediction=true;this.id=0;this.recordIds=new WeakMap;this.tokens=new WeakMap;this.recordsByToken=new Map;this.pending=[];this.pendingRawCount=0;this.rawAccepted=0;this.browserPredictions=0;this.errors=[];}
 begin(preset,fast=0,context={},surfaceKey='default'){if(this.active)throw Error('Stroke already active');const id=this.id+1;this.id+=9;this.active={id,count:0,token:'stroke:'+id};if(this.renderer.backend.viewTransform)this.renderer.send('view',this.renderer.backend.viewTransform);this.renderer.send('begin',{preset,fast,context,surfaceKey,id});return id;}
 accept(sample){if(!this.active)return;this.pending.push(sample);this.active.count++;this.rawAccepted++;}
 predictions(samples){this.predicted=samples;this.browserPredictions+=samples.length;}
 flush(){if(!this.active||!this.pending.length)return;this.renderer.send('samples',{samples:this.pending,predictions:this.predicted??[],prediction:this.prediction});this.pending=[];}
 frame(){this.flush();return this.renderer.frame();}
 end(release=null){if(!this.active)return Promise.resolve(null);this.flush();const active=this.active;this.active=null;this.pendingRawCount+=active.count;
  return this.renderer.call('end',{release,token:active.token}).then(record=>{if(record){this.recordIds.set(record,active.id);this.tokens.set(record,active.token);this.recordsByToken.set(active.token,record);}return record;}).finally(()=>this.pendingRawCount=Math.max(0,this.pendingRawCount-active.count));
 }
 token(record){const token=this.tokens.get(record);if(!token)throw Error('Unknown main-thread stroke');return token;}
 commitRecord(record,additional=[],surfaceKey='default'){const id=this.recordIds.get(record),ids=[id,...additional.map(item=>{const dx=item.commands[0][0]-record.commands[0][0],dy=item.commands[0][1]-record.commands[0][1];return id+(dx===0?0:dx>0?3:6)+(dy===0?0:dy>0?1:2);})];additional.forEach((item,i)=>{const token=this.token(record)+':copy:'+i;this.tokens.set(item,token);this.recordsByToken.set(token,item);this.recordIds.set(item,ids[i+1]);});this.renderer.send('commit',{token:this.token(record),additional,surfaceKey});return ids;}
 commitUndoneRecord(record,additional=[],surfaceKey='default'){additional.forEach((item,i)=>{const token=this.token(record)+':copy:'+i;this.tokens.set(item,token);this.recordsByToken.set(token,item);});this.renderer.send('commitUndone',{token:this.token(record),additional,surfaceKey});}
 forgetStaged(record){this.renderer.send('forget',{token:this.token(record)});this.recordsByToken.delete(this.token(record));}
 discardUncommitted(record){return this.renderer.call('discardUncommitted',{token:this.token(record)});}
 cancel(){this.pending=[];this.active=null;return this.renderer.call('cancel');}
 discardRedo(){this.renderer.send('discardRedo');}
 setSurfaceStack(keys){this.renderer.setSurfaceStack(keys);}
 navigateDerived(steps){return this.renderer.call('navigate',steps.map(({record,...step})=>({...step,token:this.token(record)})));}
 async restore(entries,cache,geometry){this.recordsByToken.clear();this.tokens=new WeakMap;this.recordIds=new WeakMap;
  const data=entries.map((e,i)=>{const token='restored:'+i;this.tokens.set(e.record,token);this.recordsByToken.set(token,e.record);return {record:e.record,surfaceKey:e.surfaceKey,keys:e.keys,cached:e.cached,token};});const state=await this.renderer.call('restore',{entries:data,cache,geometry});this.id=state.session.id;this.renderer.update(state);
 }
 destroy(){this.renderer.destroy();}
}
