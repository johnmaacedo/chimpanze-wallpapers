import { useEffect, useRef } from 'react';
import { Engine } from '../../wallpaper/engine';
import { TRANSITION_NAMES } from '../../wallpaper/shaders';

/**
 * Plays the real wallpaper shader between two images in a small canvas, so the
 * user sees exactly what will happen on the desktop.
 */
export function TransitionPreview({ a, b, transition, duration, easing, fit }: { a: string | null; b: string | null; transition: string; duration: number; easing: string; fit: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const cfgRef = useRef({ transition, duration, easing });
  cfgRef.current = { transition, duration, easing };

  useEffect(() => {
    if (!ref.current) return;
    let engine: Engine;
    try { engine = new Engine(ref.current); } catch { return; }
    engine.reloadOnLoss = false;
    engineRef.current = engine;
    return () => { engine.destroy(); engineRef.current = null; };
  }, []);

  useEffect(() => { engineRef.current?.setSettings({ fit: fit as any, kenBurns: false }); }, [fit]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !a) return;
    let alive = true;
    let flip = false;
    const pics = [a, b || a];
    engine.show({ url: pics[0], type: 'image', transition: 'idle', duration: 0, easing: 'linear', instant: true });
    const loop = () => {
      if (!alive) return;
      flip = !flip;
      const c = cfgRef.current;
      const name = c.transition === 'random' || c.transition === 'inherit' ? TRANSITION_NAMES[Math.floor(Math.random() * TRANSITION_NAMES.length)] : c.transition;
      engine.show({ url: pics[flip ? 1 : 0], type: 'image', transition: name, duration: c.duration, easing: c.easing, instant: false });
      timer = window.setTimeout(loop, c.duration + 1100);
    };
    let timer = window.setTimeout(loop, 500);
    return () => { alive = false; clearTimeout(timer); };
  }, [a, b, transition]);

  return <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block', borderRadius: 14 }} />;
}
