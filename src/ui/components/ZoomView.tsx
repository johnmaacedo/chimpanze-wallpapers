import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ZoomIn, ZoomOut, Scan, Maximize, Expand, Shrink } from 'lucide-react';

/**
 * The app's image viewer (Upscale, Galeria, results), with Photoshop-like controls:
 * wheel zooms at the cursor; dragging pans (left button, middle button, or with
 * Ctrl / Space held); double click toggles fit / 100%; Ctrl+0 fits, Ctrl+1 is
 * 100%, Ctrl+Plus / Ctrl+Minus zoom; F fills the whole app window, Esc leaves.
 * With `after`, a draggable bar compares the two images.
 */
export function ZoomView({ before, after, labels = ['Antes', 'Depois'], minHeight = 360, className = '' }: {
  before: string; after?: string | null; labels?: [string, string]; minHeight?: number | string; className?: string;
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [cut, setCut] = useState(50);
  const [full, setFull] = useState(false);
  const hover = useRef(false);
  const drag = useRef<{ x: number; y: number; t: { x: number; y: number }; mode: 'cut' | 'pan' } | null>(null);

  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [before, full]);

  // Image rectangle when fitted ("contain") in the box.
  const fit = (() => {
    if (!natural.w || !box.w) return { x: 0, y: 0, w: box.w, h: box.h };
    const s = Math.min(box.w / natural.w, box.h / natural.h);
    const w = natural.w * s; const h = natural.h * s;
    return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h };
  })();
  const fitScale = natural.w ? fit.w / natural.w : 1;

  // Keeps the zoomed image from being dragged far away from the box.
  const clampPan = useCallback((p: { x: number; y: number }, z: number) => {
    const w = fit.w * z; const h = fit.h * z;
    const minX = Math.min(0, box.w - (fit.x + w)) - 40; const maxX = Math.max(0, -fit.x) + 40;
    const minY = Math.min(0, box.h - (fit.y + h)) - 40; const maxY = Math.max(0, -fit.y) + 40;
    return { x: Math.max(minX, Math.min(maxX, p.x)), y: Math.max(minY, Math.min(maxY, p.y)) };
  }, [fit.w, fit.h, fit.x, fit.y, box.w, box.h]);

  /** Zoom to `z`, keeping the point (cx, cy) of the box still. */
  const zoomTo = (z: number, cx: number, cy: number) => {
    z = Math.max(1, Math.min(natural.w ? Math.max(8, 4 / fitScale) : 8, z));
    const ix = (cx - fit.x - pan.x) / zoom;
    const iy = (cy - fit.y - pan.y) / zoom;
    const p = { x: cx - fit.x - ix * z, y: cy - fit.y - iy * z };
    setZoom(z);
    setPan(z === 1 ? { x: 0, y: 0 } : clampPan(p, z));
  };
  const onWheel = (e: React.WheelEvent) => {
    const r = el!.getBoundingClientRect();
    zoomTo(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  };
  const centre = () => ({ x: box.w / 2, y: box.h / 2 });
  const actualSize = () => { const c = centre(); zoomTo(1 / fitScale, c.x, c.y); };
  const reset = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  // Keyboard: only for the viewer under the mouse (or the one filling the window).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!full && !hover.current) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const c = centre();
      let used = true;
      if (ctrl && e.key === '0') reset();
      else if (ctrl && e.key === '1') actualSize();
      else if (ctrl && (e.key === '+' || e.key === '=')) zoomTo(zoom * 1.5, c.x, c.y);
      else if (ctrl && e.key === '-') zoomTo(zoom / 1.5, c.x, c.y);
      else if (!ctrl && !e.altKey && e.key.toLowerCase() === 'f') setFull((v) => !v);
      else if (full && e.key === 'Escape') setFull(false);
      else used = false;
      if (used) { e.preventDefault(); e.stopPropagation(); }
    };
    // Capture phase: Esc leaves the full view before a dialog behind it closes.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const img = (src: string) => (
    <img
      src={src}
      alt=""
      draggable={false}
      onLoad={(e) => { const i = e.currentTarget; if (src === before) setNatural({ w: i.naturalWidth, h: i.naturalHeight }); }}
      style={{
        position: 'absolute', left: fit.x, top: fit.y, width: fit.w, height: fit.h,
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0',
        // Past ~250% show real pixels instead of a blurry interpolation.
        imageRendering: zoom / (fitScale || 1) > 2.5 ? 'pixelated' : 'auto',
        maxWidth: 'none',
      }}
    />
  );

  const view = (
    <div
      ref={setEl}
      className={`zoomview ${full ? 'zv-full' : ''} ${className}`}
      style={full ? undefined : { minHeight }}
      onWheel={onWheel}
      onPointerEnter={() => { hover.current = true; }}
      onPointerLeave={() => { hover.current = false; }}
      onDoubleClick={() => (zoom > 1.01 ? reset() : actualSize())}
      onPointerDown={(e) => {
        if (e.button === 2) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const onHandle = e.button === 0 && !e.ctrlKey && (e.target as HTMLElement).closest('.zv-handle');
        drag.current = { x: e.clientX, y: e.clientY, t: pan, mode: onHandle ? 'cut' : 'pan' };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (d.mode === 'cut') {
          const r = el!.getBoundingClientRect();
          setCut(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
        } else if (zoom > 1) {
          setPan(clampPan({ x: d.t.x + e.clientX - d.x, y: d.t.y + e.clientY - d.y }, zoom));
        }
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
    >
      {img(before)}
      {after && <div className="zv-after" style={{ clipPath: `inset(0 0 0 ${cut}%)` }}>{img(after)}</div>}
      {after && <div className="zv-handle" style={{ left: `${cut}%` }}><i /></div>}
      {after && (
        <>
          <span className="zv-lab" style={{ left: 10 }}>{labels[0]}</span>
          <span className="zv-lab" style={{ right: 10 }}>{labels[1]}</span>
        </>
      )}
      <div className="zv-tools" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button title="Diminuir zoom (Ctrl −)" onClick={() => { const c = centre(); zoomTo(zoom / 1.5, c.x, c.y); }}><ZoomOut size={14} /></button>
        <span>{Math.round(zoom * fitScale * 100)}%</span>
        <button title="Aumentar zoom (Ctrl +, ou roda do mouse)" onClick={() => { const c = centre(); zoomTo(zoom * 1.5, c.x, c.y); }}><ZoomIn size={14} /></button>
        <button title="Tamanho real 1:1 (Ctrl+1)" onClick={actualSize}><Scan size={14} /></button>
        <button title="Ajustar à tela (Ctrl+0)" onClick={reset}><Maximize size={14} /></button>
        <button title={full ? 'Sair da tela cheia (Esc)' : 'Tela cheia no app (F)'} onClick={() => setFull((v) => !v)}>{full ? <Shrink size={14} /> : <Expand size={14} />}</button>
      </div>
      {full && <span className="zv-hint">Roda do mouse: zoom · arrastar (ou Ctrl/Espaço + arrastar): mover · Ctrl+0 ajustar · Ctrl+1 tamanho real · Esc sair</span>}
    </div>
  );
  // Full view lives in <body> so no dialog or page box can clip it.
  return full ? createPortal(view, document.body) : view;
}
