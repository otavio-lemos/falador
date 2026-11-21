# ADR-007 — RAG Genérico (Runbooks `.md`/`.pdf`) + Conector de Execução Local/SSH com Guardrails

**Status:** IMPLEMENTADO — 2026-11-21 (Fases A–D implementadas e auditadas: RAG BM25 < 1 ms, suíte adversarial 19/19 PASS, E2E local real com `uptime` 7 ms + `d1` 55 ms + analista, SSH `localhost` fail-fast 17 ms; SSH em host remoto real: `NÃO VERIFICADO`)
**Depende de:** ADR-003 (canvas/nada fixo), ADR-005 (captura SCK + `human.approve`), ADR-006 (streaming, *barge-in* `interrupt`, `turn.detector`, `trace`, exportação pós-sessão)

---

## 1. Contexto e Motivação

O princípio central do Falador (ADR-003) é **NADA FIXO**: o motor de grafo não é restrito a tradução ou entrevista técnica. Um caso de uso natural e de altíssimo valor é **Ops / SRE / Revisão de Servidor assistida por voz e texto**:

1. Um técnico/solicitante pede por voz (microfone ou call) uma verificação em um servidor ou serviço (*"confere por que o nginx da API está dando 502 e vê o uso de disco no prod-01"*).
2. O **`llm.omlx`** consulta **documentos oficiais e runbooks locais** (`.md`, `.pdf`, `.txt`, `.yaml`) para formular o comando exato de diagnóstico conforme o procedimento da equipe.
3. O **`decision.llm`** (`d1-2B-MLX-4bit` via `/v1/systemone`, ~40 ms) classifica o risco em portas dinâmicas (`leitura_segura` / `sensivel` / `bloqueado`).
4. O **`human.approve`** exibe o comando, o host alvo e a justificativa para o operador **revisar, editar ou rejeitar**.
5. Um **nó conector de execução (`exec.command`)** executa o comando aprovado — **localmente no terminal** ou **remotamente via SSH** — e emite o resultado (`stdout`, `stderr`, `exitCode`).
6. O resultado pode ir direto para a tela (`sink.captions`) e/ou alimentar um **2º `llm.omlx`** que analisa os logs coletados e devolve o diagnóstico resumido (e opcionalmente exporta para `.md` ou webhook pós-sessão — ADR-006 Fase 6).

### 1.1 Limitações atuais verificadas no código (2026-11-21)

- **RAG acoplado a "entrevista":** em `apps/web-server.mjs:56-62`, `extractPoints()` usa prompt fixo de entrevista técnica, trunca em `6000` caracteres e resume o documento inteiro em apenas 3 frases. Além disso, `applyContext` injeta contexto apenas em fluxos classificados como entrevista. Runbooks técnicos exigem recuperação por trecho relevante (*chunking* + busca por consulta), não um resumo de 3 linhas.
- **Ausência de nó executor:** o catálogo atual (`packages/falador-nodes/src/`) só possui nós de captura, ASR, LLM, decisão, gate humano, TTS e sinks de tela/áudio — não há conector para execução local ou SSH.
- **`human.approve` só exibe texto plano:** em `packages/falador-nodes/src/human-approve.ts`, o gate passa apenas `string` simples sem metadados estruturados (host, risco `d1`, comando extraído).

---

## 2. Modelo de Ameaças e Segurança (Defesa em Profundidade)

Executar comandos sugeridos por um LLM em máquina local ou servidor remoto via SSH introduz risco real de **prompt injection**, **alucinação de flags destrutivas** e **execução em host errado**.

> **Regra fundamental:** `d1-2B` e `llm.omlx` são **camadas probabilísticas** (ótimas para triagem e produtividade), **NUNCA** garantia de segurança. Toda barreira crítica precisa ser **determinística no código do nó `exec.command`**.

### As 4 camadas obrigatórias

