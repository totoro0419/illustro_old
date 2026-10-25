import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.RT_PLAYWRIGHT_PATH??'playwright');
const dir=path.resolve('apps/editor/dist');
const out=process.env.HIT_TEST_EVIDENCE??'/tmp/m10-input-freeze/hit-test.json';
await fs.mkdir(path.dirname(out),{recursive:true});
const srv=http.createServer(async(req,res)=>{
 try{
  const p=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const f=path.resolve(dir,'.'+(p==='/'?'/index.html':p));
  if(!f.startsWith(dir+path.sep))throw Error('outside dist');
  const bytes=await fs.readFile(f);
  res.setHeader('content-type',f.endsWith('.js')?'text/javascript':f.endsWith('.html')?'text/html':f.endsWith('.css')?'text/css':'application/octet-stream');res.end(bytes);
 }catch{res.writeHead(404).end();}
});
await new Promise(ok=>srv.listen(0,'127.0.0.1',ok));
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--use-vulkan=swiftshader','--disable-vulkan-surface','--enable-features=Vulkan']});
const results=[];
try{
 for(const backend of ['webgl2','webgpu']){
  const ctx=await browser.newContext({viewport:{width:1230,height:860},hasTouch:true,deviceScaleFactor:1});
  const page=await ctx.newPage();let errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.goto('http://127.0.0.1:'+srv.address().port+'/?qa=1&perf=1&inputTrace=1&backend='+backend+'&overlay=cpu');
  await page.evaluate(()=>{
   document.getElementById('newCanvasWidth').value='4000';
   document.getElementById('newCanvasHeight').value='4000';
   document.getElementById('new').click();
  });
  await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('描画できます'),null,{timeout:90000});
  await page.evaluate(()=>{
   const finger=document.getElementById('finger');finger.checked=true;finger.dispatchEvent(new Event('change'));
   document.body.dataset.qaLastPointerTarget='';
   window.__m10HitEvents=[];
   window.addEventListener('pointerdown',e=>{
    window.__m10HitEvents.push({at:performance.now(),target:e.target?.tagName+'.'+e.target?.className,
     path:e.composedPath().slice(0,7).map(n=>n.tagName? n.tagName+'.'+n.className:n.constructor?.name),
     pointer:e.pointerType,pointerId:e.pointerId});
   },{capture:true,passive:true});
  });
  const box=await page.locator('#canvas').evaluate(el=>{
   const r=el.closest('.surface').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};
  });
  const touch=(id,px,py)=>({id,x:box.x+box.width*px,y:box.y+box.height*py,radiusX:2,radiusY:2,force:.7});
  const snapshot=()=>page.evaluate(()=>{
   const s=document.querySelector('#canvasArea .surface');
   const rect=s.getBoundingClientRect();
   const points=[[.3,.25],[.5,.48],[.72,.65]];
   return points.map(([fx,fy])=>{
    const x=rect.x+rect.width*fx,y=rect.y+rect.height*fy;
    return {x,y,elements:document.elementsFromPoint(x,y).slice(0,9).map(el=>({
     tag:el.tagName,id:el.id,cls:typeof el.className==='string'?el.className:String(el.className?.baseVal??''),
     pointerEvents:getComputedStyle(el).pointerEvents,zIndex:getComputedStyle(el).zIndex,
     visible:getComputedStyle(el).visibility,display:getComputedStyle(el).display,
     inSurface:el===s||s.contains(el)
    }))};
   });
  });
  const idle=await snapshot();
  const cdp=await ctx.newCDPSession(page);
  await page.evaluate(()=>window.__illustroPerformance.probe().renderer.call('gate','formal'));
  try{
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch(10,.16,.4)]});
   for(let i=1;i<=42;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch(10,.16+.7*i/42,.4+.1*Math.sin(i/42*Math.PI))]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await page.waitForFunction(async()=> (await window.__illustroPerformance.probe().renderer.call('inspect')).gates.held==='formal',null,{timeout:60000});
   const pending=await snapshot();
   const t1=touch(20,.37,.59),t2=touch(21,.63,.59);
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[t1]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[t1,t2]});
   const events=await page.evaluate(()=>window.__m10HitEvents);
   const during=await snapshot();
   const probe=await page.evaluate(()=>window.__illustroInputFreezeTrace.snapshot());
   assert.equal(probe.touchCount,2,'two contact events delivered to global capture before formal GPU completes');
   assert.ok(events.filter(e=>e.pointer==='touch').length>=3,'captured pointer events for first drawing and next contacts');
   for(const [name,stack] of [['idle',idle],['pending',pending],['duringTouch',during]]){
    for(const point of stack){
     const top=point.elements[0];
     assert.ok(top.inSurface,backend+' '+name+' unexpected topmost element blocks surface: '+JSON.stringify(top));
     assert.ok(top.tag==='DIV'||top.tag==='CANVAS',backend+' '+name+' topmost hit target '+JSON.stringify(top));
     assert.ok(!['illustro-input-freeze-trace','qaSummary','cropOverlay'].includes(top.id),
       backend+' '+name+' input masked by debug/crop overlay');
    }
   }
   console.log('HIT_STACK_RESULT '+JSON.stringify({
    backend,
    idle:idle.map(p=>p.elements.slice(0,4)),
    pending:pending.map(p=>p.elements.slice(0,4)),
    during:during.map(p=>p.elements.slice(0,4)),
    nextContactTargets:events.slice(-3),
    touchCount:probe.touchCount
   }));
   results.push({backend,pass:true,idle,pending,during,events,probe:{
    touchCount:probe.touchCount,maxEventLag:probe.maxEventLag,maxTimerLag:probe.maxTimerLag},
    canvasCodeUnchanged:true,errors});
   await fs.writeFile(path.join(path.dirname(out),backend+'-formal-held-hit.png'),await page.screenshot({scale:'css'}));
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }finally{
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}).catch(()=>{});
   await page.evaluate(()=>window.__illustroPerformance.probe().renderer.call('gate',false)).catch(()=>{});
  }
  await page.evaluate(()=>window.__illustroPerformance.probe().renderer.drain());
  assert.deepEqual(errors,[],backend+' page error');
  await ctx.close();
 }
}finally{
 await fs.writeFile(out,JSON.stringify({basis:'PR49 canvas code + PR61 read-only diagnostics',
  limitation:'Browser-generated touches do not recreate hardware touch/compositor stalls on Android.',results},null,2));
 await browser.close();await new Promise(ok=>srv.close(ok));
}
