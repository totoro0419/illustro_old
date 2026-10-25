import test from 'node:test';
import assert from 'node:assert/strict';
import {ViewportScene} from '../dist/rt/viewport-scene.mjs';
import {DocumentPresentation} from '../dist/rt/document-presentation.mjs';
import {DrawingHost} from '../dist/rt/drawing-host.mjs';

function fixture(){
 const prior=globalThis.document;
 const surface={children:[]};
 const make=kind=>({
  kind,style:{},children:[],parent:null,
  append(child){if(child.parent)child.parent.children.splice(child.parent.children.indexOf(child),1);child.parent=this;this.children.push(child);},
  before(child){const i=this.parent.children.indexOf(this);if(child.parent)child.parent.children.splice(child.parent.children.indexOf(child),1);child.parent=this.parent;this.parent.children.splice(i,0,child);},
  after(child){const i=this.parent.children.indexOf(this);if(child.parent)child.parent.children.splice(child.parent.children.indexOf(child),1);child.parent=this.parent;this.parent.children.splice(i+1,0,child);},
  remove(){if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;},
  setAttribute(){},
  getContext(){return {transferFromImageBitmap(){}};}
 });
 globalThis.document={createElement:make};
 const canvas=make('canvas');surface.children.push(canvas);canvas.parent=surface;
 canvas.offsetLeft=0;canvas.offsetTop=0;
 return {canvas,surface,restore(){if(prior===undefined)delete globalThis.document;else globalThis.document=prior;}};
}
const view=(dx=0,zoom=1,angle=0)=>[668,1220,334,610,4000,4000,zoom,angle,dx,0,1,1,0,0,0,0];

test('document background, viewport bitmap and temporary ink share exactly one moving scene',()=>{
 const f=fixture();
 try{
  const scene=new ViewportScene(f.canvas);
  const document=new DocumentPresentation(f.canvas,4000,4000);
  const ink=globalThis.document.createElement('canvas');scene.inkPlane.append(ink);
  assert.deepEqual(f.surface.children,[scene.element]);
  assert.deepEqual(scene.element.children,[document.element,f.canvas,scene.standby.front,scene.inkPlane]);
  assert.deepEqual(scene.inkPlane.children,[ink]);
  assert.equal(scene.standby.mode,'standby');
  scene.begin(view());scene.move(view(70,1.25,.12));
  assert.match(scene.element.style.transform,/^matrix\(/);
  const matrix=scene.element.style.transform.slice(7,-1).split(',').map(Number);
  assert.ok(Math.abs(matrix[0]-1.25*Math.cos(.12))<1e-8);
  assert.ok(Math.abs(matrix[1]-1.25*Math.sin(.12))<1e-8);
  scene.complete();assert.equal(scene.element.style.transform,'none');assert.equal(scene.standby.mode,'standby');
  ink.remove();document.destroy();scene.destroy(f.canvas);
  assert.deepEqual(f.surface.children,[f.canvas]);
 }finally{f.restore();}
});

test('fifty active-gesture view changes do not message either drawing or display worker',()=>{
 const calls=[],f=fixture();
 try{
  const scene=new ViewportScene(f.canvas),base=view();
  const host={backend:{viewTransform:base},viewportScene:scene,
   canvas:f.canvas,presentation:{postMessage(msg){calls.push(['display',msg.method]);}},
   send(method){calls.push(['draw',method]);},
   syncVisibility(){calls.push(['visibility']);},
   reproject(){calls.push(['reproject']);},
   onPresentation(){calls.push(['event']);}};
  DrawingHost.prototype.beginViewportNavigation.call(host);
  calls.length=0;
  for(let i=1;i<=50;i++)DrawingHost.prototype.setViewTransform.call(host,view(i*4,1+i*.01,i*.004));
  assert.equal(calls.filter(x=>x[0]==='draw'||x[0]==='display'||x[0]==='reproject').length,0);
  assert.equal(scene.active,true);
  assert.match(scene.element.style.transform,/^matrix\(/);
  DrawingHost.prototype.endViewportNavigation.call(host);
  assert.equal(scene.active,false);
  assert.equal(calls.filter(x=>x[0]==='display'&&x[1]==='view').length,1);
  assert.equal(calls.filter(x=>x[0]==='draw'&&x[1]==='view').length,1);
  assert.equal(calls.filter(x=>x[0]==='reproject').length,1);
  scene.destroy(f.canvas);
 }finally{f.restore();}
});
