import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { FolderOpen, Images, Search, Sparkles } from 'lucide-react';
import { api, useStore, folderName, type MediaItem } from '../api';
import { Tile } from '../components/Tile';
import { Lightbox } from '../components/Lightbox';
import { Btn, Segmented } from '../components/controls';

export function GalleryPage({ onAnimate }: { onAnimate: (p: string) => void }) {
  const { state, mediaVersion, toast } = useStore();
  const folders = useMemo(() => {
    if (!state) return [] as { folder: string; label: string; monitors: number[] }[];
    const map = new Map<string, number[]>();
    for (const m of state.monitors) {
      const f = state.config.monitors[m.id]?.folder;
      if (f) map.set(f, [...(map.get(f) || []), m.index]);
    }
    for (const c of Object.values(state.config.monitors)) if (c.folder && !map.has(c.folder)) map.set(c.folder, []);
    return [...map.entries()].map(([folder, monitors]) => ({ folder, label: folderName(folder), monitors }));
  }, [state]);
  const [folder, setFolder] = useState<string | null>(null);
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'image' | 'anim' | 'nok'>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => { if (!folder && folders.length) setFolder(folders[0].folder); }, [folders, folder]);
  useEffect(() => {
    if (!folder) return;
    let alive = true;
    setItems(null);
    api.invoke<MediaItem[]>('media:list', folder, {}).then((xs) => alive && setItems(xs)).catch(() => alive && setItems([]));
    return () => { alive = false; };
  }, [folder, mediaVersion]);

  const shown = useMemo(() => (items || []).filter((i) =>
    (filter === 'all' || (filter === 'image' && i.type === 'image') || (filter === 'anim' && i.type !== 'image') || (filter === 'nok' && i.type === 'image' && !i.upscaled)) &&
    (!q || i.name.toLowerCase().includes(q.toLowerCase()))), [items, filter, q]);

  const currents = new Set(state ? Object.values(state.config.monitors).map((c) => c.fixed || c.current) : []);
  const browse = async () => { const f = await api.invoke<string | null>('dialog:folder', 'Abrir pasta na galeria'); if (f) setFolder(f); };
  const upscaleAll = async () => {
    const list = shown.filter((i) => i.type === 'image' && !i.upscaled).map((i) => i.path);
    if (!list.length) { toast({ kind: 'info', title: 'Nada para fazer', message: 'Todas as imagens visíveis já têm versão 4K.' }); return; }
    await api.invoke('upscale:start', list, {});
    toast({ kind: 'info', title: `${list.length} imagens na fila de upscale`, message: 'Elas são processadas uma por vez na GPU.' });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Galeria</h1>
          <p>Veja seus wallpapers, coloque qualquer um em qualquer monitor e gere a versão 4K com IA.</p>
        </div>
        <div className="actions">
          <Btn onClick={browse}><FolderOpen size={16} /> Abrir outra pasta</Btn>
          <Btn className="primary" onClick={upscaleAll} disabled={!items || !items.length}><Sparkles size={16} /> Upscale 4K dos que faltam</Btn>
        </div>
      </div>

      <div className="gal-toolbar">
        <div className="folder-tabs">
          {folders.map((f) => (
            <button key={f.folder} className={`folder-tab ${folder === f.folder ? 'on' : ''}`} onClick={() => setFolder(f.folder)} title={f.folder}>
              {f.monitors.map((n) => <span key={n} className="n">{n}</span>)}
              {f.label}
            </button>
          ))}
          {folder && !folders.some((f) => f.folder === folder) && <button className="folder-tab on" title={folder}>{folderName(folder)}</button>}
        </div>
        <div className="grow" />
        <div className="row" style={{ position: 'relative' }}>
          <Search size={15} style={{ position: 'absolute', left: 11, color: 'var(--muted)' }} />
          <input className="input" placeholder="Buscar pelo nome" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 32, width: 200 }} />
        </div>
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'Tudo' }, { value: 'image', label: 'Estáticos' }, { value: 'anim', label: 'Animados' }, { value: 'nok', label: 'Sem 4K' }]} />
      </div>

      {!folder ? (
        <div className="empty-state">
          <Images size={36} />
          <h3>Nenhuma pasta ainda</h3>
          <p>Escolha a pasta de um monitor na aba Monitores, ou abra qualquer pasta para navegar.</p>
          <Btn className="primary" onClick={browse}><FolderOpen size={16} /> Abrir pasta</Btn>
        </div>
      ) : items && !shown.length ? (
        <div className="empty-state"><Images size={36} /><h3>Nada por aqui</h3><p>{items.length ? 'Nenhum arquivo combina com o filtro.' : 'Esta pasta não tem imagens ou vídeos suportados.'}</p></div>
      ) : (
        <motion.div className="gallery" layout>
          {(items ? shown : Array.from({ length: 12 }).map((_, i) => ({ path: `sk-${i}`, name: '', type: 'image' } as MediaItem))).map((it, i) => (
            items ? <Tile key={it.path} item={it} index={i} current={currents.has(it.path)} onOpen={() => setOpen(i)} />
              : <div key={it.path} className="tile"><div className="skeleton" /></div>
          ))}
        </motion.div>
      )}
      <div className="muted small" style={{ marginTop: 14 }}>{items ? `${shown.length} de ${items.length} arquivos` : 'Carregando…'}</div>

      <AnimatePresence>
        {open !== null && <Lightbox items={shown} index={open} onIndex={setOpen} onClose={() => setOpen(null)} onAnimate={(p) => { setOpen(null); onAnimate(p); }} />}
      </AnimatePresence>
    </div>
  );
}
