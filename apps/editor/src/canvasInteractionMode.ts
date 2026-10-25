/** Exclusive foreground interaction state. GPU confirmation is deliberately NOT a mode. */
export type InteractionMode = 'standby'|'drawing'|'navigation';

export class CanvasInteractionMode {
  private current:InteractionMode='standby';
  private revision=0;
  get mode():InteractionMode{return this.current;}
  get generation(){return this.revision;}
  get isStandby(){return this.current==='standby';}
  get isDrawing(){return this.current==='drawing';}
  get isNavigating(){return this.current==='navigation';}

  beginDrawing():boolean{
    if(!this.isStandby)return false;
    this.current='drawing';this.revision++;return true;
  }
  finishDrawing():boolean{
    if(!this.isDrawing)return false;
    this.current='standby';this.revision++;return true;
  }
  beginNavigation():boolean{
    if(!this.isStandby)return false;
    this.current='navigation';this.revision++;return true;
  }
  finishNavigation():boolean{
    if(!this.isNavigating)return false;
    this.current='standby';this.revision++;return true;
  }
}
