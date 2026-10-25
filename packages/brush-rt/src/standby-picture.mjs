// A retained, viewport-sized picture of the last already-visible document.
// Unlike the live drawing canvas, its pixels never change while navigating.
// Pending CPU stroke overlays stay in a separate ink plane above this picture.
// Snapshot work runs only in standby, never in pointer handlers.
const pixelRatio=()=>Math.max(1,Math.min(2,window.devicePixelRatio||1));
const parsedMatrix=element=>{
 const v=getComputedStyle(element).transform;
 try{return !v||v==='none'?new DOMMatrix():new DOMMatrix(v);}
 catch{return new DOMMatrix();}
};
const visible=element=>{
 const style=getComputedStyle(element);
 return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity||1)>0;
};
const transformElement=(ctx,element)=>{
 const t=parsedMatrix(element);
 ctx.translate(element.offsetLeft||0,element.offsetTop||0);
 ctx.transform(t.a,t.b,t.c,t.d,t.e,t.f);
};
const clipElement=(ctx,element)=>{
 const match=String(element.style.clipPath||'').match(/^polygon\((.*)\)$/);
 if(!match)return;
 const points=[...match[1].matchAll(/(-?[\d.]+)px\s+(-?[\d.]+)px/g)];
 if(points.length<3)return;
 ctx.beginPath();
 for(let i=0;i<points.length;i++){
  const x=Number(points[i][1]),y=Number(points[i][2]);
  if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
 }
 ctx.closePath();ctx.clip();
};

export class StandbyPicture {
 constructor(scene,source){
  this.scene=scene;this.source=source;this.mode='standby';
  this.ready=false;this.dirty=true;this.pending=false;this.running=false;
  this.refreshCount=0;this.renderErrors=0;this.scheduled=null;
  this.front=document.createElement('canvas');
  this.front.className='illustro-standby-picture';
  Object.assign(this.front.style,{position:'absolute',inset:'0',width:'100%',height:'100%',display:'none',
   pointerEvents:'none',transformOrigin:'0 0',imageRendering:'auto'});
  this.front.setAttribute('aria-hidden','true');
  // The standby image is *above* the completed artwork but *below* unfinished ink.
  this.scene.append(this.front);
  this.back=document.createElement('canvas');
 }
 setMode(mode){
  this.mode=mode;
  if(mode==='drawing'){this.front.style.display='none';return;}
  if(mode==='navigation'){this.cancel();this.show();return;}
  this.show();this.refresh();
 }
 show(){this.front.style.display=this.ready?'block':'none';}
 invalidate(){
  // A newly committed base must never be hidden behind a stale snapshot.
  this.dirty=true;this.ready=false;this.front.style.display='none';this.refresh();
 }
 refresh(){
  if(this.mode!=='standby'||!this.dirty||this.scheduled!==null||this.running)return;
  const action=()=>{this.scheduled=null;this.capture();};
  if(typeof requestIdleCallback==='function')this.scheduled={kind:'idle',id:requestIdleCallback(action,{timeout:160})};
  else this.scheduled={kind:'frame',id:requestAnimationFrame(action)};
 }
 cancel(){
  if(!this.scheduled)return;
  if(this.scheduled.kind==='idle')cancelIdleCallback(this.scheduled.id);
  else cancelAnimationFrame(this.scheduled.id);
  this.scheduled=null;
 }
 paint(){
  if(this.mode!=='standby')return false;
  const source=this.source,scene=this.scene;
  const w=scene.clientWidth,h=scene.clientHeight;
  if(!w||!h)return false;
  const ratio=Math.min(pixelRatio(),3072/w,3072/h);
  const bw=Math.max(1,Math.round(w*ratio)),bh=Math.max(1,Math.round(h*ratio));
  if(this.back.width!==bw)this.back.width=bw;
  if(this.back.height!==bh)this.back.height=bh;
  const ctx=this.back.getContext('2d',{alpha:false});
  if(!ctx)return false;
  // Clear the whole previously used image. The surrounds must be identical.
  ctx.resetTransform();ctx.fillStyle='#f1f4f9';ctx.fillRect(0,0,bw,bh);
  ctx.setTransform(ratio,0,0,ratio,0,0);
  const paper=scene.querySelector('.illustro-document-presentation');
  if(paper&&visible(paper)){
   ctx.save();transformElement(ctx,paper);ctx.beginPath();ctx.rect(0,0,paper.offsetWidth,paper.offsetHeight);ctx.clip();
   ctx.fillStyle='#fff';ctx.fillRect(0,0,paper.offsetWidth,paper.offsetHeight);
   for(const child of paper.children){
    if(!(child instanceof HTMLCanvasElement)||!visible(child))continue;
    ctx.save();transformElement(ctx,child);
    ctx.drawImage(child,0,0,child.offsetWidth,child.offsetHeight);ctx.restore();
   }
   ctx.restore();
  }
  if(visible(source)){
   ctx.save();transformElement(ctx,source);
   ctx.globalAlpha=Number(getComputedStyle(source).opacity||1);
   ctx.drawImage(source,0,0,source.offsetWidth,source.offsetHeight);
   ctx.restore();
  }
  return true;
 }
 capture(){
  if(this.mode!=='standby'||!this.dirty||this.running)return;
  this.running=true;
  try{
   if(!this.paint())return;
   if(this.mode!=='standby')return;
   const old=this.front;
   this.front=this.back;this.back=old;
   this.front.className='illustro-standby-picture';
   this.front.setAttribute('aria-hidden','true');
   Object.assign(this.front.style,{position:'absolute',inset:'0',width:'100%',height:'100%',
    display:'block',pointerEvents:'none',transformOrigin:'0 0'});
   this.back.remove();
   // Preserve the existing position of the retained image directly under ink.
   const ink=this.scene.querySelector('.illustro-ink-plane');
   if(ink)this.scene.insertBefore(this.front,ink);else this.scene.append(this.front);
   this.dirty=false;this.ready=true;this.refreshCount++;
  }catch(error){
   // BitmapRenderer -> Canvas2D copying is not supported uniformly by devices.
   // Keep showing the accurate live document instead of a blank cached image.
   this.renderErrors++;this.dirty=false;this.ready=false;this.front.style.display='none';
   this.lastError=String(error);
  }finally{this.running=false;}
 }
 destroy(){this.cancel();this.front.remove();this.back.remove();this.ready=false;}
}
