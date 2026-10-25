import {describe,it,expect} from 'vitest';
import {CanvasInteractionMode} from './canvasInteractionMode';

describe('Illustro foreground interactions',()=>{
  it('starts in standby and admits a drawing stroke',()=>{
    const mode=new CanvasInteractionMode();
    expect(mode.mode).toBe('standby');
    expect(mode.beginDrawing()).toBe(true);
    expect(mode.mode).toBe('drawing');
    expect(mode.beginNavigation()).toBe(false);
    expect(mode.mode).toBe('drawing');
    expect(mode.finishDrawing()).toBe(true);
    expect(mode.mode).toBe('standby');
  });

  it('enables navigation immediately after pen-up, without waiting for GPU completion',()=>{
    const mode=new CanvasInteractionMode();
    mode.beginDrawing();
    const gpuComplete=false;
    expect(mode.finishDrawing()).toBe(true);
    expect(gpuComplete).toBe(false);
    expect(mode.beginNavigation()).toBe(true);
    expect(mode.isNavigating).toBe(true);
    expect(mode.beginDrawing()).toBe(false);
    expect(mode.finishNavigation()).toBe(true);
    expect(mode.mode).toBe('standby');
  });

  it('keeps multiple new strokes available while earlier strokes finish asynchronously',()=>{
    const mode=new CanvasInteractionMode();
    mode.beginDrawing();
    mode.finishDrawing();
    const firstStrokeGpuStillPending=true;
    expect(firstStrokeGpuStillPending).toBe(true);
    expect(mode.beginDrawing()).toBe(true);
    expect(mode.finishDrawing()).toBe(true);
    expect(mode.beginNavigation()).toBe(true);
    expect(mode.finishNavigation()).toBe(true);
    expect(mode.mode).toBe('standby');
  });

  it('rejects simultaneous pen drawing and camera gestures in both directions',()=>{
    const mode=new CanvasInteractionMode();
    mode.beginNavigation();
    expect(mode.beginDrawing()).toBe(false);
    expect(mode.finishDrawing()).toBe(false);
    expect(mode.finishNavigation()).toBe(true);
    mode.beginDrawing();
    expect(mode.beginNavigation()).toBe(false);
    expect(mode.finishNavigation()).toBe(false);
    expect(mode.mode).toBe('drawing');
  });

  it('does not increment transitions for rejected or duplicate events',()=>{
    const mode=new CanvasInteractionMode();
    const revision=mode.generation;
    expect(mode.finishDrawing()).toBe(false);
    expect(mode.finishNavigation()).toBe(false);
    expect(mode.generation).toBe(revision);
    expect(mode.beginNavigation()).toBe(true);
    expect(mode.beginNavigation()).toBe(false);
    expect(mode.generation).toBe(revision+1);
  });
});
