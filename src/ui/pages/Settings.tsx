import { useEffect, useState } from 'react';
import { FileText, ShieldOff } from 'lucide-react';
import { api, useStore, TRANSITION_LABELS, EASING_LABELS } from '../api';
import { Btn, Segmented, SwitchRow } from '../components/controls';

export function SettingsPage() {
  const { state, setGlobal, toast } = useStore();
  const [legacy, setLegacy] = useState<{ present: boolean } | null>(null);
  useEffect(() => { api.invoke('legacy:status').then(setLegacy).catch(() => {}); }, []);
  if (!state) return null;
  const g = state.config.global;

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
              <SwitchRow title="Reduzir movimento" desc="Troca por um fade curto e desliga o Ken Burns em todos os monitores." on={g.reduceMotion} onChange={(v) => setGlobal({ reduceMotion: v })} />
            </div>
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
            <h3>IA local</h3>
            <div className="stack">
              <div className="field"><span className="label">Endereço do ComfyUI</span><input className="input" defaultValue={g.comfy.url} onBlur={(e) => setGlobal({ comfy: { url: e.target.value.trim() } })} /></div>
              <div className="field"><span className="label">Modelo de visão do Ollama</span><input className="input" defaultValue={g.ollama.model} onBlur={(e) => setGlobal({ ollama: { model: e.target.value.trim() } })} /></div>
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
