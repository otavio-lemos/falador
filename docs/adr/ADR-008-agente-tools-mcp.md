# ADR-008 — Agente Multi-Step com Tools Bidirecionais (`agent.tools`) + Conector MCP (`tool.mcp`)

**Status:** IMPLEMENTADO — 2026-11-21 (Fases 1–5 implementadas e auditadas via Orca Orchestration `run_664a493b15cf`: 84/84 testes PASS + 1 skip N7, 7/7 `validateFlow`, `tsc`+`vite build` OK, E2E ao vivo no `omlx :8080` 556 ms com `agent.tools` ↔ `exec_local` `uptime` 11 ms + gate + audit log; MCP server real externo e SSH em host remoto real: `NÃO VERIFICADO`)
**Depende de:** ADR-003 (canvas/nada fixo), ADR-006 (*barge-in* `interrupt`, `turn.detector`, `trace`, reset de contexto), ADR-007 (RAG BM25 `context-store.ts`, `exec.command` local/SSH com 4 camadas de segurança), `spec-falador-graph.md` v1.1

---

## 1. Contexto e Motivação

O [ADR-007](ADR-007-rag-runbooks-conector-exec.md) viabilizou o primeiro fluxo de Ops/SRE (`revisao-servidor-ops.json`), porém em formato **single-shot (1 passo fixo)**:

`pergunta → planejador LLM (1 comando) → d1 → gate → exec.command → analista LLM`

Para um **agente de suporte técnico real**, um único comando raramente resolve o diagnóstico. O agente precisa investigar de forma iterativa e escolher ferramentas diferentes conforme o resultado de cada passo:

1. Chama `ssh_exec(host="prod-01", command="systemctl status nginx")` → recebe `failed (exit=3)`.
2. Decide ler os últimos logs: `ssh_exec(host="prod-01", command="journalctl -u nginx -n 40")`.
3. Consulta um runbook local (`rag_search("nginx 502 upstream timeout")`) ou um servidor MCP (ex.: Grafana/Kubernetes/Jira/Postgres).
4. Só então sintetiza a causa raiz (e opcionalmente propõe uma ação sujeita a aprovação humana).

### 1.1 O problema central: retorno do conector sem quebrar o DAG

- O motor `falador-graph` é um **DAG acíclico** (Spec C5 rejeita ciclos entre arestas de dados).
- Numa aresta comum (esquerda → direita), o nó emite um `Envelope` e não recebe retorno.
- Numa **Tool** (SSH, local, RAG, MCP), a comunicação precisa ser **bidirecional (request → response)**: o agente chama o conector com argumentos estruturados, aguarda o resultado (`stdout`, `stderr`, `exitCode`, JSON do MCP), injeta esse retorno como mensagem `role: "tool"` no LLM e decide o próximo passo.

### 1.2 Evidência empírica verificada no `omlx` 0.8.0 (M4 Pro, 2026-11-21)

Teste direto em `http://127.0.0.1:8080/v1/chat/completions` com `LFM3-1.7B-MLX-4bit` residente e `chat_template_kwargs: { enable_thinking: false }`:

- **Volta 1 (`tools` → `tool_calls`):** retornou `finish_reason: "tool_calls"` com `tool_calls[0].function = { name: "ssh_exec", arguments: "{\"host\":\"prod-01\",\"command\":\"uptime\"}" }` (TTFT 410 ms cold / 70,8 tok/s).
- **Volta 2 (`role: "tool"` → resposta final):** recebeu o retorno simulado do `uptime` e sintetizou a resposta em português com **TTFT 130 ms** (201,7 tok/s, 1383,6 prompt tok/s).

**Conclusão:** o `omlx` 0.8.0 já suporta nativamente o protocolo OpenAI `tools` / `tool_calls` / `role: "tool"` — **zero dependência nova no runtime de LLM**. (Para raciocínio multi-step mais complexo, o usuário pode selecionar modelos maiores já presentes no cache HF, como `Qwen3.5-9B` ou `Qwen3.8-27B`.)

---

## 2. Decisões Arquiteturais (T1–T6)

