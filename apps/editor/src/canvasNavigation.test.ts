import {describe,it,expect,vi} from 'vitest';
import {CanvasNavigation} from './canvasNavigation';
import {CanvasView} from './canvasView';

const p=(x:number,y:number)=>({x,y});
function setup(){
 const view=new CanvasView(4000,4000);view.resize(1000,700);
 let starts=0,changes=0,ends=0;
 const nav=new CanvasNavigation(view,()=>{starts++},()=>{changes++},()=>{ends++});
 return {view,nav,metrics:()=>({starts,changes,ends})};
}
describe('finger navigation is entirely independent from GPU stroke completion',()=>{
 it('never changes the view or display state merely when a finger is placed',()=>{
  const {view,nav,metrics}=setup(),before=view.state;
  nav.touchDown(41,p(300,300),false);
  nav.touchDown(42,p(600,300),false);
  expect(nav.touchCount).toBe(2);
  expect(nav.active).toBe(false);
  expect(view.state).toEqual(before);
  expect(metrics()).toEqual({starts:0,changes:0,ends:0});
 });
 it('filters subpixel touch jitter and starts only on intentional movement',()=>{
  const {view,nav,metrics}=setup(),before=view.state;
  nav.touchDown(41,p(300,300),false);nav.touchDown(42,p(600,300),false);
  nav.touchFrame([[41,p(300.2,300.2)],[42,p(600.3,300.1)]]);
  expect(nav.active).toBe(false);expect(view.state).toEqual(before);
  nav.touchFrame([[41,p(318,290)],[42,p(639,307)]]);
  expect(nav.active).toBe(true);
  expect(view.panX).not.toBe(before.panX);
  expect(view.zoom).not.toBe(before.zoom);
  expect(view.rotation).not.toBe(before.rotation);
  expect(metrics().starts).toBe(1);
  expect(metrics().changes).toBe(1);
  nav.touchUp(41);nav.touchUp(42);
  expect(nav.active).toBe(false);expect(metrics().ends).toBe(1);
 });
 it('prevents phantom active mode after a rejected gesture start',()=>{
  const view=new CanvasView(4000,4000);view.resize(1000,700);
  let allow=false;
  const nav=new CanvasNavigation(view,()=>{if(!allow)throw Error('drawing mode');},()=>{},()=>{});
  nav.touchDown(1,p(100,100),false);nav.touchDown(2,p(200,100),false);
  expect(()=>nav.touchFrame([[1,p(120,120)],[2,p(240,150)]])).toThrow('drawing mode');
  expect(nav.active).toBe(false);
  allow=true;
  expect(()=>nav.touchFrame([[1,p(122,125)],[2,p(248,153)]])).not.toThrow();
  expect(nav.active).toBe(true);
  nav.touchUp(1);nav.touchUp(2);expect(nav.active).toBe(false);
 });
 it('keeps single finger pan without a jump when finger drawing is disabled',()=>{
  const {view,nav,metrics}=setup(),before=view.state;
  nav.touchDown(10,p(450,340),true);
  nav.touchFrame([[10,p(450.7,340.4)]]);
  expect(view.state).toEqual(before);expect(nav.active).toBe(false);
  nav.touchFrame([[10,p(475,330)]]);
  expect(nav.active).toBe(true);
  expect(view.panX).toBeCloseTo(before.panX+25);
  expect(view.panY).toBeCloseTo(before.panY-10);
  expect(metrics().starts).toBe(1);
 });
});
