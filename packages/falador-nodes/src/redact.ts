// falador-nodes — redact.ts: mascaramento determinístico de segredos (zero deps, idempotente).

export interface RedactResult {
  text: string;
  hits: number;
}

export interface LineRedactor {
  push(chunk: string): RedactResult;
  flush(): RedactResult;
}

interface RedactRule {
  pattern: RegExp;
  replacement: string;
}

const REDACT_RULES: readonly RedactRule[] = [
  // 1. Blocos PEM
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:pem]',
  },
  // 2. Chaves AWS
  {
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED:aws_key]',
  },
  // 3. Tokens GitHub
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    replacement: '[REDACTED:github_token]',
  },
  // 4. Tokens GitLab
  {
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:gitlab_token]',
  },
  // 5. Chaves OpenAI/Anthropic
  {
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:api_key]',
  },
  // 6. Tokens Slack
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
    replacement: '[REDACTED:slack_token]',
  },
  // 7. Headers Authorization: Bearer / Basic (antes de JWT para virar 1 hit auth_header)
  {
    pattern: /\bAuthorization\s*:\s*(Bearer|Basic)\s+(?!\[REDACTED:[a-z_]+\])[^\s"']+/gi,
    replacement: 'Authorization: $1 [REDACTED:auth_header]',
  },
  // 8. JWTs
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: '[REDACTED:jwt]',
  },
  // 9. Credenciais em URLs
  {
    pattern: /(https?|postgres(?:ql)?|mysql|redis|amqp|mongodb(?:\+srv)?):\/\/(?!\[REDACTED:[a-z_]+\]@)[^:\s/@]+:[^@\s]+@/gi,
    replacement: '$1://[REDACTED:url_creds]@',
  },
  // 10. Atribuições (PASSWORD, SECRET, TOKEN, API_KEY, etc.)
  {
    pattern: /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH|DSN))\s*([:=])\s*(?!["']?\[REDACTED:[a-z_]+\]["']?)("[^"]+"|'[^']+'|[^\s]+)/gi,
    replacement: '$1$2[REDACTED:secret]',
  },
];

/** Mascara segredos conhecidos em `text` com marcadores `[REDACTED:<tipo>]`. Idempotente. */
export function redactSecrets(text: string): RedactResult {
  if (!text) return { text, hits: 0 };
  let out = text;
  let hits = 0;
  for (const rule of REDACT_RULES) {
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      hits++;
      const groups = args.slice(1, -2) as Array<string | undefined>;
      return rule.replacement.replace(/\$(\d+)/g, (_m, idx: string) => groups[Number(idx) - 1] ?? '');
    });
  }
  return { text: out, hits };
}

/** Mascara recursivamente strings dentro de objetos/arrays arbitrários (ex.: `args` de auditoria). */
export function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value).text;
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactUnknown(v);
    }
    return out;
  }
  return value;
}

/**
 * Redactor com buffer de linha incompleta para chunk streaming:
 * mantém o sufixo sem `\n` em buffer até a próxima quebra de linha ou `flush()`.
 */
export function createLineRedactor(): LineRedactor {
  let buffer = '';

  return {
    push(chunk: string): RedactResult {
      if (!chunk) return { text: '', hits: 0 };
      buffer += chunk;
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline === -1) {
        return { text: '', hits: 0 };
      }
      const complete = buffer.slice(0, lastNewline + 1);
      buffer = buffer.slice(lastNewline + 1);
      return redactSecrets(complete);
    },
    flush(): RedactResult {
      if (!buffer) return { text: '', hits: 0 };
      const rest = buffer;
      buffer = '';
      return redactSecrets(rest);
    },
  };
}
