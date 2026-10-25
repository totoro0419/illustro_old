/**
 * Opt-in M10 contact diagnostic. The touch counter itself runs in a sandboxed
 * iframe with its own document, script and hit-test target. Its number is NOT
 * updated by Illustro's animation frame, worker, renderer or save callbacks.
 * While armed the iframe captures touches and painting is intentionally paused.
 * The normal editor, its canvas navigation and drawing code are unchanged.
 */
export function installIsolatedTouchFrame():void{
 const surface=document.querySelector<HTMLElement>('#canvasArea .surface');
 if(!surface)return;
 const frame=document.createElement('iframe');
 frame.id='illustro-independent-counter-frame';
 frame.title='独立した指の本数の判定面';
 frame.setAttribute('sandbox','allow-scripts');
 frame.setAttribute('scrolling','no');
 frame.src='./qa-touch-counter-frame.html';
 Object.assign(frame.style,{
  position:'absolute',inset:'0',width:'100%',height:'100%',
  zIndex:'9000',border:'0',background:'transparent',
  pointerEvents:'none',touchAction:'none',opacity:'0'
 });
 surface.append(frame);
 const switcher=document.createElement('button');
 switcher.type='button';
 switcher.id='illustro-independent-counter-toggle';
 Object.assign(switcher.style,{
  position:'fixed',right:'10px',top:'calc(env(safe-area-inset-top) + 76px)',
  zIndex:'2147483646',padding:'12px 14px',borderRadius:'11px',
  border:'2px solid #fff',background:'#315bc5',color:'#fff',
  font:'700 13px system-ui,sans-serif',cursor:'pointer',
  touchAction:'manipulation'
 });
 document.body.append(switcher);
 const hint=document.createElement('output');
 hint.id='illustro-independent-counter-hint';
 hint.textContent='線を離すと、指の判定面へ切り替わります';
 Object.assign(hint.style,{
  position:'fixed',bottom:'calc(env(safe-area-inset-bottom) + 65px)',
  left:'12px',maxWidth:'calc(100vw - 24px)',zIndex:'2147483646',
  background:'rgba(25,44,69,.89)',color:'#fff',borderRadius:'8px',
  font:'12px/1.5 system-ui,sans-serif',padding:'8px 10px',pointerEvents:'none'
 });
 document.body.append(hint);
 let armed=false,armedByStroke=0,frameReady=false;
 const change=(active:boolean,reason='manual')=>{
  armed=active;
  frame.style.pointerEvents=active?'auto':'none';
  frame.style.opacity=active?'1':'0';
  switcher.textContent=active?'描画へ戻る':'指の判定面を出す';
  hint.textContent=active
   ?'青い面の上に1本・2本の指を置いてください。終了後は「描画へ戻る」'
   :'描画できます。線を離すと判定面が自動で開きます';
  if(reason==='stroke'&&active)armedByStroke++;
 };
 frame.addEventListener('load',()=>{frameReady=true;});
 switcher.onclick=()=>change(!armed);
 // During pointerup CAPTURE (before brushSurface.finishStroke), arm the
 // independent surface. No status, GPU, worker completion, timeout or
 // requestAnimationFrame is consulted. Future touches target the iframe.
 const onPenRelease=(e:PointerEvent)=>{
  if(armed||e.pointerType!=='pen'&&e.pointerType!=='touch')return;
  const r=surface.getBoundingClientRect();
  if(e.clientX<r.left||e.clientX>=r.right||e.clientY<r.top||e.clientY>=r.bottom)return;
  if(e.target instanceof Element&&e.target.closest('button,input,select,textarea,.crop-handle'))return;
  change(true,'stroke');
 };
 window.addEventListener('pointerup',onPenRelease,{capture:true,passive:true});
 // For diagnostics; this never reads the cross-origin frame document.
 (window as unknown as {
  __illustroIsolatedTouchFrame?:()=>unknown;
  __illustroIsolatedTouchFrameArm?:(active:boolean)=>void
 }).__illustroIsolatedTouchFrame=()=>({armed,armedByStroke,frameReady,source:frame.src,sandbox:frame.sandbox.value});
 (window as unknown as {__illustroIsolatedTouchFrameArm?:(active:boolean)=>void})
  .__illustroIsolatedTouchFrameArm=(active:boolean)=>change(active);
 change(false);
}
