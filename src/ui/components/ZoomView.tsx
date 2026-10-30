import { useCallback, useEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, Scan, Maximize } from 'lucide-react';

/**
 * Image viewer with wheel zoom at the cursor, drag to pan and double click to
 * toggle fit / 100%. With `after`, a draggable bar compares the two images.
 */
export function ZoomView({ before, after, labels = ['Antes', 'Depois'], minHeight = 360, className = '' }: {
  before: string; after?: string | null; labels?: [string, string]; minHeight?: number | string; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [cut, setCut] = useState(50);
  const drag = useRef<{ x: number; y: number; t: { x: number; y: number }; mode: 'cut' | 'pan' } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [before]);

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
    const r = ref.current!.getBoundingClientRect();
    zoomTo(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  };
  const centre = () => ({ x: box.w / 2, y: box.h / 2 });
  const actualSize = () => { const c = centre(); zoomTo(1 / fitScale, c.x, c.y); };
  const reset = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  const img = (src: string) => (
    <img
      src={src}
      alt=""
      draggable={false}
      onLoad={(e) => { const el = e.currentTarget; if (src === before) setNatural({ w: el.naturalWidth, h: el.naturalHeight }); }}
      style={{
        position: 'absolute', left: fit.x, top: fit.y, width: fit.w, height: fit.h,
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0',
        // Past ~250% show real pixels instead of a blurry interpolation.
        imageRendering: zoom / (fitScale || 1) > 2.5 ? 'pixelated' : 'auto',
        maxWidth: 'none',
      }}
    />
  );

  return (
    <div
      ref={ref}
      className={`zoomview ${className}`}
      style={{ minHeight }}
      onWheel={onWheel}
      onDoubleClick={() => (zoom > 1.01 ? reset() : actualSize())}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const onHandle = (e.target as HTMLElement).closest('.zv-handle');
        drag.current = { x: e.clientX, y: e.clientY, t: pan, mode: onHandle ? 'cut' : 'pan' };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (d.mode === 'cut') {
          const r = ref.current!.getBoundingClientRect();
          setCut(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
        } else if (zoom > 1) {
          setPan(clampPan({ x: d.t.x + e.clientX - d.x, y: d.t.y + e.clientY - d.y }, zoom));
        }
      }}
      onPointerUp={() => { drag.current = null; }}
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
        <button title="Diminuir zoom" onClick={() => { const c = centre(); zoomTo(zoom / 1.5, c.x, c.y); }}><ZoomOut size={14} /></button>
        <span>{Math.round(zoom * fitScale * 100)}%</span>
        <button title="Aumentar zoom" onClick={() => { const c = centre(); zoomTo(zoom * 1.5, c.x, c.y); }}><ZoomIn size={14} /></button>
        <button title="Tamanho real (1:1)" onClick={actualSize}><Scan size={14} /></button>
        <button title="Ajustar à tela" onClick={reset}><Maximize size={14} /></button>
      </div>
    </div>
  );
}
