# Pesquisa: melhores práticas de visualização de workflows de agentes de sistemas

Data: 2026-11-23 · Fonte: web (Google Cloud, AWS, LangGraph, n8n, Anthropic, OWASP, Hatchworks, Designveloper, Digitarise, Kevin Ferron)

## 1. Componentes canônicos (Designveloper / getagenttools / aiagentics)

Todo diagrama de agente deve mostrar, no mínimo, 5 grupos:

1. **Input & Perception** — como a requisição entra e vira dados utilizáveis (autenticação, limites, origem do dado).
2. **State & Context** — memória de trabalho + memória longa; o que o modelo pode ver neste passo.
3. **Reasoning & Routing** — quem decide o próximo passo (modelo vs regra determinística). A fronteira deve ser visível.
4. **Tools & Execution** — read-only vs efeito colateral; owner, escopo, schema de entrada/saída, caminho de erro.
5. **Feedback, Evaluation & Oversight** — resultado da tool, retry, roteamento para humano, fim do run.

## 2. O loop (AWS / Digitarise / Anthropic)

O loop é: **Perceive → Reason → Act → Observe → (stop ou repetir)**.

- Observation fecha o loop: toda ação (inclusive erro/timeout) volta como input do próximo passo.
- Stop condition é de primeira classe: goal met, budget esgotado, humano precisa decidir. Nunca "o modelo acha que acabou".
- Approval gate ANTES do efeito colateral, nunca depois (notificação ≠ aprovação).
- Tool gateway único: RBAC, validação de input, rate limit, cost budget passam por um único checkpoint.

## 3. Padrões de orquestração (Anthropic / LangGraph)

- **ReAct**: raciocínio + ação intercalados; bom para 2–5 tool calls.
- **Plan-and-Execute**: plano completo antes de executar; bom para multi-step.
- **Evaluator-Optimizer**: agente produz, avaliador independente valida, loop até critério.
- **Maker-Checker**: revisão visível como "lane" separada, usuário aceita/rejeita.
- **Human-in-the-Loop**: 4 tipos de gate — aprovar plano, aprovar execução, aprovar output final, aprovar exceção.

## 4. O que NÃO pode faltar num diagrama de agente de sistemas (Hatchworks, GOCUX)

- **Aprovação humana visível** como nó/etapa distinta, não como texto no prompt.
- **Output da tool retornando ao agente** (edge de volta) — sem isso o loop é invisível.
- **Console/observabilidade** — o que o agente digitou e o que recebeu, em tempo real.
- **Audit trail** append-only com timestamp, comando, host, decisão, resultado.
- **Stop rules / budget** visíveis (maxSteps, timeout, cost).
- **Controle do usuário** (start/stop/pause/resume) — autonomia é do usuário, não do agente.
- **Receipts** — o que mudou, onde, quando, por quem, rollback.

## 5. Anti-padrões observados no workflow atual (assistente-especialista-ti)

- O grafo mostra tools (exec_ssh, web_search, crawler, tool_mcp, tool_workflow, rag_search) conectadas ao agente via portas `tool`, mas **não mostra o retorno do resultado da tool ao agente** de forma visualmente clara (a edge `exec_ssh.tool -> agente.tools` existe, mas é uma entre várias e sem destaque).
- O **aprovador (human.approve)** não aparece como nó no grafo — a aprovação é implícita no `approvalPolicy: always` do agent.tools. Isso esconde o gate humano do diagrama.
- O **console dedicado** (popup) não está representado como nó/sink no grafo.
- O **output final** (sink.captions final_output) está conectado só à saída `agente.out`, mas não há edge mostrando que o resultado da execução alimenta o próximo passo do loop (o loop é interno ao agent.tools, não visível).
- O nó `input` é `capture.ffmpeg` com `backend: chat` — mistura captura de áudio com entrada de texto; visualmente confuso para um agente de sistemas.
- Não há indicação visual de **dry-run vs exec ativo** no canvas.
- Não há indicação de **budget/stop rules** (maxSteps=50) no canvas.

## 6. Recomendações de visualização (para aplicar)

1. **Adicionar nó `human.approve` explícito** entre o agente e a execução de comandos, conectado como gate visível (não implícito em param).
2. **Mostrar o loop explicitamente**: edge `tool result -> agente.in` com estilo distinto (tracejado, cor diferente) e label "observação".
3. **Console como sink visível** conectado ao agente (tudo que é digitado/recebido).
4. **Colorir por papel**: agente (verde), tools (azul), gate humano (magenta/amarelo), console (cinza), input (ciano).
5. **Badge de estado** no nó: dry-run/exec ativo, maxSteps, modelo.
6. **Mini-legenda** no canvas: cores = tipo de fluxo (dado, controle, aprovação, observação).
7. **Agrupar ferramentas** num "tool belt" visual ao redor do agente, não espalhadas.
8. **Mostrar stop condition** como nó terminal explícito (OBJETIVO CONCLUÍDO).

## 7. Fontes reais

- Google Cloud, "Choose a design pattern for your agentic AI system" (single-agent, loop, human-in-the-loop).
- AWS Architecture Blog, "Inside an enterprise AI agent: a governed, observable loop architecture" (plan/act/observe, approval gate, tool gateway).
- Anthropic, "Building effective agents" + "Effective harnesses for long-running agents" (evaluator-optimizer, checklist com passes, verificação real).
- LangGraph docs (interrupts, graphs, super-steps, conditional edges).
- n8n docs (human-in-the-loop for tools, approval channels).
- OWASP AI Agent Security Cheat Sheet (tool security, least privilege, authorization middleware, fail-closed).
- Hatchworks, "Agent UX Patterns" (receipts, evidence panel, checkpoint gates, maker-checker).
- Designveloper, "A Practical Guide To AI Agent Architecture With Diagrams" (5 grupos, feedback loop).
- Digitarise, "Anatomy of an AI agent tool-calling loop" (6 estágios, control/data plane).
- Kevin Ferron, "Designing an agent graph" (interativo, gates + person).
- getagenttools, "AI Agent Architecture Diagram: 6 Practical Layers".
- aiagentics, "AI Agent Architecture: The 6 Core Components".
- Jenzo, "Agentic Workflows: Patterns, Approval Gates and Tracking Each Run".
- gocux, "How an agent system fits together" (6 componentes, stopping conditions).
- mastra.ai, "Agentic Workflows" (branching, merging, loops).
- calcstack, "Visual AI Agent Workflows: Beyond the Chat Loop" (core node types incl. Human approval, Subgraph).
- Slack Block Kit, "Human-in-the-Loop Design" (approval gate, edit-before-send, approval set).
- wingo-ui, "AI Agent Tool Call UI: Steps, Approvals and Errors" (acessibilidade, 44px, status em palavras).
