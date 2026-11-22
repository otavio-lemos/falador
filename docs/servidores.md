# docs/servidores.md — Cadastro de servidores (alvos de `exec.command`)

> Como o Falador **não** mantém um cadastro central de servidores em arquivo: cada nó `exec.command` declara a sua própria allowlist (`allowedHosts`, `defaultHost`, `sshUser`, `sshPort`). Este documento é o **template e as instruções** para você manter a lista dos seus servidores fora do repositório (ou colá-la no flow), sem inventar nomes reais.
>
> Relacionado: [`execucoes.md`](execucoes.md) (trilha de execução e logs) · [`docs/adr/ADR-007-rag-runbooks-conector-exec.md`](adr/ADR-007-rag-runbooks-conector-exec.md) · [`docs/adr/ADR-008-agente-tools-mcp.md`](adr/ADR-008-agente-tools-mcp.md).

## 1. O que é um "servidor" no Falador

Um servidor é um alvo remoto (SSH) ou a própria máquina (`transport: local`) sobre o qual o nó `exec.command` (e, via porta `tool`, o `agent.tools`) pode rodar comandos. A segurança é por **allowlist explícita**: se o host não está em `allowedHosts`, o comando é negado *antes* de qualquer spawn, e a negação vai para `logs/exec-audit.jsonl`.

Campos do nó `exec.command` relevantes para o cadastro:

| Campo | Tipo | Default | Significado |
|---|---|---|---|
| `transport` | `'local' \| 'ssh'` | `local` | `local` = spawn direto (`shell: false`); `ssh` = remoto via `ssh` com hardening |
| `mode` | `'readonly' \| 'allowlist'` | `readonly` | `readonly` = só prefixos de `DEFAULT_READONLY_PREFIXES` (uptime, df, ps, journalctl, docker ps, kubectl get, …); `allowlist` = lista em `allowedPrefixes` |
| `allowedHosts` | `string[]` | `[]` | Allowlist de hosts SSH. Vazio = nenhum host remoto permitido |
| `defaultHost` | `string` | — | Host usado quando o comando não traz `host` explícito (útil em single-shot) |
| `sshUser` | `string` | — (usa `~/.ssh/config`) | Usuário SSH. Validado: não pode começar com `-`, só `[a-zA-Z0-9._-]` |
| `sshPort` | `int` | `22` | Porta SSH (1–65535) |
| `dryRun` | `bool` | `true` | `true` = só valida e imprime preview, não executa. **Deixe `true` até ter certeza** |
| `allowedPrefixes` | `string[]` | (readonly defaults) | Prefixos permitidos em modo `allowlist` |
| `cwd` | `string` | — | Diretório de trabalho (local ou remoto) |
| `timeoutMs` | `number` | `15000` | Timeout por execução (clamp 50–60000 ms) |
| `maxOutputBytes` | `number` | `32768` | Limite de stdout/stderr capturado |
| `auditLogPath` | `string` | `logs/exec-audit.jsonl` | Arquivo JSONL de auditoria |
| `toolName` | `string` | `exec_local`/`exec_ssh` | Nome exposto na porta `tool` (para `agent.tools`) |

Regras de segurança (imutáveis, não desligue):

