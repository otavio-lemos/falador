// TerminalPanel — Transcrito em tempo real dos comandos executados na sessão (SSH persistente / local).
// Sem a caixa secundária de 170px do PTY local: 100% da área útil mostra a sessão do servidor.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Tag } from '@carbon/react';
import { Copy, TrashCan } from '@carbon/icons-react';
import type { Execution, Gate } from '../useRunner';
import './terminal-panel.scss';

export interface TerminalPanelProps {
  executions?: Execution[];
  gates?: Gate[];
  onApprove?: (gate: Gate, text: string) => Promise<void> | void;
  onReject?: (gate: Gate, reason?: string) => Promise<void> | void;
  /** Filtra execuções por serviço (omlx, asr, tts, web) */
  forceService?: string;
}

export function TerminalPanel({ executions = [], forceService }: TerminalPanelProps) {
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [clearedAtCount, setClearedAtCount] = useState(0);

  useEffect(() => {
    if (executions.length === 0 && clearedAtCount !== 0) {
      setClearedAtCount(0);
    }
  }, [executions.length, clearedAtCount]);

  const visibleExecutions = useMemo(
    () => (clearedAtCount > 0 ? executions.slice(clearedAtCount) : executions),
    [executions, clearedAtCount],
  );

  const filteredExecutions = useMemo(() => {
    if (!forceService) return visibleExecutions;
    return visibleExecutions.filter((e) => {
      const tool = (e.tool || '').toLowerCase();
      const host = (e.host || '').toLowerCase();
      switch (forceService) {
        case 'omlx':
          return tool.includes('omlx') || tool.includes('llm') || tool.includes('agent') || tool.includes('decision') || tool.includes('goal') || tool.includes('exec_') || tool.includes('rag') || tool.includes('workflow') || tool.includes('mcp');
        case 'asr':
          return tool.includes('asr') || tool.includes('voxtral') || tool.includes('whisper') || host.includes('asr');
        case 'tts':
          return tool.includes('tts') || tool.includes('speech') || host.includes('tts');
        case 'web':
          return tool.includes('web') || tool.includes('search') || tool.includes('crawler') || tool.includes('fetch') || host.includes('web');
        default:
          return true;
      }
    });
  }, [visibleExecutions, forceService]);

  // Rola o transcrito para o fim conforme novos comandos/chunks chegam.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filteredExecutions]);

  const lastExec = filteredExecutions[filteredExecutions.length - 1];
  const hasActiveSession = filteredExecutions.length > 0;
  const sessionLabel = lastExec
    ? lastExec.transport === 'ssh' && lastExec.host && lastExec.host !== 'local'
      ? `ssh · ${lastExec.host} · sessão persistente`
      : `${lastExec.transport || 'local'} · ${lastExec.host || 'local'}`
    : 'aguardando comandos';

  const handleClear = () => {
    setClearedAtCount(executions.length);
  };

  const handleCopy = () => {
    const text = filteredExecutions
      .map((e) => {
        const parts = [`$ ${e.command || '—'}`];
        if (e.stdout) parts.push(e.stdout.trimEnd());
        if (e.stderr) parts.push(e.stderr.trimEnd());
        return parts.join('\n');
      })
      .join('\n\n');
    if (text) navigator.clipboard?.writeText(text);
  };

  return (
    <div className="falador-terminal" role="region" aria-label="Terminal de Execuções">
      <div className="falador-terminal-bar">
        <div className="falador-terminal-tags">
          <span
            className={`falador-terminal-dot${hasActiveSession ? '' : ' falador-terminal-dot--disconnected'}`}
            title={sessionLabel}
          />
          <span className="falador-terminal-title">TERMINAL</span>
          <Tag size="sm" type={hasActiveSession ? 'green' : 'gray'}>
            {sessionLabel}
          </Tag>
        </div>
        <div className="falador-terminal-actions">
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Copy}
            hasIconOnly
            iconDescription="Copiar"
            onClick={handleCopy}
          />
          <Button
            kind="ghost"
            size="sm"
            renderIcon={TrashCan}
            hasIconOnly
            iconDescription="Limpar"
            onClick={handleClear}
          />
        </div>
      </div>
      <div className="falador-terminal-transcript" ref={transcriptRef} aria-label="Comandos executados">
        {filteredExecutions.length === 0 ? (
          <div className="ftr-empty">Nenhum comando executado nesta sessão ainda.</div>
        ) : (
          filteredExecutions.map((e, i) => {
            const failed = e.status === 'done' && e.exitCode !== 0;
            return (
              <div key={e.id || i} className={`ftr-exec${failed ? ' ftr-exec--fail' : e.status === 'running' ? ' ftr-exec--run' : ' ftr-exec--ok'}`}>
                <div className="ftr-cmd">
                  <span className="ftr-prompt">$</span>
                  <span className="ftr-cmd-text">{e.command || '—'}</span>
                  <span className="ftr-meta">
                    {e.host && e.host !== 'local' ? `${e.host} · ` : ''}{e.transport}
                    {e.exitCode != null ? ` · exit ${e.exitCode}` : e.status === 'running' ? ' · rodando…' : ''}
                    {typeof e.durationMs === 'number' ? ` · ${Math.round(e.durationMs)} ms` : ''}
                  </span>
                </div>
                {e.stdout ? <pre className="ftr-out">{e.stdout}</pre> : null}
                {e.stderr ? <pre className="ftr-err">{e.stderr}</pre> : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
