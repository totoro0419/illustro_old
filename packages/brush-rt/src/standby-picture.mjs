import {viewAffine} from '@rt/stroke-overlay';

// The standby display owns its own bitmap. It NEVER copies, screenshots or
// reads back a live drawing canvas on the input thread. The display worker
// supplies this bitmap after composing a fully coherent viewport.
// Pending ink remains in the higher .illustro-ink-plane.
export class StandbyPicture {
 constructor(scene,source) {
  this.scene=scene;this.source=source;
  this.mode='standby';this.ready=false;this.refreshCount=0;
  this.renderErrors=0;this.stale=false;this.view=null;this.liveView=null;
  this.front=document.createElement('canvas');
  this.front.className='illustro-standby-picture';
  this.front.setAttribute('aria-hidden','true');
  Object.assign(this.front.style,{
   position:'absolute',left:'0',top:'0',width:'100%',height:'100%',
   display:'none',background:'#f1f4f9',pointerEvents:'none',
   transformOrigin:'0 0',imageRendering:'auto'
  });
  this.context=this.front.getContext('bitmaprenderer');
  this.scene.append(this.front);
 }
 get available(){return this.ready&&!!this.context;}
 setMode(mode){this.mode=mode;this.show();}
 show(){this.front.style.display=this.available&&this.mode!=='drawing'?'block':'none';}
 // This signals that a newer formal version may be coming. Retaining the
 // previously displayed image matters: pending stroke ink covers that image.
 // A formal update must never leave the standby period with no usable pixels.
 invalidate(){this.stale=true;}
 install(bitmap,view){
  if(!bitmap)return;
  if(!this.context){bitmap.close();this.renderErrors++;this.show();return;}
  if(this.mode==='navigation'){
   // Do not upload bitmaps while moving the already-installed image.
   bitmap.close();return;
  }
  try{
   if(this.front.width!==bitmap.width)this.front.width=bitmap.width;
   if(this.front.height!==bitmap.height)this.front.height=bitmap.height;
   this.context.transferFromImageBitmap(bitmap);
   this.view=Array.from(view);
   this.ready=true;this.stale=false;this.refreshCount++;
   this.update(this.liveView??view);
   this.show();
  }catch(error){
   try{bitmap.close();}catch{}
   this.renderErrors++;this.lastError=String(error);
   // Keep previously displayed pixels if the replacement failed.
   this.show();
  }
 }
 update(to){
  if(!to)return;
  this.liveView=Array.from(to);
  if(!this.ready||!this.view)return;
  const from=this.view;
  const [a,b,c,d,e,f]=viewAffine(from,to);
  const x=from[2]/to[2],y=from[3]/to[3];
  Object.assign(this.front.style,{
   imageRendering:to[13]>.5?'pixelated':'auto',
   transform:'matrix('+[a*x,b*x,c*y,d*y,e,f].join(',')+')'
  });
 }
 destroy(){
  this.front.remove();this.front.width=1;this.front.height=1;
  this.ready=false;this.context=null;
 }
}
