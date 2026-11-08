import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X, Sparkles, Save, FolderSearch, MonitorUp, Crop, Combine, Pencil, TriangleAlert, RefreshCcw } from 'lucide-react';
import { api, useStore, mediaUrl, fileName } from '../api';
import { Btn, SwitchRow } from './controls';
import { ZoomView } from './ZoomView';

export interface ChatGptImage {
  file: string; via: 'download' | 'clipboard' | 'manual' | 'local'; width: number; height: number;
  /** Original image the edit belongs to. */
  source: string;
  /** Wanted aspect ratio (Expandir), 0 = keep. */
  aspect?: number;
  label?: string;
  /** Local AI: where the picture sits in the result, and the exact picture it expanded. */
  place?: { x: number; y: number; w: number; h: number };
  original?: string;
  warning?: string;
}

interface Merged { file: string; width: number; height: number; score: number; warnings: string[] }

const aspectName = (a: number) => ({ '1.778': '16:9', '2.333': '21:9', '3.556': '32:9', '1.600': '16:10' } as Record<string, string>)[a.toFixed(3)] || `${a.toFixed(2)}:1`;
/** Electron prefixes errors thrown in the main process; keep only our message. */
const cleanError = (e: any) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * Shown when an edited image comes back from the ChatGPT app or the local AI (or is picked by hand
 * in the Editor). Expansions are joined with the untouched original right away ("Juntar com o original").
 */
