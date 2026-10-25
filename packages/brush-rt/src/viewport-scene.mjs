import {viewAffine} from '@rt/stroke-overlay';
import {StandbyPicture} from '@rt/standby-picture';

// Every artwork element (document groups, viewport bitmap and temporary ink)
// lives inside this single compositor-owned scene. Input stays on the parent.
export class ViewportScene {
 constructor(canvas){
  this.element=document.createElement('div');
  this.element.className='illustro-viewport-scene';
  Object.assign(this.element.style,{position:'relative',width:'100%',height:'100%',
   transformOrigin:'0 0',transform:'none',pointerEvents:'none',willChange:'transform'});
  canvas.before(this.element);this.element.append(canvas);this.baseView=null;
  this.standby=new StandbyPicture(this.element,canvas);
  this.inkPlane=document.createElement('div');this.inkPlane.className='illustro-ink-plane';
  this.inkPlane.setAttribute('aria-hidden','true');
  Object.assign(this.inkPlane.style,{position:'absolute',inset:'0',pointerEvents:'none',overflow:'visible'});
  this.element.append(this.inkPlane);
  this.mode='standby';
 }
 get active(){return this.baseView!==null;}
 setMode(mode){this.mode=mode;this.standby.setMode(mode);}
 refreshStandby(){this.standby.invalidate();}
 begin(view){if(!this.active&&view){this.baseView=Array.from(view);this.setMode('navigation');}}
 move(view){
  if(!this.active)return false;
  this.element.style.transform='matrix('+viewAffine(this.baseView,view).join(',')+')';return true;
 }
 complete(){this.element.style.transform='none';this.baseView=null;this.setMode('standby');}
 destroy(canvas){this.setMode('drawing');this.standby.destroy();this.baseView=null;this.element.style.transform='none';this.element.before(canvas);this.element.remove();}
}
