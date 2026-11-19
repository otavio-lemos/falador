// RunPanel — executa o fluxo atual via host (SSE do runner NDJSON), legenda ao vivo.
import { useCallback, useRef, useState } from 'react';
import { gateAction, openRun, stopRun, type Flow, type RunnerEvent } from '../api';

interface Line {
  t: number;
  text: string;
  kind: 'ev' | 'err';
}

export function RunPanel({ flowGetter }: { flowGetter: () => Flow }) {
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [caption, setCaption] = useState('');
  const [pending, setPending] = useState<{ nodeId: string; text: string } | null>(null);
  const [edited, setEdited] = useState('');
  const ctlRef = useRef<AbortController | null>(null);

  const push = useCallback((text: string, kind: Line['kind'] = 'ev') => {
    setLines((ls) => [...ls.slice(-200), { t: Date.now(), text, kind }]);
  }, []);

  const onStart = useCallback(() => {
    const flow = flowGetter();
    setLines([]);
    setCaption('');
    let lastParcial = '';
    let lastFinal = '';
    ctlRef.current = openRun(
      flow,
      (ev: RunnerEvent) => {
        if (ev.type === 'gate') {
          const g = ev as { type: 'gate'; nodeId: string; text: string };
          setPending({ nodeId: g.nodeId, text: g.text });
          setEdited(g.text);
          return;
        }
        if (ev.type === 'caption') {
          const c = ev as { type: 'caption'; text: string; final: boolean };
          if (c.final) setCaption(c.text);
          else setCaption(c.text);
          return;
        }
        if (ev.type === 'node_error') {
          const msg = String((ev as { message?: string }).message ?? '');
          push(`[${String(ev.nodeId ?? '?')}] ${msg}`, 'err');
          return;
        }
        // legendas ao vivo: eventos edge com payload {text, final} do ASR/LLM
        const pl = extractText(ev);
        if (pl) {
          if (pl.final) {
            lastFinal = pl.text;
            setCaption(lastFinal);
          } else if (pl.text.length > lastParcial.length) {
            lastParcial = pl.text;
            setCaption(lastParcial);
          }
        }
        const t = JSON.stringify(ev);
        push(t.length > 160 ? t.slice(0, 160) + '…' : t);
      },
      (code) => {
        setRunning(false);
        push(`— run terminou (code ${code}) —`);
      },
      () => {
        setRunning(true);
        push('— run started —');
      }
    );
  }, [flowGetter, push]);

  return (
    <div>
      <div className="section-title">Run</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <button
          onClick={onStart}
          disabled={running}
          style={{ flex: 1, background: '#24a148', color: '#161616', border: 'none', padding: 8, borderRadius: 4, fontWeight: 600, cursor: running ? 'default' : 'pointer', opacity: running ? 0.5 : 1 }}
        >
          ▶ Capturar
        </button>
        <button
          onClick={() => stopRun()}
          disabled={!running}
          style={{ flex: 1, background: '#da1e28', color: '#fff', border: 'none', padding: 8, borderRadius: 4, fontWeight: 600, cursor: running ? 'pointer' : 'default', opacity: running ? 1 : 0.5 }}
        >
          ■ Parar
        </button>
      </div>
      <div className="live-caption">{caption || <span style={{ opacity: 0.6 }}>legenda ao vivo…</span>}</div>
      {pending && (
        <div style={{ marginTop: 10, border: '1px solid #4589ff', borderRadius: 6, padding: 10, background: '#1e2933' }}>
          <div className="section-title" style={{ marginTop: 0 }}>
            ✍️ Sugestão do LLM — edite e aprove
          </div>
          <textarea
            value={edited}
            onChange={(e) => setEdited(e.target.value)}
            rows={4}
            style={{ width: '100%', boxSizing: 'border-box', background: '#262626', color: '#f4f4f4', border: '1px solid #525252', borderRadius: 4, padding: 6, fontSize: 13 }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button
              onClick={() => {
                gateAction(pending.nodeId, edited);
                setPending(null);
              }}
              style={{ flex: 1, background: '#24a148', color: '#161616', border: 'none', padding: 8, borderRadius: 4, fontWeight: 600, cursor: 'pointer' }}
            >
              ✔ Aprovar (falar EN)
            </button>
            <button
              onClick={() => {
                gateAction(pending.nodeId, null);
                setPending(null);
              }}
              style={{ flex: 1, background: '#da1e28', color: '#fff', border: 'none', padding: 8, borderRadius: 4, fontWeight: 600, cursor: 'pointer' }}
            >
              ✖ Rejeitar
            </button>
          </div>
        </div>
      )}
      <div style={{ height: 10 }} />
      <div className="runlog" id="runlog">
        {lines.map((l, i) => (
          <div key={i} style={{ color: l.kind === 'err' ? '#ff8389' : '#a8a8a8' }}>
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// extrai {text, final} do evento do runner (edge_message / node_result; frame completo separa portas)
function extractText(ev: RunnerEvent): { text: string; final?: boolean } | null {
  function scanDeep(node: unknown): { text: string; final?: boolean } | null {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = scanDeep(child);
        if (found) return found;
      }
      return null;
    }
    if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      if (typeof o.text === 'string') return { text: o.text, final: o.final === true };
      for (const v of Object.values(o)) {
        const found = scanDeep(v);
        if (found) return found;
      }
    }
    return null;
  }
  return scanDeep(ev);
}
