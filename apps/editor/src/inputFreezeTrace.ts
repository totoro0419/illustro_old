/** QA-only trace of input dispatch, rendering stalls and commit UI lifecycle. */
type TraceEvent={at:number;kind:string;details?:Record<string,number|string|boolean|null>};
const getNow=()=>performance.now();
const asTime=(value:number)=>Number(value.toFixed(2));
export function installInputFreezeTrace(){
 const params=new URLSearchParams(location.search);
 if(params.get('inputTrace')!=='1')return null;
 const log:TraceEvent[]=[];
 let maxTimerLag=0,maxFrameGap=0,lastTick=getNow(),lastFrame=getNow();
 let touchCount=0,touchStarts=0,pointerTouches=0,latestEventLag=0,maxEventLag=0;
 let longestLongTask=0,totalLongTasks=0,statusTime=0;
 const pointerIds=new Set<number>();
 let recentText='待機',lastEventAt=getNow();
 const panel=document.createElement('output');
 panel.id='illustro-input-freeze-trace';
 panel.setAttribute('aria-live','off');
 Object.assign(panel.style,{position:'fixed',top:'calc(env(safe-area-inset-top) + 62px)',
  right:'9px',zIndex:'2147483646',background:'rgba(13,28,48,.95)',
  color:'white',borderRadius:'10px',padding:'10px',whiteSpace:'pre-wrap',
  pointerEvents:'none',font:'12px/1.5 monospace',maxWidth:'min(360px,90vw)'});
 document.body.append(panel);
 function mark(kind:string,details?:TraceEvent['details']){
  log.push({at:asTime(getNow()),kind,details});
  if(log.length>4000)log.shift();
  recentText=kind;
 }
 const render=()=>{
  const last=log.slice(-3).map(x=>x.kind).join(' → ');
  panel.textContent='【入力と画面停止の診断】\n'+
   'Touch実数: '+touchCount+' / Pointer指: '+pointerIds.size+'\n'+
   'Touch開始: '+touchStarts+' / 最後の入力: '+asTime(getNow()-lastEventAt)+'ms前\n'+
   '入力遅延: '+asTime(latestEventLag)+'ms / 最大: '+asTime(maxEventLag)+'ms\n'+
   '時計の最大停止: '+asTime(maxTimerLag)+'ms\n'+
   '画面更新の最大間隔: '+asTime(maxFrameGap)+'ms\n'+
   '長い処理: '+totalLongTasks+'回 / 最長: '+asTime(longestLongTask)+'ms\n'+
   '最後: '+last+'\n'+
   '（操作処理は変更していません）';
 };
 const recordInput=(kind:string,e:Event,number:number)=>{
  const now=getNow();
  const delay=Math.max(0,now-e.timeStamp);
  latestEventLag=delay;maxEventLag=Math.max(maxEventLag,delay);
  lastEventAt=now;
  mark(kind,{count:number,delayMs:asTime(delay)});
  render();
 };
 const options={capture:true,passive:true} as const;
 for(const type of ['touchstart','touchmove','touchend','touchcancel'] as const)
  window.addEventListener(type,e=>{
   touchCount=e.touches.length;
   if(type==='touchstart')touchStarts+=e.changedTouches.length;
   if(type!=='touchmove')recordInput(type,e,touchCount);
  },options);
 for(const type of ['pointerdown','pointerup','pointercancel'] as const)
  window.addEventListener(type,e=>{
   if(e.pointerType!=='touch'&&e.pointerType!=='pen')return;
   if(type==='pointerdown')pointerIds.add(e.pointerId);else pointerIds.delete(e.pointerId);
   pointerTouches=pointerIds.size;
   recordInput(type+' '+e.pointerType,e,pointerTouches);
  },options);
 let lastStatus='';
 const status=document.querySelector('#status');
 if(status){
  const observer=new MutationObserver(()=>{
   const value=status.textContent??'';
   if(value===lastStatus)return;
   lastStatus=value;
   if(value.includes('線を作品に反映')||value.includes('消した内容を作品に反映')){
    statusTime=getNow();mark('formal-confirmation',{status:value});
   }else if(value.includes('描画できます'))mark('drawing-ready');
   render();
  });
  observer.observe(status,{subtree:true,characterData:true,childList:true});
 }
 setInterval(()=>{
  const now=getNow(),elapsed=now-lastTick;lastTick=now;
  const lag=Math.max(0,elapsed-35);
  if(lag>maxTimerLag)maxTimerLag=lag;
  if(lag>=45)mark('timer-stall',{gapMs:asTime(elapsed)});
  render();
 },35);
 const frame=()=>{
  const now=getNow(),gap=now-lastFrame;
  maxFrameGap=Math.max(maxFrameGap,gap);
  if(gap>100)mark('frame-gap',{gapMs:asTime(gap)});
  lastFrame=now;requestAnimationFrame(frame);
 };
 requestAnimationFrame(frame);
 try{
  const obs=new PerformanceObserver(list=>{
   for(const entry of list.getEntries()){
    if(entry.entryType==='longtask'){
     totalLongTasks++;longestLongTask=Math.max(longestLongTask,entry.duration);
     mark('longtask',{start:asTime(entry.startTime),duration:asTime(entry.duration)});
    }else if(entry.entryType==='event'){
     mark('event-timing',{name:entry.name,start:asTime(entry.startTime),duration:asTime(entry.duration)});
    }
   }
  });
  obs.observe({type:'longtask',buffered:true});
  try{obs.observe({type:'event',durationThreshold:16,buffered:true} as PerformanceObserverInit);}catch{}
 }catch{}
 const api={
  mark,
  snapshot:()=>({timeOrigin:performance.timeOrigin,now:getNow(),touchCount,touchStarts,
   pointerTouches,latestEventLag,maxEventLag,maxTimerLag,maxFrameGap,
   totalLongTasks,longestLongTask,statusTime,recentText,events:[...log]}),
  clear:()=>{log.length=0;maxTimerLag=0;maxFrameGap=0;totalLongTasks=0;longestLongTask=0;}
 };
 (window as unknown as {__illustroInputFreezeTrace?:typeof api}).__illustroInputFreezeTrace=api;
 render();
 return api;
}
