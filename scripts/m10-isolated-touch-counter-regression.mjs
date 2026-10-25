import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.RT_PLAYWRIGHT_PATH??'playwright');
const root=path.resolve('apps/editor/dist'),out=process.env.ISOLATED_TOUCH_EVIDENCE??'/tmp/m10-isolated-counter/report.json';
await fs.mkdir(path.dirname(out),{recursive:true});
const server=http.createServer(async(req,res)=>{
 try{
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep))throw Error('outside dist');
  const data=await fs.readFile(file);
  res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');
  res.end(data);
 }catch{res.writeHead(404).end();}
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--use-vulkan=swiftshader','--disable-vulkan-surface','--enable-features=Vulkan']});
const results=[];
try{
 for(const backend of ['webgl2','webgpu']){
  const ctx=await browser.newContext({viewport:{width:1250,height:850},hasTouch:true});
  const page=await ctx.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/?qa=1&perf=1&backend='+backend+'&touchProbe=1&captureTouch=isolated');
  const frame=page.frameLocator('#illustro-independent-counter-frame');
  await frame.locator('#count').waitFor({timeout:45000});
  assert.equal(await page.locator('#illustro-independent-counter-frame').getAttribute('sandbox'),'allow-scripts',
   'contact counter must execute in sandboxed separate document');
  await page.evaluate(()=>{
   document.getElementById('newCanvasWidth').value='4000';
   document.getElementById('newCanvasHeight').value='4000';
   document.getElementById('new').click();
  });
  await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('描画できます'),null,{timeout:90000});
  await page.evaluate(()=>{
   const f=document.getElementById('finger');f.checked=true;f.dispatchEvent(new Event('change'));
   const brush=document.getElementById('brush');brush.value='foundation-g-pen';brush.dispatchEvent(new Event('change'));
   document.getElementById('size').value='140';document.getElementById('size').dispatchEvent(new Event('input'));
  });
  const box=await page.locator('#canvas').evaluate(c=>{
   const r=c.closest('.surface').getBoundingClientRect();
   return {x:r.x,y:r.y,w:r.width,h:r.height};
  });
  const t=(id,x,y)=>({id,x:box.x+x*box.w,y:box.y+y*box.h,radiusX:2,radiusY:2,force:.8});
  const cdp=await ctx.newCDPSession(page);
  await page.evaluate(()=>window.__illustroPerformance.probe().renderer.call('gate','formal'));
  try{
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[t(10,.2,.45)]});
   for(let i=1;i<=30;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[t(10,.2+i*.5/30,.45+.01*Math.sin(i/30*Math.PI))]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await page.waitForFunction(()=>window.__illustroIsolatedTouchFrame?.().armed===true,null,{timeout:30000});
   await page.waitForFunction(async()=>{
    const r=window.__illustroPerformance.probe().renderer;
    return (await r.call('inspect')).gates.held==='formal';
   },null,{timeout:60000});
   const before=await page.evaluate(()=>Array.from(window.__illustroPerformance.probe().renderer.backend.viewTransform));
   const r=await page.locator('#illustro-independent-counter-frame').boundingBox();
   assert.ok(r?.width>100&&r?.height>100);
   const c=(id,x)=>({id,x:r.x+r.width*x,y:r.y+r.height*.56,radiusX:2,radiusY:2,force:.7});
   const one=c(51,.33),two=c(52,.67);
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[one]});
   assert.equal(await frame.locator('#count').textContent(),'1',backend+' isolated contact recognizes one finger with GPU formal held');
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[one,two]});
   assert.equal(await frame.locator('#count').textContent(),'2',backend+' isolated contact recognizes two fingers with GPU formal held');
   assert.equal((await page.evaluate(()=>window.__illustroPerformance.probe().renderer.call('inspect'))).gates.held,'formal');
   assert.deepEqual(await page.evaluate(()=>Array.from(window.__illustroPerformance.probe().renderer.backend.viewTransform)),before);
   await fs.writeFile(path.join(path.dirname(out),backend+'-two-fingers-before-formal.png'),await page.screenshot({scale:'css'}));
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   assert.equal(await frame.locator('#count').textContent(),'0',backend+' touching ended');
  }finally{
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}).catch(()=>{});
   await page.evaluate(()=>window.__illustroPerformance.probe().renderer.call('gate',false)).catch(()=>{});
  }
  await page.evaluate(()=>window.__illustroPerformance.probe().renderer.drain());
  await page.evaluate(()=>window.__illustroIsolatedTouchFrameArm(false));
  assert.equal(await page.locator('#illustro-independent-counter-frame').evaluate(e=>getComputedStyle(e).pointerEvents),'none');
  assert.deepEqual(errors,[]);
  results.push({backend,isolated:true,formalHeld:true,one:true,two:true,zero:true,errors});
  await ctx.close();
 }
}finally{
 await fs.writeFile(out,JSON.stringify({source:process.env.EXPECTED_COMMIT_SHA??'working-tree',results},null,2));
 await browser.close();await new Promise(ok=>server.close(ok));
}