- `shell: false` sempre — o comando é parseado em argv, sem shell.
- SSH com `BatchMode=yes`, `ConnectTimeout=5`, `StrictHostKeyChecking=yes`, `IdentitiesOnly=yes` e separador `--`.
- Metacaracteres de shell (`&&`, `||`, `;`, `&`, `` ` ``, `$(`, `>`, `<`, `|`, `\n`, `\r`) são **negados** antes do spawn.
- Binários destrutivos (`rm`, `dd`, `shutdown`, `kill`, …) estão em denylist dura.
- `host` deve casar `^[a-zA-Z0-9._-]+$` (sem espaços, sem `/`).
- Credenciais **nunca** no JSON do flow — use `~/.ssh/config` + chaves, ou `envAllowlist` (nomes de variáveis, nunca segredos).

## 2. Template de cadastro (preencha você mesmo)

> **Não invente servidores reais.** Copie a tabela abaixo para um arquivo privado (ex.: `servers.md` na sua máquina, fora do repositório, ou num RAG de runbook) e preencha com os seus. Mantenha o arquivo fora do git (veja §4).

| host | user | port | ambiente | tags | descricao | comando de checagem padrao |
|---|---|---|---|---|---|---|
| `prod-api-01` | `ops` | `22` | `producao` | `api, nginx, linux` | Servidor de API principal (nginx upstream) | `uptime && systemctl status nginx --no-pager` |
| `staging-01` | `deploy` | `22` | `staging` | `api, staging` | Ambiente de homologação | `uptime && df -h /` |
| `db-replica-01` | `dba` | `2222` | `producao` | `postgres, replica` | Réplica de leitura do banco | `pg_isready -h 127.0.0.1 && uptime` |
| `local` | — | — | `local` | `dev` | A própria máquina (transport: local) | `uptime` |

Colunas:

- **host** — nome curto que casa `HOST_REGEX` (sem espaços). Deve ser resolvível pelo seu `~/.ssh/config` (ou IP/FQDN válido).
- **user** — usuário SSH. Vazio = usa `~/.ssh/config`.
- **port** — porta SSH (default 22).
- **ambiente** — `producao`, `staging`, `homologacao`, `dev`, `local` (livre, mas padronize).
- **tags** — lista separada por vírgula para filtrar/buscar (runbook RAG, tags do flow).
- **descricao** — uma linha: o que o servidor é e por que existe.
- **comando de checagem padrao** — comando readonly de "está vivo?" usado no `human.approve` e em smoke tests. Deve ser um dos prefixos readonly (ou estar em `allowedPrefixes`).

## 3. Como ligar o cadastro a um flow

Opção A — inline no flow (recomendado para começar): edite o nó `exec.command` no Builder e preencha:

```json
{
  "type": "exec.command",
  "params": {
    "transport": "ssh",
    "mode": "readonly",
    "dryRun": true,
    "allowedHosts": ["prod-api-01", "staging-01"],
    "defaultHost": "prod-api-01",
    "sshUser": "ops",
    "sshPort": 22,
    "timeoutMs": 15000
  }
}
```

Opção B — via agente (ADR-008): o nó `agent.tools` chama `exec_ssh(host=..., command=...)` e o agente escolhe o host a partir do prompt. Ainda assim, `allowedHosts` do `exec.command` conectado pela porta `tool` é a cerca: host fora da lista = negado.

Opção C — runbook RAG: guarde o cadastro como `.md` em `context/` (RAG BM25) e o planejador LLM consulta com `useContext: true`. O cadastro **não** substitui a allowlist do nó — é só contexto para o LLM montar o comando certo.

Checklist antes de marcar um servidor como "pronto para execução real" (`dryRun: false`):

1. Host resolve via `ssh <user>@<host> -p <port> 'uptime'` **manualmente** no terminal (fora do Falador).
2. Chave SSH configurada em `~/.ssh/config` (ou `IdentityFile`), sem senha interativa (`BatchMode=yes` falha se pedir senha).
3. Host listado em `allowedHosts` do nó.
4. `sshUser` validado (sem `-`, sem metacaracteres).
5. Comando de checagem padrão rodou com `dryRun: true` e apareceu correto no card de aprovação.
6. Só então mude `dryRun` para `false`, e mantenha `mode: readonly` até ter runbook/allowlist revisado.

## 4. Onde guardar (privacidade)

O cadastro pode conter nomes internos, IPs e topologia. Por isso:

- **Não commite** o cadastro no repositório. Mantenha fora do git (ex.: `~/ops/servers.md`) ou em `context/` (que já está no `.gitignore`).
- `.gitignore` já protege `context/`, `sessions/` e `logs/exec-audit.jsonl`. Se você criar `servers.md` na raiz do repo, adicione ao `.gitignore`.
- O audit log (`logs/exec-audit.jsonl`) registra `host`, `command`, `dryRun`, `decision`, `exitCode`, `durationMs` — trate como dado sensível.

## 5. Comando de checagem padrão — exemplos por ambiente

Escolha um comando readonly que responda "está vivo e saudável?" em < 5 s:

| Ambiente | Comando sugerido | Por quê |
|---|---|---|
| Linux genérico | `uptime && df -h /` | carga + disco |
| systemd | `systemctl is-system-running && uptime` | estado do init |
| nginx | `systemctl status nginx --no-pager -l && curl -sI http://127.0.0.1/health` | serviço + health HTTP |
| Postgres | `pg_isready && psql -c 'SELECT 1'` | conexão + query mínima |
| Docker | `docker ps --format '{{.Names}} {{.Status}}'` | containers vivos |
| Kubernetes | `kubectl get nodes && kubectl get pods -A --field-selector=status.phase!=Running` | nós + pods não-Running |
| macOS | `uptime && sw_vers` | carga + versão |

Todos os exemplos acima são prefixos readonly (ou combinações permitidas). Se precisar de algo fora da lista, adicione em `allowedPrefixes` e revise o risco.

## 6. Verificação

- `node --test packages/falador-nodes/test/rag-exec.test.ts` cobre validação de host/sshUser/metacaracteres/denylist/audit log.
- Smoke manual: com `dryRun: true`, rode o flow `revisao-servidor-ops.json` e confira no card de aprovação que o host e o comando aparecem corretos, e que uma linha foi gravada em `logs/exec-audit.jsonl` com `decision: "dry_run"`.
- Para SSH real: ainda **NÃO VERIFICADO** (ver `docs/adr/STATUS.md`). Teste primeiro em `localhost` com `sshd` ligado (macOS: `sudo systemsetup -setremotelogin on`) — o ADR-007 registrou que falhou limpo com `exitCode=255` quando o sshd estava desligado, o que é o comportamento esperado.