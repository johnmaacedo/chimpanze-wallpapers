import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X, Sparkles, Save, FolderSearch, MonitorUp, Crop } from 'lucide-react';
import { api, useStore, mediaUrl, fileName } from '../api';
import { Btn, SwitchRow } from './controls';
import { ZoomView } from './ZoomView';

export interface ChatGptImage {
  file: string; via: 'download' | 'clipboard' | 'manual'; width: number; height: number;
  /** Original image the edit belongs to. */
  source: string;
  /** Wanted aspect ratio (Expandir), 0 = keep. */
  aspect?: number;
  label?: string;
}

const aspectName = (a: number) => ({ '1.778': '16:9', '2.333': '21:9', '3.556': '32:9', '1.600': '16:10' } as Record<string, string>)[a.toFixed(3)] || `${a.toFixed(2)}:1`;

/** Shown when an edited image comes back from the ChatGPT app (or is picked by hand in the Editor). */
export function ChatGptResult() {
  const { state, toast } = useStore();
  const [img, setImg] = useState<ChatGptImage | null>(null);
  const [upscale, setUpscale] = useState(true);
  const [crop, setCrop] = useState(true);
  const [monitorId, setMonitorId] = useState('');

  useEffect(() => {
    // A result may have arrived while the window was closed.
    api.invoke<ChatGptImage | null>('chatgpt:pending').then((r) => r && setImg(r)).catch(() => {});
    const off = api.on('chatgpt:result', (r: ChatGptImage) => { setImg(r); api.invoke('chatgpt:ack'); });
    const manual = (e: Event) => setImg((e as CustomEvent<ChatGptImage>).detail);
    window.addEventListener('chatgpt-manual', manual);
    return () => { off(); window.removeEventListener('chatgpt-manual', manual); };
  }, []);
  useEffect(() => { if (img) { setUpscale(true); setCrop(true); setMonitorId(''); } }, [img?.file]);
  if (!state) return null;

  const ratio = img ? img.width / img.height : 1;
  const offAspect = !!img && !!img.aspect && Math.abs(ratio - img.aspect) / img.aspect > 0.02;
  const save = async () => {
    if (!img) return;
    await api.invoke('chatgpt:save', { file: img.file, source: img.source, upscale, crop: offAspect && crop ? img.aspect : 0, monitorId: monitorId || null });
    toast({ kind: 'info', title: upscale ? 'Salvando com upscale 4K…' : 'Salvando…', message: `Vai para ${fileName(img.source)} em _Editado. Acompanhe em Tarefas.` });
    setImg(null);
  };

  return (
    <AnimatePresence>
      {img && (
        <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setImg(null)}>
          <motion.div className="cg-modal" initial={{ scale: 0.95, y: 16, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.97, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }} onClick={(e) => e.stopPropagation()}>
            <ZoomView before={mediaUrl(img.file)} minHeight="100%" />
            <div className="side">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <h2 className="grow" style={{ margin: 0, fontSize: 17 }}>Imagem do ChatGPT</h2>
                <Btn className="sm icon ghost" onClick={() => setImg(null)} aria-label="Fechar"><X size={16} /></Btn>
              </div>
              <span className="muted small">
                {img.label ? `${img.label}, ` : ''}{img.width}×{img.height}, recebida por {img.via === 'clipboard' ? 'cópia' : img.via === 'download' ? 'download' : 'arquivo escolhido'}.
              </span>
              <div>
                <span className="small muted">Original: {fileName(img.source)}</span>
                <img className="cg-orig" src={mediaUrl(img.source)} alt="" style={{ marginTop: 6, maxHeight: 140, objectFit: 'contain', background: '#000' }} />
              </div>
              <SwitchRow title="Upscale 4K antes de salvar" desc="Real-ESRGAN na sua GPU. O ChatGPT entrega em resolução baixa para wallpaper." on={upscale} onChange={setUpscale} />
              {offAspect && (
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
              <Btn className="primary" onClick={save}>{upscale ? <Sparkles size={15} /> : <Save size={15} />} {upscale ? 'Upscale 4K e salvar' : 'Salvar'}</Btn>
              <div className="row" style={{ gap: 8 }}>
                <Btn className="sm ghost" onClick={() => api.invoke('shell:reveal', img.file)}><FolderSearch size={13} /> Mostrar arquivo</Btn>
                <Btn className="sm ghost" onClick={() => setImg(null)}><X size={13} /> Descartar</Btn>
              </div>
              {offAspect && !crop && <span className="muted small"><Crop size={11} /> Sem corte, o enquadramento do monitor decide como encaixar.</span>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
