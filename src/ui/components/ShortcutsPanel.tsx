import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Keyboard, RotateCcw } from 'lucide-react';
import { api, useStore } from '../api';
import { Btn, SwitchRow, Toggle } from './controls';

interface ScAction {
  id: string; label: string; perMonitor: boolean; defaultKey: string;
  key: string; on: boolean; ok: boolean; error: string; altKey?: string; altOk?: boolean; altError?: string;
}
interface ScStatus {
  enabled: boolean; notify: boolean; allWithAlt: boolean;
  defaults: { enabled: boolean; notify: boolean; allWithAlt: boolean; keys: Record<string, string>; off: string[] };
  actions: ScAction[];
}

const KEY_NAMES: Record<string, string> = {
  Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete',
  Pause: 'Pause', PrintScreen: 'PrintScreen',
};

/** KeyboardEvent → "Ctrl+Shift+N" (by physical key, so the keyboard layout does not matter). */
function keyFromEvent(e: KeyboardEvent): { combo: string; done: boolean } {
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean) as string[];
  let main = '';
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) main = c.slice(3);
  else if (/^Digit[0-9]$/.test(c)) main = c.slice(5);
  else if (/^Numpad[0-9]$/.test(c)) main = 'num' + c.slice(6);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) main = c;
  else if (KEY_NAMES[c]) main = KEY_NAMES[c];
  return { combo: [...mods, main || '…'].join('+'), done: !!main };
}

const LABEL: Record<string, string> = { Space: 'Espaço', Win: 'Win', Up: '↑', Down: '↓', Left: '←', Right: '→' };

function Keys({ combo, dim }: { combo: string; dim?: boolean }) {
  if (!combo) return <span className="sc-none">sem atalho</span>;
  return (
    <span className={`sc-keys ${dim ? 'dim' : ''}`}>
      {combo.split('+').map((k, i) => <kbd key={i}>{LABEL[k] || k}</kbd>)}
    </span>
  );
}

