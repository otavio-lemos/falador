// TerminalPanel — Terminal de verdade embutido na tela (append-only, streaming contínuo).
// Exibe comandos, stdout, stderr, status e gates inline sem nunca apagar a tela.
import { useEffect, useRef, useState } from 'react';
import { Button, Tag, TextInput } from '@carbon/react';
import { Copy, TrashCan } from '@carbon/icons-react';
import type { Execution, Gate } from '../useRunner';
import './terminal-panel.scss';

export interface TerminalPanelProps {
  executions?: Execution[];
  gates?: Gate[];
  onApprove?: (gate: Gate, text: string) => Promise<void> | void;
  onReject?: (gate: Gate, reason?: string) => Promise<void> | void;
}

interface SavedEntry {
  id: string;
  command: string;
  host: string;
  transport: string;
  dryRun?: boolean;
  status: 'running' | 'done';
  exitCode: number | null;
  durationMs?: number;
  stdout: string;
  stderr: string;
  output: string;
  ts: number;
}

export function TerminalPanel({ executions = [], gates = [], onApprove, onReject }: TerminalPanelProps) {
  // Histórico persistente: acumula tudo e NUNCA apaga ao reiniciar run.
  const [history, setHistory] = useState<SavedEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [gateDrafts, setGateDrafts] = useState<Record<string, string>>({});
  const termBodyRef = useRef<HTMLDivElement | null>(null);

  // Sincroniza executions novas no histórico persistente
  useEffect(() => {
    if (executions.length === 0) return;
    setHistory((prev) => {
      const copy = [...prev];
      for (const e of executions) {
        const idx = copy.findIndex((x) => x.id === e.id);
        const entry: SavedEntry = {
          id: e.id,
          command: e.command,
          host: e.host || 'local',
          transport: e.transport || 'ssh',
          dryRun: e.dryRun,
          status: e.status,
          exitCode: e.exitCode,
          durationMs: e.durationMs,
          stdout: e.stdout || '',
          stderr: e.stderr || '',
          output: e.output || '',
          ts: e.ts || Date.now(),
        };
        if (idx >= 0) {
          copy[idx] = { ...copy[idx], ...entry };
        } else {
          copy.push(entry);
        }
      }
      return copy;
    });
  }, [executions]);

  // Auto-scroll para o fim quando novo conteúdo chega
  useEffect(() => {
    if (!autoScroll || !termBodyRef.current) return;
    termBodyRef.current.scrollTop = termBodyRef.current.scrollHeight;
  }, [history, gates, autoScroll]);

  const handleCopy = () => {
    const lines = history.map((e) => {
      const prompt = `[${new Date(e.ts).toLocaleTimeString()}] ${e.host}# ${e.command}`;
      const out = e.output ? `\n${e.output}` : '';
      const end = e.status === 'done' ? `\n[exit ${e.exitCode ?? '—'}${e.durationMs ? `, ${e.durationMs}ms` : ''}]` : '';
      return `${prompt}${out}${end}`;
    });
    navigator.clipboard?.writeText(lines.join('\n\n'));
  };

  const handleClear = () => {
    setHistory([]);
  };

  const activeGate = gates[0];
  const gateCmd = activeGate
    ? (typeof activeGate.meta?.command === 'string' ? activeGate.meta.command : activeGate.text)
    : '';

  return (
    <div className="falador-terminal" role="region" aria-label="Terminal de Execuções">
      <div className="falador-terminal-bar">
        <div className="falador-terminal-tags">
          <span className="falador-terminal-dot" title="Terminal Ativo" />
          <span className="falador-terminal-title">TERMINAL</span>
          {history.length > 0 && (
            <Tag size="sm" type="gray">
              {history[history.length - 1].host}
            </Tag>
          )}
          <Tag size="sm" type={history.some((e) => e.status === 'running') ? 'cyan' : 'green'}>
            {history.some((e) => e.status === 'running') ? 'executando...' : 'pronto'}
          </Tag>
        </div>
        <div className="falador-terminal-actions">
          <Button
            kind="ghost"
            size="sm"
            onClick={() => setAutoScroll(!autoScroll)}
            className={autoScroll ? 'term-action-active' : ''}
          >
            Auto-scroll: {autoScroll ? 'ON' : 'OFF'}
          </Button>
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Copy}
            hasIconOnly
            iconDescription="Copiar saída do terminal"
            onClick={handleCopy}
            disabled={history.length === 0}
          />
          <Button
            kind="ghost"
            size="sm"
            renderIcon={TrashCan}
            hasIconOnly
            iconDescription="Limpar tela do terminal"
            onClick={handleClear}
            disabled={history.length === 0}
          />
        </div>
      </div>

      <div className="falador-terminal-screen" ref={termBodyRef}>
        {history.length === 0 && !activeGate && (
          <div className="falador-terminal-welcome">
            <p>Falador Terminal · Sessão persistente ativa</p>
            <p className="term-dim">Nenhum comando executado ainda. Comandos aprovados aparecerão aqui linha por linha sem apagar a tela.</p>
          </div>
        )}

        {history.map((entry) => {
          const isRunning = entry.status === 'running';
          const isErr = entry.exitCode !== null && entry.exitCode !== 0;
          return (
            <div key={entry.id} className="term-entry">
              <div className="term-line term-prompt-line">
                <span className="term-ts">[{new Date(entry.ts).toLocaleTimeString()}]</span>
                <span className="term-user-host">{entry.host}</span>
                <span className="term-sep">:</span>
                <span className="term-cwd">~</span>
                <span className="term-prompt-char">#</span>
                <span className="term-cmd">{entry.command}</span>
                {entry.dryRun && <span className="term-dryrun-badge">[DRY-RUN]</span>}
              </div>

              {entry.output && (
                <pre className="term-output-block">
                  {entry.stdout && <span className="term-stdout">{entry.stdout}</span>}
                  {entry.stderr && <span className="term-stderr">{entry.stderr}</span>}
                  {!entry.stdout && !entry.stderr && entry.output}
                </pre>
              )}

              {isRunning && (
                <div className="term-running-indicator">
                  <span className="term-cursor">▋</span>
                  <span className="term-dim">executando no servidor remoto...</span>
                </div>
              )}

              {!isRunning && (
                <div className="term-exit-line">
                  <span className={isErr ? 'term-exit-err' : 'term-exit-ok'}>
                    [processo concluído: saída {entry.exitCode ?? '—'}{entry.durationMs ? `, ${entry.durationMs}ms` : ''}]
                  </span>
                </div>
              )}
            </div>
          );
        })}

        {activeGate && (
          <div className="term-gate-prompt-box">
            <div className="term-gate-box-head">
              <span className="term-gate-badge">⚠ APROVAÇÃO PENDENTE</span>
              <span className="term-gate-host">
                {String(activeGate.meta?.host ?? 'servidor')}
              </span>
            </div>
            <p className="term-gate-reason">{activeGate.text}</p>
            <div className="term-gate-input-row">
              <span className="term-prompt-char">#</span>
              <TextInput
                id="term-gate-input"
                hideLabel
                labelText="Comando"
                size="sm"
                className="term-gate-field"
                value={gateDrafts[activeGate.nodeId] ?? gateCmd}
                onChange={(e) =>
                  setGateDrafts((d) => ({ ...d, [activeGate.nodeId]: e.target.value }))
                }
              />
            </div>
            <div className="term-gate-btns">
              <Button
                kind="primary"
                size="sm"
                onClick={() =>
                  void onApprove?.(
                    activeGate,
                    gateDrafts[activeGate.nodeId] ?? gateCmd,
                  )
                }
              >
                Aprovar e Executar
              </Button>
              <Button
                kind="danger--tertiary"
                size="sm"
                onClick={() =>
                  void onReject?.(
                    activeGate,
                    gateDrafts[activeGate.nodeId] ?? gateCmd,
                  )
                }
              >
                Rejeitar
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
