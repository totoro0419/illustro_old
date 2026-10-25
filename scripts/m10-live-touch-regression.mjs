import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.RT_PLAYWRIGHT_PATH??'playwright');
const root=path.resolve('apps/editor/dist');
const output=process.env.M10_LIVE_TOUCH_EVIDENCE??'/tmp/m10-live-touch/report.json';
await fs.mkdir(path.dirname(output),{recursive:true});
const server=http.createServer(async(req,res)=>{
 try{
  const route=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=path.resolve(root,'.'+(route==='/'?'/index.html':route));
  if(!file.startsWith(root+path.sep))throw Error('outside root');
  const bytes=await fs.readFile(file);
  res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/octet-stream');
  res.end(bytes);
 }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--use-vulkan=swiftshader','--disable-vulkan-surface','--enable-features=Vulkan']});
const report={commit:process.env.EXPECTED_COMMIT_SHA??'unknown',scope:'Real editor during formal stroke gate, two GPU backends. Synthetic browser touch, NOT physical Android.',results:[]};
try{
 for(const backend of ['webgl2','webgpu']){
  const ctx=await browser.newContext({viewport:{width:1280,height:850},deviceScaleFactor:1,hasTouch:true});
  const page=await ctx.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/?qa=1&perf=1&backend='+backend+'&overlay=cpu');
  await page.evaluate(()=>{
   document.getElementById('newCanvasWidth').value='4000';
   document.getElementById('newCanvasHeight').value='4000';
   document.getElementById('new').click();
  });
  await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('描画できます'),null,{timeout:90000});
  await page.evaluate(()=>{
   for(const id of ['qaPanel','canvasPerformance']){const el=document.getElementById(id);if(el)el.style.display='none';}
   const finger=document.getElementById('finger');finger.checked=true;finger.dispatchEvent(new Event('change'));
   const brush=document.getElementById('brush');brush.value='foundation-g-pen';brush.dispatchEvent(new Event('change'));
   const size=document.getElementById('size');size.value='230';size.dispatchEvent(new Event('input'));
   window.__m10Test={starts:0,points:0};
   window.addEventListener('touchstart',()=>window.__m10Test.starts++,{capture:true,passive:true});
   window.addEventListener('pointerdown',e=>{if(e.pointerType==='touch')window.__m10Test.points++;},{capture:true,passive:true});
  });
  const bounds=await page.locator('#canvas').evaluate(canvas=>{
   const rect=canvas.closest('.surface').getBoundingClientRect();
   return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
  });
  const touch=(id,x,y)=>({id,x:bounds.x+bounds.width*x,y:bounds.y+bounds.height*y,radiusX:2,radiusY:2,force:.7});
  const cdp=await ctx.newCDPSession(page);
  const renderer=()=>page.evaluate(()=>window.__illustroPerformance.probe().renderer.call('inspect'));
  const state=()=>page.evaluate(()=>{
   const surface=window.__illustroPerformance.probe();
   const host=surface.renderer;
   return {
    view:Array.from(host.backend.viewTransform??[]),
    active:host.viewportScene.active,
    matrix:host.viewportScene.element.style.transform,
    logicalStrokes:surface.controller.committedStrokeCount,
    touchEvents:window.__m10Test.starts,
    pointerEvents:window.__m10Test.points,
    temporaryLayers:host.layers.size,
    documentVersion:host.documentVersion,
    pendingGpu:surface.renderer.document?.jobs?.length??0,
    hostErrors:host.errors,
    inputFirst:host.inputFirstProbe
   };
  });
  await page.evaluate(()=>window.__illustroPerformance.probe().renderer.call('gate','formal'));
  let pending,afterGesture,completed,temporary;
  try{
   const first=touch(10,.2,.44);
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[first]});
   for(let i=1;i<=35;i++){
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch(10,.2+i*.54/35,.44+.03*Math.sin(i*Math.PI/35))]});
   }
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await page.waitForFunction(async()=>{
    const r=window.__illustroPerformance.probe().renderer;
    return (await r.call('inspect')).gates?.held==='formal';
   },null,{timeout:60000});
   pending=await state();
   assert.equal(pending.inputFirst,true,'cooperative presentation must run in ordinary app, not just QA mode');
   assert.ok(pending.logicalStrokes>=1,backend+' stroke recorded while GPU picture waits');
   assert.equal((await renderer()).gates.held,'formal',backend+' real formal work held');
   // This child deliberately intercepts bubbling events like a misplaced
   // artwork or preview layer. Capture on the fixed .surface must still work.
   await page.evaluate(()=>{
    const surface=document.querySelector('.surface');
    const child=document.createElement('div');
    child.id='m10-nested-artwork-target';
    Object.assign(child.style,{position:'absolute',inset:'0',zIndex:'70',pointerEvents:'auto',touchAction:'none',background:'transparent'});
    for(const type of ['pointerdown','pointermove','pointerup'])
     child.addEventListener(type,event=>event.stopPropagation());
    surface.append(child);
    const finger=document.getElementById('finger');
    finger.checked=false;finger.dispatchEvent(new Event('change'));
   });
   const a=touch(21,.34,.46),b=touch(22,.67,.48);
   const base=await state();
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a,b]});
   const active=await state();
   assert.equal(active.active,true,backend+' gesture begins while previous formal stroke is held');
   for(let i=1;i<=8;i++){
    const n=i/8;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[
     {...a,x:a.x+52*n-21*n,y:a.y-13*n},
     {...b,x:b.x+52*n+21*n,y:b.y+24*n}
    ]});
   }
   afterGesture=await state();
   assert.equal((await renderer()).gates.held,'formal',backend+' actual formal completion remains held while input works');
   assert.ok(afterGesture.active,backend+' navigation remains active with two fingers');
   assert.ok(afterGesture.touchEvents>=base.touchEvents+2,backend+' both touchstart events are delivered before formal completion');
   assert.ok(afterGesture.pointerEvents>=base.pointerEvents+2,backend+' pointerdown reaches input surface through nested artwork');
   assert.ok(Math.abs(afterGesture.view[8]-base.view[8])>10,backend+' pan applies during formal pending');
   assert.ok(Math.abs(afterGesture.view[6]-base.view[6])>0.001,backend+' pinch zoom applies during formal pending');
   assert.ok(Math.abs(afterGesture.view[7]-base.view[7])>0.01,backend+' rotation applies during formal pending');
   assert.notEqual(afterGesture.matrix,'none',backend+' scene transforms without waiting for worker');
   assert.equal(afterGesture.logicalStrokes,base.logicalStrokes,backend+' no accidental stroke during gesture');
   await fs.writeFile(path.join(path.dirname(output),backend+'-pending-input.png'),await page.screenshot({scale:'css'}));
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await page.evaluate(()=>document.getElementById('m10-nested-artwork-target').remove());
   assert.equal((await renderer()).gates.held,'formal',backend+' completed gesture did not ungate formal work');
   temporary=await state();
  }finally{
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}).catch(()=>{});
   await page.evaluate(()=>window.__illustroPerformance.probe().renderer.call('gate',false)).catch(()=>{});
  }
  await page.evaluate(()=>window.__illustroPerformance.probe().renderer.drain());
  completed=await state();
  assert.equal(completed.logicalStrokes,pending.logicalStrokes,backend+' finalized same stroke count');
  assert.equal(completed.active,false,backend+' exited navigation');
  assert.deepEqual(errors,[],backend+' no uncaught browser errors');
  report.results.push({backend,pending,afterGesture,temporary,completed,errors,passed:true});
  await ctx.close();
 }
}finally{
 await fs.writeFile(output,JSON.stringify(report,null,2));
 await browser.close();
 await new Promise(resolve=>server.close(resolve));
}
