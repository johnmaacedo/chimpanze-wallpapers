import { useEffect, useRef, useState } from 'react';
import { Box, RefreshCw, RotateCcw, ScanEye, ChevronLeft } from 'lucide-react';
import { api, useStore, mediaUrl } from '../api';
import { Btn, Toggle } from './controls';

export interface ImageDepthInfo { off: boolean; cut: number; label: string; count: number }

/** Per-picture depth choices of a wallpaper (3D on/off, cut attempt), kept fresh with the app state. */
export function useImageDepth(file: string | null | undefined) {
  const { state } = useStore();
  const [info, setInfo] = useState<ImageDepthInfo | null>(null);
  const entry = file ? state?.config.images?.[file.toLowerCase()] : undefined;
  const sig = entry ? `${entry.depth}|${entry.cut}` : '';
  useEffect(() => {
    if (!file) { setInfo(null); return; }
    let alive = true;
    api.invoke<ImageDepthInfo>('image:depth', file).then((i) => alive && setInfo(i)).catch(() => {});
    return () => { alive = false; };
  }, [file, sig]);
  return [info, setInfo] as const;
}

/**
 * "Profundidade 3D nesta imagem" + "Refazer recorte" for one wallpaper. Each new
 * attempt makes the AI cut the characters out in another way; the monitors showing
 * the picture switch to it as soon as it is ready.
 */
export function DepthImageControls({ file, compact, preview, onPreview }: { file: string; compact?: boolean; preview?: boolean; onPreview?: (v: boolean) => void }) {
  const { state, toast } = useStore();
  const [info, setInfo] = useImageDepth(file);
  const [busy, setBusy] = useState(false);
  if (!state || !state.depthModel || !info) return null;
  const globalOff = !state.config.global.parallax;
  const run = async (mode: 'next' | 'prev' | 'auto') => {
    setBusy(true);
    try {
      const i = await api.invoke<ImageDepthInfo>('image:recut', file, mode);
      setInfo(i);
      toast({ kind: 'ok', title: i.cut ? `Recorte: tentativa ${i.cut} de ${i.count - 1}` : 'Recorte automático de volta', message: i.label });
    } catch (e: any) {
      toast({ kind: 'error', title: 'Não deu para refazer o recorte', message: e.message });
    } finally { setBusy(false); }
  };
  const setOn = async (on: boolean) => {
    try { setInfo(await api.invoke<ImageDepthInfo>('image:depth:set', file, on)); } catch (e: any) { toast({ kind: 'error', title: 'Não deu para mudar', message: e.message }); }
  };
  const on = !info.off;
  const attempt = info.cut ? `Tentativa ${info.cut} de ${info.count - 1}: ${info.label}` : 'Recorte automático';

  if (compact) {
    return (
      <div className="depth-img compact">
        <label className="row small" style={{ gap: 8 }} title="Liga ou desliga a profundidade 3D só nesta imagem">
          <Toggle on={on} onChange={setOn} label="3D nesta imagem" /> <Box size={13} /> 3D nesta imagem
        </label>
        <Btn className="sm" disabled={busy || !on} onClick={() => run('next')} title="A IA recorta os personagens de outro jeito. Clique de novo até ficar bom.">
          <RefreshCw size={13} className={busy ? 'spin' : ''} /> {busy ? 'Refazendo…' : 'Refazer recorte'}
        </Btn>
        {info.cut > 0 && !busy && <Btn className="sm icon ghost" title="Voltar ao recorte automático" onClick={() => run('auto')}><RotateCcw size={13} /></Btn>}
        {on && <span className="small muted ellipsis depth-img-label" title={attempt}>{attempt}</span>}
      </div>
    );
  }

  return (
    <div className={`depth-img ${on ? 'on' : ''}`}>
      <div className="row" style={{ gap: 10 }}>
        <span className="depth-img-ico"><Box size={16} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <b>Profundidade 3D nesta imagem</b>
          <span className="small muted" style={{ display: 'block' }}>{on ? (globalOff ? 'Ligada aqui, mas a chave geral da página Monitores está desligada.' : 'Esta imagem se move em 3D.') : 'Desligada: esta imagem fica parada (ainda pode piscar).'}</span>
        </div>
        <Toggle on={on} onChange={setOn} label="Profundidade 3D nesta imagem" />
      </div>
      {on && (
        <>
          <div className="depth-img-attempt small"><ScanEye size={13} /> {attempt}</div>
          <Btn className="primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy} onClick={() => run('next')}>
            <RefreshCw size={14} className={busy ? 'spin' : ''} /> {busy ? 'Refazendo o recorte…' : 'Refazer recorte'}
          </Btn>
          {info.cut > 0 && (
            <div className="row" style={{ gap: 6 }}>
              <Btn className="sm grow" style={{ justifyContent: 'center' }} disabled={busy} onClick={() => run('prev')}><ChevronLeft size={14} /> Anterior</Btn>
              <Btn className="sm ghost grow" style={{ justifyContent: 'center' }} disabled={busy} onClick={() => run('auto')}><RotateCcw size={13} /> Automático</Btn>
            </div>
          )}
          {onPreview && <label className="row small muted" style={{ gap: 8 }}><Toggle on={!!preview} onChange={onPreview} label="Ver o recorte" /> Ver o recorte na imagem</label>}
          <span className="small muted">Não ficou bom? Clique em Refazer recorte de novo: cada tentativa recorta os personagens de um jeito diferente. O monitor que mostra esta imagem muda sozinho.</span>
        </>
      )}
    </div>
  );
}

