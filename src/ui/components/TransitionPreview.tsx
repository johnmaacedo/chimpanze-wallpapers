import { useEffect, useRef } from 'react';
import { Engine } from '../../wallpaper/engine';
import { useStore, TRANSITION_LIST } from '../api';

/**
 * Plays the real wallpaper shader between two images in a small canvas, so the
 * user sees exactly what will happen on the desktop.
 */
export function TransitionPreview({ a, b, transition, duration, easing, fit }: { a: string | null; b: string | null; transition: string; duration: number; easing: string; fit: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const { state } = useStore();
  const off = state?.config.global.transitionsOff || [];
  const intensity = state?.config.global.transitionIntensity ?? 1;
  const cfgRef = useRef({ transition, duration, easing, off });
  cfgRef.current = { transition, duration, easing, off };

  useEffect(() => {
    if (!ref.current) return;
    let engine: Engine;
    try { engine = new Engine(ref.current); } catch { return; }
    engine.reloadOnLoss = false;
    engineRef.current = engine;
    return () => { engine.destroy(); engineRef.current = null; };
  }, []);

  useEffect(() => { engineRef.current?.setSettings({ fit: fit as any, kenBurns: false, intensity }); }, [fit, intensity]);

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
      let name = c.transition;
      if (name === 'random' || name === 'randomSoft' || name === 'inherit') {
        // Same pool as the scheduler: "suave" = soft + motion, minus the ones turned off.
        let pool = TRANSITION_LIST.filter((t) => (name !== 'randomSoft' || t.cat === 'soft' || t.cat === 'motion') && !c.off.includes(t.id));
        if (!pool.length) pool = TRANSITION_LIST;
        name = pool[Math.floor(Math.random() * pool.length)].id;
      }
      engine.show({ url: pics[flip ? 1 : 0], type: 'image', transition: name, duration: c.duration, easing: c.easing, instant: false });
      timer = window.setTimeout(loop, c.duration + 1100);
    };
    let timer = window.setTimeout(loop, 500);
    return () => { alive = false; clearTimeout(timer); };
  }, [a, b, transition]);

  return <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block', borderRadius: 14 }} />;
}
