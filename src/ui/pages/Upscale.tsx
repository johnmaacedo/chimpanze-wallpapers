import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ImagePlus, FolderInput, Cpu, X, FolderSearch, Columns2 } from 'lucide-react';
import { api, useStore, mediaUrl, fileName, type MediaItem } from '../api';
import { Btn, Segmented, SwitchRow } from '../components/controls';
import { ZoomView } from '../components/ZoomView';

export function UpscalePage() {
  const { state, setGlobal, jobs, toast } = useStore();
  const [models, setModels] = useState<Record<string, { label: string; kind: string }>>({});
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { api.invoke('upscale:models').then(setModels).catch(() => {}); }, []);
  if (!state) return null;
  const u = state.config.global.upscale;
  const set = (patch: Partial<typeof u>) => setGlobal({ upscale: patch });
  // Images saved from the ChatGPT window are listed under Tarefas only.
  const upJobs = jobs.filter((j) => j.kind === 'upscale' && !(j.meta && j.meta.chatgpt));
  const shown = upJobs.find((j) => j.id === selected) || upJobs[0] || null;
  const source: string | undefined = shown?.meta?.file;
  const output: string | null = shown && shown.status === 'done' && shown.result && !shown.result.skipped ? shown.result.output : null;

  const addFiles = async () => {
    const files = await api.invoke<string[]>('dialog:files', { title: 'Imagens para upscale', multi: true });
    if (files.length) { await api.invoke('upscale:start', files, {}); toast({ kind: 'info', title: `${files.length} imagem(ns) na fila` }); }
  };
  const addFolder = async () => {
    const f = await api.invoke<string | null>('dialog:folder', 'Pasta para upscale');
    if (!f) return;
    const items = await api.invoke<MediaItem[]>('media:list', f, {});
    const list = items.filter((i) => i.type === 'image' && !i.upscaled).map((i) => i.path);
    if (!list.length) { toast({ kind: 'info', title: 'Nada para fazer', message: 'Nenhuma imagem sem versão 4K nessa pasta.' }); return; }
    await api.invoke('upscale:start', list, {});
    toast({ kind: 'info', title: `${list.length} imagens na fila`, message: 'Processadas uma por vez na GPU.' });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Upscale 4K</h1>
          <p>Real-ESRGAN rodando na sua RTX via Vulkan, com modelos separados para anime e para foto. Depois um Lanczos3 acerta a resolução exata da tela. O original nunca é alterado: a versão 4K vai para a subpasta _4K e passa a ser usada automaticamente.</p>
        </div>
        <div className="actions">
          <Btn onClick={addFolder}><FolderInput size={16} /> Pasta inteira</Btn>
          <Btn className="primary" onClick={addFiles}><ImagePlus size={16} /> Escolher imagens</Btn>
        </div>
      </div>

      {!state.tools.upscaler && state.platform === 'win32' && (
        <div className="panel" style={{ borderColor: 'rgba(255,107,107,.4)', marginBottom: 18 }}>O executável do upscaler não foi encontrado. Reinstale o app.</div>
      )}

      {shown && source && (
        <div className="panel" style={{ marginBottom: 18 }}>
          <h3>
            {output ? 'Antes e depois' : 'Pré-visualização'}{' '}
            <span className="sub">{fileName(source)}{output ? ` → ${shown.result.width}×${shown.result.height}` : shown.status === 'running' ? ` (${Math.round(shown.progress * 100)}%)` : ''}</span>
          </h3>
          <ZoomView key={shown.id} before={mediaUrl(source)} after={output ? mediaUrl(output) : null} labels={['Original', 'Upscale']} minHeight={460} />
          <p className="muted small" style={{ margin: '8px 0 0' }}>
            Roda do mouse dá zoom onde o cursor está, arrastar move a imagem, duplo clique alterna entre ajustar e 100%. {output ? 'Arraste a barra branca para comparar.' : ''}
          </p>
        </div>
      )}

      <div className="monitor-grid" style={{ marginTop: 0 }}>
        <div className="panel">
          <h3>Como fazer</h3>
          <div className="stack">
            <div className="field">
              <span className="label">Tipo de imagem</span>
              <Segmented value={u.mode as any} onChange={(v) => set({ mode: v })} options={[{ value: 'auto', label: 'Detectar sozinho' }, { value: 'anime', label: 'Anime' }, { value: 'photo', label: 'Foto realista' }, { value: 'art', label: 'Arte digital' }]} />
              <span className="hint">No modo automático, cada imagem é analisada (áreas chapadas e paleta) para escolher o modelo certo.</span>
            </div>
            <div className="field">
              <span className="label">Tamanho final</span>
              <Segmented value={u.target as any} onChange={(v) => set({ target: v })} options={[{ value: '4k', label: '4K' }, { value: '5k', label: '5K' }, { value: '8k', label: '8K' }, { value: 'monitor', label: 'Maior monitor' }, { value: 'x2', label: '2x' }, { value: 'x4', label: '4x' }]} />
              <span className="hint">4K preenche 3840×2160 sem bordas, e imagens em pé viram 2160×3840.</span>
            </div>
            <div className="field">
              <span className="label">Formato</span>
              <Segmented value={u.format as any} onChange={(v) => set({ format: v })} options={[{ value: 'png', label: 'PNG sem perdas' }, { value: 'jpg', label: 'JPG 95' }, { value: 'webp', label: 'WebP 95' }]} />
            </div>
            <SwitchRow title="Pular imagens que já são grandes" desc="Não reprocessa o que já tem a resolução alvo." on={u.skipIfLarger} onChange={(v) => set({ skipIfLarger: v })} />
          </div>
        </div>

        <div className="panel">
          <h3>Modelos <span className="sub"><Cpu size={12} style={{ verticalAlign: -2 }} /> rodam na GPU</span></h3>
          <div className="stack">
            <ModelSelect label="Anime e ilustração" value={u.animeModel} models={models} onChange={(v) => set({ animeModel: v })} kinds={['anime', 'art']} />
            <ModelSelect label="Foto realista" value={u.photoModel} models={models} onChange={(v) => set({ photoModel: v })} kinds={['photo']} />
            <ModelSelect label="Arte digital" value={u.artModel} models={models} onChange={(v) => set({ artModel: v })} kinds={['art', 'anime']} />
            <SwitchRow title="Usar a versão 4K nos monitores" desc="Quando existir, a versão da pasta _4K entra no lugar da original." on={state.config.global.preferUpscaled} onChange={(v) => setGlobal({ preferUpscaled: v })} />
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 18 }}>
        <h3>Fila <span className="sub">{upJobs.filter((j) => j.status === 'queued' || j.status === 'running').length} pendente(s)</span></h3>
        {!upJobs.length && <div className="muted">Nenhum upscale ainda. Escolha imagens ou uma pasta.</div>}
        <AnimatePresence initial={false}>
          {upJobs.slice(0, 40).map((j) => (
            <motion.div key={j.id} className={`job ${shown && shown.id === j.id ? 'sel' : ''}`} layout onClick={() => setSelected(j.id)} style={{ cursor: 'pointer' }}
              initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
              <div className="top">
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="t ellipsis">{j.title}</div>
                  <div className="s ellipsis">
                    {j.status === 'done' && j.result && !j.result.skipped
                      ? `${j.result.width}×${j.result.height}, ${j.result.kind === 'anime' ? 'anime' : j.result.kind === 'art' ? 'arte digital' : 'foto'}, ${models[j.result.model]?.label || j.result.model}`
                      : j.status === 'error' ? j.error : j.stage}
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
    </div>
  );
}

function ModelSelect({ label, value, models, onChange, kinds }: { label: string; value: string; models: Record<string, { label: string; kind: string }>; onChange: (v: string) => void; kinds: string[] }) {
  const opts = Object.entries(models).sort(([, a], [, b]) => (kinds.indexOf(a.kind) === -1 ? 1 : 0) - (kinds.indexOf(b.kind) === -1 ? 1 : 0));
  return (
    <div className="field">
      <span className="label">{label}</span>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {opts.map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
      </select>
    </div>
  );
}
