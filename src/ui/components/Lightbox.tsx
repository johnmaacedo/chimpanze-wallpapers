import { motion, AnimatePresence } from 'motion/react';
import { useEffect, useState } from 'react';
import { X, Pin, Play, Sparkles, FolderSearch, WandSparkles, ChevronLeft, ChevronRight } from 'lucide-react';
import { api, useStore, mediaUrl, fmtBytes, type MediaItem } from '../api';
import { Btn } from './controls';
import { UpscaleConfirm } from './UpscalePicker';
import { CutPreview, DepthImageControls } from './DepthImage';

export function Lightbox({ items, index, onClose, onIndex, onEdit }: { items: MediaItem[]; index: number; onClose: () => void; onIndex: (i: number) => void; onEdit?: (path: string) => void }) {
  const { state, toast } = useStore();
  const item = items[index];
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [cut, setCut] = useState(50);
  const [compare, setCompare] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cutView, setCutView] = useState(false);

  useEffect(() => {
    setSize(null);
    setCompare(false);
    if (item && item.type === 'image') api.invoke('media:size', item.path).then(setSize).catch(() => {});
  }, [item?.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') onIndex(Math.min(items.length - 1, index + 1));
      if (e.key === 'ArrowLeft') onIndex(Math.max(0, index - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items.length, onClose, onIndex]);

  if (!item || !state) return null;
  const apply = async (id: string, fix: boolean) => {
    await api.invoke('monitor:apply', id, item.path, { fix });
    toast({ kind: 'ok', title: fix ? 'Fixado no monitor' : 'Aplicado', message: item.name });
  };
  const upscale = () => setConfirming(true);
  const startUpscale = async () => {
    setConfirming(false);
    await api.invoke('upscale:start', [item.path], {});
    toast({ kind: 'info', title: 'Upscale na fila', message: 'Acompanhe o progresso no botão de tarefas, no canto inferior direito.' });
  };

  return (
    <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className="lightbox" initial={{ scale: 0.94, y: 20, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }} onClick={(e) => e.stopPropagation()}>
        <div className="view">
          {cutView && item.type === 'image' ? (
            <CutPreview file={item.path} image={item.edited || item.upscaled || item.path} />
          ) : compare && item.upscaled ? (
            <div className="compare" style={{ ['--cut' as any]: `${cut}%`, minHeight: '70vh' }}
              onMouseMove={(e) => { const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect(); setCut(((e.clientX - r.left) / r.width) * 100); }}>
              <img src={mediaUrl(item.path)} alt="" />
              <img className="after" src={mediaUrl(item.upscaled)} alt="" />
              <div className="handle" />
              <span className="lab" style={{ left: 12 }}>Original</span>
              <span className="lab" style={{ right: 12 }}>4K (IA)</span>
            </div>
          ) : item.type === 'video'
            ? <video key={item.path} src={mediaUrl(item.path)} autoPlay muted loop controls={false} />
            : <motion.img key={item.path} src={mediaUrl(item.edited || item.upscaled || item.path)} alt="" initial={{ opacity: 0, scale: 1.02 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4 }} />}
          <button className="btn icon" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', background: 'rgba(0,0,0,.5)' }} onClick={() => onIndex(Math.max(0, index - 1))} aria-label="Anterior"><ChevronLeft size={18} /></button>
          <button className="btn icon" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'rgba(0,0,0,.5)' }} onClick={() => onIndex(Math.min(items.length - 1, index + 1))} aria-label="Próxima"><ChevronRight size={18} /></button>
        </div>
        <div className="side">
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <h2 className="grow">{item.name}</h2>
            <Btn className="sm icon ghost" onClick={onClose} aria-label="Fechar"><X size={16} /></Btn>
          </div>
          <div className="muted small">
            {size ? `${size.width}×${size.height}` : item.type === 'video' ? 'Vídeo' : item.type === 'gif' ? 'GIF animado' : ''}
            {item.size ? `, ${fmtBytes(item.size)}` : ''}
            {item.upscaled ? ', com versão 4K' : ''}
            {item.edited ? ', editada' : ''}
          </div>

          <div className="stack" style={{ gap: 8 }}>
            <span className="small" style={{ fontWeight: 700, color: 'var(--ink-2)' }}>Colocar no monitor</span>
            {state.monitors.map((m) => (
              <div className="mon-apply" key={m.id}>
                <span className="n">{m.index}</span>
                <span className="grow ellipsis" style={{ fontWeight: 650 }}>{state.config.monitors[m.id]?.alias || m.name}</span>
                <Btn className="sm" title="Aplicar agora e continuar a rotação" onClick={() => apply(m.id, false)}><Play size={13} /> Aplicar</Btn>
                <Btn className="sm icon" title="Fixar (pausa a rotação deste monitor)" onClick={() => apply(m.id, true)}><Pin size={13} /></Btn>
              </div>
            ))}
          </div>

          {item.type === 'image' && <DepthImageControls file={item.path} preview={cutView} onPreview={setCutView} />}

          {item.type === 'image' && (
            <div className="stack" style={{ gap: 8 }}>
              <Btn className="primary" onClick={upscale}><Sparkles size={15} /> {item.upscaled ? 'Refazer upscale 4K' : 'Upscale para 4K (GPU)'}</Btn>
              {item.upscaled && <Btn onClick={() => setCompare((c) => !c)}>{compare ? 'Ver imagem' : 'Comparar antes e depois'}</Btn>}
              {onEdit && <Btn className="ai" onClick={() => onEdit(item.path)}><WandSparkles size={15} /> Editar imagem</Btn>}
            </div>
          )}
          <Btn className="ghost sm" onClick={() => api.invoke('shell:reveal', item.path)}><FolderSearch size={14} /> Mostrar no Explorer</Btn>
        </div>
      </motion.div>
      <div onClick={(e) => e.stopPropagation()}>
        <AnimatePresence>
          {confirming && <UpscaleConfirm files={[item.path]} onClose={() => setConfirming(false)} onConfirm={startUpscale} />}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
