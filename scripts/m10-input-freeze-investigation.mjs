import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.RT_PLAYWRIGHT_PATH??'playwright');
const root=path.resolve('apps/editor/dist');
const output=process.env.TOUCH_TRACE_EVIDENCE??'/tmp/m10-input-freeze/report.json';
await fs.mkdir(path.dirname(output),{recursive:true});
const srv=http.createServer(async(req,res)=>{
 try{
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep))throw Error('outside root');
  const bytes=await fs.readFile(file);
  res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/octet-stream');
  res.end(bytes);
 }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--use-vulkan=swiftshader','--disable-vulkan-surface','--enable-features=Vulkan']});
const results=[];
function profileSummary(profile){
 const ids=new Map(profile.nodes.map(n=>[n.id,n]));
 const byName=new Map();
 const deltas=profile.timeDeltas??[];
 let micro=0;
 for(let i=0;i<(profile.samples??[]).length;i++){
  const node=ids.get(profile.samples[i]);if(!node)continue;
  const name=(node.callFrame.functionName||'(anonymous)')+
   '@'+(node.callFrame.url.split('/').pop()||'(inline)')+':'+node.callFrame.lineNumber;
  const d=deltas[i]??1000;
  micro+=d;byName.set(name,(byName.get(name)??0)+d);
 }
 return {sampledMs:Math.round(micro/1000),hotspots:[...byName].sort((a,b)=>b[1]-a[1]).slice(0,30).map(([functionName,total])=>({functionName,selfMs:Math.round(total/1000)}))};
}
try{
 for(const backend of ['webgl2','webgpu']){
  const ctx=await browser.newContext({viewport:{width:1280,height:860},deviceScaleFactor:1,hasTouch:true});
  const page=await ctx.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const cdp=await ctx.newCDPSession(page);
  await page.goto('http://127.0.0.1:'+srv.address().port+'/?qa=1&perf=1&inputTrace=1&backend='+backend+'&overlay=cpu');
  await page.evaluate(()=>{
   document.getElementById('newCanvasWidth').value='4000';
   document.getElementById('newCanvasHeight').value='4000';
   document.getElementById('new').click();
  });
  await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('描画できます'),null,{timeout:90000});
  await page.evaluate(()=>{
   const finger=document.getElementById('finger');finger.checked=true;finger.dispatchEvent(new Event('change'));
   const brush=document.getElementById('brush');brush.value='foundation-g-pen';brush.dispatchEvent(new Event('change'));
   const size=document.getElementById('size');size.value='230';size.dispatchEvent(new Event('input'));
  });
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:6});
  const rect=await page.locator('#canvas').evaluate(c=>{
   const r=c.closest('.surface').getBoundingClientRect();
   return {x:r.x,y:r.y,width:r.width,height:r.height};
  });
  const touch=(id,fx,fy)=>({id,x:rect.x+rect.width*fx,y:rect.y+rect.height*fy,radiusX:2,radiusY:2,force:.85});
  await cdp.send('Profiler.enable');await cdp.send('Profiler.start');
  await page.evaluate(()=>window.__illustroInputFreezeTrace.clear());
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch(21,.15,.42)]});
  const moves=120;
  for(let i=1;i<=moves;i++){
   const t=i/moves;
   await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch(21,.15+.7*t,.42+.18*Math.sin(3*Math.PI*t))]});
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  // Probe immediate contacts while a real 4000px wide heavy stroke is being
  // finalized. No artificial GPU gate is used in this investigation.
  const second=touch(22,.31,.69),third=touch(23,.64,.69);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[second]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[second,third]});
  const beforeStatus=await page.evaluate(()=>window.__illustroInputFreezeTrace.snapshot());
  await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('作品に反映しました'),null,{timeout:120000});
  const afterStatus=await page.evaluate(()=>window.__illustroInputFreezeTrace.snapshot());
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const {profile}=await cdp.send('Profiler.stop');await cdp.send('Profiler.disable');
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
  const interesting=['pointerup','touchstart','timer-stall','longtask','committed-ui','save-prepare','status-write','formal-confirmation'];
  const events=afterStatus.events.filter(x=>interesting.some(q=>x.kind.includes(q)));
  const up=events.find(x=>x.kind.includes('pointerup'));
  const confirmation=events.findLast(x=>x.kind==='formal-confirmation');
  const firstTouch=events.find(x=>x.kind==='touchstart'&&(!up||x.at>=up.at));
  const report={backend,canvas:'4000x4000',brush:'G-pen 230',cpuThrottle:6,
   firstTouchBeforeConfirmation:firstTouch&&confirmation?firstTouch.at<confirmation.at:null,
   times:{penUp:up?.at??null,firstTouch:firstTouch?.at??null,status:confirmation?.at??null,
    eventFromPenUp:firstTouch&&up?Number((firstTouch.at-up.at).toFixed(2)):null,
    statusFromPenUp:confirmation&&up?Number((confirmation.at-up.at).toFixed(2)):null},
   beforeStatus:{touchCount:beforeStatus.touchCount,touchStarts:beforeStatus.touchStarts,
    longestLongTask:beforeStatus.longestLongTask,maxTimerLag:beforeStatus.maxTimerLag,maxFrameGap:beforeStatus.maxFrameGap},
   afterStatus:{touchCount:afterStatus.touchCount,touchStarts:afterStatus.touchStarts,
    longestLongTask:afterStatus.longestLongTask,totalLongTasks:afterStatus.totalLongTasks,
    maxEventLag:afterStatus.maxEventLag,maxTimerLag:afterStatus.maxTimerLag,maxFrameGap:afterStatus.maxFrameGap},
   profile:profileSummary(profile),events,errors
  };
  results.push(report);
  await fs.writeFile(path.join(path.dirname(output),backend+'-trace.json'),JSON.stringify({beforeStatus,afterStatus},null,2));
  await fs.writeFile(path.join(path.dirname(output),backend+'.cpuprofile'),JSON.stringify(profile));
  await fs.writeFile(path.join(path.dirname(output),backend+'-final.png'),await page.screenshot({scale:'css'}));
  console.log('INPUT_FREEZE_REPORT '+JSON.stringify({backend,times:report.times,beforeStatus:report.beforeStatus,
    afterStatus:report.afterStatus,profile:report.profile,firstTouchBeforeConfirmation:report.firstTouchBeforeConfirmation,
    errors}));
  await ctx.close();
 }
}finally{
 await fs.writeFile(output,JSON.stringify({source:process.env.EXPECTED_COMMIT_SHA??'working tree',
  limitations:'Software Chromium with sixfold CPU throttling is NOT a physical Android GPU reproduction.',results},null,2));
 await browser.close();
 await new Promise(resolve=>srv.close(resolve));
}
