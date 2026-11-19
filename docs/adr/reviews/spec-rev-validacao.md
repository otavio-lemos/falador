# Revisão adversarial da Spec falador-graph v1.0 — revisor "validação & formato"

## FALHAS BLOQUEANTES

**B1 — Portas não têm lugar declarado na spec.** V4 exige comparar "tipo de porta", mas nada define onde o motor descobre a lista de portas/tipos/direção de cada tipo de nó. O exemplo usa `asr.parcs` sem tabela de portas. Contrato entre adaptadores e motor fica a cargo de cada implementador.

**B2 — Portas/nós inexistentes não são cobertos.** `{ "from": "mik.out", ... }` (typo de id) passa silencioso ou explode em runtime, violando "erro na montagem, nunca em runtime". Falta regra e formato de referência; id de nó com `.` quebra o formato.

**B3 — fan-out de `control` contradiz V2.** `emitControl` existe mas não se define como control viaja; se control chega de múltiplas origens (UI + nó), V2 proíbe. E isolate + backpressure em cascata pode dar deadlock silencioso: o que acontece com as filas de um nó isolado?

## AMBIGUIDADES

- **A1** — "YAML aceito se parseado fora do motor" sem garantir tipo (capacity: "64") nem âncoras/comentários.
- **A2** — `version: 1` sem política de versionamento (`SPEC_VERSION_UNSUPPORTED`?).
- **A3** — `validate(params) → erros[]` sem formato de erro; params extra não dito (estrito?).
- **A4** — Bindings parciais: campo obrigatório do tipo ausente = erro ou default? Onde ficam defaults?
- **A5** — Nó com porta de saída declarada e nenhuma edge: warning ou erro? Como se declara sink (`outputs: []`?)?
- **A6** — `scope: 'node'` + `uptoSeq` com duas saídas do mesmo nó: seq de qual porta?
- **A7** — `msg.cancelled` entregue "ou não entregue (política do tipo de nó)": critério 10.4 não é determinístico.

## MENORIAS

- V1: range de ttlMs e combinação com block.
- V3: mensagem do ciclo precisa formato (Kahn + caminho).
- V6: typo "porte"; como se determina "sink" (campo no tipo ou convenção de nome?).
- V7: id duplicado de nó não coberto (virar V0).
- Aceite 5: testar id duplicado e porta inexistente.
- Evento `run_started` não listado (inconsistente com run_stopped).

## Veredito

B1–B3 bloqueantes; a lista de portas precisa ser contratuais no registro de tipos.

*→ Incorporado na Spec v1.1 (PortDecl obrigatório no NodeTypeDef, V0/charset, UNKNOWN_NODE/UNKNOWN_PORT em montagem, control pelas edges + marcação imediata, STRICT params + erros {path,code,message}, requiredBindings, sink/sourceOnly como campos, versão única, cancel determinístico com flag).*
