// Janelas pop-out: cada painel abre em uma janela própria NOMEADA (uma por painel).
// Clique repetido só foca a janela existente (não recarrega). O popup reusa o MESMO
// LiveView em modo `popout`, anexado ao run atual por SSE — nunca inicia um run.
export type PopoutPanel = 'chat' | 'terminal' | 'logs';

interface PopoutOptions {
  width?: number;
  height?: number;
}

// Referências por painel para focar em vez de recarregar.
const openWindows: Partial<Record<PopoutPanel, Window | null>> = {};

export function openPopout(panel: PopoutPanel, flowName?: string, opts: PopoutOptions = {}): Window | null {
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
