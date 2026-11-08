import { useEffect, useRef, useState } from 'react';
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignStartVertical, AlignEndVertical, AlignStartHorizontal, AlignEndHorizontal,
  Crosshair, MoveVertical, MoveHorizontal, Scan, Expand, RotateCcw, Check, X, ImagePlus, Images, ClipboardPaste, FlipHorizontal2,
  Wand2, Move, Spline, Lock, Unlock, Brush,
} from 'lucide-react';
import { Btn, Segmented } from '../components/controls';
import { boxH, composite, cssMatrix, loadPix, quad, NO_CORNERS, type LayerGeom, type PasteOpts, type Pix } from './composite';

/** A picture placed on top of the one being edited ("Colar"). */
export interface Layer extends LayerGeom { path: string; url: string }

export type LayerPreset = 'center' | 'fitH' | 'fitW' | 'real' | 'cover' | 'cx' | 'cy' | 'left' | 'right' | 'top' | 'bottom';

/** Ready-made placements. */
export function placeLayer(l: Layer, p: LayerPreset, bw: number, bh: number): Layer {
  const n: Layer = { ...l };
  const fitH = (bh / bw) * (l.nw / l.nh);
  const reset = () => { n.rot = 0; n.sy = 1; n.corners = NO_CORNERS.map((c) => [...c] as [number, number]); };
  if (p === 'fitH') { n.w = fitH; n.cx = 0.5; n.cy = 0.5; reset(); }
  if (p === 'fitW') { n.w = 1; n.cx = 0.5; n.cy = 0.5; reset(); }
  if (p === 'real') { n.w = l.nw / bw; n.cx = 0.5; n.cy = 0.5; reset(); }
  if (p === 'cover') { n.w = Math.max(1, fitH); n.cx = 0.5; n.cy = 0.5; reset(); }
  if (p === 'center') { n.cx = 0.5; n.cy = 0.5; }
  if (p === 'cx') n.cx = 0.5;
  if (p === 'cy') n.cy = 0.5;
  const hh = boxH(n, bw, bh) / 2;
  if (p === 'left') n.cx = n.w / 2;
  if (p === 'right') n.cx = 1 - n.w / 2;
  if (p === 'top') n.cy = hh;
  if (p === 'bottom') n.cy = 1 - hh;
  return n;
}

/** First placement of an imported picture: narrower than the canvas → full height in the middle, else full width. */
export function initialLayer(path: string, url: string, nw: number, nh: number, bw: number, bh: number): Layer {
  const l: Layer = { path, url, nw, nh, cx: 0.5, cy: 0.5, w: 1, sy: 1, rot: 0, flip: false, corners: NO_CORNERS.map((c) => [...c] as [number, number]) };
  return placeLayer(l, nw / nh <= bw / bh ? 'fitH' : 'fitW', bw, bh);
}

/** The edited picture with the layer put in, at full resolution (PNG bytes). */
export async function bakeLayer(baseUrl: string, l: Layer, o: PasteOpts): Promise<Pix> {
  const [B, S] = await Promise.all([loadPix(baseUrl), loadPix(l.url)]);
  const { out } = composite(B, S, l, o, 1);
  return { w: B.w, h: B.h, data: out };
}

type View = 'box' | 'preview' | 'diff';

/**
 * The layer over the preview. Move: drag inside (snaps to the centre and the edges; Alt = free),
 * corners resize (proportional), round handle rotates. Distort: each corner moves on its own.
 */
