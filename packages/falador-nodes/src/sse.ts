// falador-nodes — helpers HTTP/SSE (ZERO dependências; Node >= 22 fetch/WebSocket nativos)

/**
 * Header de autenticação do omlx (:8080). O omlx >= 0.8 exige API key para binds
 * não-loopback; sem ela o /v1/chat/completions responde 401 "API key required".
 * Vem de FALADOR_OMLX_API_KEY (faladorctl exporta a partir de .env.falador).
 */
export function omlxAuthHeaders(): Record<string, string> {
  const key = process.env.FALADOR_OMLX_API_KEY?.trim();
  return key ? { authorization: `Bearer ${key}` } : {};
}

/** POST JSON e devolve o body como Uint8Array. */
export async function postJsonBytes(
  url: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...omlxAuthHeaders() },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} de ${url}: ${txt.slice(0, 200)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface SseHandler {
  /** Por evento `data:` analisado (JSON válido apenas). */
  onData(json: unknown): void;
  /** Chamado no encerramento normal ([DONE]. */
  onDone?(): void;
}

/**
 * Executa POST com resposta SSE e consome o stream.
 * Retorna quando o stream termina (ou erro/abort).
 */
export async function postSse(
  url: string,
  body: unknown,
  handler: SseHandler,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...omlxAuthHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} de ${url}: ${txt.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        handler.onDone?.();
        return;
      }
      try {
        handler.onData(JSON.parse(data));
      } catch {
        /* data não-JSON: ignora (comentário SSE) */
      }
    }
  }
  handler.onDone?.();
}

/** Extrai texto de payload phrase | tokens_parcial. Retorna null se irrelevante. */
export function payloadText(payload: unknown): { text: string; final: boolean } | null {
  if (typeof payload === 'string') return { text: payload, final: true };
  if (payload && typeof payload === 'object' && typeof (payload as any).text === 'string') {
    const p = payload as { text: string; final?: boolean };
    return { text: p.text, final: p.final !== false };
  }
  return null;
}
