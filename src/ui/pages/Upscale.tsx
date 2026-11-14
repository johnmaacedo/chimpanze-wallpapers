import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ImagePlus, FolderInput, X, FolderSearch, Columns2, Images, Sparkles, FlaskConical, Check, RotateCcw, Trash2, ChevronDown, ScanSearch } from 'lucide-react';
import { api, useStore, mediaUrl, fileName, type MediaItem } from '../api';
import { Btn, Segmented, SwitchRow, Toggle } from '../components/controls';
import { ZoomView } from '../components/ZoomView';
import { GalleryPicker, UpscaleConfirm } from '../components/UpscalePicker';

export const UP_KINDS = [
  { id: 'anime', label: 'Anime', desc: 'Desenho, ilustração' },
  { id: 'render', label: 'Render 3D', desc: 'Jogo, personagem 3D' },
  { id: 'photo', label: 'Foto real', desc: 'Pessoas, vida real' },
  { id: 'landscape', label: 'Paisagem', desc: 'Natureza, cidade' },
] as const;
export const UP_LEVELS = [
  { id: 'light', label: 'Leve', desc: 'Já está boa: só mais nitidez' },
  { id: 'medium', label: 'Médio', desc: 'Uso geral' },
  { id: 'strong', label: 'Forte', desc: 'Está ruim: reconstrói mais (lento)' },
] as const;
/** Share of the original kept by each level when "Fidelidade" is on automatic. */
const LEVEL_FIDELITY: Record<string, number> = { light: 0.6, medium: 0.13, strong: 0 };
/** Old settings used "art" for what is now "render". */
export const kindOf = (mode: string) => (mode === 'art' ? 'render' : mode);

interface Test { before: string; after: string; width: number; height: number; model: string; kind: string }

