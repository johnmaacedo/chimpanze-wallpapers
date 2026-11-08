import { useRef, useState } from 'react';
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignStartVertical, AlignEndVertical, AlignStartHorizontal, AlignEndHorizontal,
  Crosshair, MoveVertical, MoveHorizontal, Scan, Expand, RotateCcw, Check, X, ImagePlus, Images, ClipboardPaste, FlipHorizontal2,
} from 'lucide-react';
import { Btn } from '../components/controls';

/**
 * A picture placed on top of the one being edited ("Colar imagem"). Position and
 * size are normalised to the edited picture: cx, w relative to its width, cy to its height.
 */
export interface Layer { path: string; url: string; nw: number; nh: number; cx: number; cy: number; w: number; rot: number; flip: boolean }

export type LayerPreset = 'center' | 'fitH' | 'fitW' | 'real' | 'cover' | 'cx' | 'cy' | 'left' | 'right' | 'top' | 'bottom';

/** Height of the layer, relative to the edited picture's height. */
export const layerH = (l: Layer, bw: number, bh: number) => l.w * (bw / bh) * (l.nh / l.nw);

/** Ready-made placements (the expansion case is "fitH": the original back in the middle, full height). */
export function placeLayer(l: Layer, p: LayerPreset, bw: number, bh: number): Layer {
  const n = { ...l };
  const fitH = (bh / bw) * (l.nw / l.nh); // w that makes the layer exactly as tall as the picture
  if (p === 'fitH') { n.w = fitH; n.cx = 0.5; n.cy = 0.5; n.rot = 0; }
  if (p === 'fitW') { n.w = 1; n.cx = 0.5; n.cy = 0.5; n.rot = 0; }
  if (p === 'real') { n.w = l.nw / bw; n.cx = 0.5; n.cy = 0.5; n.rot = 0; }
  if (p === 'cover') { n.w = Math.max(1, fitH); n.cx = 0.5; n.cy = 0.5; n.rot = 0; }
  if (p === 'center') { n.cx = 0.5; n.cy = 0.5; }
  if (p === 'cx') n.cx = 0.5;
  if (p === 'cy') n.cy = 0.5;
  const hh = layerH(n, bw, bh) / 2;
  if (p === 'left') n.cx = n.w / 2;
  if (p === 'right') n.cx = 1 - n.w / 2;
  if (p === 'top') n.cy = hh;
  if (p === 'bottom') n.cy = 1 - hh;
  return n;
}

/** First placement of an imported picture: narrower than the canvas → full height in the middle, else full width. */
export function initialLayer(path: string, url: string, nw: number, nh: number, bw: number, bh: number): Layer {
  const l: Layer = { path, url, nw, nh, cx: 0.5, cy: 0.5, w: 1, rot: 0, flip: false };
  return placeLayer(l, nw / nh <= bw / bh ? 'fitH' : 'fitW', bw, bh);
}

