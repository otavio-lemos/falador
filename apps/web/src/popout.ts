// Janelas pop-out: cada painel abre em uma janela própria NOMEADA (uma por painel).
// Clique repetido só foca a janela existente (não recarrega). O popup reusa o MESMO
// LiveView em modo `popout`, anexado ao run atual por SSE — nunca inicia um run.
export type PopoutPanel = 'chat' | 'terminal' | 'logs' | 'audit' | 'log';

export interface PopoutOptions {
  width?: number;
  height?: number;
  // Para painel 'log' (e opcional em 'terminal'): serviceId ('omlx' | 'asr' | 'tts' | 'web')
  serviceId?: string;
}

const KNOWN_SERVICES = new Set(['omlx', 'asr', 'tts', 'web']);

// Referências por painel para focar em vez de recarregar.
// Para 'log' e 'terminal', a chave inclui o serviceId.
const openWindows: Partial<Record<PopoutPanel, Window | null>> = {};
const openLogWindows: Record<string, Window | null> = {};
const openTerminalWindows: Record<string, Window | null> = {};

export function openPopout(panel: PopoutPanel, flowName?: string, opts: PopoutOptions = {}): Window | null {
  if (panel === 'log') {
    // Defesa em profundidade: se chamarem openPopout('log', 'omlx') sem opts.serviceId,
    // reconhece o nome do serviço e ainda abre a janela individual corretamente.
    const svc = opts.serviceId || (flowName && KNOWN_SERVICES.has(flowName) ? flowName : undefined);
    const actualFlow = opts.serviceId ? flowName : (flowName && KNOWN_SERVICES.has(flowName) ? undefined : flowName);
    if (!svc) return null;
    const existing = openLogWindows[svc];
    if (existing && !existing.closed) {
      existing.focus();
      return existing;
    }
    const width = opts.width ?? 980;
    const height = opts.height ?? 640;
    const query = actualFlow
      ? `?flow=${encodeURIComponent(actualFlow)}&service=${encodeURIComponent(svc)}`
      : `?service=${encodeURIComponent(svc)}`;
    const win = window.open(
      `/popout/log${query}`,
      `falador-popout-log-${svc}`,
      `popup=yes,width=${width},height=${height}`,
    );
    openLogWindows[svc] = win;
    win?.focus();
    return win;
  }
  if (panel === 'terminal') {
    const svc = opts.serviceId;
    const existing = svc ? openTerminalWindows[svc] : openTerminalWindows['all'];
    if (existing && !existing.closed) {
      existing.focus();
      return existing;
    }
    const width = opts.width ?? 980;
    const height = opts.height ?? 640;
    const query = flowName
      ? `?flow=${encodeURIComponent(flowName)}${svc ? `&service=${encodeURIComponent(svc)}` : ''}`
      : (svc ? `?service=${encodeURIComponent(svc)}` : '');
    const win = window.open(
      `/popout/terminal${query}`,
      svc ? `falador-popout-terminal-${svc}` : 'falador-popout-terminal',
      `popup=yes,width=${width},height=${height}`,
    );
    if (svc) {
      openTerminalWindows[svc] = win;
    } else {
      openTerminalWindows['all'] = win;
    }
    win?.focus();
    return win;
  }
  const existing = openWindows[panel];
  if (existing && !existing.closed) {
    existing.focus();
    return existing;
  }
  const width = opts.width ?? (panel === 'chat' ? 720 : 980);
  const height = opts.height ?? (panel === 'chat' ? 820 : 640);
  const query = flowName ? `?flow=${encodeURIComponent(flowName)}` : '';
  const win = window.open(
    `/popout/${panel}${query}`,
    `falador-popout-${panel}`,
    `popup=yes,width=${width},height=${height}`,
  );
  openWindows[panel] = win;
  win?.focus();
  return win;
}

// Export for testing
if (typeof window !== 'undefined') {
  (window as unknown as { __openPopoutForTest: typeof openPopout }).__openPopoutForTest = openPopout;
}