export function ShortcutsPanel() {
  const { setGlobal } = useStore();
  const [st, setSt] = useState<ScStatus | null>(null);
  const [rec, setRec] = useState<string | null>(null);
  const [preview, setPreview] = useState('');
  const [recErr, setRecErr] = useState('');
  const recRef = useRef<string | null>(null);

  useEffect(() => {
    api.invoke<ScStatus>('shortcuts:status').then(setSt).catch(() => {});
    return api.on('shortcuts', (s: ScStatus) => setSt(s));
  }, []);

  const stop = useCallback(async () => {
    recRef.current = null;
    setRec(null); setPreview(''); setRecErr('');
    const s = await api.invoke<ScStatus>('shortcuts:suspend', false).catch(() => null);
    if (s) setSt(s);
  }, []);

  const start = async (id: string) => {
    if (recRef.current) await stop();
    recRef.current = id;
    setRec(id); setPreview(''); setRecErr('');
    // Our own global shortcuts would swallow the keys while recording.
    await api.invoke('shortcuts:suspend', true).catch(() => {});
  };

  useEffect(() => {
    if (!rec) return;
    const onKey = async (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.type !== 'keydown' || e.repeat) return;
      const id = recRef.current;
      if (!id) return;
      if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) { stop(); return; }
      if ((e.code === 'Backspace' || e.code === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        await setGlobal({ shortcuts: { keys: { [id]: '' } } }); stop(); return;
      }
      const { combo, done } = keyFromEvent(e);
      setPreview(combo);
      if (!done) return;
      const isF = /^F\d+$/.test(combo.split('+').pop()!);
      if (!isF && !e.ctrlKey && !e.altKey && !e.metaKey) { setRecErr('Use Ctrl, Alt ou Win junto (só Shift atrapalharia a digitação).'); return; }
      await setGlobal({ shortcuts: { keys: { [id]: combo } } });
      stop();
    };
    const onBlur = () => stop();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [rec, setGlobal, stop]);

  useEffect(() => () => { if (recRef.current) api.invoke('shortcuts:suspend', false).catch(() => {}); }, []);

  if (!st) return null;
  const off = st.actions.filter((a) => !a.on).map((a) => a.id);
  const isDefault = st.enabled === st.defaults.enabled && st.notify === st.defaults.notify && st.allWithAlt === st.defaults.allWithAlt
    && !off.length && st.actions.every((a) => a.key === a.defaultKey);
  const failed = st.actions.filter((a) => a.on && a.key && !a.ok);

  return (
    <div className="panel">
      <h3><Keyboard size={16} className="h-ico" /> Atalhos <span className="sub">funcionam com o app minimizado ou na bandeja</span></h3>
      <SwitchRow title="Atalhos de teclado globais" desc="Valem em qualquer programa. Agem no monitor onde está o mouse." on={st.enabled} onChange={(v) => setGlobal({ shortcuts: { enabled: v } })} />
      <SwitchRow title="Mesmo atalho + Alt = todos os monitores" desc="Ex.: Ctrl+Shift+Alt+N troca o wallpaper de todos de uma vez." on={st.allWithAlt} onChange={(v) => setGlobal({ shortcuts: { allWithAlt: v } })} />
      <SwitchRow title="Mostrar aviso" desc="Uma notificação rápida do Windows confirma pausar, fixar e ligar/desligar." on={st.notify} onChange={(v) => setGlobal({ shortcuts: { notify: v } })} />

      {failed.length > 0 && st.enabled && (
        <div className="sc-warn"><AlertTriangle size={15} /> {failed.length === 1 ? 'Um atalho não funcionou' : `${failed.length} atalhos não funcionaram`}: outro programa já usa a combinação ou ela repete outra. Clique nas teclas e grave outra.</div>
      )}

      <div className={`sc-list ${st.enabled ? '' : 'disabled'}`}>
        {st.actions.map((a) => {
          const bad = st.enabled && a.on && a.key && !a.ok;
          const recording = rec === a.id;
          return (
            <div key={a.id} className={`sc-row ${bad ? 'bad' : ''}`}>
              <Toggle on={a.on} label={a.label}
                onChange={(v) => setGlobal({ shortcuts: { off: v ? off.filter((x) => x !== a.id) : [...off, a.id] } })} />
              <div className="txt">
                <b>{a.label}</b>
                {bad
                  ? <span className="err">{a.error}</span>
                  : a.perMonitor && st.allWithAlt && a.altKey
                    ? <span>Todos os monitores: <Keys combo={a.altKey} dim />{a.on && st.enabled && a.altOk === false && a.altError ? <em className="err"> — {a.altError}</em> : null}</span>
                    : a.perMonitor ? <span>No monitor onde está o mouse</span> : null}
              </div>
              <button className={`sc-key ${recording ? 'rec' : ''}`} onClick={() => (recording ? stop() : start(a.id))} title="Clique e aperte a nova combinação">
                {recording ? <span className="sc-rec">{preview ? <Keys combo={preview} /> : 'Aperte as teclas…'}</span> : <Keys combo={a.key} />}
              </button>
              <button className="sc-reset" title={`Voltar para ${a.defaultKey}`} disabled={a.key === a.defaultKey}
                onClick={() => setGlobal({ shortcuts: { keys: { [a.id]: a.defaultKey } } })}><RotateCcw size={14} /></button>
            </div>
          );
        })}
      </div>
      {rec && <p className="hint sc-hint">{recErr || 'Aperte a combinação (ex.: Ctrl+Shift+letra). Esc cancela, Backspace deixa sem atalho.'}</p>}

      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <Btn className="sm" disabled={isDefault} onClick={() => setGlobal({ shortcuts: st.defaults })}><RotateCcw size={14} /> Restaurar padrão</Btn>
      </div>
    </div>
  );
}