/** The picture with the background dimmed and the cut outline drawn, so each attempt can be judged. */
export function CutPreview({ file, image }: { file: string; image: string }) {
  const { state } = useStore();
  const ref = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'none'>('loading');
  const entry = state?.config.images?.[file.toLowerCase()];
  const sig = entry ? `${entry.depth}|${entry.cut}` : '';
  useEffect(() => {
    let alive = true;
    setStatus('loading');
    (async () => {
      const url = await api.invoke<string | null>('image:cutPreview', file);
      if (!url) { if (alive) setStatus('none'); return; }
      const load = async (u: string) => createImageBitmap(await (await fetch(u)).blob(), { premultiplyAlpha: 'none' });
      const [dm, pic] = await Promise.all([load(url), load(mediaUrl(image))]);
      const cv = ref.current;
      if (!alive || !cv) return;
      const W = dm.width; const H = dm.height;
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(dm, 0, 0);
      const d = ctx.getImageData(0, 0, W, H).data;
      ctx.drawImage(pic, 0, 0, W, H);
      const px = ctx.getImageData(0, 0, W, H);
      const o = px.data;
      for (let i = 0; i < W * H; i++) {
        const m = d[i * 4 + 2] / 255; // B = how much of the pixel is character
        const edge = m > 0.15 && m < 0.85 ? 1 : 0;
        const k = 0.28 + 0.72 * m;
        o[i * 4] = edge ? 255 : o[i * 4] * k + 18 * (1 - k);
        o[i * 4 + 1] = edge ? 181 : o[i * 4 + 1] * k + 10 * (1 - k);
        o[i * 4 + 2] = edge ? 71 : o[i * 4 + 2] * k + 30 * (1 - k);
      }
      ctx.putImageData(px, 0, 0);
      setStatus('ok');
    })().catch(() => alive && setStatus('none'));
    return () => { alive = false; };
  }, [file, image, sig]);
  return (
    <div className="cut-preview">
      <canvas ref={ref} style={{ display: status === 'ok' ? 'block' : 'none' }} />
      {status !== 'ok' && <div className="muted small" style={{ padding: 30 }}>{status === 'loading' ? 'Carregando o recorte…' : 'Esta imagem ainda não tem recorte. Coloque-a num monitor ou clique em Refazer recorte.'}</div>}
      {status === 'ok' && <span className="cut-legend">Personagem em destaque · fundo escurecido · contorno do recorte em laranja</span>}
    </div>
  );
}