export function PasteLayerBox({ layer, onChange, bw, bh, viewW, viewH, zoom, alpha, mode, view, opts, baseUrl, showMask }: {
  layer: Layer; onChange: (l: Layer) => void; bw: number; bh: number; viewW: number; viewH: number; zoom: number; alpha: number;
  mode: 'move' | 'distort'; view: View; opts: PasteOpts; baseUrl: string; showMask: boolean;
}) {
  const drag = useRef<{ kind: 'move' | 'scale' | 'rotate' | 'corner'; i: number; x: number; y: number; l: Layer; cx: number; cy: number; d0: number; a0: number } | null>(null);
  const [guides, setGuides] = useState({ v: false, h: false });
  const [dragging, setDragging] = useState(false);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const cache = useRef<{ key: string; B: Pix; S: Pix } | null>(null);
  // Box in screen px (before zoom): the unrotated, unstretched rectangle.
  const bwPx = layer.w * viewW, bhPx = boxH(layer, bw, bh) * viewH;
  const q = quad(layer, viewW, viewH); // corners in view px
  const centre = [layer.cx * viewW, layer.cy * viewH];
  // The picture is drawn as a w×h element mapped onto the quad.
  const imgW = 1000, imgH = Math.max(1, Math.round((1000 * layer.nh) / layer.nw));
  const matrix = cssMatrix(imgW, imgH, layer.flip ? [q[1], q[0], q[3], q[2]] : q);

  // Live preview of the real result (small), when not dragging.
  useEffect(() => {
    if (view !== 'preview' || dragging) return;
    let alive = true;
    const t = window.setTimeout(async () => {
      const key = `${baseUrl}|${layer.url}|${viewW}`;
      if (!cache.current || cache.current.key !== key) {
        const maxW = Math.min(1100, Math.round(viewW * Math.min(2, window.devicePixelRatio || 1)));
        const [B, S] = await Promise.all([loadPix(baseUrl, maxW), loadPix(layer.url, Math.round(maxW * Math.max(0.3, Math.min(2.5, layer.w * 1.2))))]);
        cache.current = { key, B, S };
      }
      if (!alive) return;
      const { B, S } = cache.current;
      const { out, alpha: a } = composite(B, S, layer, opts, bw / B.w);
      if (showMask) for (let k = 0; k < a.length; k++) if (a[k] > 0) { out[k * 4] = out[k * 4] * (1 - 0.45 * a[k]) + 255 * 0.45 * a[k]; out[k * 4 + 1] *= 1 - 0.3 * a[k]; out[k * 4 + 2] *= 1 - 0.3 * a[k]; }
      const cv = previewRef.current;
      if (!cv || !alive) return;
      cv.width = B.w; cv.height = B.h;
      cv.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(out), B.w, B.h), 0, 0);
    }, 120);
    return () => { alive = false; window.clearTimeout(t); };
  }, [view, dragging, layer, opts, baseUrl, viewW, showMask]);

  const start = (kind: 'move' | 'scale' | 'rotate' | 'corner', i = 0) => (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const host = (e.currentTarget as HTMLElement).closest('.editor-canvas')!.getBoundingClientRect();
    const cx = host.left + layer.cx * host.width, cy = host.top + layer.cy * host.height;
    drag.current = { kind, i, x: e.clientX, y: e.clientY, l: JSON.parse(JSON.stringify(layer)), cx, cy, d0: Math.hypot(e.clientX - cx, e.clientY - cy), a0: Math.atan2(e.clientY - cy, e.clientX - cx) };
    setDragging(true);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const n: Layer = JSON.parse(JSON.stringify(d.l));
    const dxs = (e.clientX - d.x) / zoom, dys = (e.clientY - d.y) / zoom; // view px
    if (d.kind === 'move') {
      n.cx = d.l.cx + dxs / viewW; n.cy = d.l.cy + dys / viewH;
      const sx = 6 / (viewW * zoom), sy = 6 / (viewH * zoom); let v = false, h = false;
      if (!e.altKey) {
        const hw = n.w / 2, hh = boxH(n, bw, bh) / 2;
        for (const t of [0.5, hw, 1 - hw]) if (Math.abs(n.cx - t) < sx) { n.cx = t; v = t === 0.5; break; }
        for (const t of [0.5, hh, 1 - hh]) if (Math.abs(n.cy - t) < sy) { n.cy = t; h = t === 0.5; break; }
      }
      setGuides({ v, h });
    } else if (d.kind === 'scale') {
      n.w = Math.max(0.02, d.l.w * (Math.hypot(e.clientX - d.cx, e.clientY - d.cy) / Math.max(1, d.d0)));
    } else if (d.kind === 'rotate') {
      let a = d.l.rot + ((Math.atan2(e.clientY - d.cy, e.clientX - d.cx) - d.a0) * 180) / Math.PI;
      a = ((a + 540) % 360) - 180;
      if (e.shiftKey) a = Math.round(a / 15) * 15; else for (const s of [-180, -90, 0, 90, 180]) if (Math.abs(a - s) < 1.5) a = s;
      n.rot = a;
    } else {
      // A corner, in the box's own (rotated) frame, as a fraction of the box.
      const r = (-d.l.rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
      const lx = dxs * c - dys * s, ly = dxs * s + dys * c;
      const fx = (e.shiftKey ? 0.25 : 1) * lx / Math.max(1, bwPx), fy = (e.shiftKey ? 0.25 : 1) * ly / Math.max(1, bhPx);
      n.corners[d.i] = [d.l.corners[d.i][0] + fx, d.l.corners[d.i][1] + fy];
    }
    onChange(n);
  };
  const end = () => { drag.current = null; setDragging(false); setGuides({ v: false, h: false }); };
  const inv = 1 / zoom;
  const hide = view !== 'box' && !dragging;
  return (
    <>
      {view === 'preview' && <canvas ref={previewRef} className="paste-preview" style={{ opacity: dragging ? 0 : 1 }} />}
      {guides.v && <div className="paste-guide v" />}
      {guides.h && <div className="paste-guide h" />}
      <img className="paste-img" src={layer.url} alt="" draggable={false}
        style={{ width: imgW, height: imgH, transform: matrix, opacity: hide && view === 'preview' ? 0 : alpha, mixBlendMode: view === 'diff' ? 'difference' : undefined }} />
      {/* Hit area: the quad's bounding polygon. */}
      <svg className="paste-hit" width={viewW} height={viewH} viewBox={`0 0 ${viewW} ${viewH}`}>
        <polygon points={q.map((p) => p.join(',')).join(' ')} onPointerDown={start('move')} onPointerMove={move} onPointerUp={end} />
      </svg>
      <svg className="paste-outline" width={viewW} height={viewH} viewBox={`0 0 ${viewW} ${viewH}`}>
        <polygon points={q.map((p) => p.join(',')).join(' ')} style={{ strokeWidth: 1.5 * inv }} />
        <line x1={(q[0][0] + q[1][0]) / 2} y1={(q[0][1] + q[1][1]) / 2} x2={centre[0] + ((q[0][0] + q[1][0]) / 2 - centre[0]) * (1 + 30 * inv / Math.max(1, bhPx / 2))} y2={centre[1] + ((q[0][1] + q[1][1]) / 2 - centre[1]) * (1 + 30 * inv / Math.max(1, bhPx / 2))} style={{ strokeWidth: 1.5 * inv }} />
      </svg>
      {q.map((p, i) => (
        <i key={i} className={`ph ${mode === 'distort' ? 'pin' : ''}`} style={{ left: p[0], top: p[1], transform: `translate(-50%, -50%) scale(${inv})` }}
          onPointerDown={start(mode === 'distort' ? 'corner' : 'scale', i)} onPointerMove={move} onPointerUp={end}
          title={mode === 'distort' ? 'Arraste este canto (Shift = mais fino)' : 'Mudar o tamanho'} />
      ))}
      {(() => {
        const top = [(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2];
        const k = 1 + (30 * inv) / Math.max(1, bhPx / 2);
        const rx = centre[0] + (top[0] - centre[0]) * k, ry = centre[1] + (top[1] - centre[1]) * k;
        return <i className="ph rot" style={{ left: rx, top: ry, transform: `translate(-50%, -50%) scale(${inv})` }} onPointerDown={start('rotate')} onPointerMove={move} onPointerUp={end} title="Girar (Shift = de 15 em 15°)" />;
      })()}
    </>
  );
}

/** Side panel of "Colar". */
export function PastePanel(p: {
  layer: Layer | null; setLayer: (l: Layer) => void; bw: number; bh: number;
  alpha: number; setAlpha: (v: number) => void; opts: PasteOpts; setOpts: (o: PasteOpts) => void;
  mode: 'move' | 'distort'; setMode: (m: 'move' | 'distort') => void; view: View; setView: (v: View) => void;
  showMask: boolean; setShowMask: (v: boolean) => void;
  onImportFile: () => void; onImportGallery: () => void; onImportClipboard: () => void; onAuto: () => void; autoBusy: boolean;
  onApply: () => void; onCancel: () => void; busy: boolean;
}) {
  const { layer, setLayer, bw, bh, opts, setOpts } = p;
  const [lock, setLock] = useState(true);
  const P = (x: LayerPreset) => layer && setLayer(placeLayer(layer, x, bw, bh));
  const O = (patch: Partial<PasteOpts>) => setOpts({ ...opts, ...patch });
  const px = layer ? { x: Math.round((layer.cx - layer.w / 2) * bw), y: Math.round((layer.cy - boxH(layer, bw, bh) / 2) * bh), w: Math.round(layer.w * bw), h: Math.round(boxH(layer, bw, bh) * bh) } : null;
  const distorted = layer ? layer.corners.some(([a, b]) => Math.abs(a) > 1e-4 || Math.abs(b) > 1e-4) : false;
  return (
    <div className="paste-panel">
      <p className="small muted" style={{ margin: 0 }}>
        Coloque outra imagem por cima desta, por exemplo o original de volta numa expansão feita no ChatGPT. O <b>Encaixe automático</b> acha o tamanho, a posição e as cores sozinho.
      </p>
      <div className="paste-import">
        <Btn className={layer ? 'sm' : 'sm primary'} onClick={p.onImportFile}><ImagePlus size={14} /> Do computador</Btn>
        <Btn className="sm" onClick={p.onImportGallery}><Images size={14} /> Da galeria</Btn>
        <Btn className="sm" onClick={p.onImportClipboard} title="Imagem copiada (Ctrl+V)"><ClipboardPaste size={14} /> Colar (Ctrl+V)</Btn>
      </div>
      {layer && px && (
        <>
          <Btn className="primary" style={{ justifyContent: 'center' }} disabled={p.autoBusy} onClick={p.onAuto}>
            <Wand2 size={15} className={p.autoBusy ? 'spin' : ''} /> {p.autoBusy ? 'Procurando o encaixe…' : 'Encaixe automático'}
          </Btn>

          <span className="label">O que colar</span>
          <Segmented value={opts.mode} onChange={(m) => O({ mode: m })} options={[{ value: 'paint', label: 'Só a parte pintada' }, { value: 'all', label: 'A imagem toda' }]} />
          {opts.mode === 'paint' && (
            <>
              <span className="small muted">Cola só onde esta imagem está pintada (a parte escondida do ChatGPT). Bordas redesenhadas pelo ChatGPT ficam intactas.</span>
              <Range label="Aumentar a área" value={opts.grow} min={0} max={80} step={1} fmt={(v) => `${Math.round(v)} px`} on={(v) => O({ grow: v })} />
              <Range label="Borda suave da área" value={opts.soft} min={0} max={80} step={1} fmt={(v) => `${Math.round(v)} px`} on={(v) => O({ soft: v })} />
            </>
          )}
          <Range label="Borda suave da imagem" value={opts.feather} min={0} max={200} step={1} fmt={(v) => (v < 1 ? 'Sem' : `${Math.round(v)} px`)} on={(v) => O({ feather: v })} />

          <span className="label">Ver</span>
          <Segmented value={p.view} onChange={p.setView} options={[{ value: 'preview', label: 'Resultado' }, { value: 'box', label: 'Imagem' }, { value: 'diff', label: 'Diferença' }]} />
          <span className="small muted">
            {p.view === 'diff' ? 'Diferença: onde encaixa certinho fica preto. Contornos coloridos = ainda desalinhado.' : p.view === 'preview' ? 'Mostra o resultado final, com cores e área já aplicadas.' : 'Mostra a imagem colada por cima, sem ajustes de cor.'}
          </span>
          {p.view === 'preview' && <label className="row small muted" style={{ gap: 8 }}><input type="checkbox" checked={p.showMask} onChange={(e) => p.setShowMask(e.target.checked)} /> Marcar em vermelho a área colada</label>}
          {p.view === 'box' && <Range label="Ver através" value={(1 - p.alpha) * 100} min={0} max={90} step={1} fmt={(v) => (v < 1 ? 'Nada' : `${Math.round(v)}%`)} on={(v) => p.setAlpha(1 - v / 100)} />}

          <span className="label">Cores</span>
          <Range label="Igualar às cores da imagem de baixo" value={opts.match * 100} min={0} max={100} step={1} fmt={(v) => `${Math.round(v)}%`} on={(v) => O({ match: v / 100 })} />
          <Range label="Brilho" value={opts.bright * 100} min={-100} max={100} step={1} fmt={(v) => `${Math.round(v)}`} on={(v) => O({ bright: v / 100 })} />
          <Range label="Contraste" value={opts.contrast * 100} min={-100} max={100} step={1} fmt={(v) => `${Math.round(v)}`} on={(v) => O({ contrast: v / 100 })} />
          <Range label="Saturação" value={opts.sat * 100} min={-100} max={100} step={1} fmt={(v) => `${Math.round(v)}`} on={(v) => O({ sat: v / 100 })} />
          <Range label="Temperatura" value={opts.temp * 100} min={-100} max={100} step={1} fmt={(v) => `${Math.round(v)}`} on={(v) => O({ temp: v / 100 })} />

          <span className="label">Ajuste manual</span>
          <Segmented value={p.mode} onChange={p.setMode} options={[{ value: 'move', label: 'Mover e tamanho' }, { value: 'distort', label: 'Perspectiva (cantos)' }]} />
          <span className="small muted">
            {p.mode === 'distort' ? <>Arraste cada canto separado para esticar em perspectiva (Shift = movimento fino). <Spline size={12} /></> : <>Arraste para mover, cantos mudam o tamanho, bolinha gira. Setas do teclado: 1 px (Shift = 10). <Move size={12} /></>}
          </span>
          {distorted && <Btn className="sm ghost" onClick={() => setLayer({ ...layer, corners: NO_CORNERS.map((c) => [...c] as [number, number]) })}><RotateCcw size={13} /> Tirar a perspectiva</Btn>}
          <div className="paste-presets">
            <button onClick={() => P('fitH')}><MoveVertical size={15} /><b>Centro, altura toda</b></button>
            <button onClick={() => P('fitW')}><MoveHorizontal size={15} /><b>Centro, largura toda</b></button>
            <button onClick={() => P('center')}><Crosshair size={15} /><b>Centralizar</b><span>sem mudar o tamanho</span></button>
            <button onClick={() => P('real')}><Scan size={15} /><b>Tamanho real</b><span>1 pixel = 1 pixel</span></button>
            <button onClick={() => P('cover')}><Expand size={15} /><b>Cobrir tudo</b></button>
          </div>
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
          <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <div className="grow">
              <Range label={lock ? 'Tamanho' : 'Largura'} value={layer.w * 100} min={2} max={300} step={0.05} fmt={(v) => `${v.toFixed(2)}%`} on={(v) => setLayer({ ...layer, w: v / 100 })} />
            </div>
            <button className={`paste-lock ${lock ? 'on' : ''}`} title={lock ? 'Proporção travada: clique para esticar largura e altura separadas' : 'Proporção livre'} onClick={() => { if (!lock) setLayer({ ...layer, sy: 1 }); setLock(!lock); }}>
              {lock ? <Lock size={14} /> : <Unlock size={14} />}
            </button>
          </div>
          {!lock && <Range label="Esticar a altura" value={layer.sy * 100} min={50} max={150} step={0.05} fmt={(v) => `${v.toFixed(2)}%`} on={(v) => setLayer({ ...layer, sy: v / 100 })} />}
          <Range label="Rotação" value={layer.rot} min={-180} max={180} step={0.05} fmt={(v) => `${v.toFixed(2)}°`} on={(v) => setLayer({ ...layer, rot: v })} />
          <div className="small muted">Posição {px.x}, {px.y} · {px.w}×{px.h} px · Alt solta o ímã</div>
          <div className="row" style={{ gap: 8 }}>
            <Btn className="primary grow" style={{ justifyContent: 'center' }} disabled={p.busy} onClick={p.onApply}><Check size={15} /> Aplicar (Enter)</Btn>
            <Btn className="ghost" disabled={p.busy} onClick={p.onCancel}><X size={15} /> Cancelar</Btn>
          </div>
          <span className="small muted"><Brush size={12} /> Dica: na aba <b>Pintar</b> você pinta o que o ChatGPT não deve ver antes de expandir; aqui, "Só a parte pintada" reconhece essa cor.</span>
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