| # | Tema | Decisão |
|---|---|---|
| **T1** | **Porta bidirecional `tool` (estilo n8n AI Agent)** | Introduzir o tipo de porta `tool` no `falador-graph` com direção de **registro** (`provedor.tool → agent.tools`) sem violar o DAG acíclico: no `start()` do grafo, cada nó provedor (`exec.command`, `tool.mcp`, `rag.search`) expõe uma interface `ToolProvider` (`listTools()` + `invoke(name, args, ctx)`). O `agent.tools` chama `invoke(...)` de forma **request → response** e recebe o resultado diretamente de volta no loop. |
| **T2** | **Novo nó `agent.tools`** | Nó dedicado em `packages/falador-nodes/src/agent-tools.ts` que executa o loop OpenAI `tool_calls` com teto rígido (`maxSteps`, default `5`, máximo `12`), orçamento de saída por tool (`maxToolOutputChars`, default `8000`), triagem opcional via `d1-2B` (`/v1/systemone`), aprovação humana integrada (`__gate`), cancelamento imediato via `onControl('interrupt')` (aborta LLM e mata tool em voo), histórico deslizante + `reset_history`, e `trace` detalhando cada step. |
| **T3** | **Reutilização nativa de `exec.command` e `context-store` (L5)** | Em vez de duplicar código, `exec.command` passa a expor também a porta `tool` (`exec_local` / `exec_ssh`), reaproveitando **100%** do validador determinístico, denylist dura, `allowedPrefixes`, `allowedHosts`, `sshUser`, escape POSIX, `dryRun: true` default e `logs/exec-audit.jsonl` (ADR-007). Novo nó leve `rag.search` expõe `context-store.ts` (BM25) como tool sob demanda (`search_docs`). |
| **T4** | **Novo nó `tool.mcp` (zero deps)** | Cliente MCP (Model Context Protocol, JSON-RPC 2.0) em `packages/falador-nodes/src/tool-mcp.ts` usando apenas `spawn` (`shell: false`) para transporte **`stdio`** e `fetch` nativo para **`http` (Streamable HTTP)**. Faz handshake `initialize` + `tools/list`, expõe as ferramentas filtradas por `allowedTools` ao `agent.tools`, e executa `tools/call` devolvendo o resultado ao agente. |
| **T5** | **Segurança em camadas para Tools & MCP** | Toda tool marcada como mutável ou externa passa por: (1) `allowedTools` explícito no `tool.mcp`, (2) `dryRun: true` por padrão, (3) triagem `d1-2B` + gate `human.approve` configurável (`approvalPolicy: 'always' | 'non_readonly' | 'never'`, default `'always'` para `exec` e `mcp`), (4) audit log unificado em `logs/exec-audit.jsonl` (incluindo chamadas MCP), (5) sanitização/delimitação de retorno de tool para mitigar *indirect prompt injection*. |
| **T6** | **UX estilo n8n no Canvas + Timeline no LiveView** | No canvas (`FlowNode.tsx`), `agent.tools` exibe uma zona de conectores de **Tools** (com cor dedicada `#0ea5e9` / ícone de ferramenta) onde o usuário pluga visualmente `exec.command`, `tool.mcp` e `rag.search`. No `LiveView.tsx`, exibir a timeline ao vivo dos passos do agente (*Passo 1: `ssh_exec` → aguardando aprovação → ok (42 ms) → Passo 2: resposta final*). |

---

## 3. Desenho Técnico dos Contratos

### 3.1 Contrato `ToolProvider` (retorno bidirecional no motor)

Em `packages/falador-graph/src/types.ts`:

- Adicionar `'tool'` à união `PortType`:
  `export type PortType = 'pcm16k' | 'audio_chunk' | 'tokens_parcial' | 'phrase' | 'tool';`
- Definir os tipos leves de tool (zero deps):
  ```ts
  export interface ToolDef {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
    readonly?: boolean;                  // dica para approvalPolicy
    sourceNodeId: string;
  }

  export interface ToolCallResult {
    ok: boolean;
    output: string;
    exitCode?: number;
    dryRun?: boolean;
    durationMs: number;
    meta?: Record<string, unknown>;
  }

  export interface ToolProvider {
    listTools(): Promise<ToolDef[]> | ToolDef[];
    invoke(
      name: string,
      args: Record<string, unknown>,
      opts: { signal: AbortSignal; runId: string; callerNodeId: string },
    ): Promise<ToolCallResult>;
  }
  ```
- **Como funciona sem criar ciclo no DAG:**
  - A aresta no fluxo vai do provedor para o agente: `exec_ssh.tool -> agente.tools` e `mcp_k8s.tool -> agente.tools`.
  - **Exceção controlada à Spec V2 (`in-degree`):** apenas portas de tipo `'tool'` aceitam **múltiplas entradas (`in-degree >= 1`)**, pois representam um conjunto de ferramentas registradas no agente (ex.: 1 agente conectado a `exec_ssh`, `rag_docs` e `mcp_grafana` ao mesmo tempo).
  - No `runtime.ts`, `ctx.getTools?.(port)` retorna a lista de `ToolProvider`s dos nós conectados àquela porta `'tool'` — permitindo invocação direta `await provider.invoke(...)` com retorno síncrono/async para o `agent.tools`, **zero ciclo no grafo**.

### 3.2 Fluxo interno do nó `agent.tools`

