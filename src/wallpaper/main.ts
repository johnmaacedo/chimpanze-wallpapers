import { Engine, type ShowMsg } from './engine';

declare global {
  interface Window { cw: { invoke: (c: string, ...a: any[]) => Promise<any>; send: (c: string, ...a: any[]) => void; on: (c: string, cb: (p: any) => void) => () => void; platform: string } }
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const engine = new Engine(canvas);
engine.onFirstFrame = () => window.cw.send('wp:frame');
engine.onError = (m) => window.cw.send('wp:error', m);

window.cw.on('wp:show', (msg: ShowMsg) => { engine.show(msg); });
window.cw.on('wp:paused', (p: boolean) => engine.setPaused(!!p));
window.cw.on('wp:settings', (s: any) => engine.setSettings(s || {}));

// Compile the fallback transition, then tell main we are ready.
setTimeout(() => {
  engine.warmup(['fade']); // the rest compile on first use (few stay in GPU memory)
  window.cw.send('wp:ready');
}, 0);
