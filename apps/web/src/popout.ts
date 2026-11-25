// Janelas pop-out: cada painel abre em uma janela própria NOMEADA (uma por painel).
// Clique repetido só foca a janela existente (não recarrega). O popup reusa o MESMO
// LiveView em modo `popout`, anexado ao run atual por SSE — nunca inicia um run.
export type PopoutPanel = 'chat' | 'terminal' | 'logs' | 'log';

export interface PopoutOptions {
  width?: number;
  height?: number;
  // Para painel 'log': serviceId obrigatório (ex.: 'omlx', 'asr', 'tts', 'web')
  serviceId?: string;
}

// Referências por painel para focar em vez de recarregar.
// Para 'log', a chave inclui o serviceId.
const openWindows: Partial<Record<PopoutPanel, Window | null>> = {};
const openLogWindows: Record<string, Window | null> = {};

export function openPopout(panel: PopoutPanel, flowName?: string, opts: PopoutOptions = {}): Window | null {
  if (panel === 'log') {
    const svc = opts.serviceId;
    if (!svc) return null;
    const existing = openLogWindows[svc];
    if (existing && !existing.closed) {
      existing.focus();
      return existing;
    }
    const width = opts.width ?? 980;
    const height = opts.height ?? 640;
    const query = flowName ? `?flow=${encodeURIComponent(flowName)}&service=${encodeURIComponent(svc)}` : `?service=${encodeURIComponent(svc)}`;
    const win = window.open(
      `/popout/log${query}`,
      `falador-popout-log-${svc}`,
      `popup=yes,width=${width},height=${height}`,
    );
    openLogWindows[svc] = win;
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
