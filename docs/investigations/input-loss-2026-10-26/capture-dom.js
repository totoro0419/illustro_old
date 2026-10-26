/* Temporary observation only. Run in the actual Illustro page's DevTools.
 * Adds no element, style, input interception, rendering change or fake input.
 * This observes DOM delivery, not Android/Chrome native input reception.
 * Export after a trial: copy(JSON.stringify(window.__illustroInputLossEvidence.stop(),null,2))
 */
(() => {
  'use strict';
  if (window.__illustroInputLossEvidence) throw Error('Recorder already installed; reload before a new trial.');
  const startedAt=performance.now(),capacity=50000,rows=new Array(capacity);
  const events=new WeakMap(),abort=new AbortController(),observers=[];
  let count=0,eventId=0,stoppedAt=null,frameId=0,timerId=0,stopTimer=0,lastTick=startedAt;
  const support={longtask:false,eventTiming:false};
  const record=(kind,details={})=>{if(stoppedAt===null)rows[count++%capacity]={at:performance.now(),kind,...details};};
  const label=node=>node instanceof Element?node.tagName.toLowerCase()+(node.id?'#'+node.id:''):node===window?'window':node===document?'document':'other';
  const point=t=>({id:t.identifier,x:t.clientX,y:t.clientY});
  const input=(stage,event)=>{
    let id=events.get(event);
    if(id===undefined){
      id=++eventId;events.set(event,id);
      const details={eventId:id,type:event.type,eventAt:event.timeStamp,isTrusted:event.isTrusted,
        target:label(event.target),path:event.composedPath().slice(0,16).map(label),
        defaultPrevented:event.defaultPrevented,cancelable:event.cancelable};
      if('pointerId' in event)Object.assign(details,{pointerId:event.pointerId,pointerType:event.pointerType,
        button:event.button,buttons:event.buttons,isPrimary:event.isPrimary,
        pressure:event.pressure,width:event.width,height:event.height,x:event.clientX,y:event.clientY});
      if('touches' in event)Object.assign(details,{touches:[...event.touches].map(point),changedTouches:[...event.changedTouches].map(point)});
      record('input',details);
    }
    record('delivery',{eventId:id,stage,type:event.type,defaultPrevented:event.defaultPrevented,eventPhase:event.eventPhase});
  };
  const types=['pointerdown','pointermove','pointerup','pointercancel','pointerover','pointerout',
    'pointerenter','pointerleave','gotpointercapture','lostpointercapture','touchstart','touchmove','touchend','touchcancel'];
  const surface=document.querySelector('#canvasArea .surface');
  for(const [target,name] of [[window,'window'],[document,'document'],[surface,'surface']]){
    if(!target)continue;
    for(const capture of [true,false])for(const type of types)
      target.addEventListener(type,e=>input(name+':'+(capture?'capture':'bubble'),e),{capture,passive:true,signal:abort.signal});
  }
  for(const type of ['visibilitychange','pagehide','pageshow','blur','focus'])
    window.addEventListener(type,()=>record(type,{visibility:document.visibilityState}),{capture:true,passive:true,signal:abort.signal});
  const status=document.querySelector('#status');
  if(status){
    const observer=new MutationObserver(()=>record('status-observed',{value:status.textContent}));
    observer.observe(status,{subtree:true,childList:true,characterData:true});observers.push(observer);
  }
  for(const type of ['longtask','event']){
    try{
      if(!PerformanceObserver.supportedEntryTypes.includes(type))continue;
      const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())
        record('performance',{entryType:entry.entryType,name:entry.name,start:entry.startTime,duration:entry.duration});});
      observer.observe(type==='event'?{type,durationThreshold:16,buffered:false}:{type,buffered:false});
      observers.push(observer);support[type==='longtask'?'longtask':'eventTiming']=true;
    }catch(error){record('observer-unavailable',{type,reason:String(error)});}
  }
  const frame=()=>{record('frame');if(stoppedAt===null)frameId=requestAnimationFrame(frame);};
  frameId=requestAnimationFrame(frame);
  timerId=setInterval(()=>{const now=performance.now();record('timer',{gap:now-lastTick});lastTick=now;},35);
  const metadata=()=>({origin:location.origin,path:location.pathname,
    selectedQuery:Object.fromEntries(['inputTrace','touchProbe','captureTouch','backend','qa'].map(k=>[k,new URLSearchParams(location.search).get(k)])),
    userAgent:navigator.userAgent,timeOrigin:performance.timeOrigin,startedAt,stoppedAt,now:performance.now(),
    support:{...support},surfaceAvailable:!!surface,commit:document.querySelector('#canvas')?.dataset.commit??null,
    iframes:[...document.querySelectorAll('iframe')].map(e=>({id:e.id,src:e.getAttribute('src')})),
    viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
    eventCount:count,capacity,overwritten:Math.max(0,count-capacity),
    clockNote:'DOM receipt time and browser event time, not a hardware contact timestamp.'});
  const snapshot=()=>({metadata:metadata(),events:count<=capacity?rows.slice(0,count):rows.slice(count%capacity).concat(rows.slice(0,count%capacity)),
    originalRecorder:window.__illustroInputFreezeTrace?.snapshot?.()??null});
  const stop=()=>{
    if(stoppedAt===null){record('stop');stoppedAt=performance.now();abort.abort();
      clearInterval(timerId);clearTimeout(stopTimer);cancelAnimationFrame(frameId);for(const observer of observers)observer.disconnect();}
    return snapshot();
  };
  window.__illustroInputLossEvidence={snapshot,stop,
    mark:label=>record('trial-mark',{label:String(label).slice(0,120)})};
  record('start',{scope:'DOM only; no input interception or added input surface'});
  stopTimer=setTimeout(stop,60000);
})();
