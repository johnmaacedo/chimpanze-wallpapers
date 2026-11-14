import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Brush, Eraser, Undo2, RotateCcw, Check, X, Hand, Layers, Eye, WandSparkles } from 'lucide-react';
import { api, useStore } from '../api';
import { Btn, Segmented } from './controls';
import type { ImageDepthInfo } from './DepthImage';

type Tool = 'front' | 'back' | 'magic' | 'hand';
const TINT = [255, 181, 71];

/**
 * "Corrigir recorte à mão": the picture with the automatic cut tinted over it. Paint
 * with "Frente" what must move with the character (the character itself, a weapon,
 * a chair) and with "Fundo" what was caught by mistake. Saved with the wallpaper
 * and applied on top of any automatic cut, now and after "Refazer recorte".
 * Photoshop-like: wheel zooms, Ctrl/Space + drag moves, [ and ] change the brush.
 */
export function CutEditor({ file, onClose, onSaved }: { file: string; onClose: () => void; onSaved?: (i: ImageDepthInfo) => void }) {
  const { toast } = useStore();
  const wrap = useRef<HTMLDivElement>(null);
  const pic = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  // Offscreen layers at the working size: the automatic cut, what the user added and removed.
  const auto = useRef<HTMLCanvasElement | null>(null);
  const add = useRef<HTMLCanvasElement | null>(null);
  const rem = useRef<HTMLCanvasElement | null>(null);
  const undo = useRef<{ a: ImageData; r: ImageData }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [box, setBox] = useState({ w: 800, h: 500 });
  const [tool, setTool] = useState<Tool>('front');
  const [brush, setBrush] = useState(36);
  const [view, setView] = useState<'over' | 'cut'>('over');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [dirty, setDirty] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [held, setHeld] = useState(false);
  const [picking, setPicking] = useState(false);
  const drag = useRef<{ mode: 'paint' | 'pan'; x: number; y: number; p: { x: number; y: number }; last?: [number, number] } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await api.invoke<{ image: string; matte: string; fix: string | null } | null>('image:cut:get', file);
      if (!r) throw new Error('O modelo de recorte não está instalado.');
      const load = async (u: string) => createImageBitmap(await (await fetch(u)).blob(), { premultiplyAlpha: 'none' });
      const [img, dm, fx] = await Promise.all([load(r.image), load(r.matte), r.fix ? load(r.fix) : null]);
      if (!alive) return;
      const k = Math.min(1, 1280 / Math.max(img.width, img.height));
      const w = Math.round(img.width * k), h = Math.round(img.height * k);
      const mk = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
      const p = pic.current!; p.width = w; p.height = h; p.getContext('2d')!.drawImage(img, 0, 0, w, h);
      // Automatic cut: tint with alpha = matte (blue channel of the depth picture).
      const a = mk(); const ax = a.getContext('2d', { willReadFrequently: true })!;
      ax.drawImage(dm, 0, 0, w, h);
      const d = ax.getImageData(0, 0, w, h);
      for (let i = 0; i < w * h; i++) { const m = d.data[i * 4 + 2]; d.data[i * 4] = TINT[0]; d.data[i * 4 + 1] = TINT[1]; d.data[i * 4 + 2] = TINT[2]; d.data[i * 4 + 3] = m; }
      ax.putImageData(d, 0, 0);
      auto.current = a;
      const A = mk(), R = mk();
      if (fx) {
        // Saved corrections: R = front, G = background. The automatic cut already has them
        // baked in, so take them out of it first (the layers put them back).
        const t = mk(); const tx = t.getContext('2d', { willReadFrequently: true })!;
        tx.drawImage(fx, 0, 0, w, h);
        const f = tx.getImageData(0, 0, w, h);
        const ia = new ImageData(w, h), ir = new ImageData(w, h);
        for (let i = 0; i < w * h; i++) {
          ia.data[i * 4] = TINT[0]; ia.data[i * 4 + 1] = TINT[1]; ia.data[i * 4 + 2] = TINT[2]; ia.data[i * 4 + 3] = f.data[i * 4];
          ir.data[i * 4 + 3] = f.data[i * 4 + 1];
        }
        A.getContext('2d')!.putImageData(ia, 0, 0); R.getContext('2d')!.putImageData(ir, 0, 0);
      }
      add.current = A; rem.current = R;
      setSize({ w, h });
      setStatus('ready');
    })().catch((e) => { if (alive) { setStatus('error'); toast({ kind: 'error', title: 'Não consegui abrir o recorte', message: e.message }); } });
    return () => { alive = false; };
  }, [file]);

  const repaint = () => {
    const o = over.current; const a = auto.current; const A = add.current; const R = rem.current;
    if (!o || !a || !A || !R) return;
    if (o.width !== a.width) { o.width = a.width; o.height = a.height; }
    const x = o.getContext('2d')!;
    x.globalCompositeOperation = 'source-over';
    x.clearRect(0, 0, o.width, o.height);
    x.drawImage(a, 0, 0); x.drawImage(A, 0, 0);
    x.globalCompositeOperation = 'destination-out';
    x.drawImage(R, 0, 0);
    x.globalCompositeOperation = 'source-over';
  };
  useEffect(() => { if (status === 'ready') repaint(); }, [status, size]);

  // Picture rectangle fitted in the box.
  const fit = size.w ? Math.min(box.w / size.w, box.h / size.h) : 1;
  const vw = size.w * fit, vh = size.h * fit;
  const toPic = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = pic.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * size.w, ((e.clientY - r.top) / r.height) * size.h];
  };
  const stroke = (from: [number, number], to: [number, number]) => {
    const A = add.current!.getContext('2d')!; const R = rem.current!.getContext('2d')!;
    const r = brush / fit / zoom / 2;
    const line = (ctx: CanvasRenderingContext2D, op: GlobalCompositeOperation, color: string) => {
      ctx.globalCompositeOperation = op; ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = r * 2;
      ctx.beginPath(); ctx.moveTo(from[0], from[1]); ctx.lineTo(to[0], to[1]); ctx.stroke();
      ctx.beginPath(); ctx.arc(to[0], to[1], r, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    };
    const tint = `rgb(${TINT.join(',')})`;
    if (tool === 'front') { line(A, 'source-over', tint); line(R, 'destination-out', '#000'); }
    else { line(R, 'source-over', '#000'); line(A, 'destination-out', '#000'); }
    repaint();
  };
  /** Clique mágico: the whole object under the click goes to the front (or, with Alt, to the background). */
  const magic = async (p: [number, number], toBack: boolean) => {
    if (picking) return;
    setPicking(true);
    try {
      const r = await api.invoke<{ png: Uint8Array; share: number; score: number }>('image:cut:magic', file, [{ x: p[0] / size.w, y: p[1] / size.h, add: true }]);
      const bmp = await createImageBitmap(new Blob([r.png as any], { type: 'image/png' }));
      const c = document.createElement('canvas'); c.width = size.w; c.height = size.h;
      const x = c.getContext('2d', { willReadFrequently: true })!;
      x.drawImage(bmp, 0, 0, size.w, size.h);
      const d = x.getImageData(0, 0, size.w, size.h);
      for (let i = 0; i < size.w * size.h; i++) { const on = d.data[i * 4] > 96; d.data[i * 4] = TINT[0]; d.data[i * 4 + 1] = TINT[1]; d.data[i * 4 + 2] = TINT[2]; d.data[i * 4 + 3] = on ? 255 : 0; }
      x.putImageData(d, 0, 0);
      snapshot();
      const A = add.current!.getContext('2d')!; const R = rem.current!.getContext('2d')!;
      const [put, cut] = toBack ? [R, A] : [A, R];
      put.globalCompositeOperation = 'source-over'; put.drawImage(c, 0, 0);
      cut.globalCompositeOperation = 'destination-out'; cut.drawImage(c, 0, 0); cut.globalCompositeOperation = 'source-over';
      repaint(); setDirty(true);
      if (r.share > 0.85) toast({ kind: 'warn', title: 'Pegou quase a imagem toda', message: 'Desfaça (Ctrl+Z) e clique mais no meio do objeto.' });
    } catch (e: any) {
      toast({ kind: 'error', title: 'O clique mágico falhou', message: e.message });
    } finally { setPicking(false); }
  };
  const snapshot = () => {
    const A = add.current!, R = rem.current!;
    undo.current.push({ a: A.getContext('2d')!.getImageData(0, 0, A.width, A.height), r: R.getContext('2d')!.getImageData(0, 0, R.width, R.height) });
    if (undo.current.length > 20) undo.current.shift();
  };
  const doUndo = () => {
    const s = undo.current.pop();
    if (!s) return;
    add.current!.getContext('2d')!.putImageData(s.a, 0, 0); rem.current!.getContext('2d')!.putImageData(s.r, 0, 0);
    repaint();
  };
  const clearAll = () => {
    snapshot();
    for (const c of [add.current!, rem.current!]) c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    repaint(); setDirty(true);
  };
  const zoomAt = (z: number, cx: number, cy: number) => {
    z = Math.max(1, Math.min(12, z));
    const r = wrap.current!.getBoundingClientRect();
    const dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2);
    const f = z / zoom;
    setPan((p) => (z === 1 ? { x: 0, y: 0 } : { x: dx - (dx - p.x) * f, y: dy - (dy - p.y) * f }));
    setZoom(z);
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Control' || e.code === 'Space') { setHeld(true); if (e.code === 'Space') e.preventDefault(); }
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); doUndo(); }
      if (e.key === '[') setBrush((b) => Math.max(4, Math.round(b * 0.8)));
      if (e.key === ']') setBrush((b) => Math.min(300, Math.round(b * 1.25)));
      if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setZoom(1); setPan({ x: 0, y: 0 }); }
      if (!e.ctrlKey && e.key.toLowerCase() === 'b') setTool('front');
      if (!e.ctrlKey && e.key.toLowerCase() === 'e') setTool('back');
      if (!e.ctrlKey && e.key.toLowerCase() === 'w') setTool('magic');
    };
    const up = (e: KeyboardEvent) => { if (e.key === 'Control' || e.code === 'Space') setHeld(false); };
    window.addEventListener('keydown', down, true); window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); };
  });

  const save = async () => {
    setStatus('saving');
    try {
      const A = add.current!, R = rem.current!;
      const a = A.getContext('2d')!.getImageData(0, 0, A.width, A.height).data;
      const r = R.getContext('2d')!.getImageData(0, 0, R.width, R.height).data;
      const out = new ImageData(A.width, A.height);
      let any = false;
      for (let i = 0; i < A.width * A.height; i++) {
        out.data[i * 4] = a[i * 4 + 3]; out.data[i * 4 + 1] = r[i * 4 + 3]; out.data[i * 4 + 3] = 255;
        if (a[i * 4 + 3] > 8 || r[i * 4 + 3] > 8) any = true;
      }
      let bytes: Uint8Array | null = null;
      if (any) {
        const c = document.createElement('canvas'); c.width = A.width; c.height = A.height;
        c.getContext('2d')!.putImageData(out, 0, 0);
        const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('png'))), 'image/png'));
        bytes = new Uint8Array(await blob.arrayBuffer());
      }
      const info = await api.invoke<ImageDepthInfo>('image:cut:save', file, bytes);
      onSaved?.(info);
      toast({ kind: 'ok', title: any ? 'Recorte corrigido' : 'Correções removidas', message: 'O monitor que mostra esta imagem já usa o recorte novo.' });
      onClose();
    } catch (e: any) {
      setStatus('ready');
      toast({ kind: 'error', title: 'Não consegui salvar o recorte', message: e.message });
    }
  };

  const panning = held || tool === 'hand';
  return createPortal(
    <div className="cut-editor">
      <div className="cut-top">
        <b><Layers size={16} /> Corrigir o recorte à mão</b>
        <span className="muted small grow">Laranja = o que se move com a personagem. Pinte o que faltou com Frente e apague o que entrou sem querer com Fundo.</span>
        <Btn className="ghost" onClick={onClose}><X size={15} /> Cancelar</Btn>
        <Btn className="primary" disabled={status !== 'ready' || !dirty} onClick={save}><Check size={15} /> {status === 'saving' ? 'Refazendo a profundidade…' : 'Salvar recorte'}</Btn>
      </div>
      <div className="cut-body">
        <div className="cut-tools">
          <button className={tool === 'front' ? 'on' : ''} onClick={() => setTool('front')} title="Frente: personagem e objetos que se movem junto (B)"><Brush size={17} /><span>Frente</span></button>
          <button className={tool === 'back' ? 'on' : ''} onClick={() => setTool('back')} title="Fundo: apaga do recorte (E)"><Eraser size={17} /><span>Fundo</span></button>
          <button className={tool === 'magic' ? 'on' : ''} onClick={() => setTool('magic')} title="Clique mágico: clique num objeto e ele entra inteiro na Frente (com Alt, vai para o Fundo) (W)"><WandSparkles size={17} /><span>Mágico</span></button>
          <button className={tool === 'hand' ? 'on' : ''} onClick={() => setTool('hand')} title="Mover a imagem (ou segure Ctrl / Espaço)"><Hand size={17} /><span>Mover</span></button>
          <i />
          <button onClick={doUndo} title="Desfazer (Ctrl+Z)"><Undo2 size={17} /><span>Desfazer</span></button>
          <button onClick={clearAll} title="Apagar todas as minhas correções"><RotateCcw size={17} /><span>Limpar</span></button>
        </div>
        <div className="cut-stage" ref={wrap}
          onWheel={(e) => zoomAt(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY)}
          onPointerDown={(e) => {
            if (status !== 'ready' || e.button === 2) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            if (panning || e.button === 1) { drag.current = { mode: 'pan', x: e.clientX, y: e.clientY, p: pan }; return; }
            if (tool === 'magic') { magic(toPic(e), e.altKey); return; }
            snapshot();
            const p = toPic(e);
            drag.current = { mode: 'paint', x: e.clientX, y: e.clientY, p: pan, last: p };
            stroke(p, p); setDirty(true);
          }}
          onPointerMove={(e) => {
            const r = wrap.current!.getBoundingClientRect();
            setCursor({ x: e.clientX - r.left, y: e.clientY - r.top });
            const d = drag.current;
            if (!d) return;
            if (d.mode === 'pan') { if (zoom > 1) setPan({ x: d.p.x + e.clientX - d.x, y: d.p.y + e.clientY - d.y }); return; }
            const p = toPic(e);
            stroke(d.last!, p); d.last = p;
          }}
          onPointerUp={() => { drag.current = null; }}
          onPointerLeave={() => setCursor(null)}
          style={{ cursor: panning ? 'grab' : tool === 'magic' ? (picking ? 'progress' : 'crosshair') : 'none' }}>
          <div className="cut-canvas" style={{ width: vw, height: vh, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
            <canvas ref={pic} style={{ opacity: view === 'cut' ? 0.18 : 1 }} />
            <canvas ref={over} className="ov" style={{ opacity: view === 'cut' ? 1 : 0.55 }} />
          </div>
          {status === 'loading' && <div className="cut-wait">Preparando o recorte desta imagem…</div>}
          {status === 'saving' && <div className="cut-wait">Refazendo a profundidade com o seu recorte…</div>}
          {picking && <div className="cut-wait">Selecionando o objeto…</div>}
          {cursor && !panning && tool !== 'magic' && status === 'ready' && <div className={`cut-cursor ${tool}`} style={{ left: cursor.x, top: cursor.y, width: brush, height: brush }} />}
        </div>
        <div className="cut-side">
          <span className="label">Tamanho do pincel <b>{brush}px</b></span>
          <input type="range" min={4} max={300} step={1} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
          <span className="label"><Eye size={13} /> Ver como</span>
          <Segmented value={view} onChange={setView} options={[{ value: 'over', label: 'Por cima' }, { value: 'cut', label: 'Só o recorte' }]} />
          <div className="cut-keys small muted">
            <span><b>B</b> Frente</span><span><b>E</b> Fundo</span><span><b>W</b> Clique mágico (<b>Alt</b>+clique manda para o Fundo)</span><span><b>[ ]</b> pincel</span>
            <span><b>Ctrl</b>/<b>Espaço</b> + arrastar: mover</span><span><b>Roda</b>: zoom</span><span><b>Ctrl+Z</b> desfazer</span><span><b>Ctrl+0</b> ajustar</span>
          </div>
          <span className="small muted">As correções ficam salvas com este wallpaper e continuam valendo mesmo se você usar "Refazer recorte".</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
