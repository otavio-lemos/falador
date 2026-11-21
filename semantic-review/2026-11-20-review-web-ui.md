# Falador Web UI — Review Funcional Completo

Revisão da interface web do projeto Falador (`apps/web/src/`). Os problemas abaixo foram verificados contra o catálogo real (`run-flow.mjs --catalog`) e o código-fonte. Oito problemas identificados, dos quais quatro bloqueiam funções centrais.

**Watch for:** O campo `control: 'model'` no `NodeEditor` **nunca é tratado** (confirmed) — cai em `TextInput` cru para todos os nós ASR, LLM e Decisão. As props `models` e `apps` não chegam ao `NodeEditor` porque `FlowCanvas` quebra a cadeia (confirmed). O botão "Novo workflow" na `TopBar` chama `onNewFlow()` que é `undefined` em runtime porque `App.tsx` não passa a prop (confirmed). Teams é filtrado do dropdown de apps por `SKIP_PREFIXES: ['com.microsoft.']` (confirmed).

**Verdict**: NEEDS_CHANGES

---

## High-level view

A razão pela qual nenhum dropdown de modelo aparece na UI são dois bugs em cadeia: o `NodeEditor` tem `models` e `apps` na sua assinatura, mas `FlowCanvas` não as passa ao `EditorAnchor`; e mesmo que passasse, `ParamField` não tem branch para `control === 'model'` — cai direto no `TextInput`. Resultado: o usuário vê um campo de texto vazio onde deveria haver uma lista dos modelos instalados.

A língua de tradução (`tts.sts.language`) tem `control: 'dropdown'` com cinco opções em `data.ts`, e `language` aparece em `paramNames` do catálogo — então o campo existe e renderiza o dropdown correto. O problema não é ausência do campo, é que o editor inteiro não abre funcionando quando `models`/`apps` chegam como `undefined` (a TypeScript strictness provavelmente está mascarando o erro).

Não existe distinção de capacidade nos dropdowns de modelo: ASR e LLM de texto recebem a mesma lista filtrada por `isTextModel`, que exclui exatamente os modelos ASR (`voxtral`, `audio`). O resultado é que o único nó ASR com param `model` (`asr.realtime`) recebe uma lista que não contém Voxtral. `asr.lfm3` não tem campo `model` no catálogo — usa o sidecar fixo.

Não existe botão "Gerenciar Modelos" em nenhuma parte da UI. Modelos do cache HF local (`models.cache`) nunca aparecem no editor — só `models.omlx`. O usuário não tem como ver o que está baixado sem o terminal.

Teams é bloqueado no dropdown de apps por `SKIP_PREFIXES: ['com.microsoft.']` em `web-server.mjs`, que pretendia filtrar helpers Office mas exclui o app de conferência principal do usuário. Novo workflow e renomear workflow não funcionam porque `App.tsx` não passa `onNewFlow` e `onRename` para a `TopBar`.

---

<details>
<summary>Issues (8)</summary>

1. **`control: 'model'` não renderiza dropdown** (confirmed) — `ParamField` em `NodeEditor.tsx` não tem branch `if (control === 'model')`. Todos os campos `model` de `asr.realtime`, `llm.omlx` e `decision.llm` caem em `TextInput` cru. Adicionar branch com `ComboBox` alimentado por `modelList`.

2. **Props `models` e `apps` quebram em `FlowCanvas`** (confirmed) — `FlowCanvas.tsx` chama `<EditorAnchor>` sem passar `models`, `apps` e `onRefreshApps`. `BuilderView` não passa `models` para `FlowCanvas`, e `FlowCanvas` não declara nem repassa `apps`. Adicionar as props na cadeia `BuilderView → FlowCanvas → EditorAnchor → NodeEditor`.

3. **ASR recebe lista de modelos de texto, sem modelos ASR** (confirmed) — `NodeEditor` calcula `modelList` como `models.omlx.filter(isTextModel)` para qualquer nó que não seja `decision.llm`. `isTextModel` exclui `voxtral` e `audio`, que são os únicos modelos ASR disponíveis. Criar `isAsrModel` e `isDecisionModel` em `live-utils.ts`; mapear `asr.realtime → isAsrModel`, `decision.llm → isDecisionModel`, `llm.omlx → isTextModel`.

