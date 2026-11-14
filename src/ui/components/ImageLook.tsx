import { useEffect, useState } from 'react';
import { ChevronDown, Eye, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { api, useStore } from '../api';
import { Btn, Toggle } from './controls';

/** What one wallpaper may set for itself; anything missing follows the Monitores page. */
export interface ImageLookCfg {
  parallaxPreset?: string; parallaxMotion?: string; parallaxStrength?: number; parallaxSpeed?: number;
}
interface LookInfo { look: ImageLookCfg | null; blink: boolean }

const PRESETS = [['auto', 'Automático'], ['anime', 'Anime'], ['landscape', 'Paisagem'], ['real', 'Pessoas reais']] as const;
const MOTIONS = [['auto', 'Automático'], ['orbit', 'Órbita'], ['walk', 'Caminhada'], ['travel', 'Travelling'], ['dolly', 'Aproximação'], ['float', 'Flutuar'], ['breathe', 'Respiração'], ['sway', 'Balanço']] as const;

/**
 * "Ajustes próprios desta imagem": each wallpaper keeps its own depth preset, camera
 * movement, strength, speed and whether its eyes blink. Saved with the picture; the
 * monitors showing it change at once.
 */
export function ImageLook({ file, startOpen = false }: { file: string; startOpen?: boolean }) {
  const { state, toast } = useStore();
  const entry = state?.config.images?.[file.toLowerCase()] as any;
  const sig = JSON.stringify([entry?.look, entry?.blink]);
  const [info, setInfo] = useState<LookInfo | null>(null);
  const [open, setOpen] = useState(startOpen);
  useEffect(() => {
    let alive = true;
    api.invoke<LookInfo>('image:look', file).then((i) => alive && setInfo(i)).catch(() => {});
    return () => { alive = false; };
  }, [file, sig]);
  if (!state || !state.depthModel || !info) return null;
  const g = state.config.global;
  const own = !!info.look;
  const look = info.look || {};
  const send = async (patch: { look?: ImageLookCfg | null; blink?: boolean }) => {
    try { setInfo(await api.invoke<LookInfo>('image:look:set', file, patch)); } catch (e: any) { toast({ kind: 'error', title: 'Não deu para salvar', message: e.message }); }
  };
  const set = (patch: ImageLookCfg) => send({ look: { ...look, ...patch } });
  const preset = look.parallaxPreset || (g.parallaxPreset === 'custom' ? 'auto' : g.parallaxPreset) || 'auto';
  const motion = look.parallaxMotion || g.parallaxMotion || 'auto';
  const strength = look.parallaxStrength ?? g.parallaxStrength ?? 1;
  const speed = look.parallaxSpeed ?? g.parallaxSpeed ?? 1;
  const globalBlinkOff = g.parallaxBlink === false;

  return (
    <div className={`img-look ${open ? 'open' : ''} ${own ? 'own' : ''}`}>
      <button className="img-look-head" onClick={() => setOpen((v) => !v)}>
        <SlidersHorizontal size={14} />
        <span className="grow">Ajustes próprios desta imagem</span>
        {own && <span className="chip-on">ativos</span>}
        {!info.blink && <span className="chip-on off">sem piscar</span>}
        <ChevronDown size={14} className="chev" />
      </button>
      {open && (
        <div className="img-look-body">
          <label className="row small" style={{ gap: 8 }}>
            <Toggle on={own} onChange={(v) => send({ look: v ? { parallaxPreset: preset, parallaxMotion: motion, parallaxStrength: strength, parallaxSpeed: speed } : null })} label="Usar ajustes próprios" />
            <span className="grow">Movimento só desta imagem</span>
          </label>
          {own ? (
            <>
              <span className="label">Tipo</span>
              <div className="chips">{PRESETS.map(([id, label]) => <button key={id} className={`chip-t ${preset === id ? 'on' : ''}`} onClick={() => set({ parallaxPreset: id })}>{label}</button>)}</div>
              <span className="label">Movimento da câmera</span>
              <div className="chips">{MOTIONS.map(([id, label]) => <button key={id} className={`chip-t ${motion === id ? 'on' : ''}`} onClick={() => set({ parallaxMotion: id })}>{label}</button>)}</div>
              <Range label="Força" value={strength} min={0.3} max={2} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ parallaxStrength: v })} />
              <Range label="Velocidade" value={speed} min={0.3} max={3} step={0.05} fmt={(v) => `${v.toFixed(2).replace(/\.?0+$/, '')}×`} onChange={(v) => set({ parallaxSpeed: v })} />
              <Btn className="sm ghost" onClick={() => send({ look: null })}><RotateCcw size={13} /> Voltar ao padrão dos monitores</Btn>
            </>
          ) : <span className="small muted">Desligado: esta imagem segue o que está na página Monitores.</span>}
          <label className="row small" style={{ gap: 8, marginTop: 4 }} title={globalBlinkOff ? 'O piscar está desligado para todos na página Monitores' : ''}>
            <Toggle on={info.blink && !globalBlinkOff} onChange={(v) => !globalBlinkOff && send({ blink: v })} label="Piscar os olhos nesta imagem" />
            <Eye size={13} /> <span className="grow">Piscar os olhos nesta imagem</span>
          </label>
          {globalBlinkOff && <span className="small muted">O piscar está desligado para todos (página Monitores).</span>}
        </div>
      )}
    </div>
  );
}

function Range({ label, value, min, max, step, fmt, onChange }: { label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="paste-range">
      <span className="row" style={{ justifyContent: 'space-between' }}><span>{label}</span><b>{fmt(v)}</b></span>
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={() => onChange(v)} onKeyUp={() => onChange(v)} />
    </label>
  );
}