/** The edited picture with the layer drawn in, at full resolution (PNG bytes). */
export async function bakeLayer(baseUrl: string, l: Layer, feather: number): Promise<Uint8Array> {
  const load = async (u: string) => createImageBitmap(await (await fetch(u)).blob(), { imageOrientation: 'from-image' });
  const [base, pic] = await Promise.all([load(baseUrl), load(l.url)]);
  const W = base.width; const H = base.height;
  const oc = new OffscreenCanvas(W, H);
  const ctx = oc.getContext('2d')!;
  ctx.drawImage(base, 0, 0);
  const lw = Math.max(1, Math.round(l.w * W)); const lh = Math.max(1, Math.round(lw * l.nh / l.nw));
  const tc = new OffscreenCanvas(lw, lh);
  const t = tc.getContext('2d')!;
  t.imageSmoothingQuality = 'high';
  if (l.flip) { t.translate(lw, 0); t.scale(-1, 1); }
  t.drawImage(pic, 0, 0, lw, lh);
  t.setTransform(1, 0, 0, 1, 0, 0);
  // Soft edges: the layer fades into the picture over `feather` pixels.
  const f = Math.min(feather, lw / 3, lh / 3);
  if (f > 0.5) {
    const m = new OffscreenCanvas(lw, lh);
    const mc = m.getContext('2d')!;
    mc.filter = `blur(${f / 2}px)`;
    mc.fillStyle = '#fff';
    mc.fillRect(f, f, lw - 2 * f, lh - 2 * f);
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(m, 0, 0);
  }
  ctx.translate(l.cx * W, l.cy * H);
  ctx.rotate((l.rot * Math.PI) / 180);
  ctx.drawImage(tc, -lw / 2, -lh / 2);
  base.close(); pic.close();
  return new Uint8Array(await (await oc.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

/**
 * The layer drawn over the preview: drag to move (snaps to the centre and edges),
 * corners to resize (keeps the proportion), the round handle on top to rotate.
 */
export function PasteLayerBox({ layer, onChange, bw, bh, viewW, viewH, zoom, alpha, feather }: {
  layer: Layer; onChange: (l: Layer, final?: boolean) => void; bw: number; bh: number; viewW: number; viewH: number; zoom: number; alpha: number; feather: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'move' | 'scale' | 'rotate'; x: number; y: number; l: Layer; cx: number; cy: number; d0: number; a0: number } | null>(null);
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const hN = layerH(layer, bw, bh);
  const start = (mode: 'move' | 'scale' | 'rotate') => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const r = ref.current!.getBoundingClientRect();
    const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
    drag.current = { mode, x: e.clientX, y: e.clientY, l: { ...layer }, cx, cy, d0: Math.hypot(e.clientX - cx, e.clientY - cy), a0: Math.atan2(e.clientY - cy, e.clientX - cx) };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const n = { ...d.l };
    if (d.mode === 'move') {
      n.cx = d.l.cx + (e.clientX - d.x) / (viewW * zoom);
      n.cy = d.l.cy + (e.clientY - d.y) / (viewH * zoom);
      // Snap: centre lines and picture edges (within ~6 screen pixels), Alt = free.
      const sx = 6 / (viewW * zoom); const sy = 6 / (viewH * zoom);
      let v = false; let h = false;
      if (!e.altKey) {
        const hw = n.w / 2; const hh = layerH(n, bw, bh) / 2;
        for (const target of [0.5, hw, 1 - hw]) if (Math.abs(n.cx - target) < sx) { n.cx = target; v = target === 0.5; break; }
        for (const target of [0.5, hh, 1 - hh]) if (Math.abs(n.cy - target) < sy) { n.cy = target; h = target === 0.5; break; }
      }
      setGuides({ v, h });
    } else if (d.mode === 'scale') {
      const k = Math.hypot(e.clientX - d.cx, e.clientY - d.cy) / Math.max(1, d.d0);
      n.w = Math.max(0.02, d.l.w * k);
    } else {
      let a = d.l.rot + ((Math.atan2(e.clientY - d.cy, e.clientX - d.cx) - d.a0) * 180) / Math.PI;
      a = ((a + 540) % 360) - 180;
      // Snap to straight angles (Shift = steps of 15°).
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      else for (const s of [-180, -90, 0, 90, 180]) if (Math.abs(a - s) < 2) a = s;
      n.rot = a;
    }
    onChange(n);
  };
  const end = () => { if (drag.current) { drag.current = null; setGuides({ v: false, h: false }); onChange(layer, true); } };
  const inv = 1 / zoom; // handles keep their size when zoomed in
  return (
    <>
      {guides.v && <div className="paste-guide v" />}
      {guides.h && <div className="paste-guide h" />}
      <div
        ref={ref}
        className="paste-layer"
        style={{
          left: `${layer.cx * 100}%`, top: `${layer.cy * 100}%`, width: `${layer.w * 100}%`, height: `${hN * 100}%`,
          transform: `translate(-50%, -50%) rotate(${layer.rot}deg)`,
        }}
        onPointerDown={start('move')} onPointerMove={move} onPointerUp={end}
      >
        <img src={layer.url} alt="" draggable={false} style={{
          opacity: alpha, transform: layer.flip ? 'scaleX(-1)' : undefined,
          maskImage: feather > 0 ? featherMask(feather, layer.w * bw, hN * bh) : undefined,
          WebkitMaskImage: feather > 0 ? featherMask(feather, layer.w * bw, hN * bh) : undefined,
        }} />
        {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
          <i key={c} className={`ph ${c}`} style={{ transform: `scale(${inv})` }} onPointerDown={start('scale')} onPointerMove={move} onPointerUp={end} />
        ))}
        <i className="ph rot" style={{ transform: `translateX(-50%) scale(${inv})` }} onPointerDown={start('rotate')} onPointerMove={move} onPointerUp={end} title="Girar (Shift = de 15 em 15°)" />
      </div>
    </>
  );
}

/** CSS mask that previews the soft edges (feather in picture pixels, on a layer of lw×lh picture pixels). */
function featherMask(f: number, lw: number, lh: number) {
  const x = Math.min(50, (f / Math.max(1, lw)) * 100); const y = Math.min(50, (f / Math.max(1, lh)) * 100);
  return `linear-gradient(90deg, transparent, #000 ${x}%, #000 ${100 - x}%, transparent), linear-gradient(0deg, transparent, #000 ${y}%, #000 ${100 - y}%, transparent)`;
}

