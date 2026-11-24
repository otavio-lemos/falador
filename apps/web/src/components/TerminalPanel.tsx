// TerminalPanel — Terminal de verdade embutido na tela com xterm.js real.
// Suporte a ANSI colors, cursor piscante, digitação interativa, fit dinâmico e scrollback persistente.
import { useEffect, useRef } from 'react';
import { Button, Tag } from '@carbon/react';
import { Copy, TrashCan } from '@carbon/icons-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Execution, Gate } from '../useRunner';
import './terminal-panel.scss';

export interface TerminalPanelProps {
  executions?: Execution[];
  gates?: Gate[];
  onApprove?: (gate: Gate, text: string) => Promise<void> | void;
  onReject?: (gate: Gate, reason?: string) => Promise<void> | void;
}

export function TerminalPanel({ executions = [], gates = [], onApprove, onReject }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const writtenExecIdsRef = useRef<Set<string>>(new Set());
  const writtenChunksCountRef = useRef<Map<string, number>>(new Map());
  const promptActiveRef = useRef(false);
  const lineBufferRef = useRef('');

  // 1. Inicializa o XTerm real uma única vez
  useEffect(() => {
    if (!containerRef.current) return;
    if (termRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: '"IBM Plex Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.45,
      scrollback: 5000,
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: '#1f6feb',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#f0f6fc',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#ffffff',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Mensagem de boas-vindas inicial no xterm real
    term.writeln('\x1b[1;36mFalador Terminal\x1b[0m · Emulador interativo real (xterm.js)');
    term.writeln('\x1b[90mSessão persistente ativa. Comandos e saídas do agente rolam aqui em tempo real sem apagar.\x1b[0m');
    term.writeln('');
    term.write('\x1b[1;32mfalador\x1b[0m:\x1b[1;34m~\x1b[0m$ ');
    promptActiveRef.current = true;

    // Permite digitação interativa no xterm
    term.onData((data) => {
      // Enter
      if (data === '\r' || data === '\n') {
        const cmd = lineBufferRef.current.trim();
        lineBufferRef.current = '';
        term.writeln('');
        if (cmd) {
          if (gates.length > 0 && onApprove) {
            void onApprove(gates[0], cmd);
          } else {
            term.writeln(`\x1b[90m[comando recebido: ${cmd}]\x1b[0m`);
            term.write('\x1b[1;32mfalador\x1b[0m:\x1b[1;34m~\x1b[0m$ ');
          }
        } else {
          term.write('\x1b[1;32mfalador\x1b[0m:\x1b[1;34m~\x1b[0m$ ');
        }
        return;
      }

      // Backspace
      if (data === '\x7f' || data === '\b') {
        if (lineBufferRef.current.length > 0) {
          lineBufferRef.current = lineBufferRef.current.slice(0, -1);
          term.write('\b \b');
        }
        return;
      }

      // Ctrl+C
      if (data === '\x03') {
        lineBufferRef.current = '';
        term.writeln('^C');
        term.write('\x1b[1;32mfalador\x1b[0m:\x1b[1;34m~\x1b[0m$ ');
        return;
      }

      // Digitação normal
      lineBufferRef.current += data;
      term.write(data);
    });

    // ResizeObserver para manter o terminal ajustado à largura/altura da tela
    const ro = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // 2. Transmite execuções do agente em tempo real para o XTerm
  useEffect(() => {
    const term = termRef.current;
    if (!term || executions.length === 0) return;

    for (const e of executions) {
      const isNew = !writtenExecIdsRef.current.has(e.id);
      if (isNew) {
        writtenExecIdsRef.current.add(e.id);
        writtenChunksCountRef.current.set(e.id, 0);

        // Se havia prompt aberto, pula linha
        term.writeln('');
        const hostTag = e.host || 'servidor';
        const ts = new Date(e.ts || Date.now()).toLocaleTimeString();
        term.writeln(`\x1b[90m[${ts}]\x1b[0m \x1b[1;32m${hostTag}\x1b[0m:\x1b[1;34m~\x1b[0m# \x1b[1;37m${e.command}\x1b[0m${e.dryRun ? ' \x1b[33m[DRY-RUN]\x1b[0m' : ''}`);
      }

      // Chunks de streaming (stdout / stderr)
      const prevCount = writtenChunksCountRef.current.get(e.id) ?? 0;
      const chunks = e.chunks ?? [];
      if (chunks.length > prevCount) {
        for (let i = prevCount; i < chunks.length; i++) {
          const chunk = chunks[i];
          const color = chunk.stream === 'stderr' ? '\x1b[31m' : '';
          const reset = chunk.stream === 'stderr' ? '\x1b[0m' : '';
          // Converte quebras de linha para CRLF exigidas pelo xterm
          const formatted = chunk.text.replace(/\r?\n/g, '\r\n');
          term.write(`${color}${formatted}${reset}`);
        }
        writtenChunksCountRef.current.set(e.id, chunks.length);
      } else if (isNew && e.output && chunks.length === 0) {
        const formatted = e.output.replace(/\r?\n/g, '\r\n');
        term.writeln(formatted);
      }

      // Fim do comando
      if (e.status === 'done' && isNew) {
        const exitColor = e.exitCode === 0 ? '\x1b[32m' : '\x1b[31m';
        term.writeln(`${exitColor}[processo finalizado: saída ${e.exitCode ?? '—'}${e.durationMs ? `, ${e.durationMs}ms` : ''}]\x1b[0m`);
        term.write(`\x1b[1;32m${e.host || 'falador'}\x1b[0m:\x1b[1;34m~\x1b[0m# `);
      }
    }
  }, [executions]);

  // 3. Notifica gates pendentes direto no terminal
  useEffect(() => {
    const term = termRef.current;
    if (!term || gates.length === 0) return;
    const g = gates[0];
    term.writeln('');
    term.writeln(`\x1b[1;33m┌── [APROVAÇÃO NECESSÁRIA: ${g.nodeId}] ───────────────────────\x1b[0m`);
    term.writeln(`\x1b[33m│\x1b[0m ${g.text}`);
    term.writeln('\x1b[1;33m└─────────────────────────────────────────────────────────────\x1b[0m');
    term.write('\x1b[1;33mComando para aprovar/editar > \x1b[0m');
  }, [gates]);

  const handleClear = () => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    term.write('\x1b[1;32mfalador\x1b[0m:\x1b[1;34m~\x1b[0m$ ');
  };

  const handleCopy = () => {
    const term = termRef.current;
    if (!term) return;
    term.selectAll();
    const text = term.getSelection();
    term.clearSelection();
    if (text) navigator.clipboard?.writeText(text);
  };

  return (
    <div className="falador-terminal" role="region" aria-label="Terminal Real xterm.js">
      <div className="falador-terminal-bar">
        <div className="falador-terminal-tags">
          <span className="falador-terminal-dot" title="xterm.js Ativo" />
          <span className="falador-terminal-title">TERMINAL (XTERM.JS)</span>
          <Tag size="sm" type="cyan">interativo</Tag>
          <Tag size="sm" type="green">scrollback infinito</Tag>
        </div>
        <div className="falador-terminal-actions">
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Copy}
            hasIconOnly
            iconDescription="Copiar seleção do terminal"
            onClick={handleCopy}
          />
          <Button
            kind="ghost"
            size="sm"
            renderIcon={TrashCan}
            hasIconOnly
            iconDescription="Limpar tela"
            onClick={handleClear}
          />
        </div>
      </div>
      <div className="falador-xterm-container" ref={containerRef} />
    </div>
  );
}