4. **Cache HF local invisível no editor** (confirmed) — `models.cache` nunca é usado no `NodeEditor`. Modelos baixados mas não carregados no omlx (ex.: um modelo novo ainda não servido) não aparecem como opção. Incluir `models.cache` no `ComboBox` de modelo, separado por seção ou com prefixo diferente.

5. **Sem botão "Gerenciar Modelos"** (confirmed) — não existe ponto de entrada na UI para ver e buscar modelos por capacidade. O usuário não descobre o que está instalado sem abrir o terminal. Adicionar um modal acessível da `TopBar` que lista `models.omlx` e `models.cache` agrupados por tipo (ASR / LLM-texto / Decisão / Outros) com busca por nome.

6. **Teams filtrado do dropdown de apps** (confirmed) — `web-server.mjs`, `SKIP_PREFIXES: ['com.apple.', 'com.microsoft.']` exclui todo bundle `com.microsoft.*`, incluindo `com.microsoft.teams`. Remover `'com.microsoft.'` dos prefixos; filtrar por nomes específicos de helpers (`OneDriveStandaloneUpdater`, etc.) ou por sufixo (`.xpc`, `.helper`).

7. **`onNewFlow` não conectado em `App.tsx`** (confirmed) — `TopBar` declara `onNewFlow` como prop obrigatória; `App.tsx` não a passa. Clicar em "Novo workflow" chama `undefined()` — erro de runtime. Implementar em `App.tsx`: criar flow vazio com nome único, salvar via `saveFlow`, selecionar.

8. **`onRename` e `description` não conectados em `App.tsx`** (confirmed) — `TopBar` declara `onRename(newName, newDesc)` e `description` como props; `App.tsx` não as passa. O ✎ abre o campo de edição mas confirmar não persiste o rename no arquivo JSON porque `onRename` é `undefined`. Implementar em `App.tsx`: ao confirmar, chamar `saveFlow(newName, flow, oldName)` que faz o rename+salva.

</details>

---

<details>
<summary>Detalhes</summary>

## Seleção de modelo: branch `'model'` ausente e cadeia de props quebrada

`NodeEditor.tsx` define `ParamField` com branches para `dropdown`, `slider`, `toggle`, `textarea`, `json` — e cai no `TextInput` para todo o resto. `data.ts` marca `control: 'model'` para o campo `model` de `asr.realtime`, `llm.omlx` e `decision.llm`. Nenhum desses chega a um componente de seleção.

```
// NodeEditor.tsx – ParamField (fim do componente)
if (control === 'dropdown' && doc?.options) { … }
if (control === 'slider' && doc) { … }
if (control === 'toggle') { … }
if (control === 'textarea') { … }
if (control === 'json') { … }
// FALTA: if (control === 'model') { … ComboBox com modelList … }
return <TextInput … />;   // ← todo 'model' cai aqui
```

Mesmo adicionando o branch, a lista estaria vazia porque a cadeia de props está quebrada antes de chegar aqui:

```
BuilderView
  → passa apps para FlowCanvas (FlowCanvas não declara apps na interface)
  → não passa models para FlowCanvas de forma alguma
FlowCanvas
  → EditorAnchor: NÃO passa models, apps, onRefreshApps para NodeEditor
NodeEditor
  → modelList = models.omlx.filter(isTextModel)  ← models é undefined → crash ou []
```

A prop `apps` está na interface de `Props` de `FlowCanvas` declarada, mas o componente não a repassa ao `EditorAnchor`. Resultado: o campo de `input` do `capture.ffmpeg` também nunca mostra o datalist de apps.

## Modelos ASR excluídos da lista de modelos ASR

O catálogo confirma que `asr.realtime` tem `model` em `paramNames`. A lista calculada no `NodeEditor`:

```ts
const modelList = data.type === 'decision.llm'
  ? models.omlx
  : models.omlx.filter(isTextModel);
```

`isTextModel` exclui via regex `d1|omni|audio|voxtral|silero|vad`. Voxtral-Mini-4B-Realtime-2602-4bit (o único modelo ASR disponível no omlx) é filtrado fora. O usuário abre o "editor de modelo" do `asr.realtime` e encontra uma lista de modelos LLM — nenhum dos quais funciona com streaming ASR.

A correção precisa de um mapa de capacidade:

