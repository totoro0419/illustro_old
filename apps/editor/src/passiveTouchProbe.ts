/**
 * QA-only raw contact diagnostic. Canvas rendering/navigation/stroke logic is
 * untouched. Optional dedicated contact layer intentionally blocks painting
 * while armed, so the device sends input directly to a known stable target.
 */
export function installPassiveTouchProbe():void{
 const params=new URLSearchParams(location.search);
 if(params.get('touchProbe')!=='1')return;
 const wantDirect=params.get('captureTouch')==='1';
 const output=document.createElement('output');
 output.id='illustro-passive-touch-probe';
 output.setAttribute('aria-label','現在の指の接触本数');
 // This display is always non-interactive. The separate test layer is not.
 Object.assign(output.style,{
  position:'fixed',top:'calc(env(safe-area-inset-top) + 58px)',right:'10px',
  zIndex:'2147483646',maxWidth:'min(360px,calc(100vw - 20px))',
  padding:'10px 12px',borderRadius:'10px',boxSizing:'border-box',
  background:'rgba(14,30,51,.94)',color:'#fff',font:'13px/1.5 monospace',
  whiteSpace:'pre-wrap',textAlign:'left',pointerEvents:'none',
  userSelect:'none',touchAction:'auto'
 });
 document.body.append(output);

 let touchStarts=0,touchMoves=0,touchEnds=0,touchCancels=0;
 let pointerStarts=0,pointerEnds=0;
 let touchCount=0,onCanvas:number|null=null,touchSeen=false;
 let lastType='待機中',lastAt='なし',renderPending=0,directEnabled=false;
 let armed=document.createElement('div'),switcher=document.createElement('button');
 const pointers=new Map<number,{x:number;y:number}>();
 const eventSeen=new WeakSet<Event>();
 const surface=()=>document.querySelector<HTMLElement>('#canvasArea .surface');
 const inCanvas=(x:number,y:number)=>{
  const el=surface();if(!el)return false;
  const r=el.getBoundingClientRect();
  return x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom;
 };
 const canvasTouches=(touches:TouchList):number=>
  Array.from(touches).filter(t=>inCanvas(t.clientX,t.clientY)).length;
 const activeCount=()=>{
  // TouchEvent gives the complete contact set. If the browser exposes only
  // PointerEvents, fall back to the pointer-ID set. Never SUM both streams.
  return touchSeen?touchCount:pointers.size;
 };
 const render=()=>{
  renderPending=0;
  const count=activeCount();
  output.textContent=
    '【指の数：'+count+'】\n'+
    'タッチ実数: '+count+'（1本→1 / 2本→2）\n'+
    'Touch: '+touchCount+' / Pointer: '+pointers.size+'\n'+
    'キャンバス内: '+(onCanvas===null?'未準備':onCanvas)+'\n'+
    '開始: '+touchStarts+' / 移動: '+touchMoves+'\n'+
    '終了: '+touchEnds+' / 中断: '+touchCancels+'\n'+
    'Pointer開始: '+pointerStarts+' / 終了: '+pointerEnds+'\n'+
    '入力の種類: '+(touchSeen?'Touch優先':'Pointer代替')+'\n'+
    '検査方式: '+(directEnabled?'専用面で直接認識':'通常画面を観察')+'\n'+
    '最後: '+lastType+' @ '+lastAt;
  if(directEnabled){
   armed.dataset.contactCount=String(count);
   armed.querySelector<HTMLElement>('.illustro-touch-count')!.textContent=String(count);
  }
 };
 const scheduleRender=()=>{
  if(!renderPending)renderPending=requestAnimationFrame(render);
 };
 const stamp=(type:string)=>{
  lastType=type;lastAt=new Date().toLocaleTimeString('ja-JP',{hour12:false});
 };
 const recordTouch=(type:'touchstart'|'touchmove'|'touchend'|'touchcancel',e:TouchEvent)=>{
  if(eventSeen.has(e))return;
  eventSeen.add(e);
  touchSeen=true;touchCount=e.touches.length;
  onCanvas=canvasTouches(e.touches);
  stamp(type);
  if(type==='touchstart')touchStarts+=e.changedTouches.length;
  else if(type==='touchmove')touchMoves++;
  else if(type==='touchend')touchEnds+=e.changedTouches.length;
  else touchCancels+=e.changedTouches.length;
  if(type==='touchmove')scheduleRender();else render();
 };
 const recordPointer=(type:'pointerdown'|'pointermove'|'pointerup'|'pointercancel'|'lostpointercapture',e:PointerEvent)=>{
  if(e.pointerType!=='touch'||eventSeen.has(e))return;
  eventSeen.add(e);
  stamp(type);
  if(type==='pointerdown'){
   pointerStarts++;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  }else if(type==='pointermove'){
   if(pointers.has(e.pointerId))pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  }else if(pointers.has(e.pointerId)){
   pointerEnds++;pointers.delete(e.pointerId);
  }
  if(!touchSeen)onCanvas=[...pointers.values()].filter(p=>inCanvas(p.x,p.y)).length;
  if(type==='pointermove')scheduleRender();else render();
 };
 const opts={capture:true,passive:true} as const;
 for(const type of ['touchstart','touchmove','touchend','touchcancel'] as const)
  window.addEventListener(type,e=>recordTouch(type,e),opts);
 for(const type of ['pointerdown','pointermove','pointerup','pointercancel'] as const)
  window.addEventListener(type,e=>recordPointer(type,e),opts);

 // Dedicated stable hit target is available ONLY in this opt-in QA mode.
 // It is intentionally in front of the artwork; while active, painting is
 // paused, so there is no ambiguity about which element receives touch.
 armed.id='illustro-direct-touch-layer';
 armed.setAttribute('aria-label','指の本数を調べる専用面');
 Object.assign(armed.style,{
  position:'absolute',inset:'0',zIndex:'9999',boxSizing:'border-box',
  touchAction:'none',pointerEvents:'auto',background:'rgba(45,102,213,.035)',
  outline:'2px dashed rgba(45,102,213,.5)',outlineOffset:'-2px',
  display:'none',userSelect:'none',overscrollBehavior:'contain'
 });
 armed.innerHTML='<div style="position:absolute;left:50%;top:45%;transform:translate(-50%,-50%);pointer-events:none;text-align:center;white-space:nowrap;border-radius:12px;padding:12px 18px;background:rgba(255,255,255,.8);color:#1d3554">指の本数を直接確認<div class="illustro-touch-count" style="font-size:42px;font-weight:700">0</div><small>描画は一時停止中</small></div>';
 const listenOpts={passive:false} as const;
 for(const type of ['touchstart','touchmove','touchend','touchcancel'] as const){
  armed.addEventListener(type,e=>{
   recordTouch(type,e);
   // Suppress native browser panning/zooming only on this QA-only touch pad.
   if(e.cancelable)e.preventDefault();
  },listenOpts);
 }
 for(const type of ['pointerdown','pointermove','pointerup','pointercancel'] as const)
  armed.addEventListener(type,e=>{
   recordPointer(type,e);
   if(type==='pointerdown'&&e.pointerType==='touch'){
    try{armed.setPointerCapture(e.pointerId);}catch{}
   }
  });
 // A browser may lose capture without delivering a corresponding pointerup.
 armed.addEventListener('lostpointercapture',e=>{
  if(e instanceof PointerEvent)recordPointer('lostpointercapture',e);
 });
 switcher.id='illustro-direct-touch-toggle';
 switcher.type='button';
 Object.assign(switcher.style,{
  position:'fixed',right:'10px',top:'calc(env(safe-area-inset-top) + 280px)',
  zIndex:'2147483647',font:'bold 14px system-ui',
  border:'2px solid #fff',borderRadius:'10px',padding:'11px 14px',
  color:'#fff',background:'#3356b6',cursor:'pointer',touchAction:'manipulation'
 });
 document.body.append(switcher);
 const setDirect=(active:boolean)=>{
  const parent=surface();
  if(!parent){directEnabled=false;switcher.textContent='キャンバスがまだありません';return;}
  if(armed.parentElement!==parent)parent.append(armed);
  directEnabled=active;
  armed.style.display=active?'block':'none';
  switcher.textContent=active?'描画に戻す（判定面を消す）':'指の判定面を出す';
  pointers.clear();touchSeen=false;touchCount=0;onCanvas=0;
  render();
 };
 switcher.addEventListener('click',()=>setDirect(!directEnabled));
 setDirect(wantDirect);
 // Diagnostics only. Never mutate input, drawing, GPU or navigation state.
 (window as unknown as {__illustroTouchProbe?:()=>unknown;__illustroTouchProbeDirect?:(enabled:boolean)=>void}).__illustroTouchProbe=()=>({
  touchStarts,touchMoves,touchEnds,touchCancels,touchCount,onCanvas,
  pointerStarts,pointerEnds,pointerCount:pointers.size,combined:activeCount(),
  directEnabled,touchSeen,lastType,lastAt
 });
 (window as unknown as {__illustroTouchProbeDirect?:(enabled:boolean)=>void}).__illustroTouchProbeDirect=setDirect;
}
