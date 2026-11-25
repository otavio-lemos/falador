// Janela pop-out de UM painel (Conversa | Terminal | Logs | Log individual), idêntica à página central.
// Reusa o mesmo LiveView em modo `popout` e o mesmo runner, mas em modo "espelho":
// anexa ao run atual por SSE (useMirrorRunner) sem iniciar nada. Interativo.
import { useEffect, useMemo, useState } from 'react';
import { Theme } from '@carbon/react';
import { LiveView } from './LiveView';
import { fetchFlow, type Flow } from '../api';
import { useMirrorRunner } from '../useRunner';
import type { PopoutPanel } from '../popout';
import './popout.scss';

function panelFromPath(): PopoutPanel {
  const m = location.pathname.match(/^\/popout\/(chat|terminal|logs|log)/);
  return (m?.[1] as PopoutPanel) ?? 'chat';
}

export function PopoutView() {
  const panel = panelFromPath();
  const search = new URLSearchParams(location.search);
  const flowName = search.get('flow') ?? '';
  const serviceId = search.get('service') ?? '';
  const runner = useMirrorRunner();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!flowName) { setError('Fluxo não informado na URL (use /popout/<painel>?flow=<nome>).'); return; }
    let alive = true;
    fetchFlow(flowName)
      .then((f) => { if (alive) setFlow(f); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [flowName]);

  // Entrada de chat quando o fluxo tem input.chat (mesma regra do App).
  const inputMode = useMemo<'apps' | 'chat'>(() => {
    if (!flow) return 'chat';
    return flow.nodes.some((n) => n.type === 'input.chat') ? 'chat' : 'apps';
  }, [flow]);

  const noop = () => { /* janela espelho: ações que mudam o flow não se aplicam */ };

  if (panel === 'log') {
    if (!serviceId) {
      return (
        <Theme theme="g100">
          <div className="popout-fallback" role="alert">Serviço de log não informado na URL (use /popout/log?service=omlx|asr|tts|web).</div>
        </Theme>
      );
    }
    if (!flow) {
      return (
        <Theme theme="g100">
          <div className="popout-fallback">Carregando fluxo…</div>
        </Theme>
      );
    }
    return (
      <Theme theme="g100">
        <LiveView
          popout={"log"}
          runner={runner}
          flow={flow}
          scenarioName=""
          theme="g100"
          onToggleTheme={noop}
          inputMode={inputMode}
          outputMode="write"
          onToggleMicMute={noop}
          onToggleOutputMode={noop}
          models={{ omlx: [], cache: [] }}
          apps={[]}
          contextDocs={[]}
          onUploadDoc={noop}
          onRemoveDoc={noop}
          onStart={noop}
          flows={[]}
          currentFlow={flowName}
          onSwitchFlow={noop}
          onUpdateStage={noop}
          onRegenerate={noop}
          onServiceStatus={noop}
          onNotify={noop}
          onGoBuilder={noop}
          onExit={noop}
          onReset={noop}
          resetSignal={0}
        />
      </Theme>
    );
  }

  return (
    <Theme theme="g100">
      {error ? (
        <div className="popout-fallback" role="alert">{error}</div>
      ) : !flow ? (
        <div className="popout-fallback">Carregando fluxo…</div>
      ) : (
        <LiveView
          popout={panel}
          runner={runner}
          flow={flow}
          scenarioName=""
          theme="g100"
          onToggleTheme={noop}
          inputMode={inputMode}
          outputMode="write"
          onToggleMicMute={noop}
          onToggleOutputMode={noop}
          models={{ omlx: [], cache: [] }}
          apps={[]}
          contextDocs={[]}
          onUploadDoc={noop}
          onRemoveDoc={noop}
          onStart={noop}
          flows={[]}
          currentFlow={flowName}
          onSwitchFlow={noop}
          onUpdateStage={noop}
          onRegenerate={noop}
          onServiceStatus={noop}
          onNotify={noop}
          onGoBuilder={noop}
          onExit={noop}
          onReset={noop}
          resetSignal={0}
        />
      )}
    </Theme>
  );
}
