/** Offline evidence audit. Does not import or modify the running editor. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=path.resolve(import.meta.dirname,'../../..');
const output=path.resolve(process.argv[2]??path.join(import.meta.dirname,'evidence'));
const revision='eeea860a1997bbe613af4e07601d78e0a39eeceb';
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const read=p=>execFileSync('git',['show',`${revision}:${p}`],{cwd:root,encoding:'utf8'});
const paths=['apps/editor/src/inputFreezeTrace.ts','apps/editor/src/main.ts',
 'apps/editor/src/brushSurface.ts','apps/editor/src/canvasNavigation.ts',
 'apps/editor/src/passiveTouchProbe.ts','apps/editor/src/isolatedTouchFrame.ts',
 'packages/brush-rt/src/drawing-host.mjs','packages/brush-rt/src/document-presentation.mjs',
 'packages/brush-rt/src/viewport-scene.mjs','scripts/m10-live-touch-regression.mjs',
 'packages/brush-rt/src/drawing.worker.mjs','packages/brush-rt/src/renderer.mjs'];
const sources=Object.fromEntries(paths.map(p=>[p,read(p)]));
const trace=sources[paths[0]],main=sources[paths[1]],brush=sources[paths[2]];
const position=(source,needle)=>{const at=source.indexOf(needle);assert.ok(at>=0,needle);return at;};
const checks=[
 {id:'capture-installed-before-editor-input',observed:position(main,'installInputFreezeTrace();')<position(main,'new BrushSurface(')},
 {id:'touch-navigation-precedes-brush-admission-guards',observed:position(brush,"if(e.pointerType==='touch'){")<position(brush,'const inputReason=')},
 {id:'pen-pointer-cleared-before-session-end',observed:position(brush,'const upAt=performance.now();this.pointer=null;')<position(brush,'const promise=session.end(')},
 {id:'formal-status-after-waitStroke',observed:/waitStroke\(ids\)\.then\(completion=>/.test(brush)&&brush.includes("'線を作品に反映しました。'")},
 {id:'window-touch-recorders-are-passive-capture',observed:trace.includes('const options={capture:true,passive:true}')},
 {id:'touchmove-not-added-to-event-log',observed:trace.includes("if(type!=='touchmove')recordInput(type,e,touchCount);")},
 {id:'pointermove-and-hover-not-registered-by-trace',observed:!trace.includes("'pointermove'")&&!trace.includes("'pointerout'")&&!trace.includes("'pointerleave'")},
 {id:'isolated-frame-requires-separate-query-option',observed:sources[paths[4]].includes("if(params.get('touchProbe')!=='1')return;")&&sources[paths[4]].includes("params.get('captureTouch')==='isolated'")},
 {id:'overlay-source-has-pointer-events-none',observed:sources[paths[6]].includes("element.className='illustro-stroke-overlay'")&&sources[paths[6]].includes("pointerEvents:'none'")},
 {id:'old-regression-adds-test-hit-target',observed:sources[paths[9]].includes("surface.append(child)")},
 {id:'old-regression-draws-with-synthetic-finger-input',observed:sources[paths[9]].includes('finger.checked=true')&&sources[paths[9]].includes("cdp.send('Input.dispatchTouchEvent'")&&!sources[paths[9]].includes("pointerType:'pen'")},
 {id:'worker-status-waits-for-picture-ack',observed:sources[paths[10]].includes("case 'waitStroke':{const result=await r.waitStroke(a);await settlePictures();return result;}")},
 {id:'post-release-deadline-selects-render-job-budget',observed:sources[paths[10]].includes('r.releaseInteractiveUntil=performance.now()+280')&&sources[paths[11]].includes('const interactiveFormal=this.tiledPresentation&&')&&sources[paths[11]].includes('interactiveFormal?1:idleBacklog?24')},
];
for(const check of checks)assert.equal(check.observed,true,check.id);

const executable=stripTypeScriptTypes(trace,{mode:'strip'}).replace('export function installInputFreezeTrace','function installInputFreezeTrace');
function environment(query='?inputTrace=1',observerSupported=true){
 let now=0,interval=null,frame=null,mutation=null,performanceCallback=null;
 const listeners=new Map(),elements=[];
 const element=()=>({style:{},textContent:'',setAttribute(){},addEventListener(){},append(){},focus(){},select(){}});
 const status=element();
 const window={addEventListener(type,callback,options){const rows=listeners.get(type)??[];rows.push({callback,options});listeners.set(type,rows);}};
 const context=vm.createContext({window,location:{search:query},URLSearchParams,
  performance:{now:()=>now,timeOrigin:0},
  document:{body:{append(e){elements.push(e);}},createElement:element,querySelector:s=>s==='#status'?status:null},
  MutationObserver:class {constructor(callback){mutation=callback;}observe(){}},
  PerformanceObserver:class {constructor(callback){if(!observerSupported)throw Error('unsupported');performanceCallback=callback;}observe(){}},
  setInterval:callback=>(interval=callback,1),requestAnimationFrame:callback=>(frame=callback,1),navigator:{}});
 const api=vm.runInContext(`${executable}\ninstallInputFreezeTrace();`,context);
 return {api,listeners,elements,setNow:n=>now=n,
  emit(type,extra={}){for(const row of listeners.get(type)??[])row.callback({timeStamp:now,...extra});},
  tick(){interval?.();},frame(){frame?.();},
  status(value){status.textContent=value;mutation?.();},
  performance(entry){performanceCallback?.({getEntries:()=>[entry]});}};
}
const experiments=[];
function observed(id,work){experiments.push({id,...work()});}
observed('disabled-without-opt-in',()=>{const e=environment('');assert.equal(e.api,null);assert.equal(e.listeners.size,0);assert.equal(e.elements.length,0);return {listenerCount:0,elementCount:0};});
observed('touchmove-delivered-without-a-log-row',()=>{
 const e=environment();e.setNow(100);e.emit('touchmove',{touches:[{},{}],changedTouches:[{}]});
 const s=e.api.snapshot();assert.equal(s.touchCount,2);assert.equal(s.events.length,0);
 return {touchCount:s.touchCount,loggedEvents:s.events.length,meaning:'A missing start/log row is not proof that every type of touch event was absent.'};
});
observed('pen-is-included-in-pointer-finger-counter',()=>{
 const e=environment();e.setNow(100);e.emit('pointerdown',{pointerType:'pen',pointerId:5});
 const s=e.api.snapshot();assert.equal(s.pointerTouches,1);assert.equal(s.touchCount,0);
 return {pointerTouches:s.pointerTouches,touchCount:s.touchCount,event:s.events[0]};
});
observed('pointer-motion-and-hover-have-no-recorder',()=>{
 const e=environment();for(const type of ['pointermove','pointerout','pointerleave'])assert.equal(e.listeners.has(type),false);
 return {registeredPointerTypes:[...e.listeners.keys()].filter(t=>t.startsWith('pointer'))};
});
observed('timer-and-frame-log-thresholds',()=>{
 const a=environment();a.setNow(79);a.tick();assert.equal(a.api.snapshot().events.length,0);
 const b=environment();b.setNow(80);b.tick();assert.equal(b.api.snapshot().events[0].kind,'timer-stall');
 const c=environment();c.setNow(100);c.frame();assert.equal(c.api.snapshot().events.length,0);
 const d=environment();d.setNow(101);d.frame();assert.equal(d.api.snapshot().events[0].kind,'frame-gap');
 return {timerIntervalMs:35,timerLoggedAtGapMs:80,frameLoggedOnlyAboveMs:100,
  meaning:'Absence of a log row is not a continuous heartbeat record.'};
});
observed('repeated-status-text-skips-formal-confirmation',()=>{
 const e=environment();for(const at of [100,200]){e.setNow(at);e.api.mark('status-write',{value:'線を作品に反映しました。'});e.status('線を作品に反映しました。');}
 const s=e.api.snapshot(),formal=s.events.filter(x=>x.kind==='formal-confirmation'),writes=s.events.filter(x=>x.kind==='status-write');
 assert.equal(formal.length,1);assert.equal(writes.length,2);assert.equal(s.statusTime,100);
 return {statusWrites:writes.length,formalRows:formal.length,statusTime:s.statusTime};
});
observed('longtask-arrival-is-not-task-start',()=>{
 const e=environment();e.setNow(500);e.performance({entryType:'longtask',startTime:190,duration:300});const row=e.api.snapshot().events[0];
 assert.equal(row.at,500);assert.equal(row.details.start,190);assert.equal(row.details.duration,300);
 return {row,taskInterval:[190,490],meaning:'Check overlap using details.start and duration, not only row.at.'};
});
observed('unsupported-performance-observer-is-silent',()=>{
 const e=environment('?inputTrace=1',false),s=e.api.snapshot();assert.equal(s.totalLongTasks,0);assert.equal(s.events.length,0);
 return {totalLongTasks:s.totalLongTasks,supportFlagInSnapshot:Object.hasOwn(s,'longtaskSupported')};
});
observed('bounded-log-has-no-dropped-record-counter',()=>{
 const e=environment();e.setNow(1);e.emit('touchstart',{touches:[{}],changedTouches:[{}]});
 for(let i=0;i<4000;i++){e.setNow(i+2);e.api.mark('audit-only-row');}
 const s=e.api.snapshot();assert.equal(s.events.length,4000);assert.equal(s.events.some(x=>x.kind==='touchstart'),false);assert.equal(s.touchCount,1);
 return {eventCount:s.events.length,touchCount:s.touchCount,hasStartRow:false,droppedCountInSnapshot:Object.hasOwn(s,'droppedEvents'),meaning:'A possible recorder limit, not evidence it happened in the user recording.'};
});
const fingerprints=paths.map(p=>({path:p,blob:git('rev-parse',`${revision}:${p}`),sha256:createHash('sha256').update(sources[p]).digest('hex'),bytes:Buffer.byteLength(sources[p])}));
const history=[['49','56'],['56','57'],['57','58'],['58','59'],['59','60'],['60','63']].map(([from,to])=>({from:Number(from),to:Number(to),files:git('diff','--name-only',`refs/investigation/pr${from}`,`refs/investigation/pr${to}`).split('\n').filter(Boolean)}));
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'source-audit.json'),JSON.stringify({scope:'Static source inspection. No Android device observation.',revision,fingerprints,checks,history},null,2)+'\n');
fs.writeFileSync(path.join(output,'recorder-audit.json'),JSON.stringify({scope:'Offline invocation of the exact PR64 logger with stand-in DOM and clocks. NOT browser/Android input or a reproduction of the symptom.',sourceBlob:fingerprints[0].blob,experiments,rootCauseIdentified:false},null,2)+'\n');

// Verify the optional new observer without running it in an editor or browser.
const capturePath=path.join(import.meta.dirname,'capture-dom.js'),captureSource=fs.readFileSync(capturePath,'utf8');
let captureNow=0,creates=0,mutationCallback=null,disconnected=0,nextTimer=0;
const timerCallbacks=new Map(),frameCallbacks=new Map(),subscriptions=[];
class AuditElement {constructor(tagName,id=''){this.tagName=tagName;this.id=id;}addEventListener(type,callback,options){subscriptions.push({target:this,type,callback,options});}}
const captureWindow=new AuditElement('WINDOW'),captureDocument=new AuditElement('DOCUMENT');
const captureSurface=new AuditElement('DIV'),captureStatus=new AuditElement('P');
const captureCanvas=new AuditElement('CANVAS');captureCanvas.dataset={commit:'offline-audit'};
captureDocument.querySelector=selector=>selector==='#canvasArea .surface'?captureSurface:selector==='#status'?captureStatus:selector==='#canvas'?captureCanvas:null;
captureDocument.querySelectorAll=()=>[];captureDocument.createElement=()=>{creates++;throw Error('Unexpected DOM creation');};
captureWindow.__illustroInputFreezeTrace={snapshot:()=>({scope:'stand-in existing recorder'})};
const captureContext=vm.createContext({window:captureWindow,document:captureDocument,Element:AuditElement,URLSearchParams,
 location:{origin:'https://example.invalid',pathname:'/audit/',search:'?inputTrace=1'},
 navigator:{userAgent:'offline-audit'},innerWidth:100,innerHeight:100,devicePixelRatio:1,
 performance:{now:()=>captureNow,timeOrigin:0},
 AbortController:class {constructor(){this.signal={};}abort(){for(let i=subscriptions.length-1;i>=0;i--)if(subscriptions[i].options.signal===this.signal)subscriptions.splice(i,1);}},
 MutationObserver:class {constructor(callback){mutationCallback=callback;}observe(){}disconnect(){disconnected++;}},
 PerformanceObserver:class {static supportedEntryTypes=[];},
 requestAnimationFrame:cb=>{const id=++nextTimer;frameCallbacks.set(id,cb);return id;},cancelAnimationFrame:id=>frameCallbacks.delete(id),
 setInterval:cb=>{const id=++nextTimer;timerCallbacks.set(id,cb);return id;},clearInterval:id=>timerCallbacks.delete(id),
 setTimeout:()=>++nextTimer,clearTimeout(){}});
vm.runInContext(captureSource,captureContext);
const captureApi=captureWindow.__illustroInputLossEvidence;
const event={type:'pointerdown',timeStamp:0,isTrusted:false,target:captureSurface,defaultPrevented:false,cancelable:true,
 pointerId:1,pointerType:'touch',button:0,buttons:1,isPrimary:true,pressure:.5,width:1,height:1,clientX:10,clientY:20,
 composedPath:()=>[captureSurface,captureDocument,captureWindow]};
for(const target of [captureWindow,captureDocument,captureSurface])for(const row of subscriptions.filter(r=>r.target===target&&r.type==='pointerdown'&&r.options.capture))row.callback(event);
for(const target of [captureSurface,captureDocument,captureWindow])for(const row of subscriptions.filter(r=>r.target===target&&r.type==='pointerdown'&&!r.options.capture))row.callback(event);
captureStatus.textContent='線を作品に反映しました。';mutationCallback();mutationCallback();
for(const now of [35,70]){captureNow=now;for(const cb of timerCallbacks.values())cb();}
const recorded=captureApi.stop();
assert.equal(recorded.events.filter(e=>e.kind==='input').length,1);
assert.equal(recorded.events.filter(e=>e.kind==='delivery').length,6);
assert.equal(recorded.events.filter(e=>e.kind==='status-observed').length,2);
assert.equal(recorded.events.filter(e=>e.kind==='timer').length,2);
assert.equal(creates,0);assert.equal(subscriptions.length,0);assert.equal(frameCallbacks.size,0);assert.equal(timerCallbacks.size,0);assert.equal(disconnected,1);
assert.equal(/\.preventDefault\(|\.stopPropagation\(|\.stopImmediatePropagation\(|\.setPointerCapture\(|\.createElement\(/.test(captureSource),false);
fs.writeFileSync(path.join(output,'capture-preparation-audit.json'),JSON.stringify({scope:'Offline recorder/cleanup check with stand-in event targets, NOT browser event propagation or Android execution.',sourceSha256:createHash('sha256').update(captureSource).digest('hex'),eventCopies:1,recordedDeliveryStages:6,repeatedStatusObservations:2,continuousTimerRows:2,createdElements:creates,listenersAfterStop:subscriptions.length,timersAfterStop:timerCallbacks.size,framesAfterStop:frameCallbacks.size,executesOnUserAndroid:false,rootCauseIdentified:false},null,2)+'\n');
console.log(JSON.stringify({staticObservations:checks.length,recorderExperiments:experiments.length,optionalRecorderAudit:'observed',rootCauseIdentified:false,output},null,2));
