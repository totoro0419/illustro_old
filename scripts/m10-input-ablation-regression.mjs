import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.RT_PLAYWRIGHT_PATH??'playwright');
const root=path.resolve('apps/editor/dist'),output=process.env.M10_ABLATION_EVIDENCE??'/tmp/m10-ablation/report.json';
await fs.mkdir(path.dirname(output),{recursive:true});
const server=http.createServer(async(req,res)=>{
 try{
  const p=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const f=path.resolve(root,'.'+(p==='/'?'/index.html':p));
  if(!f.startsWith(root+path.sep))throw Error('outside root');
  const b=await fs.readFile(f);
  res.setHeader('content-type',f.endsWith('.js')?'text/javascript':f.endsWith('.html')?'text/html':f.endsWith('.css')?'text/css':'application/octet-stream');res.end(b);
 }catch{res.writeHead(404).end();}
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--use-vulkan=swiftshader','--disable-vulkan-surface','--enable-features=Vulkan']});
const results=[];
try{
 for(const backend of ['webgl2','webgpu']){
  for(const mode of ['baseline','overlay','presentation','persistence']){
   const ctx=await browser.newContext({viewport:{width:1280,height:850},hasTouch:true,deviceScaleFactor:1});
   const page=await ctx.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:'+server.address().port+'/?qa=1&touchProbe=1&ablate='+mode+'&backend='+backend+'&perf=1&overlay=cpu');
   await page.evaluate(()=>{
    document.getElementById('newCanvasWidth').value='4000';
    document.getElementById('newCanvasHeight').value='4000';
    document.getElementById('new').click();
   });
   await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('描画できます'),null,{timeout:90000});
   await page.evaluate(()=>{
    const f=document.getElementById('finger');f.checked=true;f.dispatchEvent(new Event('change'));
    const brush=document.getElementById('brush');brush.value='foundation-g-pen';brush.dispatchEvent(new Event('change'));
    const size=document.getElementById('size');size.value='170';size.dispatchEvent(new Event('input'));
   });
   const host=await page.evaluate(()=>({
    mode:window.__illustroPerformance.probe().renderer.m10Mode??'baseline',
    observed:document.body.dataset.m10Ablation,
    panel:getComputedStyle(document.getElementById('m10-ablation-probe')).pointerEvents
   }));
   assert.equal(host.mode,mode==='baseline'?'baseline':mode,backend+' expected diagnostic mode');
   assert.equal(host.observed,mode);
   assert.equal(host.panel,'none','read-only counter may not intercept canvas touch input');
   const r=await page.locator('#canvas').evaluate(c=>{
    const r=c.closest('.surface').getBoundingClientRect();
    return {x:r.x,y:r.y,w:r.width,h:r.height};
   });
   const xy=(id,x,y)=>({id,x:r.x+r.w*x,y:r.y+r.h*y,radiusX:2,radiusY:2,force:.75});
   const cdp=await ctx.newCDPSession(page);
   const gate=mode!=='presentation';
   if(gate)await page.evaluate(()=>window.__illustroPerformance.probe().renderer.call('gate','formal'));
   try{
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[xy(10,.2,.44)]});
    for(let i=1;i<=22;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[xy(10,.2+i*.55/22,.44+.06*Math.sin(i/22*Math.PI))]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    // No completed GPU picture is necessary for this observation. We are
    // distinguishing only the presence of touch while the stroke is pending.
    if(gate)await page.waitForFunction(async()=>{
     return (await window.__illustroPerformance.probe().renderer.call('inspect')).gates.held==='formal';
    },null,{timeout:60000});
    const start=await page.evaluate(()=>window.__m10Ablation.snapshot());
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[xy(20,.38,.58)]});
    const one=await page.evaluate(()=>window.__m10Ablation.snapshot());
    assert.equal(one.count,1,backend+'/'+mode+' first touch count');
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[xy(20,.38,.58),xy(21,.62,.58)]});
    const two=await page.evaluate(()=>window.__m10Ablation.snapshot());
    assert.equal(two.count,2,backend+'/'+mode+' second touch count');
    if(mode==='presentation'){
     assert.equal(await page.evaluate(()=>window.__illustroPerformance.probe().renderer.m10PublicationPaused),true,
       backend+' publication-only ablation activates at pen release');
    }
    if(mode==='persistence'){
     assert.ok(two.records.some(r=>r.kind==='persistence-skipped'),backend+' persistence preparation is skipped');
    }
    await fs.writeFile(path.join(path.dirname(output),backend+'-'+mode+'-two-touch.png'),await page.screenshot({scale:'css'}));
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    const end=await page.evaluate(()=>window.__m10Ablation.snapshot());
    assert.equal(end.count,0);
    results.push({backend,mode,atPenUp:start,one:{count:one.count,latency:one.lastEventDelay},
      two:{count:two.count,latency:two.lastEventDelay},timerMax:two.largestPause,
      after:end.count,held:gate,errors});
    assert.deepEqual(errors,[],backend+'/'+mode+' browser errors');
   }finally{
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}).catch(()=>{});
    if(gate)await page.evaluate(()=>window.__illustroPerformance.probe().renderer.call('gate',false)).catch(()=>{});
   }
   await ctx.close();
  }
 }
 // A control page does not load the editor or GPU at all.
 const ctx=await browser.newContext({viewport:{width:900,height:750},hasTouch:true});
 const page=await ctx.newPage();
 const control=await fs.readFile('qa/m10-input-ablation/control.html','utf8');
 await page.setContent(control);
 const cdp=await ctx.newCDPSession(page);
 const rect=await page.locator('#pad').boundingBox();
 const point=(id,x)=>({id,x:rect.x+rect.width*x,y:rect.y+rect.height*.5,radiusX:2,radiusY:2,force:.65});
 const a=point(100,.32),b=point(101,.65);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a]});
 assert.match(await page.locator('#counter').textContent(),/1$/);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a,b]});
 assert.match(await page.locator('#counter').textContent(),/2$/);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 assert.match(await page.locator('#counter').textContent(),/0$/);
 results.push({mode:'control',counts:[1,2,0],pass:true});
 await ctx.close();
}finally{
 await fs.writeFile(output,JSON.stringify({base:'PR49 980eab54f7f2957b809ccaf6f8a0e1d0df1ae9a3',
  caveat:'Synthetic software-browser contacts do not reproduce real Android touch/compositor failures.',
  results},null,2));
 await browser.close();await new Promise(ok=>server.close(ok));
}
