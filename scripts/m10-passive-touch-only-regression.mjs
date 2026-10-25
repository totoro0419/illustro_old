import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.RT_PLAYWRIGHT_PATH??'playwright');
const dir=path.resolve('apps/editor/dist');
const evidence=process.env.PASSIVE_TOUCH_EVIDENCE??'/tmp/m10-passive-touch/report.json';
await fs.mkdir(path.dirname(evidence),{recursive:true});
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  const file=path.resolve(dir,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
  if(!file.startsWith(dir+path.sep))throw Error('outside dist');
  const data=await fs.readFile(file);
  res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');
  res.end(data);
 }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--use-vulkan=swiftshader','--disable-vulkan-surface','--enable-features=Vulkan']});
const results=[];
try{
 for(const backend of ['webgl2','webgpu']){
  const context=await browser.newContext({viewport:{width:1280,height:850},deviceScaleFactor:1,hasTouch:true});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/?qa=1&perf=1&backend='+backend+'&overlay=cpu&touchProbe=1');
  const inactive=await page.evaluate(()=>window.__illustroTouchProbe?.());
  assert.ok(inactive&&inactive.touchCount===0,'QA-only monitor must start with zero fingers');
  assert.equal(await page.locator('#illustro-passive-touch-probe').evaluate(node=>getComputedStyle(node).pointerEvents),'none','monitor must never catch pointer input');
  assert.equal(await page.locator('#illustro-passive-touch-probe').evaluate(node=>node.parentElement===document.body),true,'monitor must not alter artwork scene hierarchy');
  await page.evaluate(()=>{
   document.getElementById('newCanvasWidth').value='4000';
   document.getElementById('newCanvasHeight').value='4000';
   document.getElementById('new').click();
  });
  await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('描画できます'),null,{timeout:90000});
  await page.evaluate(()=>{
   for(const id of ['qaPanel','canvasPerformance']){
    const node=document.getElementById(id);if(node)node.style.display='none';
   }
   const finger=document.getElementById('finger');
   finger.checked=true;finger.dispatchEvent(new Event('change'));
   const brush=document.getElementById('brush');brush.value='foundation-g-pen';brush.dispatchEvent(new Event('change'));
  });
  const rect=await page.locator('#canvas').evaluate(node=>{
   const r=node.closest('.surface').getBoundingClientRect();
   return {x:r.x,y:r.y,w:r.width,h:r.height};
  });
  const touch=(id,fx,fy)=>({id,x:rect.x+rect.w*fx,y:rect.y+rect.h*fy,radiusX:2,radiusY:2,force:.7});
  const cdp=await context.newCDPSession(page);
  const first=touch(22,.28,.40),second=touch(23,.71,.58);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[first]});
  const one=await page.evaluate(()=>window.__illustroTouchProbe());
  assert.equal(one.touchCount,1,backend+' actual first TouchEvent reaches global capture listener');
  assert.equal(one.onCanvas,1,backend+' contact within canvas viewport recognized');
  assert.equal(one.touchStarts,1,backend+' one touchstart reported');
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[first,second]});
  const two=await page.evaluate(()=>window.__illustroTouchProbe());
  assert.equal(two.touchCount,2,backend+' both fingers recognized');
  assert.equal(two.onCanvas,2,backend+' both contacts are inside viewport');
  assert.equal(two.touchStarts,2,backend+' start counter increments for each contact');
  assert.match(await page.locator('#illustro-passive-touch-probe').textContent(),/Touch実数: 2/);
  await fs.writeFile(path.join(path.dirname(evidence),backend+'-two-fingers.png'),await page.screenshot({scale:'css'}));
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const after=await page.evaluate(()=>window.__illustroTouchProbe());
  assert.equal(after.touchCount,0,backend+' two fingers released');
  assert.equal(after.touchEnds,2,backend+' both touch endings counted');

  // Confirm formal GPU completion can be held while the *unchanged* base
  // canvas continues receiving new TouchEvents through the passive monitor.
  const renderer=()=>page.evaluate(()=>window.__illustroPerformance.probe().renderer.call('inspect'));
  await page.evaluate(()=>window.__illustroPerformance.probe().renderer.call('gate','formal'));
  let held=false,during;
  try{
   const longPoint=id=>touch(id,.28,.42);
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[longPoint(31)]});
   for(let i=1;i<=26;i++)await cdp.send('Input.dispatchTouchEvent',{
    type:'touchMove',touchPoints:[touch(31,.28+.5*i/26,.42+.08*Math.sin(i/26*Math.PI))]
   });
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await page.waitForFunction(async()=>{
    const state=await window.__illustroPerformance.probe().renderer.call('inspect');
    return state.gates.held==='formal';
   },null,{timeout:60000});
   held=true;
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[first]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[first,second]});
   during=await page.evaluate(()=>window.__illustroTouchProbe());
   assert.equal(during.touchCount,2,backend+' touches still detected while GPU formal gate held');
   assert.equal(during.onCanvas,2,backend+' held GPU does not block viewport contact observation in software browser');
   assert.equal((await renderer()).gates.held,'formal');
   await fs.writeFile(path.join(path.dirname(evidence),backend+'-gpu-held-two-fingers.png'),await page.screenshot({scale:'css'}));
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   // EXPLICIT independent touch capture owns a dedicated hit surface. This
   // tests the exact mode offered to mobile users, not a passive observer.
   await page.evaluate(()=>window.__illustroTouchProbeDirect(true));
   assert.equal(await page.locator('#illustro-direct-touch-layer').evaluate(e=>getComputedStyle(e).pointerEvents),'auto');
   assert.equal(await page.locator('#illustro-direct-touch-layer').evaluate(e=>getComputedStyle(e).touchAction),'none');
   assert.equal(await page.locator('#illustro-direct-touch-layer').getAttribute('data-contact-count'),'0');
   const originalView=await page.evaluate(()=>Array.from(window.__illustroPerformance.probe().renderer.backend.viewTransform));
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[first]});
   const directOne=await page.evaluate(()=>window.__illustroTouchProbe());
   assert.equal(directOne.combined,1,backend+' dedicated input plane must count a finger during formal GPU gate');
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[first,second]});
   const directTwo=await page.evaluate(()=>window.__illustroTouchProbe());
   assert.equal(directTwo.combined,2,backend+' dedicated input plane must count two fingers during formal GPU gate');
   assert.equal(directTwo.onCanvas,2,backend+' both contacts must map into the canvas');
   assert.equal(await page.locator('#illustro-direct-touch-layer').getAttribute('data-contact-count'),'2');
   assert.match(await page.locator('#illustro-passive-touch-probe').textContent(),/Touch実数: 2/);
   assert.deepEqual(await page.evaluate(()=>Array.from(window.__illustroPerformance.probe().renderer.backend.viewTransform)),originalView,
     backend+' test pad must not alter camera navigation or drawing');
   await fs.writeFile(path.join(path.dirname(evidence),backend+'-dedicated-two-fingers.png'),await page.screenshot({scale:'css'}));
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   assert.equal((await page.evaluate(()=>window.__illustroTouchProbe())).combined,0,backend+' release returns to zero');
   await page.evaluate(()=>window.__illustroTouchProbeDirect(false));
   assert.equal(await page.locator('#illustro-direct-touch-layer').evaluate(e=>getComputedStyle(e).display),'none');
  }finally{
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}).catch(()=>{});
   await page.evaluate(()=>window.__illustroPerformance.probe().renderer.call('gate',false)).catch(()=>{});
  }
  await page.evaluate(()=>window.__illustroPerformance.probe().renderer.drain());
  assert.deepEqual(errors,[],backend+' no browser exceptions');
  results.push({backend,one,two,after,held,during,directCaptureVerified:true,errors,pass:true});
  await context.close();
 }
 // Dedicated detector also works without loading Illustro or its GPU.
 const independent=await browser.newContext({viewport:{width:900,height:750},hasTouch:true});
 const independentPage=await independent.newPage();
 await independentPage.setContent(await fs.readFile('qa/m10-direct-touch/index.html','utf8'));
 const standalonePad=await independentPage.locator('#pad').boundingBox();
 assert.ok(standalonePad,'independent touch pad is visible');
 const standaloneCdp=await independent.newCDPSession(independentPage);
 const cp=(id,fx)=>({id,x:standalonePad.x+standalonePad.width*fx,
   y:standalonePad.y+standalonePad.height*.55,radiusX:2,radiusY:2,force:.7});
 const standaloneFirst=cp(91,.35),standaloneSecond=cp(92,.65);
 await standaloneCdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[standaloneFirst]});
 assert.equal(await independentPage.locator('#count').textContent(),'1','standalone detector: one finger');
 await standaloneCdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[standaloneFirst,standaloneSecond]});
 assert.equal(await independentPage.locator('#count').textContent(),'2','standalone detector: two fingers');
 await fs.writeFile(path.join(path.dirname(evidence),'standalone-two-fingers.png'),
    await independentPage.screenshot({scale:'css'}));
 await standaloneCdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 assert.equal(await independentPage.locator('#count').textContent(),'0','standalone detector: fingers lifted');
 await independent.close();

 const control=await browser.newContext({viewport:{width:900,height:600},hasTouch:true});
 const directPage=await control.newPage();
 await directPage.goto('http://127.0.0.1:'+server.address().port+'/?qa=1&touchProbe=1&captureTouch=1');
 assert.equal(await directPage.evaluate(()=>window.__illustroTouchProbe?.().directEnabled),true,
   'direct detection must start armed when explicitly requested');
 await directPage.close();
 const noProbe=await control.newPage();
 await noProbe.goto('http://127.0.0.1:'+server.address().port+'/?qa=1&touchProbe=0');
 assert.equal(await noProbe.evaluate(()=>typeof window.__illustroTouchProbe),'undefined','touch monitor must be absent unless explicitly enabled');
 assert.equal(await noProbe.locator('#illustro-passive-touch-probe').count(),0,'no probe UI in default editor');
 await control.close();
}finally{
 await fs.writeFile(evidence,JSON.stringify({base:'PR #49 980eab54f7f2957b809ccaf6f8a0e1d0df1ae9a3',source:process.env.EXPECTED_COMMIT_SHA??'working tree',results},null,2));
 await browser.close();
 await new Promise(resolve=>server.close(resolve));
}