export function ChatGptResult() {
  const { state, toast } = useStore();
  const [img, setImg] = useState<ChatGptImage | null>(null);
  const [upscale, setUpscale] = useState(true);
  const [crop, setCrop] = useState(true);
  const [monitorId, setMonitorId] = useState('');
  const [merged, setMerged] = useState<Merged | null>(null);
  const [useMerged, setUseMerged] = useState(true);
  const [mergeStage, setMergeStage] = useState('');
  const [mergeError, setMergeError] = useState('');

  useEffect(() => {
    // A result may have arrived while the window was closed.
    api.invoke<ChatGptImage | null>('chatgpt:pending').then((r) => r && setImg(r)).catch(() => {});
    const off = api.on('chatgpt:result', (r: ChatGptImage) => { setImg(r); api.invoke('chatgpt:ack'); });
    const offStage = api.on('expand:stage', (s: string) => setMergeStage(s));
    const manual = (e: Event) => setImg((e as CustomEvent<ChatGptImage>).detail);
    window.addEventListener('chatgpt-manual', manual);
    return () => { off(); offStage(); window.removeEventListener('chatgpt-manual', manual); };
  }, []);

  const isExpand = !!img && !!img.aspect;
  const runMerge = async (r: ChatGptImage) => {
    setMerged(null); setMergeError(''); setMergeStage('Juntando com o original…');
    try {
      const m = await api.invoke<Merged>('expand:merge', { source: r.source, expansion: r.file, aspect: r.aspect, place: r.place, original: r.original });
      if (r.warning) m.warnings = [r.warning, ...m.warnings];
      setMerged(m); setUseMerged(true);
    } catch (err) {
      setMergeError(cleanError(err)); setUseMerged(false);
    } finally { setMergeStage(''); }
  };
  useEffect(() => {
    if (!img) return;
    setUpscale(true); setCrop(true); setMonitorId('');
    setMerged(null); setMergeError(''); setUseMerged(true);
    if (img.aspect) runMerge(img);
  }, [img?.file]);
  if (!state) return null;

  const ratio = img ? img.width / img.height : 1;
  const offAspect = !!img && !!img.aspect && Math.abs(ratio - img.aspect) / img.aspect > 0.02;
  const showMerged = isExpand && useMerged && !!merged;
  const busyMerge = isExpand && !!mergeStage;
  const engine = img?.via === 'local' ? 'IA local' : 'ChatGPT';

  const save = async () => {
    if (!img) return;
    const file = showMerged ? merged!.file : img.file;
    await api.invoke('chatgpt:save', { file, source: img.source, upscale, crop: !showMerged && offAspect && crop ? img.aspect : 0, monitorId: monitorId || null });
    toast({ kind: 'info', title: upscale ? 'Salvando com upscale 4K…' : 'Salvando…', message: `Vai para ${fileName(img.source)} em _Editado. Acompanhe em Tarefas.` });
    setImg(null);
  };
  const openInEditor = () => {
    if (!img) return;
    window.dispatchEvent(new CustomEvent('cw-open-editor', { detail: showMerged ? merged!.file : img.file }));
    setImg(null);
  };

  return (
    <AnimatePresence>
      {img && (
        <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !busyMerge && setImg(null)}>
          <motion.div className="cg-modal" initial={{ scale: 0.95, y: 16, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.97, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }} onClick={(e) => e.stopPropagation()}>
            {showMerged
              ? <ZoomView before={mediaUrl(merged!.file)} after={mediaUrl(img.file)} labels={['Juntado com o original', `Só ${engine}`]} minHeight="100%" />
              : <ZoomView before={mediaUrl(img.file)} minHeight="100%" />}
            <div className="side">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <h2 className="grow" style={{ margin: 0, fontSize: 17 }}>{isExpand ? 'Imagem expandida' : `Imagem do ${engine}`}</h2>
                <Btn className="sm icon ghost" onClick={() => setImg(null)} disabled={busyMerge} aria-label="Fechar"><X size={16} /></Btn>
              </div>
              <span className="muted small">
                {img.label ? `${img.label}, ` : ''}{engine}, {img.width}×{img.height}
                {img.via !== 'local' ? `, recebida por ${img.via === 'clipboard' ? 'cópia' : img.via === 'download' ? 'download' : 'arquivo escolhido'}` : ''}.
              </span>

              {isExpand && (
                <div className="merge-box">
                  <div className="row" style={{ gap: 8 }}><Combine size={15} /><b className="small grow">Juntar com o original</b></div>
                  {busyMerge && (
                    <span className="muted small">
                      <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }} style={{ display: 'inline-flex', marginRight: 6 }}><Sparkles size={12} /></motion.span>
                      {mergeStage}
                    </span>
                  )}
                  {merged && (
                    <>
                      <span className="muted small">
                        O original voltou inteiro e na resolução dele ({merged.width}×{merged.height}); só as partes novas vieram do {engine}. Arraste a barra na imagem para comparar.
                      </span>
                      <SwitchRow title="Usar a versão juntada" desc="Recomendado: sem marcas nem emendas em cima das pessoas." on={useMerged} onChange={setUseMerged} />
                      {merged.warnings.map((w, i) => <span key={i} className="merge-warn small"><TriangleAlert size={12} /> {w}</span>)}
                    </>
                  )}
                  {mergeError && (
                    <>
                      <span className="merge-warn small"><TriangleAlert size={12} /> {mergeError}</span>
                      <Btn className="sm ghost" onClick={() => runMerge(img)}><RefreshCcw size={13} /> Tentar juntar de novo</Btn>
                    </>
                  )}
                </div>
              )}

              <div>
                <span className="small muted">Original: {fileName(img.source)}</span>
                <img className="cg-orig" src={mediaUrl(img.source)} alt="" style={{ marginTop: 6, maxHeight: 120, objectFit: 'contain', background: '#000' }} />
              </div>
              <SwitchRow title="Upscale 4K antes de salvar" desc="Real-ESRGAN na sua GPU, para ficar nítido no monitor." on={upscale} onChange={setUpscale} />
              {!showMerged && offAspect && (
                <SwitchRow title={`Cortar para ${aspectName(img.aspect!)}`} desc={`Veio em ${aspectName(ratio)}. Corta o excesso pelo centro para encaixar no monitor.`} on={crop} onChange={setCrop} />
              )}
              <div className="stack" style={{ gap: 6 }}>
                <span className="small muted">Depois de salvar, colocar no monitor:</span>
                <div className="chips">
                  <button className={`chip-t ${monitorId ? '' : 'on'}`} onClick={() => setMonitorId('')}>Nenhum</button>
                  {state.monitors.map((m) => (
                    <button key={m.id} className={`chip-t ${monitorId === m.id ? 'on' : ''}`} onClick={() => setMonitorId(m.id)}>
                      <MonitorUp size={11} style={{ verticalAlign: -1 }} /> {m.index}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grow" />
              <Btn className="primary" onClick={save} disabled={busyMerge}>{upscale ? <Sparkles size={15} /> : <Save size={15} />} {upscale ? 'Upscale 4K e salvar' : 'Salvar'}</Btn>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Btn className="sm ghost" onClick={openInEditor} disabled={busyMerge}><Pencil size={13} /> Retocar no Editor</Btn>
                <Btn className="sm ghost" onClick={() => api.invoke('shell:reveal', showMerged ? merged!.file : img.file)}><FolderSearch size={13} /> Mostrar arquivo</Btn>
                <Btn className="sm ghost" onClick={() => setImg(null)} disabled={busyMerge}><X size={13} /> Descartar</Btn>
              </div>
              {!showMerged && offAspect && !crop && <span className="muted small"><Crop size={11} /> Sem corte, o enquadramento do monitor decide como encaixar.</span>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