```ts
// live-utils.ts
export const isAsrModel = (id: string) => /voxtral|nemotron.*asr|whisper/i.test(id);
export const isDecisionModel = (id: string) => /d1|omni/i.test(id);
```

E no `NodeEditor`, um switch por `data.type`:
- `asr.realtime` → `models.omlx.filter(isAsrModel)`
- `llm.omlx` → `models.omlx.filter(isTextModel)`
- `decision.llm` → `models.omlx.filter(isDecisionModel)`

`asr.lfm3` não tem campo `model` no catálogo (usa o sidecar via `url`) — não precisa de lista.

## Idioma de tradução — situação real

O catálogo retorna `language` em `paramNames` do `tts.sts`, e `PARAM_HELP['tts.sts'].language` tem `control: 'dropdown'` com cinco opções. O branch `dropdown` em `ParamField` existe e renderizaria corretamente. O campo existe e funciona — mas só se o editor abrir. Com `models` chegando como `undefined`, qualquer acesso a `models.omlx` dentro do `NodeEditor` lança erro antes de renderizar qualquer campo. A língua não aparece por causa do mesmo bug de cadeia de props do item #2, não por um problema próprio.

## Teams bloqueado no dropdown de apps

`web-server.mjs` filtra apps rodando via SCK:

```js
const SKIP_PREFIXES = [
  'com.apple.',
  'com.microsoft.',  // ← exclui com.microsoft.teams
];
```

A intenção era bloquear helpers como `com.microsoft.OneDriveStandaloneUpdater`. O filtro por prefixo é largo demais. Zoom (`us.zoom.xos`) não é afetado. Meet roda no Chrome — SCK captura todo o Chrome, não só a aba do Meet, limitação documentada nos ADRs e fora do escopo desta UI.

Mudar para blocklist por `bundleId` exato ou por sufixo:

```js
const SKIP_BUNDLE_IDS = new Set([
  'com.microsoft.OneDriveStandaloneUpdater',
  'com.microsoft.autoupdate2',
  // … helpers específicos
]);
```

## `onNewFlow` e `onRename` desconectados

`App.tsx` renderiza `<TopBar>` sem três props que a interface exige:

```tsx
<TopBar
  view={view} latencyMs={runner.latency} running={runner.running}
  flows={flows} currentFlow={currentFlow}
  onSelectFlow={setCurrentFlow} onSave={onSave}
  onTest={onTest} onGoLive={onGoLive}
  onGoBuilder={() => setView('builder')} onStop={runner.stop}
  // onNewFlow: FALTANDO → runtime error ao clicar "Novo workflow"
  // onRename: FALTANDO → rename edita o estado local mas não salva no disco
  // description: FALTANDO → campo de descrição fica vazio mesmo com flow salvo
/>
```

`onRename` precisa chamar `saveFlow(newName, { ...flow, description: newDesc }, oldName)`. O host já aceita `renameFrom` no `POST /api/flows` para deletar o arquivo antigo.

</details>

---

<details>
<summary>Mapa de arquivos</summary>

| Arquivo | Problema |
|---|---|
| `NodeEditor.tsx` | Branch `'model'` ausente em `ParamField`; recebe `models`/`apps` mas sem efeito porque `FlowCanvas` não passa |
| `FlowCanvas.tsx` | `EditorAnchor` não passa `models`, `apps`, `onRefreshApps` para `NodeEditor`; `Props` não declara nem repassa `apps` |
| `BuilderView.tsx` | Não passa `models` para `FlowCanvas`; passa `apps` mas `FlowCanvas` as ignora |
| `App.tsx` | `onNewFlow`, `onRename`, `description` faltando no `<TopBar>` |
| `TopBar.tsx` | Interface bem definida; recebe `undefined` para `onNewFlow` e `onRename` em runtime |
| `LiveView.tsx` | Stage `'model-asr'` retorna só o valor atual sem lista; idioma TTS mostrado como voz (female/male) mas campo `language` não exposto |
| `live-utils.ts` | `isTextModel` correto; faltam `isAsrModel` e `isDecisionModel` para filtros por capacidade |
| `data.ts` | Sem problemas; `PARAM_HELP` correto e completo |
| `web-server.mjs` | `SKIP_PREFIXES: ['com.microsoft.']` bloqueia Teams; `models.cache` retornado mas nunca exibido no editor |

</details>
