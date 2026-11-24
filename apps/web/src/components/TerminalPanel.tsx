// TerminalPanel — Terminal PTY real embutido na tela com xterm.js + PTY backend.
// Suporte a shell interativo real, ANSI colors, redimensionamento (SIGWINCH), reconexão via buffer e fila ordenada de digitação.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Tag } from '@carbon/react';
import { Copy, Renew, TrashCan } from '@carbon/icons-react';
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

const STORAGE_KEY = 'falador.terminalSessionId';

function decodeBase64Bytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function TerminalPanel(_props: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const pendingInputRef = useRef<string[]>([]);
  const flushingInputRef = useRef(false);
  const resizeTimerRef = useRef<number | null>(null);
  const disposedRef = useRef(false);

  const [connected, setConnected] = useState(false);
  const [shellName, setShellName] = useState('zsh');

  const flushInput = useCallback(async () => {
    if (flushingInputRef.current) return;
    flushingInputRef.current = true;
    try {
      while (pendingInputRef.current.length > 0) {
        const sid = sessionIdRef.current;
        if (!sid) {
          pendingInputRef.current.length = 0;
          break;
        }
        const chunk = pendingInputRef.current.splice(0).join('');
        if (!chunk) continue;
        await fetch('/api/terminal/input', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sid, data: chunk }),
        });
      }
    } catch {
      // ignora erro transitório de rede
    } finally {
      flushingInputRef.current = false;
      if (pendingInputRef.current.length > 0 && sessionIdRef.current) {
        void flushInput();
      }
    }
  }, []);

  const connectSession = useCallback(async (term: Terminal, reuseId?: string | null) => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setConnected(false);

    try {
      const resp = await fetch('/api/terminal/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(reuseId ? { id: reuseId } : {}),
          cols: term.cols,
          rows: term.rows,
        }),
      });
      if (!resp.ok || disposedRef.current) return;
      const data = await resp.json() as { id: string; shell?: string };
      if (disposedRef.current) return;

      sessionIdRef.current = data.id;
      try {
        sessionStorage.setItem(STORAGE_KEY, data.id);
      } catch { /* ignore storage errors */ }

      const baseShell = String(data.shell || 'zsh').split('/').pop() || 'zsh';
      setShellName(baseShell);

      const es = new EventSource(`/api/terminal/stream?id=${encodeURIComponent(data.id)}`);
      esRef.current = es;

      es.onopen = () => {
        if (!disposedRef.current) setConnected(true);
      };

      es.addEventListener('output', (ev) => {
        if (disposedRef.current) return;
        try {
          const parsed = JSON.parse((ev as MessageEvent).data) as { data?: string };
          if (typeof parsed.data === 'string' && parsed.data.length > 0) {
            term.write(decodeBase64Bytes(parsed.data));
          }
        } catch { /* ignore malformed frame */ }
      });

      es.addEventListener('exit', () => {
        if (!disposedRef.current) setConnected(false);
        es.close();
        if (esRef.current === es) esRef.current = null;
      });

      es.onerror = () => {
        if (!disposedRef.current && es.readyState === EventSource.CLOSED) {
          setConnected(false);
        }
      };
    } catch {
      if (!disposedRef.current) setConnected(false);
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current || termRef.current) return;
    disposedRef.current = false;

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

    const dataDisp = term.onData((data) => {
      pendingInputRef.current.push(data);
      void flushInput();
    });

    let storedId: string | null = null;
    try {
      storedId = sessionStorage.getItem(STORAGE_KEY);
    } catch { /* ignore */ }
    void connectSession(term, storedId);

    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch { /* ignore */ }
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        const sid = sessionIdRef.current;
        if (!sid || disposedRef.current) return;
        void fetch('/api/terminal/resize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sid, cols: term.cols, rows: term.rows }),
        }).catch(() => {});
      }, 60);
    });
    ro.observe(containerRef.current);

    return () => {
      disposedRef.current = true;
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      ro.disconnect();
      dataDisp.dispose();
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [connectSession, flushInput]);

  const handleNewSession = async () => {
    const term = termRef.current;
    if (!term) return;
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    const oldId = sessionIdRef.current;
    sessionIdRef.current = null;
    pendingInputRef.current.length = 0;
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }
    if (oldId) {
      await fetch(`/api/terminal/session?id=${encodeURIComponent(oldId)}`, { method: 'DELETE' }).catch(() => {});
    }
    term.reset();
    await connectSession(term, null);
    term.focus();
  };

  const handleClear = () => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
  };

  const handleCopy = () => {
    const term = termRef.current;
    if (!term) return;
    const existing = term.getSelection();
    if (existing) {
      navigator.clipboard?.writeText(existing);
      return;
    }
    term.selectAll();
    const text = term.getSelection();
    term.clearSelection();
    if (text) navigator.clipboard?.writeText(text);
  };

  return (
    <div className="falador-terminal" role="region" aria-label="Terminal Real xterm.js">
      <div className="falador-terminal-bar">
        <div className="falador-terminal-tags">
          <span
            className={`falador-terminal-dot${connected ? '' : ' falador-terminal-dot--disconnected'}`}
            title={connected ? `${shellName} conectado` : 'desconectado'}
          />
          <span className="falador-terminal-title">TERMINAL (PTY)</span>
          <Tag size="sm" type={connected ? 'green' : 'red'}>
            {connected ? `${shellName} · conectado` : 'desconectado'}
          </Tag>
        </div>
        <div className="falador-terminal-actions">
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Renew}
            onClick={() => void handleNewSession()}
          >
            Nova sessão
          </Button>
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
      <div className="falador-xterm-container" ref={containerRef} />
    </div>
  );
}
