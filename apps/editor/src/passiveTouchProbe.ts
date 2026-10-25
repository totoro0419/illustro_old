/** Passive QA-only input monitor. NEVER changes canvas, stroke or gesture behavior. */
export function installPassiveTouchProbe():void{
 const params=new URLSearchParams(location.search);
 if(params.get('touchProbe')!=='1')return;
 const output=document.createElement('output');
 output.id='illustro-passive-touch-probe';
 output.setAttribute('aria-label','指の接触の記録');
 output.setAttribute('role','status');
 // Fixed OUTSIDE the artwork tree. It cannot become the input target.
 Object.assign(output.style,{
  position:'fixed',top:'calc(env(safe-area-inset-top) + 56px)',right:'10px',
  zIndex:'2147483646',maxWidth:'min(340px,calc(100vw - 20px))',
  padding:'9px 11px',borderRadius:'9px',boxSizing:'border-box',
  background:'rgba(20,36,59,.92)',color:'#ffffff',font:'12px/1.5 monospace',
  whiteSpace:'pre-wrap',textAlign:'left',pointerEvents:'none',
  userSelect:'none',touchAction:'auto'
 });
 document.body.append(output);
 let touchStarts=0,touchMoves=0,touchEnds=0,touchCancels=0,touchCount=0;
 let pointerStarts=0,pointerEnds=0,lastType='待機中',lastAt='なし';
 const pointerIds=new Set<number>();
 let pendingRender=0;
 const canvasTouches=(touches:TouchList)=>{
  const area=document.querySelector<HTMLElement>('#canvasArea .surface');
  if(!area)return null;
  const r=area.getBoundingClientRect();let count=0;
  for(const t of Array.from(touches)){
   if(t.clientX>=r.left&&t.clientX<r.right&&t.clientY>=r.top&&t.clientY<r.bottom)count++;
  }
  return count;
 };
 let onCanvas:number|null=null;
 const render=()=>{
  pendingRender=0;
  output.textContent=
   '【指の認識だけを確認】\n'+
   'Touch実数: '+touchCount+'（画面全体）\n'+
   'キャンバス内: '+(onCanvas===null?'未準備':onCanvas)+'\n'+
   'Touch開始: '+touchStarts+' / 移動: '+touchMoves+'\n'+
   '終了: '+touchEnds+' / 中断: '+touchCancels+'\n'+
   'Pointer指: '+pointerIds.size+' / 開始: '+pointerStarts+' / 終了: '+pointerEnds+'\n'+
   '最後の入力: '+lastType+' @ '+lastAt+'\n'+
   '検査専用・作品と操作に変更なし';
 };
 const refresh=(type:string,event:TouchEvent,immediate:boolean)=>{
  touchCount=event.touches.length;onCanvas=canvasTouches(event.touches);
  lastType=type;lastAt=new Date().toLocaleTimeString('ja-JP',{hour12:false});
  if(immediate){if(pendingRender)cancelAnimationFrame(pendingRender);render();}
  else if(!pendingRender)pendingRender=requestAnimationFrame(render);
 };
 const options={capture:true,passive:true} as const;
 window.addEventListener('touchstart',e=>{touchStarts+=e.changedTouches.length;refresh('touchstart',e,true);},options);
 window.addEventListener('touchmove',e=>{touchMoves++;refresh('touchmove',e,false);},options);
 window.addEventListener('touchend',e=>{touchEnds+=e.changedTouches.length;refresh('touchend',e,true);},options);
 window.addEventListener('touchcancel',e=>{touchCancels+=e.changedTouches.length;refresh('touchcancel',e,true);},options);
 window.addEventListener('pointerdown',e=>{
  if(e.pointerType!=='touch')return;
  pointerStarts++;pointerIds.add(e.pointerId);lastType='pointerdown';
  lastAt=new Date().toLocaleTimeString('ja-JP',{hour12:false});render();
 },options);
 const endPointer=(e:PointerEvent,type:string)=>{
  if(e.pointerType!=='touch')return;
  pointerEnds++;pointerIds.delete(e.pointerId);lastType=type;
  lastAt=new Date().toLocaleTimeString('ja-JP',{hour12:false});render();
 };
 window.addEventListener('pointerup',e=>endPointer(e,'pointerup'),options);
 window.addEventListener('pointercancel',e=>endPointer(e,'pointercancel'),options);
 render();
 // Read-only test data: the monitor never calls the drawing subsystem.
 (window as unknown as {__illustroTouchProbe?:()=>unknown}).__illustroTouchProbe=()=>({
  touchStarts,touchMoves,touchEnds,touchCancels,touchCount,onCanvas,
  pointerStarts,pointerEnds,pointerCount:pointerIds.size,lastType,lastAt
 });
}
