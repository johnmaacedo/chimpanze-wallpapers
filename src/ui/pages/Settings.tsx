import { useEffect, useState } from 'react';
import { FileText, ShieldOff, MessageSquare } from 'lucide-react';
import { api, useStore, TRANSITION_LABELS, TRANSITION_LIST, TRANSITION_CATEGORIES, EASING_LABELS } from '../api';
import { Btn, Segmented, SwitchRow } from '../components/controls';

export function SettingsPage() {
  const { state, setGlobal, toast } = useStore();
  const [legacy, setLegacy] = useState<{ present: boolean } | null>(null);
  const [chatgpt, setChatgpt] = useState<{ installed: boolean } | null>(null);
  useEffect(() => { api.invoke('legacy:status').then(setLegacy).catch(() => {}); }, []);
  useEffect(() => { api.invoke('chatgpt:status').then(setChatgpt).catch(() => {}); }, []);
  if (!state) return null;
  const g = state.config.global;
  const cg = g.chatgpt || {};
  const off = g.transitionsOff || [];

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Ajustes</h1><p>Comportamento geral. Cada monitor pode sobrescrever a transição na aba Monitores.</p></div>
      </div>

      <div className="monitor-grid" style={{ marginTop: 0 }}>
        <div className="stack">
          <div className="panel">
            <h3>Sistema</h3>
            <SwitchRow title="Iniciar com o Windows" desc="Abre escondido na bandeja, detecta os monitores e restaura os wallpapers." on={g.startWithWindows} onChange={(v) => setGlobal({ startWithWindows: v })} />
            <SwitchRow title="Pausar em tela cheia" desc="Para animações e trocas no monitor com um jogo ou vídeo em tela cheia." on={g.pauseOnFullscreen} onChange={(v) => setGlobal({ pauseOnFullscreen: v })} />
            <SwitchRow title="Pausar atrás de janelas maximizadas" desc="Economiza GPU quando o wallpaper nem aparece." on={g.pauseOnMaximized} onChange={(v) => setGlobal({ pauseOnMaximized: v })} />
            <div className="field" style={{ marginTop: 10 }}>
              <span className="label">Wallpaper oficial do Windows</span>
              <Segmented value={g.syncWindows} onChange={(v) => setGlobal({ syncWindows: v })} options={[{ value: 'onExit', label: 'Atualizar ao sair' }, { value: 'always', label: 'A cada troca' }, { value: 'never', label: 'Nunca' }]} />
              <span className="hint">Ao sair do app, o último wallpaper de cada monitor fica como fundo do Windows. "A cada troca" também atualiza a tela de bloqueio, mas pode piscar em algumas versões do Windows 11.</span>
            </div>
          </div>

          <div className="panel">
            <h3><MessageSquare size={15} style={{ verticalAlign: -2 }} /> ChatGPT (edição com IA)</h3>
            <p className="muted small" style={{ marginTop: 0 }}>O Editor manda imagens para o aplicativo do ChatGPT instalado no PC (nunca o navegador) e recebe a imagem editada de volta, quando você baixa ou copia ela no ChatGPT.</p>
            <dl className="kv">
              <dt>Aplicativo</dt><dd>{chatgpt == null ? '…' : chatgpt.installed ? 'Encontrado' : 'Não instalado'}</dd>
            </dl>
            {chatgpt && !chatgpt.installed && <Btn className="sm" style={{ marginTop: 8 }} onClick={() => api.invoke('chatgpt:store')}>Instalar pela Microsoft Store</Btn>}
            <SwitchRow title="Colar sozinho" desc="Depois de abrir o ChatGPT, o app cola a imagem e o pedido para você." on={cg.autoType !== false} onChange={(v) => setGlobal({ chatgpt: { autoType: v } })} />
            <SwitchRow title="Enviar sozinho" desc="Aperta Enter no final. Desligado: você confere o pedido antes." on={cg.autoSend !== false} onChange={(v) => setGlobal({ chatgpt: { autoSend: v } })} />
            <SwitchRow title="Começar conversa nova" desc="Abre um chat novo antes de colar (Ctrl+Shift+O)." on={cg.newChat !== false} onChange={(v) => setGlobal({ chatgpt: { newChat: v } })} />
          </div>

          {legacy?.present && (
            <div className="panel" style={{ borderColor: 'rgba(255,181,71,.35)' }}>
              <h3>App antigo encontrado</h3>
              <p className="muted" style={{ marginTop: 0 }}>O "Wallpaper por Monitor V5" ainda inicia com o Windows. Os dois juntos disputam o wallpaper. As pastas e timers dele já foram importados.</p>
              <Btn onClick={async () => { const s = await api.invoke('legacy:disable'); setLegacy(s); toast({ kind: 'ok', title: 'App antigo desativado', message: 'Ele não inicia mais com o Windows.' }); }}>
                <ShieldOff size={15} /> Desativar o app antigo
              </Btn>
            </div>
          )}
        </div>

        <div className="stack">
          <div className="panel">
            <h3>Transições padrão</h3>
            <div className="stack">
              <div className="field">
                <span className="label">Transição</span>
                <select className="select" value={g.defaultTransition} onChange={(e) => setGlobal({ defaultTransition: e.target.value })}>
                  {Object.entries(TRANSITION_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
              <div className="field">
                <span className="label">Duração: {(g.transitionMs / 1000).toFixed(1)} s</span>
                <input type="range" min={400} max={4000} step={100} value={g.transitionMs} onChange={(e) => setGlobal({ transitionMs: Number(e.target.value) })} />
              </div>
              <div className="field">
                <span className="label">Curva</span>
                <select className="select" value={g.easing} onChange={(e) => setGlobal({ easing: e.target.value })}>
                  {Object.entries(EASING_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
              <div className="field">
                <span className="label">Intensidade dos efeitos: {Math.round((g.transitionIntensity ?? 1) * 100)}%</span>
                <input type="range" min={0.3} max={1.6} step={0.05} value={g.transitionIntensity ?? 1} onChange={(e) => setGlobal({ transitionIntensity: Number(e.target.value) })} />
                <span className="hint">Quanto zoom, desfoque, giro e brilho cada transição usa. Abaixo de 100% fica mais sutil.</span>
              </div>
              <SwitchRow title="Reduzir movimento" desc="Troca por um fade curto e desliga o Ken Burns em todos os monitores." on={g.reduceMotion} onChange={(v) => setGlobal({ reduceMotion: v })} />
            </div>
          </div>

          <div className="panel">
            <h3>Transições no modo aleatório</h3>
            <p className="muted small" style={{ marginTop: 0 }}>Desmarque as que você não quer ver. "Aleatória suave" usa só Suaves e Movimento.</p>
            {TRANSITION_CATEGORIES.map((cat) => (
              <div key={cat.id}>
                <div className="trans-cat">{cat.label}</div>
                <div className="chips">
                  {TRANSITION_LIST.filter((t) => t.cat === cat.id).map((t) => {
                    const isOff = off.includes(t.id);
                    return (
                      <button key={t.id} className={`chip-t ${isOff ? '' : 'on'}`}
                        onClick={() => setGlobal({ transitionsOff: isOff ? off.filter((x) => x !== t.id) : [...off, t.id] })}>
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="panel">
            <h3>Janela</h3>
            <div className="field">
              <span className="label">Opacidade da janela: {Math.round(g.uiOpacity * 100)}%</span>
              <input type="range" min={0.3} max={1} step={0.05} value={g.uiOpacity} onChange={(e) => setGlobal({ uiOpacity: Number(e.target.value) })} />
              <span className="hint">Deixa a janela translúcida para ver o wallpaper enquanto ajusta. Atalho global: Ctrl+Alt+W mostra ou esconde o app.</span>
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <span className="label">Canto do modo compacto</span>
              <Segmented value={g.compactCorner as any} onChange={(v) => setGlobal({ compactCorner: v })} options={[{ value: 'tl', label: 'Sup. esq.' }, { value: 'tr', label: 'Sup. dir.' }, { value: 'bl', label: 'Inf. esq.' }, { value: 'br', label: 'Inf. dir.' }]} />
            </div>
          </div>

          <div className="panel">
            <h3>Sobre</h3>
            <dl className="kv">
              <dt>Versão</dt><dd>{state.version}</dd>
              <dt>Área de trabalho</dt><dd>{state.platform !== 'win32' ? 'modo de desenvolvimento' : state.raisedDesktop ? 'Windows 11 24H2+ (raised desktop)' : 'clássica'}</dd>
              <dt>Monitores ativos</dt><dd>{state.monitors.length}</dd>
              {state.migratedFrom && <><dt>Importado de</dt><dd className="ellipsis">{state.migratedFrom}</dd></>}
            </dl>
            {state.logFile && <Btn className="sm ghost" style={{ marginTop: 12 }} onClick={() => api.invoke('shell:open', state.logFile)}><FileText size={14} /> Abrir log</Btn>}
          </div>
        </div>
      </div>
    </div>
  );
}
