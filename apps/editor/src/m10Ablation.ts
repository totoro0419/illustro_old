/** Read-only display and input probe used only by the M10 ablation URLs. */
export type AblationMode='baseline'|'overlay'|'presentation'|'persistence';
export function ablationMode():AblationMode{
 const v=new URLSearchParams(location.search).get('ablate');
 return v==='overlay'||v==='presentation'||v==='persistence'?v:'baseline';
}
export function installAblationProbe(mode:AblationMode){
 if(new URLSearchParams(location.search).get('touchProbe')!=='1')return null;
 const panel=document.createElement('output');
 panel.id='m10-ablation-probe';
 panel.setAttribute('aria-label','指の入力・画面更新の調査');
 Object.assign(panel.style,{position:'fixed',top:'calc(env(safe-area-inset-top) + 59px)',right:'8px',
  zIndex:'2147483647',maxWidth:'min(330px,90vw)',color:'white',
  background:'rgba(10,25,46,.93)',padding:'9px',borderRadius:'10px',
  font:'12px/1.55 monospace',whiteSpace:'pre-wrap',pointerEvents:'none'});
 document.body.append(panel);
 let count=0,pointerCount=0,starts=0,events=0,last='まだ入力なし';
 let lastClock=performance.now(),largestPause=0,lastEventDelay=0,maxDelay=0,confirmedAt=0;
 const pointers=new Set<number>(),records:Array<{kind:string;at:number;count:number;delay:number}>=[];
 const mark=(kind:string,event?:Event)=>{
  const now=performance.now(),delay=event?Math.max(0,now-event.timeStamp):0;
  last=kind;events++;lastEventDelay=delay;maxDelay=Math.max(maxDelay,delay);
  records.push({kind,at:now,count,delay});if(records.length>1200)records.shift();render();
 };
 const render=()=>{
  panel.textContent='試験: '+mode+'\n指の本数: '+count+
   ' / Pointer: '+pointerCount+'\n指を置いた回数: '+starts+
   '\n入力の遅延: '+Math.round(lastEventDelay)+'ms / 最大 '+Math.round(maxDelay)+'ms'+
   '\n画面処理の最長中断: '+Math.round(largestPause)+'ms'+
   '\n最後: '+last+
   '\n操作/描画用の入力処理は変更なし';
 };
 const opts={capture:true,passive:true} as const;
 for(const type of ['touchstart','touchend','touchcancel','touchmove'] as const){
  window.addEventListener(type,e=>{
   count=e.touches.length;
   if(type==='touchstart')starts+=e.changedTouches.length;
   if(type!=='touchmove')mark(type,e);
  },opts);
 }
 for(const type of ['pointerdown','pointerup','pointercancel'] as const){
  window.addEventListener(type,e=>{
   if(e.pointerType!=='touch')return;
   if(type==='pointerdown')pointers.add(e.pointerId);else pointers.delete(e.pointerId);
   pointerCount=pointers.size;
   // Some devices deliver pointer events but no TouchEvent.
   if(starts===0)count=pointerCount;
   mark(type,e);
  },opts);
 }
 const interval=window.setInterval(()=>{
  const now=performance.now();largestPause=Math.max(largestPause,Math.max(0,now-lastClock-40));
  lastClock=now;render();
 },40);
 const api={
  mark:(s:string)=>{if(s==='formal-confirmed')confirmedAt=performance.now();mark(s);},
  snapshot:()=>({mode,count,pointerCount,starts,events,last,lastEventDelay,maxDelay,
   largestPause,confirmedAt,records:[...records],interval})
 };
 (window as unknown as {__m10Ablation?:typeof api}).__m10Ablation=api;
 render();return api;
}