```text
Entrada (in: phrase | parcs: tokens_parcial)
  │
  ▼
[1] Descobre tools via ctx.getTools('tools') → monta array OpenAI `tools`
  │
  ▼
[2] Loop step = 1 .. maxSteps:
      ├── Chama POST /v1/chat/completions (stream: false ou SSE) com `tools` + `enable_thinking: false`
      ├── Se abortado por `interrupt` → interrompe loop sem emitir `final: true` nem poluir `history`
      ├── Se resposta NÃO tem `tool_calls`:
      │     └── Emite `{ text: content, final: true }` na porta `out` + atualiza `history` → FIM
      └── Se resposta TEM `tool_calls`:
            Para cada call:
              ├── Emite evento de progresso (`agent_step`: calling tool + args) para a UI
              ├── Se `approvalPolicy` exigir (ou `d1` classificar como `sensivel`):
              │     └── Chama `__gate(preview, { tool, host, command, args, decision })`
              │         ├── Se rejeitado → devolve `role: "tool"` com `"Ação rejeitada pelo operador"`
              │         └── Se editado → aplica edição antes de invocar
              ├── Invoca `provider.invoke(call.name, args, { signal })`
              ├── Trunca `output` em `maxToolOutputChars` preservando o final (`[truncado]`)
              ├── Empacota retorno com delimitador anti-prompt-injection (`<tool_output name="...">...</tool_output>`)
              └── Adiciona `role: "tool"` às mensagens e volta ao passo [2]
  │
  ▼
Se bater `maxSteps` sem resposta final → faz 1 última chamada sem `tools` pedindo síntese do que foi coletado.
```

### 3.3 Especificação do nó `tool.mcp`

- **Arquivo:** `packages/falador-nodes/src/tool-mcp.ts`
- **Portas:** `inputs: []`, `outputs: [{ name: 'tool', type: 'tool', required: false }]`
- **Params:**
  - `serverName`: string (prefixo/namespace opcional nas tools para evitar colisão entre 2 MCPs, ex.: `grafana_query`)
  - `transport`: `'stdio' | 'http'` (default `'stdio'`)
  - `command`: string (para `stdio`, ex.: `'npx'` ou caminho absoluto de binário — validado contra denylist dura e `shell: false`)
  - `args`: `string[]` (para `stdio`)
  - `envAllowlist`: `string[]` (nomes de variáveis de ambiente do processo pai permitidas para repassar ao servidor MCP; **nunca** colocar tokens/senhas literais no JSON do fluxo!)
  - `url`: string (para `http` Streamable HTTP, validada contra `allowedUrls` ou `127.0.0.1`/`localhost` por padrão)
  - `allowedTools`: `string[]` (obrigatório ou explícito: lista de nomes de tools do servidor MCP que o agente pode enxergar e chamar; vazio = bloqueia chamadas por segurança até o usuário liberar)
  - `dryRun`: `boolean` (**default `true`**)
  - `timeoutMs`: `number` (default `15000`, máximo `60000`)
  - `auditLogPath`: `string` (default `'logs/exec-audit.jsonl'`)
- **Protocolo (JSON-RPC 2.0 puro, zero deps):**
  - `stdio`: framing por linha NDJSON (`\n`) sobre `stdin`/`stdout` do filho (`spawn(command, args, { shell: false })`), `stderr` redirecionado para logs do nó; `stop()` encerra o processo filho limpo (`SIGTERM` → `SIGKILL` em 1 s).
  - `http`: `POST` JSON-RPC 2.0 com `Accept: application/json, text/event-stream` e header `Mcp-Session-Id` quando retornado pelo servidor.
  - Métodos mínimos: `initialize` → `notifications/initialized` → `tools/list` → `tools/call`.

---

## 4. Fluxo de Referência: `agente-suporte-ops.json`

```text
[captura (mic / SCK)]
        │ pcm16k (drop_oldest, ttl 1500ms)
        ▼
[asr.realtime (Voxtral)]
   ├──→ [transcricao (sink.captions)]
   └──→ [turn.detector (d1-2B)]
                │ tokens_parcial
                ▼
         [agente (agent.tools)] ──→ [diagnostico (sink.captions)]
           ▲       ▲        ▲
      tool │  tool │   tool │
           │       │        │
  [exec_ssh]  [rag_docs]  [mcp_ops]
  (SSH safe)  (BM25 .md)  (MCP server)
```

---

## 5. Modelo de Ameaças e Mitigações