/** Side panel of "Colar imagem". */
export function PastePanel({ layer, setLayer, bw, bh, alpha, setAlpha, feather, setFeather, onImportFile, onImportGallery, onImportClipboard, onApply, onCancel, busy }: {
  layer: Layer | null; setLayer: (l: Layer) => void; bw: number; bh: number; alpha: number; setAlpha: (v: number) => void; feather: number; setFeather: (v: number) => void;
  onImportFile: () => void; onImportGallery: () => void; onImportClipboard: () => void; onApply: () => void; onCancel: () => void; busy: boolean;
}) {
  const P = (p: LayerPreset) => layer && setLayer(placeLayer(layer, p, bw, bh));
  const px = layer ? { x: Math.round((layer.cx - layer.w / 2) * bw), y: Math.round((layer.cy - layerH(layer, bw, bh) / 2) * bh), w: Math.round(layer.w * bw), h: Math.round(layerH(layer, bw, bh) * bh) } : null;
  return (
    <div className="paste-panel">
      <p className="small muted" style={{ margin: 0 }}>
        Coloque outra imagem por cima desta, por exemplo o original de volta no centro de uma expansão feita no ChatGPT. Arraste para mover, puxe os cantos para mudar o tamanho e a bolinha de cima para girar.
      </p>
      <div className="paste-import">
        <Btn className={layer ? 'sm' : 'sm primary'} onClick={onImportFile}><ImagePlus size={14} /> Do computador</Btn>
        <Btn className="sm" onClick={onImportGallery}><Images size={14} /> Da galeria</Btn>
        <Btn className="sm" onClick={onImportClipboard} title="Imagem copiada (Ctrl+V)"><ClipboardPaste size={14} /> Colar (Ctrl+V)</Btn>
      </div>
      {layer && px && (
        <>
          <span className="label">Encaixes prontos</span>
          <div className="paste-presets">
            <button onClick={() => P('fitH')} className="pp-main"><MoveVertical size={15} /><b>Centro, altura toda</b><span>O original de volta no meio da expansão</span></button>
            <button onClick={() => P('fitW')}><MoveHorizontal size={15} /><b>Centro, largura toda</b></button>
            <button onClick={() => P('center')}><Crosshair size={15} /><b>Centralizar</b><span>sem mudar o tamanho</span></button>
            <button onClick={() => P('real')}><Scan size={15} /><b>Tamanho real</b><span>1 pixel = 1 pixel</span></button>
            <button onClick={() => P('cover')}><Expand size={15} /><b>Cobrir tudo</b></button>
          </div>
          <span className="label">Alinhar</span>
          <div className="paste-align">
            <button title="Encostar à esquerda" onClick={() => P('left')}><AlignStartVertical size={15} /></button>
            <button title="Centro na horizontal" onClick={() => P('cx')}><AlignCenterVertical size={15} /></button>
            <button title="Encostar à direita" onClick={() => P('right')}><AlignEndVertical size={15} /></button>
            <button title="Encostar em cima" onClick={() => P('top')}><AlignStartHorizontal size={15} /></button>
            <button title="Centro na vertical" onClick={() => P('cy')}><AlignCenterHorizontal size={15} /></button>
            <button title="Encostar embaixo" onClick={() => P('bottom')}><AlignEndHorizontal size={15} /></button>
            <button title="Espelhar" className={layer.flip ? 'on' : ''} onClick={() => setLayer({ ...layer, flip: !layer.flip })}><FlipHorizontal2 size={15} /></button>
            <button title="Endireitar (0°)" onClick={() => setLayer({ ...layer, rot: 0 })}><RotateCcw size={15} /></button>
          </div>
          <Range label="Tamanho" value={layer.w * 100} min={2} max={300} step={0.1} fmt={(v) => `${v.toFixed(1)}% da largura`} on={(v) => setLayer({ ...layer, w: v / 100 })} />
          <Range label="Rotação" value={layer.rot} min={-180} max={180} step={0.1} fmt={(v) => `${v.toFixed(1)}°`} on={(v) => setLayer({ ...layer, rot: v })} />
          <Range label="Ver através (só para alinhar)" value={(1 - alpha) * 100} min={0} max={90} step={1} fmt={(v) => (v < 1 ? 'Nada' : `${Math.round(v)}%`)} on={(v) => setAlpha(1 - v / 100)} />
          <Range label="Bordas suaves" value={feather} min={0} max={200} step={1} fmt={(v) => (v < 1 ? 'Sem' : `${Math.round(v)} px`)} on={setFeather} />
          <div className="small muted">Posição {px.x}, {px.y} · {px.w}×{px.h} px · setas do teclado movem 1 px (Shift = 10 px) · Alt solta o ímã</div>
          <div className="row" style={{ gap: 8 }}>
            <Btn className="primary grow" style={{ justifyContent: 'center' }} disabled={busy} onClick={onApply}><Check size={15} /> Aplicar (Enter)</Btn>
            <Btn className="ghost" disabled={busy} onClick={onCancel}><X size={15} /> Cancelar</Btn>
          </div>
        </>
      )}
    </div>
  );
}

function Range({ label, value, min, max, step, fmt, on }: { label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; on: (v: number) => void }) {
  return (
    <label className="paste-range">
      <span className="row" style={{ justifyContent: 'space-between' }}><span>{label}</span><b>{fmt(value)}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => on(Number(e.target.value))} />
    </label>
  );
}