export function UpscalePage({ initialFile, clearInitial }: { initialFile?: string | null; clearInitial?: () => void }) {
  const { state, setGlobal, jobs, toast } = useStore();
  const [models, setModels] = useState<Record<string, { label: string; kind: string }>>({});
  const [file, setFile] = useState<string | null>(null);
  const [picking, setPicking] = useState<null | 'one' | 'many'>(null);
  // Pictures waiting for the user's go-ahead (nothing starts without it).
  const [pending, setPending] = useState<string[] | null>(null);
  const [test, setTest] = useState<Test | null>(null);
  const [testing, setTesting] = useState('');
  const [studio, setStudio] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { api.invoke('upscale:models').then(setModels).catch(() => {}); }, []);
  useEffect(() => api.on('upscale:test', (p: any) => { if (p && p.stage) setTesting(p.stage); }), []);
  useEffect(() => { if (initialFile) { choose(initialFile); clearInitial?.(); } }, [initialFile]);
  if (!state) return null;
  const u = state.config.global.upscale;
  const set = (patch: Partial<typeof u>) => setGlobal({ upscale: patch });
  const kind = kindOf(u.mode);
  const level = u.level || 'medium';
  const fidelity = u.fidelity ?? null;
  const fidShown = fidelity ?? LEVEL_FIDELITY[level] ?? 0.13;

  const studioJob = studio ? jobs.find((j) => j.id === studio) : null;
  const result = studioJob && studioJob.status === 'done' && studioJob.result && !studioJob.result.skipped ? studioJob.result : null;
  const running = !!studioJob && (studioJob.status === 'running' || studioJob.status === 'queued');
  // Batch jobs only (pictures saved from the ChatGPT window and the one being tried here are listed elsewhere).
  const upJobs = jobs.filter((j) => j.kind === 'upscale' && !(j.meta && (j.meta.chatgpt || j.meta.studio)));
  const shownJob = upJobs.find((j) => j.id === selected) || null;

  function choose(f: string) { dropStudio(); setFile(f); setTest(null); setSelected(null); }
  function dropStudio() {
    if (result?.output) api.invoke('upscale:discard', result.output).catch(() => {});
    setStudio(null);
  }
  const browseOne = async () => { const [f] = await api.invoke<string[]>('dialog:files', { title: 'Imagem para upscale' }); if (f) choose(f); };
  const addFiles = async () => {
    const files = await api.invoke<string[]>('dialog:files', { title: 'Imagens para upscale', multi: true });
    if (files.length === 1) choose(files[0]); else if (files.length) setPending(files);
  };
  const addFolder = async () => {
    const f = await api.invoke<string | null>('dialog:folder', 'Pasta para upscale');
    if (!f) return;
    const items = await api.invoke<MediaItem[]>('media:list', f, {});
    const list = items.filter((i) => i.type === 'image' && !i.upscaled).map((i) => i.path);
    if (!list.length) { toast({ kind: 'info', title: 'Nada para fazer', message: 'Nenhuma imagem sem versão 4K nessa pasta.' }); return; }
    setPending(list);
  };
  const startBatch = async () => {
    const files = pending || [];
    setPending(null);
    if (!files.length) return;
    await api.invoke('upscale:start', files, {});
    toast({ kind: 'info', title: `${files.length} imagem(ns) na fila`, message: 'Processadas uma por vez na GPU.' });
  };
  const runTest = async () => {
    if (!file) return;
    setTesting('Preparando o pedaço…'); setTest(null);
    try { setTest(await api.invoke<Test>('upscale:test', file, {})); } catch (e: any) { toast({ kind: 'error', title: 'O teste falhou', message: e.message }); } finally { setTesting(''); }
  };
  const run = async () => {
    if (!file) return;
    dropStudio(); setTest(null);
    setStudio(await api.invoke<string>('upscale:studio', file, {}));
  };
  const keep = async () => {
    if (!file || !result) return;
    try {
      await api.invoke('upscale:keep', result.output, file);
      toast({ kind: 'ok', title: 'Versão 4K salva', message: `${fileName(file)} passa a usar esta versão.` });
      setStudio(null);
    } catch (e: any) { toast({ kind: 'error', title: 'Não consegui salvar', message: e.message }); }
  };
  const kindName = (k: string) => UP_KINDS.find((x) => x.id === kindOf(k))?.label || k;
  const levelName = (l: string) => UP_LEVELS.find((x) => x.id === l)?.label || '';

  // What the big viewer shows: a batch job picked in the queue, the result, the test piece, or just the picture.
  const jobOut: string | null = shownJob && shownJob.status === 'done' && shownJob.result && !shownJob.result.skipped ? shownJob.result.output : null;
  const view = shownJob && shownJob.meta?.file
    ? { before: mediaUrl(shownJob.meta.file), after: jobOut ? mediaUrl(jobOut) : null, labels: ['Original', 'Upscale'] as [string, string], title: fileName(shownJob.meta.file) }
    : result && file ? { before: mediaUrl(file), after: mediaUrl(result.output), labels: ['Original', `${kindName(result.kind)} · ${levelName(result.level)}`] as [string, string], title: `${fileName(file)} → ${result.width}×${result.height}` }
      : test ? { before: mediaUrl(test.before), after: mediaUrl(test.after), labels: ['Pedaço original', 'Como vai ficar'] as [string, string], title: 'Teste num pedaço da imagem' }
        : file ? { before: mediaUrl(file), after: null, labels: ['', ''] as [string, string], title: fileName(file) } : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Upscale 4K</h1>
          <p>Diga que tipo de imagem é e quanto quer melhorar; o app escolhe o modelo. Veja o resultado antes de manter. O original nunca muda.</p>
        </div>
        <div className="actions">
          <Btn className="primary" onClick={() => setPicking('one')}><Images size={16} /> Escolher da galeria</Btn>
          <Btn onClick={browseOne}><ImagePlus size={16} /> Do computador</Btn>
        </div>
      </div>

      {!state.tools.upscaler && state.platform === 'win32' && (
        <div className="panel" style={{ borderColor: 'rgba(255,107,107,.4)', marginBottom: 18 }}>Os modelos de upscale não estão instalados. Baixe em Ajustes → Recursos de IA.</div>
      )}

      <div className="up-grid">
        <div className="panel up-view">
          {view ? (
            <>
              <h3>{view.after ? 'Antes e depois' : 'Imagem escolhida'} <span className="sub">{view.title}</span></h3>
              <ZoomView key={view.before + (view.after || '')} before={view.before} after={view.after} labels={view.labels} minHeight={440} />
              {running && studioJob && (
                <div className="job" style={{ marginTop: 10 }}>
                  <div className="top"><div className="grow"><div className="t">Fazendo o upscale… {Math.round(studioJob.progress * 100)}%</div><div className="s ellipsis">{studioJob.stage}</div></div>
                    <Btn className="sm icon ghost" title="Cancelar" onClick={() => api.invoke('jobs:cancel', studioJob.id)}><X size={14} /></Btn></div>
                  <div className="bar"><i style={{ width: `${Math.round(studioJob.progress * 100)}%` }} /></div>
                </div>
              )}
              {studioJob && studioJob.status === 'error' && <div className="merge-warn small" style={{ marginTop: 10 }}>{studioJob.error}</div>}
              <div className="row up-actions">
                {result && !shownJob ? (
                  <>
                    <Btn className="primary" onClick={keep}><Check size={15} /> Manter este</Btn>
                    <Btn onClick={() => { dropStudio(); }}><RotateCcw size={15} /> Refazer com outro ajuste</Btn>
                    <Btn className="ghost" onClick={() => { dropStudio(); }}><Trash2 size={15} /> Descartar</Btn>
                    <span className="muted small grow">Arraste a barra para comparar. Nada foi salvo ainda.</span>
                  </>
                ) : shownJob ? (
                  <Btn className="ghost" onClick={() => setSelected(null)}><X size={15} /> Fechar comparação da fila</Btn>
                ) : (
                  <>
                    <Btn className="primary" disabled={!file || running || !!testing} onClick={run}><Sparkles size={15} /> Fazer upscale</Btn>
                    <Btn disabled={!file || running || !!testing} onClick={runTest}><FlaskConical size={15} /> {testing ? testing : 'Testar num pedaço (rápido)'}</Btn>
                    {test && <span className="muted small grow">Este é só um pedaço do meio da imagem, no tamanho final. Mude o tipo ou o nível e teste de novo.</span>}
                  </>
                )}
              </div>
              <p className="muted small" style={{ margin: '8px 0 0' }}>Roda do mouse dá zoom, arrastar move, Ctrl+1 mostra em tamanho real, F abre em tela cheia.</p>
            </>
          ) : (
            <div className="empty-state" style={{ border: 0, minHeight: 420 }}>
              <ScanSearch size={36} />
              <h3>Escolha uma imagem</h3>
              <p>Uma imagem por vez tem prévia, teste rápido e a opção de refazer. Para várias de uma vez, use os botões abaixo.</p>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                <Btn className="primary" onClick={() => setPicking('one')}><Images size={16} /> Da galeria</Btn>
                <Btn onClick={browseOne}><ImagePlus size={16} /> Do computador</Btn>
              </div>
            </div>
          )}
        </div>

        <div className="stack">
          <div className="panel">
            <h3>Que imagem é?</h3>
            <div className="pick-cards">
              {UP_KINDS.map((k) => (
                <button key={k.id} className={`pick-card ${u.mode !== 'auto' && kind === k.id ? 'on' : ''}`} onClick={() => set({ mode: k.id })}>
                  <b>{k.label}</b><span>{k.desc}</span>
                </button>
              ))}
            </div>
            <label className="row small" style={{ gap: 8, marginTop: 10 }}>
              <Toggle on={u.mode === 'auto'} onChange={(v) => set({ mode: v ? 'auto' : 'anime' })} label="Detectar sozinho" />
              <span className="grow">Detectar sozinho (anime ou foto)</span>
            </label>
          </div>

          <div className="panel">
            <h3>Quanto melhorar?</h3>
            <div className="pick-cards three">
              {UP_LEVELS.map((l) => (
                <button key={l.id} className={`pick-card ${level === l.id ? 'on' : ''}`} onClick={() => set({ level: l.id, fidelity: null })}>
                  <b>{l.label}</b><span>{l.desc}</span>
                </button>
              ))}
            </div>
            <div className="field slider" style={{ marginTop: 12 }}>
              <span className="label">Fidelidade ao original <b>{Math.round(fidShown * 100)}%{fidelity === null ? ' (automático)' : ''}</b></span>
              <input type="range" min={0} max={1} step={0.05} value={fidShown} style={{ ['--p' as any]: `${fidShown * 100}%` }} onChange={(e) => set({ fidelity: Number(e.target.value) })} />
              <span className="hint">Mais alto = muda menos a imagem (mistura o resultado com o original só ampliado). {fidelity !== null && <button className="link" onClick={() => set({ fidelity: null })}>Voltar ao automático</button>}</span>
            </div>
          </div>

          <div className="panel">
            <button className="adv-head" onClick={() => setAdvanced((v) => !v)}><span className="grow">Avançado e várias imagens</span><ChevronDown size={15} style={{ transform: advanced ? 'rotate(180deg)' : 'none', transition: 'transform .3s var(--spring)' }} /></button>
            {advanced && (
              <div className="stack" style={{ marginTop: 12 }}>
                <div className="field">
                  <span className="label">Tamanho final</span>
                  <Segmented value={u.target as any} onChange={(v) => set({ target: v })} options={[{ value: '4k', label: '4K' }, { value: 'monitor', label: 'Maior monitor' }, { value: '5k', label: '5K' }, { value: '8k', label: '8K' }, { value: 'x2', label: '2x' }, { value: 'x4', label: '4x' }]} />
                  <span className="hint">4K preenche 3840×2160; imagens em pé viram 2160×3840.</span>
                </div>
                <div className="field">
                  <span className="label">Formato</span>
                  <Segmented value={u.format as any} onChange={(v) => set({ format: v })} options={[{ value: 'png', label: 'PNG sem perdas' }, { value: 'jpg', label: 'JPG 95' }, { value: 'webp', label: 'WebP 95' }]} />
                </div>
                <SwitchRow title="Usar a versão 4K nos monitores" desc="Quando existir, a versão da pasta _4K entra no lugar da original." on={state.config.global.preferUpscaled} onChange={(v) => setGlobal({ preferUpscaled: v })} />
                <SwitchRow title="Em lote, pular as que já são grandes" desc="Não reprocessa o que já tem a resolução alvo." on={u.skipIfLarger} onChange={(v) => set({ skipIfLarger: v })} />
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <Btn className="sm" onClick={() => setPicking('many')}><Images size={14} /> Várias da galeria</Btn>
                  <Btn className="sm" onClick={addFiles}><ImagePlus size={14} /> Várias do computador</Btn>
                  <Btn className="sm" onClick={addFolder}><FolderInput size={14} /> Pasta inteira</Btn>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {upJobs.length > 0 && (
        <div className="panel" style={{ marginTop: 18 }}>
          <h3>Fila <span className="sub">{upJobs.filter((j) => j.status === 'queued' || j.status === 'running').length} pendente(s)</span></h3>
          <AnimatePresence initial={false}>
            {upJobs.slice(0, 40).map((j) => (
              <motion.div key={j.id} className={`job ${shownJob && shownJob.id === j.id ? 'sel' : ''}`} layout onClick={() => setSelected(j.id)} style={{ cursor: 'pointer' }}
                initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
                <div className="top">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="t ellipsis">{j.title}</div>
                    <div className="s ellipsis">
                      {j.status === 'done' && j.result && !j.result.skipped
                        ? `${j.result.width}×${j.result.height}, ${kindName(j.result.kind)}${j.result.level ? `, ${levelName(j.result.level)}` : ''}, ${models[j.result.model]?.label || j.result.model}`
                        : j.status === 'error' ? j.error : j.status === 'done' && j.result?.skipped ? j.result.reason : j.stage}
                    </div>
                  </div>
                  {j.status === 'done' && j.result && j.result.output && (
                    <>
                      <Btn className="sm icon" title="Comparar" onClick={() => setSelected(j.id)}><Columns2 size={14} /></Btn>
                      <Btn className="sm icon" title="Mostrar no Explorer" onClick={() => api.invoke('shell:reveal', j.result.output)}><FolderSearch size={14} /></Btn>
                    </>
                  )}
                  {(j.status === 'running' || j.status === 'queued') && <Btn className="sm icon ghost" title="Cancelar" onClick={() => api.invoke('jobs:cancel', j.id)}><X size={14} /></Btn>}
                </div>
                {(j.status === 'running' || j.status === 'queued') && <div className="bar"><i style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <AnimatePresence>
        {picking && <GalleryPicker key="pick" single={picking === 'one'} title={picking === 'one' ? 'Imagem para o upscale' : undefined} onClose={() => setPicking(null)}
          onPick={(paths) => { const one = picking === 'one'; setPicking(null); if (one || paths.length === 1) { if (paths[0]) choose(paths[0]); } else setPending(paths); }} />}
        {pending && <UpscaleConfirm key="confirm" files={pending} onClose={() => setPending(null)} onConfirm={startBatch} />}
      </AnimatePresence>
    </div>
  );
}
