// RunPanel — executa o fluxo atual via host (SSE do runner NDJSON), legenda ao vivo.
// Perfis de Run (W8): override de params por nó aplicado SÓ na execução; o grafo não muda.
// Camada visual Carbon v11; lógica de run/gate/captions preservada 1:1.
import { useCallback, useRef, useState } from 'react';
import { Button, Dropdown, IconButton, TextArea, ToastNotification } from '@carbon/react';
import { Add, PlayFilled, StopFilled } from '@carbon/icons-react';
import { gateAction, openRun, stopRun, type Flow, type FlowProfiles, type NodeMetrics, type RunSnapshot, type RunnerEvent } from '../api';

interface Line {
  t: number;
  text: string;
  kind: 'ev' | 'err';
}

const DEFAULT_PROFILE = '';

export function RunPanel({ flowGetter, profiles, onMetrics, onSaveProfile }: {
  flowGetter: () => Flow;
  profiles: FlowProfiles;
  onMetrics: (m: Record<string, NodeMetrics>) => void;
  onSaveProfile: (name: string) => void;
}) {
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [caption, setCaption] = useState('');
  const [pending, setPending] = useState<{ nodeId: string; text: string } | null>(null);
  const [edited, setEdited] = useState('');
  const [suggestion, setSuggestion] = useState(''); // sugestão do LLM (fixa até a próxima)
  const [profile, setProfile] = useState('');
  const [runToast, setRunToast] = useState<string | null>(null); // erro de run → ToastNotification
  const ctlRef = useRef<AbortController | null>(null);
  const transcriptIds = useRef<Set<string>>(new Set()); // sinks de legenda ligados direto ao ASR

  const push = useCallback((text: string, kind: Line['kind'] = 'ev') => {
    setLines((ls) => [...ls.slice(-200), { t: Date.now(), text, kind }]);
  }, []);

  const onStart = useCallback(() => {
    const flow = flowGetter();
    const ov = profile ? profiles[profile] : undefined;
    if (ov) flow.nodes = flow.nodes.map((n) => (ov[n.id] ? { ...n, params: { ...n.params, ...ov[n.id] } } : n));
    // transcrição = sink.captions alimentado DIRETO por um nó asr.*; os demais = sugestão
    const asrIds = new Set(flow.nodes.filter((n) => n.type.startsWith('asr')).map((n) => n.id));
    const capIds = new Set(flow.nodes.filter((n) => n.type === 'sink.captions').map((n) => n.id));
    transcriptIds.current = new Set(
      flow.edges
        .filter((e) => asrIds.has(e.from.split('.')[0]) && capIds.has(e.to.split('.')[0]))
        .map((e) => e.to.split('.')[0]),
    );
    onMetrics({});
    setLines([]);
    setCaption('');
    setSuggestion('');
    let lastParcial = '';
    let lastFinal = '';
    ctlRef.current = openRun(
      flow,
      (ev: RunnerEvent) => {
        if (ev.type === 'metrics') {
          onMetrics((ev as unknown as { snapshot: RunSnapshot }).snapshot.nodes);
          return;
        }
        if (ev.type === 'summary') {
          const m = (ev as unknown as { summary?: { metrics?: RunSnapshot } }).summary?.metrics;
          if (m) onMetrics(m.nodes);
        }
        if (ev.type === 'gate') {
          const g = ev as { type: 'gate'; nodeId: string; text: string };
          setPending({ nodeId: g.nodeId, text: g.text });
          setEdited(g.text);
          return;
        }
        if (ev.type === 'caption') {
          const c = ev as { type: 'caption'; nodeId: string; text: string; final: boolean };
          if (transcriptIds.current.has(c.nodeId)) setCaption(c.text);
          else setSuggestion(c.text); // sugestão do assistente — fixa até a próxima
          return;
        }
        if (ev.type === 'node_error') {
          const e = ev as { nodeId?: string; code?: string; message?: string };
          // log_info/log_warn do motor chegam como node_error code log_* — não são erro
          const isLog = (e.code ?? '').startsWith('log_') && e.code !== 'log_error';
          push(`[${e.nodeId ?? '?'}] ${e.message ?? ''}`, isLog ? 'ev' : 'err');
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
        const line = formatEvent(ev);
        if (line) push(line);
      },
      (code) => {
        setRunning(false);
        push(`— run terminou (code ${code}) —`);
        // null = SIGKILL normal do host após o summary; -1 = stream morreu sem 'ended'
        if (typeof code === 'number' && code !== 0) setRunToast(`o run terminou com code ${code} — veja o log abaixo`);
      },
      () => {
        setRunning(true);
        push('— run started —');
      }
    );
  }, [flowGetter, push, profile, profiles, onMetrics]);

  const profileItems = [DEFAULT_PROFILE, ...Object.keys(profiles)];

  return (
    <div>
      <div className="section-title">Run</div>
      <div className="run-controls">
        <div className="run-profile" title="Perfil de Run (W8): overrides de params por nó, aplicados só na execução — o grafo salvo não muda">
          <Dropdown
            id="run-profile"
            size="sm"
            titleText="Perfil de Run (W8)"
            hideLabel
            label="perfil de Run"
            items={profileItems}
            itemToString={(name) => (name ? name : 'perfil: (padrão do grafo)')}
            selectedItem={profile}
            onChange={({ selectedItem }) => setProfile(selectedItem ?? '')}
          />
        </div>
        <IconButton
          kind="ghost"
          size="sm"
          label="Salvar os params atuais como perfil de Run (persiste no flow JSON)"
          onClick={() => {
            const name = window.prompt('Nome do perfil — fotografa os params atuais de todos os nós:');
            if (name?.trim()) onSaveProfile(name.trim());
          }}
        >
          <Add size={16} />
        </IconButton>
      </div>
      <div className="run-buttons">
        <Button kind="primary" size="md" renderIcon={PlayFilled} onClick={onStart} disabled={running}>
          Capturar
        </Button>
        <Button kind="danger" size="md" renderIcon={StopFilled} onClick={() => stopRun()} disabled={!running}>
          Parar
        </Button>
      </div>
      <div className="live-caption">{caption || <span className="live-caption-empty">legenda ao vivo…</span>}</div>
      {suggestion && (
        <div className="suggestion-box">
          <div className="section-title">💡 Sugestão — leia e responda com suas palavras</div>
          <div className="suggestion-text">{suggestion}</div>
        </div>
      )}
      {pending && (
        <div className="gate-box">
          <div className="section-title">
            ✍️ Sugestão do LLM — edite e aprove
          </div>
          <TextArea
            id="gate-text"
            labelText="Sugestão do LLM (editável)"
            hideLabel
            rows={4}
            value={edited}
            onChange={(e) => setEdited(e.target.value)}
          />
          <div className="gate-actions">
            <Button
              kind="primary"
              size="md"
              onClick={() => {
                gateAction(pending.nodeId, edited);
                setPending(null);
              }}
            >
              Aprovar
            </Button>
            <Button
              kind="danger"
              size="md"
              onClick={() => {
                gateAction(pending.nodeId, null);
                setPending(null);
              }}
            >
              Rejeitar
            </Button>
          </div>
        </div>
      )}
      <div className="runlog" id="runlog">
        {lines.map((l, i) => (
          <div key={i} className={l.kind === 'err' ? 'runlog-line--err' : 'runlog-line'}>
            {l.text}
          </div>
        ))}
      </div>
      {runToast && (
        <ToastNotification className="falador-toast" kind="error" title="Erro no run" subtitle={runToast} timeout={5000} onClose={() => setRunToast(null)} />
      )}
    </div>
  );
}

// eventos do runner → linhas legíveis (nada de JSON cru na tela)
function formatEvent(ev: RunnerEvent): string | null {
  switch (ev.type) {
    case 'run_stopped':
      return `■ run parado (${String((ev as { reason?: string }).reason ?? '')})`;
    case 'edge_overflow':
      return `⚠ overflow em ${String((ev as { edge?: string }).edge ?? '?')} — ${String((ev as { dropped?: number }).dropped ?? 0)} descartada(s)`;
    case 'edge_expired':
      return `⚠ ${String((ev as { count?: number }).count ?? 0)} mensagem(ns) expirada(s) em ${String((ev as { edge?: string }).edge ?? '?')}`;
    case 'cancelled':
      return '✕ cancelamento propagado';
    case 'summary':
      return '— summary: métricas finais atualizadas —';
    default:
      return null; // node_started/stopped, metrics, caption, gate: tratados ou ruído
  }
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
