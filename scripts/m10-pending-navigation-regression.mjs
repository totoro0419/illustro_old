import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.RT_PLAYWRIGHT_PATH??'playwright');
const root=path.resolve('apps/editor/dist');
const output=process.env.NAVIGATION_EVIDENCE??'/tmp/illustro-navigation/report.json';
await fs.mkdir(path.dirname(output),{recursive:true});
const server=http.createServer(async(req,res)=>{
 try{
  const route=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=path.resolve(root,'.'+(route==='/'?'/index.html':route));
  if(!file.startsWith(root+path.sep))throw Error('Outside build');
  const bytes=await fs.readFile(file);
  res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/octet-stream');
  res.end(bytes);
 }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--use-vulkan=swiftshader','--disable-vulkan-surface','--enable-features=Vulkan']});
const report={source:process.env.EXPECTED_COMMIT_SHA??'working-tree',scope:'Actual touch input while formal GPU completion is held. Software browser GPU, physical devices not tested.',results:[]};
try{
 for(const backend of ['webgl2','webgpu']){
  const context=await browser.newContext({viewport:{width:1250,height:870},deviceScaleFactor:1,hasTouch:true});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/?qa=1&perf=1&backend='+backend+'&overlay=cpu');
  await page.evaluate(()=>{
   document.getElementById('newCanvasWidth').value='3000';
   document.getElementById('newCanvasHeight').value='3000';
   document.getElementById('new').click();
  });
  await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('描画できます'),null,{timeout:90000});
  await page.evaluate(()=>{
   for(const id of ['qaPanel','canvasPerformance']){const e=document.getElementById(id);if(e)e.style.display='none';}
   const finger=document.getElementById('finger');finger.checked=true;finger.dispatchEvent(new Event('change'));
   const brush=document.getElementById('brush');brush.value='foundation-g-pen';brush.dispatchEvent(new Event('change'));
   const size=document.getElementById('size');size.value='180';size.dispatchEvent(new Event('input'));
   const color=document.getElementById('colorHex');color.value='#E74371';color.dispatchEvent(new Event('input'));color.dispatchEvent(new Event('change'));
  });
  const box=await page.locator('#canvas').evaluate(node=>{
   const r=node.closest('.surface').getBoundingClientRect();
   return {x:r.x,y:r.y,w:r.width,h:r.height};
  });
  const t=(id,fx,fy)=>({id,x:box.x+fx*box.w,y:box.y+fy*box.h,radiusX:2,radiusY:2,force:.7});
  const cdp=await context.newCDPSession(page);
  async function draw(id,fy){
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[t(id,.20,fy)]});
   for(let i=1;i<=35;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[t(id,.20+.56*i/35,fy+.015*Math.sin(i/35*Math.PI))]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }
  const state=()=>page.evaluate(()=>{
   const probe=window.__illustroPerformance.probe(),host=probe.renderer,v=host.backend.viewTransform,scene=document.querySelector('.illustro-viewport-scene');
   return {view:Array.from(v??[]),active:host.viewportScene.active,transform:scene.style.transform,strokes:probe.controller.committedStrokeCount,sessionId:probe.session.id,presentation:host.presentationVersion,docVersion:host.documentVersion,previewCount:host.layers.size,errors:host.errors};
  });
  // A settled stroke is already present before the next formal GPU job.
  await draw(11,.39);
  assert.equal(await page.locator('.surface').getAttribute('data-interaction-mode'),'standby',backend+' returns to standby immediately after input ends');
  await page.evaluate(async()=>{const probe=window.__illustroPerformance.probe();await probe.renderer.drain();});
  const seeded=await state();
  assert.ok(seeded.strokes>=1,backend+' seed stroke committed');
  await page.evaluate(()=>window.__illustroPerformance.probe().renderer.call('gate','formal'));
  await draw(12,.56);
  assert.equal(await page.locator('.surface').getAttribute('data-interaction-mode'),'standby',backend+' formal GPU pending does not block standby');
  await page.waitForFunction(async()=>{
   const r=window.__illustroPerformance.probe().renderer;
   return (await r.call('inspect')).gates.held==='formal';
  },null,{timeout:60000});
  const before=await state();
  assert.equal(before.active,false,'camera initially idle');
  assert.equal(before.strokes,seeded.strokes+1,'latest logical stroke accepted while formal GPU stalled');
  const first=t(71,.34,.48),second=t(72,.67,.48);
  let moving,endState,held;
  try{
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[first]});
   assert.equal(await page.locator('.surface').getAttribute('data-interaction-mode'),'drawing',backend+' first finger is drawing, never navigation simultaneously');
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[first,second]});
   assert.equal(await page.locator('.surface').getAttribute('data-interaction-mode'),'navigation',backend+' second finger transfers exclusive ownership to navigation');
   const start=await state();
   assert.equal(start.active,true,'second finger activates navigation immediately');
   const startGate=await page.evaluate(async()=> (await window.__illustroPerformance.probe().renderer.call('inspect')).gates);
   assert.equal(startGate.navigationHold,true,'drawing worker must be notified that a gesture owns the GPU presentation priority');
   // Pan, pinch and rotation from physical multi-point touch input; no worker
   // reply or deferred GPU completion is allowed in this step.
   for(let i=1;i<=7;i++){
    const n=i/7;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[
     {...first,x:first.x+58*n-26*n,y:first.y-20*n},
     {...second,x:second.x+58*n+26*n,y:second.y+29*n}
    ]});
   }
   moving=await state();
   const activeGate=await page.evaluate(async()=> (await window.__illustroPerformance.probe().renderer.call('inspect')).gates);
   held=activeGate.held;
   assert.equal(activeGate.navigationHold,true,'formal GPU work must remain suspended while camera is moving');
   assert.equal(held,'formal',backend+' formal work must still be blocked');
   assert.ok(moving.active,backend+' navigation remains active while formal is blocked');
   assert.ok(moving.transform.startsWith('matrix(')&&moving.transform!=='matrix(1,0,0,1,0,0)',backend+' scene transformed synchronously');
   assert.ok(Math.abs(moving.view[8]-before.view[8])>15,backend+' pan accepted without formal completion');
   assert.ok(Math.abs(moving.view[6]-before.view[6])>.002,backend+' pinch accepted without formal completion');
   assert.ok(Math.abs(moving.view[7]-before.view[7])>.02,backend+' rotation accepted without formal completion');
   assert.equal(moving.strokes,before.strokes,backend+' a two-finger gesture must not commit an accidental stroke');
   await fs.writeFile(path.join(path.dirname(output),backend+'-during-held-formal.png'),await page.screenshot({scale:'css'}));
  }finally{
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}).catch(()=>{});
   await page.evaluate(()=>window.__illustroPerformance.probe().renderer.call('gate',false)).catch(()=>{});
  }
  await page.evaluate(()=>window.__illustroPerformance.probe().renderer.drain());
  endState=await state();
  assert.equal(await page.locator('.surface').getAttribute('data-interaction-mode'),'standby',backend+' released gesture returns to standby independent of commit');
  const endGate=await page.evaluate(async()=> (await window.__illustroPerformance.probe().renderer.call('inspect')).gates);
  assert.equal(endGate.navigationHold,false,'drawing worker resumes exact formal publication after fingers release');
  assert.equal(endState.active,false,'navigation ended after fingers released');
  assert.equal(endState.strokes,before.strokes,'gesture added no stroke after completion');
  assert.deepEqual(errors,[],backend+' no uncaught browser exceptions');
  report.results.push({backend,seeded,before,moving,held,endState,errors,pass:true});
  await context.close();
 }
}finally{
 await fs.writeFile(output,JSON.stringify(report,null,2));
 await browser.close();
 await new Promise(resolve=>server.close(resolve));
}
