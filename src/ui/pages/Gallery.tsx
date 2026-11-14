import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { FolderOpen, Images, Search, Sparkles, Box, Eye, X, Play, Pin, WandSparkles, Expand, Eraser, FolderSearch, CheckSquare, Scissors, FolderPlus, ImagePlus, Trash2, FolderInput, MonitorUp, ChevronLeft, Folder, Upload } from 'lucide-react';
import { api, useStore, folderName, type MediaItem } from '../api';
import { Tile } from '../components/Tile';
import { Lightbox } from '../components/Lightbox';
import { Btn, Segmented } from '../components/controls';
import { UpscaleConfirm } from '../components/UpscalePicker';
import { useMusicCats } from '../components/Music';

export function GalleryPage({ onEdit }: { onEdit: (p: string, tool?: string) => void }) {
  const { state, mediaVersion, toast } = useStore();
  const folders = useMemo(() => {
    if (!state) return [] as { folder: string; label: string; monitors: number[] }[];
    const map = new Map<string, number[]>();
    for (const m of state.monitors) {
      const f = state.config.monitors[m.id]?.folder;
      if (f) map.set(f, [...(map.get(f) || []), m.index]);
    }
    // Folders kept in the Galeria by the user (not used by any monitor right now).
    for (const f of ((state.config.global as any).folders || []) as string[]) if (f && !map.has(f)) map.set(f, []);
    return [...map.entries()].map(([folder, monitors]) => ({ folder, label: folderName(folder), monitors, saved: ((state.config.global as any).folders || []).includes(folder) }));
  }, [state]);
  const [folder, setFolder] = useState<string | null>(null);
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'image' | 'anim' | 'nok' | 'ed'>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [pending, setPending] = useState<string[] | null>(null);
  /** Multi-selection: paths, and the last one clicked (Shift selects the range). */
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; item: MediaItem; index: number } | null>(null);
  const [openCut, setOpenCut] = useState(false);
  const { cats } = useMusicCats();
  const { setGlobal, setMonitor } = useStore();
  const [subs, setSubs] = useState<string[]>([]);
  const [confirmTrash, setConfirmTrash] = useState<string[] | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const saved: string[] = ((state?.config.global as any)?.folders || []) as string[];
  useEffect(() => {
    let alive = true;
    if (folder) api.invoke<string[]>('gallery:subfolders', folder).then((x) => alive && setSubs(x)).catch(() => alive && setSubs([]));
    return () => { alive = false; };
  }, [folder, mediaVersion]);
  /** Keeps a folder in the Galeria's list (and opens it). */
  const keepFolder = async (f: string) => { if (!saved.includes(f) && !folders.some((x) => x.folder === f)) await setGlobal({ folders: [...saved, f] }); setFolder(f); };
  const addFolder = async () => { const f = await api.invoke<string | null>('dialog:folder', 'Pasta de wallpapers para guardar na Galeria'); if (f) await keepFolder(f); };
  const forgetFolder = async (f: string) => { await setGlobal({ folders: saved.filter((x) => x !== f) }); setFolder(null); };
  const parentOf = (f: string) => f.replace(/[\\/][^\\/]+[\\/]?$/, '');
  const importFiles = async (files?: string[]) => {
    if (!folder) return;
    const list = files || await api.invoke<string[]>('dialog:files', { title: 'Imagens para adicionar a esta pasta', multi: true });
    if (!list || !list.length) return;
    const n = await api.invoke<number>('gallery:add', folder, list);
    toast({ kind: n ? 'ok' : 'info', title: n ? `${n} wallpaper(s) adicionado(s)` : 'Nada adicionado', message: n ? folderName(folder) : 'Os arquivos já estão nesta pasta ou não são imagens/vídeos.' });
  };
  const moveTo = async (files: string[], dest: string) => {
    if (dest === '?') { const d = await api.invoke<string | null>('dialog:folder', 'Mover para qual pasta?'); if (!d) return; dest = d; }
    const n = await api.invoke<number>('gallery:move', files, dest);
    setSel(new Set());
    toast({ kind: 'ok', title: `${n} movido(s)`, message: `Para ${folderName(dest)}. As versões 4K/editadas e os ajustes foram junto.` });
  };
  const doTrash = async (files: string[]) => {
    setConfirmTrash(null);
    const n = await api.invoke<number>('gallery:trash', files);
    setSel(new Set());
    toast({ kind: 'ok', title: `${n} mandado(s) para a Lixeira`, message: 'Dá para restaurar pela Lixeira do Windows.' });
  };
  const makeFolder = async () => {
    if (!folder || !newFolder) return;
    try { const d = await api.invoke<string>('gallery:mkdir', folder, newFolder); setNewFolder(null); setFolder(d); toast({ kind: 'ok', title: 'Pasta criada', message: folderName(d) }); }
    catch (e: any) { toast({ kind: 'error', title: 'Não deu para criar', message: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }); }
  };
  const moveTargets = useMemo(() => [...new Set([...folders.map((f) => f.folder), ...subs])].filter((f) => f !== folder), [folders, subs, folder]);
  useEffect(() => { setSel(new Set()); setAnchor(null); }, [folder]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', key); window.addEventListener('blur', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); window.removeEventListener('blur', close); };
  }, [menu]);

  useEffect(() => { if (!folder && folders.length) setFolder(folders[0].folder); }, [folders, folder]);
  useEffect(() => {
    if (!folder) return;
    let alive = true;
    setItems(null);
    api.invoke<MediaItem[]>('media:list', folder, {}).then((xs) => alive && setItems(xs)).catch(() => alive && setItems([]));
    return () => { alive = false; };
  }, [folder, mediaVersion]);

  const shown = useMemo(() => (items || []).filter((i) =>
    (filter === 'all' || (filter === 'image' && i.type === 'image') || (filter === 'anim' && i.type !== 'image') || (filter === 'nok' && i.type === 'image' && !i.upscaled) || (filter === 'ed' && !!i.edited)) &&
    (!q || i.name.toLowerCase().includes(q.toLowerCase()))), [items, filter, q]);

  const toggle = (i: number, shift: boolean) => setSel((s) => {
    const n = new Set(s);
    if (shift && anchor !== null) { const [a, b] = anchor < i ? [anchor, i] : [i, anchor]; for (let k = a; k <= b; k++) n.add(shown[k].path); }
    else if (n.has(shown[i].path)) n.delete(shown[i].path); else n.add(shown[i].path);
    setAnchor(i);
    return n;
  });
  const picked = shown.filter((i) => sel.has(i.path));
  const pickedImages = picked.filter((i) => i.type === 'image').map((i) => i.path);
  /** One setting applied to every selected picture. */
  const batch = async (label: string, run: (file: string) => Promise<any>) => {
    let ok = 0;
    for (const f of pickedImages) { try { await run(f); ok++; } catch (_) { /* skip this one */ } }
    toast({ kind: ok ? 'ok' : 'warn', title: label, message: `${ok} de ${pickedImages.length} imagem(ns).` });
  };
  const apply = async (id: string, item: MediaItem, fix: boolean) => {
    await api.invoke('monitor:apply', id, item.path, { fix });
    toast({ kind: 'ok', title: fix ? 'Fixado no monitor' : 'Aplicado', message: item.name });
  };
  const currents = new Set(state ? Object.values(state.config.monitors).map((c) => c.fixed || c.current) : []);
  const browse = async () => { const f = await api.invoke<string | null>('dialog:folder', 'Abrir pasta na galeria'); if (f) setFolder(f); };
  const upscaleAll = async () => {
    const list = shown.filter((i) => i.type === 'image' && !i.upscaled).map((i) => i.path);
    if (!list.length) { toast({ kind: 'info', title: 'Nada para fazer', message: 'Todas as imagens visíveis já têm versão 4K.' }); return; }
    setPending(list);
  };
  const startUpscale = async () => {
    const list = pending || [];
    setPending(null);
    await api.invoke('upscale:start', list, {});
    toast({ kind: 'info', title: `${list.length} imagens na fila de upscale`, message: 'Elas são processadas uma por vez na GPU.' });
  };

  return (
    <div className={`page ${dropping ? 'dropping' : ''}`}
      onDragOver={(e) => { if (folder && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false); }}
      onDrop={(e) => { e.preventDefault(); setDropping(false); const list = [...e.dataTransfer.files].map((f) => (window as any).cw.pathOf(f)).filter(Boolean); if (list.length) importFiles(list); }}>
      {dropping && <div className="drop-hint"><Upload size={28} /> Solte para copiar para {folder ? folderName(folder) : ''}</div>}
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
          <button className="folder-tab add" onClick={addFolder} title="Guardar mais uma pasta de wallpapers na Galeria"><FolderPlus size={13} /> Pasta</button>
        </div>
        <div className="grow" />
        <div className="row" style={{ position: 'relative' }}>
          <Search size={15} style={{ position: 'absolute', left: 11, color: 'var(--muted)' }} />
          <input className="input" placeholder="Buscar pelo nome" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 32, width: 200 }} />
        </div>
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'Tudo' }, { value: 'image', label: 'Estáticos' }, { value: 'anim', label: 'Animados' }, { value: 'nok', label: 'Sem 4K' }, { value: 'ed', label: 'Editados' }]} />
      </div>

      {folder && state && (
        <div className="folder-bar">
          {(() => { const p = parentOf(folder); const known = folders.some((f) => f.folder === folder); return !known && p && p !== folder ? <button className="fb-up" onClick={() => setFolder(p)} title={p}><ChevronLeft size={13} /> {folderName(p)}</button> : null; })()}
          <span className="fb-name" title={folder}><Folder size={14} /> {folderName(folder)}</span>
          <span className="fb-label">Usar no monitor:</span>
          {state.monitors.map((m) => {
            const using = state.config.monitors[m.id]?.folder === folder;
            return <button key={m.id} className={`chip-t ${using ? 'on' : ''}`} title={using ? 'Este monitor já usa esta pasta' : `O monitor ${m.index} passa a tocar os wallpapers desta pasta`}
              onClick={async () => { if (!using) { await setMonitor(m.id, { folder, fixed: '' }); toast({ kind: 'ok', title: `Monitor ${m.index} usa esta pasta`, message: folderName(folder) }); } }}><MonitorUp size={11} /> {m.index}</button>;
          })}
          <span className="grow" />
          <Btn className="sm" onClick={() => importFiles()} title="Copia imagens ou vídeos do computador para esta pasta (ou arraste para cá)"><ImagePlus size={13} /> Adicionar imagens</Btn>
          {newFolder === null
            ? <Btn className="sm" onClick={() => setNewFolder('')}><FolderPlus size={13} /> Nova pasta</Btn>
            : <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); makeFolder(); }}>
                <input className="input sm" autoFocus placeholder="Nome da pasta" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setNewFolder(null); }} />
                <Btn className="sm primary" disabled={!newFolder.trim()}>Criar</Btn>
                <Btn className="sm ghost icon" onClick={() => setNewFolder(null)}><X size={13} /></Btn>
              </form>}
          <Btn className="sm ghost icon" title="Abrir no Explorer" onClick={() => api.invoke('shell:open', folder)}><FolderSearch size={13} /></Btn>
          {saved.includes(folder) && <Btn className="sm ghost" title="Tira da lista da Galeria (não apaga nada do disco)" onClick={() => forgetFolder(folder)}><X size={13} /> Tirar da lista</Btn>}
          {subs.length > 0 && (
            <div className="fb-subs">
              {subs.map((s) => <button key={s} className="chip-t" onClick={() => setFolder(s)} title={s}><Folder size={11} /> {folderName(s)}</button>)}
            </div>
          )}
        </div>
      )}

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
        <div className="gallery">
          {(items ? shown : Array.from({ length: 12 }).map((_, i) => ({ path: `sk-${i}`, name: '', type: 'image' } as MediaItem))).map((it, i) => (
            items ? <Tile key={it.path} item={it} index={i} current={currents.has(it.path)} onOpen={() => { setOpenCut(false); setOpen(i); }}
              selected={sel.has(it.path)} selecting={sel.size > 0} onToggle={(shift) => toggle(i, shift)} onMenu={(x, y) => setMenu({ x, y, item: it, index: i })} />
              : <div key={it.path} className="tile"><div className="skeleton" /></div>
          ))}
        </div>
      )}
      <div className="muted small" style={{ marginTop: 14 }}>{items ? `${shown.length} de ${items.length} arquivos` : 'Carregando…'}{items && !sel.size ? ' · Ctrl+clique seleciona várias, botão direito abre as ações' : ''}</div>

      <AnimatePresence>
        {sel.size > 0 && (
          <motion.div className="sel-bar" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 30 }} transition={{ type: 'spring', stiffness: 380, damping: 30 }}>
            <b>{sel.size} selecionada(s)</b>
            <Btn className="sm primary" disabled={!pickedImages.length} onClick={() => setPending(pickedImages)}><Sparkles size={14} /> Upscale 4K</Btn>
            {pickedImages.length === 1 && <Btn className="sm" onClick={() => onEdit(pickedImages[0])}><WandSparkles size={14} /> Editar</Btn>}
            <span className="sep" />
            <Btn className="sm" disabled={!pickedImages.length} title="Liga a profundidade 3D nas selecionadas" onClick={() => batch('3D ligado', (f) => api.invoke('image:depth:set', f, true))}><Box size={14} /> 3D ligar</Btn>
            <Btn className="sm" disabled={!pickedImages.length} title="Desliga a profundidade 3D nas selecionadas" onClick={() => batch('3D desligado', (f) => api.invoke('image:depth:set', f, false))}>3D desligar</Btn>
            <Btn className="sm" disabled={!pickedImages.length} title="As selecionadas voltam a piscar" onClick={() => batch('Piscar ligado', (f) => api.invoke('image:look:set', f, { blink: true }))}><Eye size={14} /> Piscar</Btn>
            <Btn className="sm" disabled={!pickedImages.length} title="As selecionadas não piscam mais" onClick={() => batch('Piscar desligado', (f) => api.invoke('image:look:set', f, { blink: false }))}>Sem piscar</Btn>
            <select className="select sm" value="" title="Move as selecionadas para outra pasta (as versões 4K/editadas vão junto)" onChange={(e) => { const v = e.target.value; if (v) moveTo([...sel], v); }}>
              <option value="">Mover para…</option>
              {moveTargets.map((f) => <option key={f} value={f}>{folderName(f)}</option>)}
              <option value="?">Outra pasta…</option>
            </select>
            {confirmTrash
              ? <><b className="small" style={{ color: 'var(--danger)' }}>Mandar {confirmTrash.length} para a Lixeira?</b><Btn className="sm danger" onClick={() => doTrash(confirmTrash)}><Trash2 size={13} /> Sim, excluir</Btn><Btn className="sm ghost" onClick={() => setConfirmTrash(null)}>Não</Btn></>
              : <Btn className="sm ghost" title="Manda as selecionadas (e as versões 4K/editadas) para a Lixeira do Windows" onClick={() => setConfirmTrash([...sel])}><Trash2 size={13} /> Excluir</Btn>}
            <select className="select sm" value="" title="Liga as selecionadas a uma categoria de música" disabled={!pickedImages.length} onChange={async (e) => { const v = e.target.value; if (!v) return; await api.invoke('music:setCat', pickedImages, v === '-' ? null : v); toast({ kind: 'ok', title: v === '-' ? 'Categoria de música removida' : 'Categoria de música aplicada', message: `${pickedImages.length} imagem(ns).` }); }}>
              <option value="">♪ Categoria de música…</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="-">Sem categoria</option>
            </select>
            <span className="grow" />
            <Btn className="sm ghost" onClick={() => setSel(new Set(shown.map((i) => i.path)))}><CheckSquare size={14} /> Todas</Btn>
            <Btn className="sm ghost" onClick={() => setSel(new Set())}><X size={14} /> Limpar</Btn>
          </motion.div>
        )}
      </AnimatePresence>

      {menu && state && (
        <div className="ctx-menu" style={{ left: Math.min(menu.x, window.innerWidth - 250), top: Math.min(menu.y, window.innerHeight - 420) }} onPointerDown={(e) => e.stopPropagation()} onClick={() => setMenu(null)}>
          <div className="ctx-title ellipsis">{menu.item.name}</div>
          {state.monitors.map((m) => (
            <div className="ctx-row" key={m.id}>
              <button className="grow" onClick={() => apply(m.id, menu.item, false)}><Play size={13} /> Aplicar no monitor {m.index}</button>
              <button title="Fixar neste monitor" onClick={() => apply(m.id, menu.item, true)}><Pin size={13} /></button>
            </div>
          ))}
          {menu.item.type === 'image' && (
            <>
              <i />
              <button onClick={() => onEdit(menu.item.path)}><WandSparkles size={13} /> Editar (ajustes e filtros)</button>
              <button onClick={() => onEdit(menu.item.path, 'expand')}><Expand size={13} /> Expandir para o monitor</button>
              <button onClick={() => onEdit(menu.item.path, 'erase')}><Eraser size={13} /> Borracha</button>
              <button onClick={() => window.dispatchEvent(new CustomEvent('cw-open-upscale', { detail: menu.item.path }))}><Sparkles size={13} /> {menu.item.upscaled ? 'Refazer upscale (com prévia)' : 'Upscale 4K (com prévia)'}</button>
              <button onClick={() => { setOpenCut(true); setOpen(menu.index); }}><Scissors size={13} /> Recorte 3D e movimento</button>
            </>
          )}
          <i />
          <button onClick={() => toggle(menu.index, false)}><CheckSquare size={13} /> {sel.has(menu.item.path) ? 'Tirar da seleção' : 'Selecionar'}</button>
          <button onClick={() => api.invoke('shell:reveal', menu.item.path)}><FolderSearch size={13} /> Mostrar no Explorer</button>
          <button onClick={() => moveTo([menu.item.path], '?')}><FolderInput size={13} /> Mover para outra pasta…</button>
          <button className="danger" onClick={() => { setSel(new Set([menu.item.path])); setConfirmTrash([menu.item.path]); }}><Trash2 size={13} /> Excluir (Lixeira)</button>
        </div>
      )}

      <AnimatePresence>
        {open !== null && <Lightbox items={shown} index={open} onIndex={setOpen} onClose={() => setOpen(null)} startCut={openCut} onEdit={(p, tool) => { setOpen(null); onEdit(p, tool); }} />}
        {pending && <UpscaleConfirm key="confirm" files={pending} onClose={() => setPending(null)} onConfirm={startUpscale} />}
      </AnimatePresence>
    </div>
  );
}