| Camada | Mecanismo | O que bloqueia |
|---|---|---|
| **1. Triagem semântica** | `decision.llm` (`d1-2B`, portas `leitura_segura`, `sensivel`, `bloqueado`) | Separa diagnóstico read-only de ações mutáveis ou destrutivas antes mesmo de chegar ao gate. |
| **2. Gate humano** | `human.approve` (editável) | Operador confere host + comando exato antes da execução. Obrigatório em `sensivel` (e recomendado por padrão no fluxo de referência). |
| **3. Validador determinístico** | Parser + políticas dentro do `exec.command` | Bloqueia **encadeamento/injeção de shell** (`;`, `&&`, `||`, `` ` ``, `$(`, `>`, `>>`, `| sh`, `| bash`), comandos fora da `allowedPrefixes`, hosts fora de `allowedHosts` e **denylist dura imutável** (`rm -rf`, `mkfs`, `dd`, `shutdown`, `reboot`, `kill -9 1`, `chmod -R`, `curl ... \| sh`). |
| **4. Isolamento + Auditoria** | `spawn(..., { shell: false })`, `ssh -o BatchMode=yes`, `timeoutMs`, `maxOutputBytes`, `dryRun: true` por padrão, `logs/exec-audit.jsonl` | Impede travamento do grafo, vazamento de credenciais (sem senha em JSON) e garante rastreabilidade completa de tudo que foi aprovado e rodado. |

---

## 3. Decisões Arquiteturais (E1–E5)

| # | Tema | Decisão |
|---|---|---|
| **E1** | **RAG local por chunks (zero dep nova)** | Evoluir `context/docs.json` para armazenar **chunks** (~800 chars, overlap 120, quebrando por headings `#`/`##` em `.md` e por parágrafo em `.pdf`/`.txt`). Adicionar suporte explícito a `.md`, `.txt`, `.pdf` (`pdftotext`), `.yaml`, `.json`. Recuperação em tempo real via **BM25 leve em JS puro** (< 5 ms, sem banco vetorial externo). Injeção controlada por params no `llm.omlx`: `useContext: boolean`, `contextTopK: number` (default 3), `contextTags?: string[]`. |
| **E2** | **Novo nó `exec.command`** | Nó único e plugável em `packages/falador-nodes/src/exec-command.ts` suportando `transport: 'local' | 'ssh'`, com `dryRun: boolean` (**default `true`** ao criar no canvas para segurança por padrão). |
| **E3** | **Contrato de comando único (anti-injeção)** | O nó aceita entrada `in (phrase)` (de `human.approve`) ou `parcs (tokens_parcial)` (de `decision.llm`). Extrai **um único comando** (de JSON `{ command, host?, reason? }`, de bloco ` ```sh ` / ` ```bash `, ou de texto plano se for 1 linha). Em modos `readonly` e `allowlist`, executa **sem shell intermediário** (`shell: false` local; `argv` escapado/validado no SSH) e rejeita metacaracteres de encadeamento (`;`, `&&`, `||`, `` ` ``, `$(`, redirecionamento `>`). |
| **E4** | **SSH seguro sem senhas** | `transport: 'ssh'` usa o binário `ssh` nativo do macOS com flags fixas: `-o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes` (usando chaves/config de `~/.ssh/config` e `ssh-agent`). **Proibido** armazenar senha ou chave privada em params do fluxo. `allowedHosts` obrigatório (lista vazia = recusa executar SSH). |
| **E5** | **Integração com ADR-006** | `exec.command` implementa `onControl(c)`: em `interrupt`, mata o processo filho (`SIGTERM` → `SIGKILL` em 1 s). Propaga `Envelope.meta.trace` (`tExecStartMs`, `tExecEndMs`, `exitCode`). Emite `out (phrase)` formatado para alimentar um 2º `llm.omlx` (analista) ou `sink.captions`. |

---

## 4. Arquitetura do Fluxo de Referência (`revisao-servidor-ops.json`)

```text
[captura (mic / SCK)]
        │ pcm16k (drop_oldest, ttl 1500ms)
        ▼
[asr.realtime (Voxtral)]
   ├──→ [transcricao (sink.captions)]
   └──→ [turn.detector (d1-2B)]                  ← garante fim da solicitação
                │ tokens_parcial
                ▼
[planejador (llm.omlx, useContext: true)]        ← consulta runbooks .md/.pdf via RAG BM25
                │ tokens_parcial (JSON {command, host, reason})
                ▼
[risco (decision.llm, d1-2B, 3 portas)]
   ├── leitura_segura ──→ [gate_leitura (human.approve)] ──┐
   ├── sensivel       ──→ [gate_sensivel (human.approve)] ─┼──→ [executor (exec.command)]
   └── bloqueado      ──→ [alerta (sink.captions)]         │           │ phrase (stdout/stderr/exit)
                                                           │           ▼
                                                           │    [analista (llm.omlx)]
                                                           │           │ tokens_parcial
                                                           │           ▼
                                                           │    [diagnostico (sink.captions)]
```

*(Nota: respeitando Spec V2 `in-degree = 1` do `falador-graph`, caso haja 2 ramos indo para execução, cada ramo tem seu próprio nó `exec.command` — ex.: `exec_leitura` em modo `readonly` e `exec_sensivel` em modo `allowlist` — ou ambos convergem antes do gate conforme o desenho do usuário no canvas.)*

---

## 5. Plano de Implementação Detalhado (4 Fases)

---

### Fase A — Generalização do RAG Local (Runbooks `.md`, `.pdf`, `.txt`)

**Objetivo:** transformar o RAG atual de "cheatsheet de entrevista" em um **retriever local genérico de documentos/runbooks** configurável por nó.

#### Arquivos afetados
1. `packages/falador-nodes/src/context-store.ts` (novo módulo compartilhado entre host e nós, zero deps)
   - Função `chunkDocument(name, text, opts)`:
     - Para `.md`: quebra preservando hierarquia de headings (`#`, `##`, `###`), mantendo o título da seção no topo de cada chunk (`[runbook-nginx.md > Erro 502] ...`).
     - Para `.txt`/`.pdf`/`.yaml`: quebra por parágrafo em blocos de ~800 chars com overlap de 120 chars.
   - Função `searchChunks(docs, query, { topK = 3, tags, maxChars = 2400 })`:
     - Tokenização simples (lowercase, remove pontuação, ignora stopwords PT/EN básicas) + score **BM25** por chunk.
     - Retorna os `topK` trechos mais relevantes em `< 5 ms`.
2. `apps/web-server.mjs`
   - No upload (`POST /api/context/doc`): aceitar `.md`, `.txt`, `.pdf`, `.yaml`, `.yml`, `.json`; salvar `{ id, name, tags, addedAt, points, chunks[] }` em `context/docs.json`.
   - Tornar o prompt de `extractPoints()` neutro (*"Extraia até 3 pontos-chave objetivos deste documento"* em vez de *"entrevista técnica"*).
   - Remover o filtro hardcoded *"só aplica contexto em flows de entrevista"*.
3. `packages/falador-nodes/src/llm-omlx.ts`
   - Novos params opcionais:
     - `useContext` (boolean, default `false`)
     - `contextTopK` (number, default `3`)
     - `contextTags` (string[], opcional — filtra ex.: `["nginx", "k8s"]`)
     - `contextMaxChars` (number, default `2400`)
   - Quando `useContext === true`: antes de chamar `omlx`, consulta `searchChunks(docs, userText, ...)` e injeta os trechos recuperados num bloco `[DOCUMENTAÇÃO OFICIAL RELEVANTE]` no `system` (sem contaminar o `history`).
4. `apps/web/src/components/NodeEditor.tsx` & sidebar de documentos
   - Expor toggle `useContext`, `contextTopK` e `contextTags` no Inspector do `llm.omlx`.
   - Aceitar upload de `.md` na UI de Contexto/Documentos com campo opcional de tags.

#### Verificação da Fase A
- Teste unitário em `packages/falador-nodes`:
  - Runbook `.md` com 5 seções (Nginx, Postgres, Redis, Disk, DNS) → query `"erro 502 nginx upstream"` retorna o chunk de Nginx em 1º lugar.
  - `llm.omlx` com `useContext: false` **não** injeta documentos (tradutores ficam limpos).
  - `llm.omlx` com `useContext: true` injeta apenas os `topK` chunks respeitando `contextMaxChars`.

---

### Fase B — Nó Conector `exec.command` (Local + SSH com Guardrails)

**Objetivo:** permitir execução controlada de comandos locais ou remotos via SSH com proteção determinística contra injeção e auditoria completa.

#### Especificação do nó (`packages/falador-nodes/src/exec-command.ts`)
- **Tipo:** `exec.command`
- **Portas:**
  - `inputs`:
    - `{ name: 'in', type: 'phrase' }` (saída de `human.approve`)
    - `{ name: 'parcs', type: 'tokens_parcial' }` (saída direta de `decision.llm` ou `llm.omlx`, age só em `final: true`)
  - `outputs`:
    - `{ name: 'out', type: 'phrase' }` (emite relatório estruturado em texto + `meta.exec = { command, host, exitCode, durationMs, dryRun, truncated }`)
- **Params:**
  - `transport`: `'local' | 'ssh'` (default `'local'`)
  - `mode`: `'readonly' | 'allowlist'` (default `'readonly'`)
  - `dryRun`: `boolean` (**default `true`** — simula e valida sem executar até o usuário desativar explicitamente)
  - `allowedPrefixes`: `string[]` (default seguro em `readonly`: `['uname', 'uptime', 'df', 'free', 'ps', 'ls', 'cat', 'head', 'tail', 'grep', 'systemctl status', 'journalctl', 'docker ps', 'docker logs', 'kubectl get', 'kubectl describe', 'kubectl logs', 'ss', 'netstat', 'curl -I', 'dig', 'nslookup']`)
  - `allowedHosts`: `string[]` (obrigatório quando `transport === 'ssh'`; ex.: `['staging-api', 'prod-readonly-01']`)
  - `defaultHost`: `string` (opcional, usado se o payload não especificar host)
  - `sshUser`: `string` (opcional; se omitido usa `~/.ssh/config`)
  - `sshPort`: `number` (opcional, default `22`)
  - `cwd`: `string` (opcional, apenas para `transport: 'local'`)
  - `timeoutMs`: `number` (default `15000`, máximo `60000`)
  - `maxOutputBytes`: `number` (default `32768`)
- **Validador determinístico (`validateCommand`):**
  1. Extrai comando único de JSON `{ command, host }`, bloco markdown ```` ``` ```` ou linha única. Rejeita texto com múltiplas linhas de comando.
  2. **Denylist dura imutável** (rejeita mesmo que alguém tente liberar):
     - Metacaracteres de encadeamento/subshell: `;`, `&&`, `||`, `` ` ``, `$(`, `\n`, `\r`, `>`, `>>`, `<`, `|` (pipe simples opcionalmente só permitido em futuro modo explícito; na v1, bloqueado para zero ambiguidade).
     - Binários destrutivos: `rm`, `rmdir`, `mkfs`, `dd`, `shutdown`, `reboot`, `halt`, `poweroff`, `passwd`, `useradd`, `userdel`, `chown`, `chmod`, `kill`, `killall`, `pkill`, `iptables`, `nft`.
  3. **Allowlist de prefixo:** o comando normalizado deve casar exatamente com um dos `allowedPrefixes` (com fronteira de palavra).
  4. **Allowlist de host (SSH):** `host` deve constar exatamente em `allowedHosts` e casar `/^[a-zA-Z0-9._-]+$/` (bloqueia flags injetadas no nome do host, ex.: `-oProxyCommand=...`).
- **Execução segura:**
  - `local`: faz parse seguro de `argv` (respeitando aspas simples/duplas) e chama `spawn(argv[0], argv.slice(1), { shell: false, cwd, stdio: ['ignore', 'pipe', 'pipe'] })`.
  - `ssh`: `spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes', '-p', String(sshPort), targetHost, '--', validatedCommand], { shell: false })`.
  - **Timeout & `onControl` (`interrupt`):** mata o child (`SIGTERM`, seguido de `SIGKILL` após 1 s) e registra `exec.command.killed`.
  - **Audit log:** grava 1 linha JSON em `logs/exec-audit.jsonl` (com timestamp, `runId`, `nodeId`, `transport`, `host`, `command`, `dryRun`, `decision` permitido/bloqueado, `exitCode`, `durationMs`).

#### Verificação da Fase B (incluindo testes adversariais!)
- Testes unitários obrigatórios em `packages/falador-nodes`:
  - **Injeção de shell bloqueada:** `df -h; rm -rf /`, `uptime && cat /etc/shadow`, `ls $(whoami)`, ``ps `id` ``, `cat /etc/hosts > /tmp/x` → TODOS rejeitados com `EXEC_POLICY_DENIED`.
  - **Host injection bloqueado:** host `-oProxyCommand=id` ou host fora de `allowedHosts` → rejeitado antes de chamar `spawn`.
  - **`dryRun: true`:** valida tudo, grava no audit log com `dryRun: true` e emite preview sem executar processo.
  - **Execução local real controlada:** `uname -s` em modo `readonly` com `dryRun: false` retorna `Darwin`, `exitCode: 0`.
  - **Timeout:** comando que demora > `timeoutMs` é morto e retorna `timedOut: true` sem travar o grafo.
  - **`interrupt` (ADR-006):** aborta processo filho em voo.

---

### Fase C — Upgrade de `human.approve` e UI (Builder + LiveView)

**Objetivo:** dar visibilidade clara ao operador antes de aprovar qualquer comando no terminal ou SSH.

#### Arquivos afetados
1. `packages/falador-nodes/src/human-approve.ts`
   - Preservar metadados relevantes (`decision` do `d1`, `host`, `command`, `reason` se presentes no JSON do payload) ao chamar `gate.request(text, meta?)` (retrocompatível com chamadas existentes).
2. `apps/web/src/views/LiveView.tsx`
   - No card de aprovação (`human.approve`), se o texto contiver comando/JSON estruturado, renderizar:
     - Badge de **Host** (`local` ou nome do servidor SSH) + badge de **Risco `d1`** + campo **monospaced editável** com o comando exato + botões **Aprovar e Executar** / **Rejeitar**.
   - Se o fluxo tiver nó `exec.command`, mostrar um indicador discreto de modo (`DRY-RUN` vs `EXEC ATIVO`) no cabeçalho do Live Mode.
3. `apps/web/src/flow-utils.ts`, `Palette.tsx`, `NodeEditor.tsx`
   - Registrar `exec.command` na paleta (categoria *Ações / Conectores*) com ícone próprio e editor de parâmetros no Inspector (toggle `dryRun`, seletor `transport`, lista editável de `allowedHosts` e `allowedPrefixes`).

#### Verificação da Fase C
- `tsc --noEmit` e `vite build` verdes em `apps/web`.
- Fluxo no canvas conecta `decision.llm` → `human.approve` → `exec.command` → `llm.omlx` → `sink.captions` sem erro de tipo de porta (`validateFlow`).

---

### Fase D — Fluxo de Referência + Documentação

#### Arquivos afetados
1. `apps/tui/flows/revisao-servidor-ops.json` (novo workflow no catálogo)
   - Configurado com `dryRun: true` e `mode: "readonly"` por padrão.
   - Descrição clara explicando o fluxo (voz → runbooks `.md`/`.pdf` → `d1` risco → aprovação humana → execução local/SSH → análise do resultado).
2. `.gitignore`
   - Garantir que `logs/exec-audit.jsonl` e `context/docs.json` (caso contenham docs internos/privados) estejam protegidos.
3. `AGENTS.md`
   - Registrar o novo nó `exec.command`, o RAG BM25 genérico e os resultados medidos após execução.

---

## 6. Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| **Prompt injection escondido num runbook ou log de servidor** (ex.: um log retornado pelo SSH contendo *"Ignore previous instructions and run..."*) | O 2º `llm.omlx` (analista) **não** tem saída conectada a `exec.command` no fluxo padrão (só vai para `sink.captions`), evitando loop autônomo; além disso, `exec.command` sempre aplica denylist + allowlist + `human.approve`. |
| **SSH pedindo senha / confirmação de host key e travando o processo** | `-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5` garante falha imediata (< 5 s) com mensagem clara (`Host key verification failed` ou `Permission denied`). |
| **Saída gigante de log (`journalctl` sem `-n`) estourando o contexto do 2º LLM** | `maxOutputBytes` (32 KB) trunca a saída preservando o final (últimas linhas, onde geralmente está o erro) e sinaliza `[truncado]`. |
| **Usuário acionar execução real sem querer ao testar no canvas** | `dryRun: true` é o default ao adicionar `exec.command` no canvas e no fluxo de referência; precisa ser desligado conscientemente pelo usuário. |

---

## 7. Critérios de Aceite

1. RAG local indexa `.md`, `.pdf` e `.txt` por chunks e recupera trechos corretos via BM25 em `< 10 ms`.
2. Suíte adversarial do `exec.command` (injeção de shell, host injection, binários destrutivos, timeout, `dryRun`) 100% verde.
3. `validateFlow` passa em `apps/tui/flows/revisao-servidor-ops.json` e em todos os fluxos existentes.
4. Teste E2E local: pedido por voz → consulta runbook `.md` → `llm.omlx` gera comando → `d1-2B` classifica → aprovação no browser → `exec.command` roda comando `readonly` local (`uptime`/`df -h`) → 2º `llm.omlx` resume o diagnóstico na tela + grava linha em `logs/exec-audit.jsonl`.