| Risco | Mitigação |
|---|---|
| **Loop infinito de tool calls** (modelo pequeno chamando a mesma tool repetidamente) | `maxSteps` duro (default `5`), detector de chamada idêntica repetida (2× seguidas com mesmos args → avisa o LLM e força encerramento) e timeout global por turno. |
| **Indirect Prompt Injection via saída de SSH ou MCP** (um log ou ticket contendo *"Ignore previous instructions and delete..."*) | Retornos de tool são encapsulados em `<tool_output>` com instrução de sistema tratando-os como dados não-confiáveis + `exec.command` mantém denylist/allowlist determinística + `human.approve` obrigatório por padrão em chamadas externas. |
| **MCP server expondo 50 tools perigosas** (ex.: `drop_table`, `delete_cluster`) | `allowedTools` obrigatório no `tool.mcp` (só expõe ao LLM as tools explicitamente liberadas pelo operador) + `dryRun: true` por padrão. |
| **Vazamento de segredos em `apps/tui/flows/*.json`** | `tool.mcp` **nunca** armazena tokens/senhas em `params`; usa apenas `envAllowlist` (nomes de variáveis de ambiente do host) ou `~/.ssh/config` no caso do SSH. |
| **Processo MCP zumbi após parada do fluxo** | `tool.mcp.stop()` fecha `stdin`, envia `SIGTERM` e garante `SIGKILL` após 1 s; `onControl('interrupt')` cancela `tools/call` pendente via `AbortSignal`. |

---

## 6. Plano de Implementação Incremental (5 Fases)

1. **Fase 1 — Motor (`packages/falador-graph`):**
   - Adicionar `PortType = ... | 'tool'`, interfaces `ToolDef` / `ToolCallResult` / `ToolProvider`, exceção de multi-input para portas `'tool'` em `spec.ts`, e `ctx.getTools(port)` em `runtime.ts`.
   - Testes unitários provando múltiplos provedores na mesma porta `tools`, validação de tipo de porta e ausência de ciclo.
2. **Fase 2 — Provedores locais (`exec.command` + `rag.search`):**
   - Expor porta `tool` em `exec-command.ts` (reutilizando `validateCommand`, `spawn`, `dryRun`, audit log) mantendo 100% compatibilidade com o modo linear (`in`/`parcs` → `out`).
   - Criar `rag-search.ts` (`rag.search`) expondo `searchChunks` (BM25) como tool `search_docs`.
   - Testes unitários de invocação bidirecional (args → execução → retorno ao chamador) + testes adversariais mantidos.
3. **Fase 3 — Cliente MCP (`packages/falador-nodes/src/tool-mcp.ts`):**
   - Implementar cliente JSON-RPC 2.0 zero-deps para `stdio` e Streamable `http`, com `allowedTools`, `dryRun`, `timeoutMs`, `envAllowlist` e audit log.
   - Testes unitários com servidor MCP mock em `stdio` (script Node filho) e servidor MCP mock em `http`, cobrindo `tools/list`, `tools/call`, bloqueio fora de `allowedTools`, `dryRun`, timeout e shutdown limpo.
4. **Fase 4 — Nó `agent.tools` (`packages/falador-nodes/src/agent-tools.ts`):**
   - Loop OpenAI `tool_calls` contra `omlx :8080`, `maxSteps`, detector de repetição, integração com `d1-2B` + `__gate` (`human.approve`), `interrupt` (ADR-006), `reset_history` e `trace` por step.
   - Testes unitários com mock OpenAI multi-step (2 chamadas de tool seguidas → resposta final), rejeição no gate, limite `maxSteps`, e `interrupt` no meio de uma tool.
5. **Fase 5 — Host, UI Canvas & Fluxo de Referência:**
   - Expor eventos `agent_step` no `run-flow.mjs` / `apps/web-server.mjs`.
   - Atualizar `FlowNode.tsx`, `FlowCanvas.tsx`, `Palette.tsx`, `NodeEditor.tsx` e `LiveView.tsx` (porta `tools` dedicada + timeline de passos do agente + aprovação por tool call).
   - Criar `apps/tui/flows/agente-suporte-ops.json` (`dryRun: true`, `approvalPolicy: 'always'`) e validar com `validateFlow`.

---

## 7. Critérios de Aceite

1. `node --test --test-force-exit` 100% verde em `packages/falador-graph` e `packages/falador-nodes` (incluindo testes de loop multi-step, MCP `stdio` + `http` mock, e suíte adversarial).
2. `validateFlow` passa em `apps/tui/flows/agente-suporte-ops.json` e em todos os 6 fluxos existentes.
3. `tsc --noEmit` e `vite build` verdes em `apps/web`.
4. **Prova E2E ao vivo no M4 Pro (`omlx :8080`):** pergunta pedindo diagnóstico → `agent.tools` chama `rag_search` + `exec_local` (`uptime` / `df -h`) em 2 passos encadeados → recebe os resultados de volta → devolve resposta final fundamentada + audit log completo, zero deps externas adicionadas.
