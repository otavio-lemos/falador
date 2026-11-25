# Unified Approval Component (A/B/C) & 3-Workflow Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify the 3 approval levels (`A · Perguntar tudo`, `B · Só destrutivos/alteração`, `C · Aprovar tudo`) directly inside the `Approval` (`human.approve`) component in both the Workflow Builder and the Runner top stages bar, remove the duplicate dropdown next to `Pensamentos` in the Logs bar, remove legacy `'manual' | 'auto'` modes, and retain only the 3 active workflows (`especialista-ti.json`, `agente-workflows.json`, `entrevista.json`).

**Architecture:** `human.approve` owns the 3 canonical approval modes (`'ask_all' | 'non_readonly' | 'approve_all'`). At runtime, `packages/falador-cli/run-flow.mjs` derives the effective approval level from the `human.approve` node's `params.mode` (or `agent.tools.params.approvalPolicy` when no `human.approve` node is present) and propagates it consistently across `human.approve`, `agent.tools`, `exec.command`, and upstream `decision.llm` routing (`entrevista.json`). The Runner's `Approval` stage box in `LiveView.tsx` displays and updates these 3 options directly, while the redundant selector in `LogsPanel.tsx` is deleted.

**Tech Stack:** TypeScript (Node 26 native type-stripping, `node:test`), React 18, Carbon Design System (`@carbon/react`), Vite, Playwright.

**Spec:** Aligned design from conversation transcript (`2026-11-25`) and `AGENTS.md` (§3 ADR-007, ADR-008, ADR-011, ADR-012).

## Global Constraints

- **No legacy compatibility for `'manual' | 'auto'`:** `human.approve.validateParams` must accept ONLY `'ask_all' | 'non_readonly' | 'approve_all'` (plus `undefined`, which defaults to `'non_readonly'`). Any `'manual'` or `'auto'` value must fail validation with `INVALID_PARAM`.
- **Exactly 3 workflows in `apps/tui/flows/*.json`:** Only `especialista-ti.json`, `agente-workflows.json`, and `entrevista.json` may exist at `apps/tui/flows/*.json` (`ti-diagnostico.json` and `traducao-transcricao.json` must be deleted).
- **Exact option IDs and labels in UI (Builder & Runner `Approval` box):**
  - `ask_all` → `'A · Perguntar tudo'`
  - `non_readonly` → `'B · Só destrutivos/alteração'`
  - `approve_all` → `'C · Aprovar tudo'`
- **No duplicate selector in `LogsPanel`:** The `.approval-level-wrap` dropdown next to `Pensamentos` in `LogsPanel.tsx` must be completely removed.
- **Worktree & main repo sync:** Per `AGENTS.md`, keep tests green and sync commits on completion.

## Review Focus

1. **Selecting any of the 3 options in the Runner `Approval` stage box must pass `validateFlow`:** Previously, selecting `Always`, `Non-readonly`, or `Never` wrote invalid values into `human.approve.params.mode` and crashed `validateFlow`. Tested in Task 1 and Task 3.
2. **Decision + Approval workflows without an agent (`entrevista.json`) under mode `A` (`ask_all`) and mode `C` (`approve_all`):** In `entrevista.json`, `decisao` (`decision.llm`) has ports `auto` (direct to `sugestao`) and `humano` (to `revisao` `human.approve`). When `revisao.params.mode === 'ask_all'`, `run-flow.mjs` must route `decisao` to the port connected to `human.approve` (`humano`) so every suggestion asks the user; when `mode === 'approve_all'`, `human.approve` bypasses the gate so even `humano` items pass straight through; when `mode === 'non_readonly'`, `decision.llm` decides between `auto` and `humano`. Tested in Task 2.
3. **Agent workflows (`agente-workflows.json`) without a `human.approve` node:** `deriveStages` synthesizes an `Approval` stage from `agent.tools.params.approvalPolicy`. It must display the normalized `A / B / C` value (`'always' -> 'ask_all'`, `'non_readonly' -> 'non_readonly'`, `'never' -> 'approve_all'`) and `onUpdateStage` must map the user's `A / B / C` selection back to `agent.tools.params.approvalPolicy` (`'always' | 'non_readonly' | 'never'`) so `agentTools.validateParams` succeeds. Tested in Task 3.
4. **All existing unit tests referencing `mode: 'manual' | 'auto'`:** Must be updated to `'ask_all' | 'non_readonly' | 'approve_all'` so the test suite passes with zero legacy fallback. Tested in Task 1 and Task 2.

---

### Task 1: Replace `manual | auto` with `ask_all | non_readonly | approve_all` in `human.approve`

**Files:**
- Modify: `packages/falador-nodes/src/human-approve.ts:57-115`
- Test: `packages/falador-nodes/test/translate-and-approve.test.ts:140-190`
- Test: `packages/falador-nodes/test/first-class-providers.test.ts:170-365`

**Interfaces:**
- Produces:
  - `export type HumanApproveMode = 'ask_all' | 'non_readonly' | 'approve_all'` in `packages/falador-nodes/src/human-approve.ts`
  - `humanApprove.validateParams(p)` rejects any `p.mode` not in `['ask_all', 'non_readonly', 'approve_all']` with `{ path: 'params.mode', code: 'INVALID_PARAM', message: "mode deve ser 'ask_all' | 'non_readonly' | 'approve_all'" }`
  - `humanApprove.create(ctx)` defaults `mode` to `'non_readonly'`; bypasses gate when `mode === 'approve_all'`, and requests human approval via `__gate` when `mode === 'ask_all'` or `mode === 'non_readonly'`.

- [ ] **Step 1: Update the unit tests in `packages/falador-nodes/test/translate-and-approve.test.ts` and `packages/falador-nodes/test/first-class-providers.test.ts` to assert the new modes and rejection of legacy `'manual' | 'auto'`**

In `packages/falador-nodes/test/translate-and-approve.test.ts`:
```ts
  test('human.approve com mode="approve_all" emite direto sem chamar __gate; mode="ask_all" e "non_readonly" chamam __gate; rejeita "manual"/"auto"', async () => {
    assert.equal(humanApprove.validateParams?.({ mode: 'manual' })?.length, 1);
    assert.equal(humanApprove.validateParams?.({ mode: 'auto' })?.length, 1);
    assert.deepEqual(humanApprove.validateParams?.({ mode: 'ask_all' }), []);
    assert.deepEqual(humanApprove.validateParams?.({ mode: 'non_readonly' }), []);
    assert.deepEqual(humanApprove.validateParams?.({ mode: 'approve_all' }), []);
```
Replace `mode: 'auto'` with `mode: 'approve_all'` and `mode: 'manual'` with `mode: 'non_readonly'` in that test and in `packages/falador-nodes/test/first-class-providers.test.ts` (lines 175, 271, 357).

- [ ] **Step 2: Run the node tests to verify they fail against the old `human-approve.ts`**

Run: `node --test --test-force-exit packages/falador-nodes/test/translate-and-approve.test.ts packages/falador-nodes/test/first-class-providers.test.ts`
Expected: FAIL (`validateParams` still accepts `'manual'`/`'auto'` and rejects `'ask_all'`/`'non_readonly'`/`'approve_all'`).

- [ ] **Step 3: Update `packages/falador-nodes/src/human-approve.ts` to use `HumanApproveMode = 'ask_all' | 'non_readonly' | 'approve_all'`**

In `packages/falador-nodes/src/human-approve.ts`:
```ts
export type HumanApproveMode = 'ask_all' | 'non_readonly' | 'approve_all';
```
- In `validateParams`:
```ts
  validateParams: (p) => {
    if (
      p.mode !== undefined &&
      p.mode !== 'ask_all' &&
      p.mode !== 'non_readonly' &&
      p.mode !== 'approve_all'
    ) {
      return [
        {
          path: 'params.mode',
          code: 'INVALID_PARAM',
          message: "mode deve ser 'ask_all' | 'non_readonly' | 'approve_all'",
        },
      ];
    }
    return [];
  },
```
- In `create(ctx)`:
  - `const mode = (ctx.params.mode as HumanApproveMode | undefined) ?? 'non_readonly';`
  - Change both `if (mode === 'auto')` checks (in `gateProvider.request` at line 81 and in `onInput` at line 108) to `if (mode === 'approve_all')`.

- [ ] **Step 4: Run the node tests to verify they pass**

Run: `node --test --test-force-exit packages/falador-nodes/test/translate-and-approve.test.ts packages/falador-nodes/test/first-class-providers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/falador-nodes/src/human-approve.ts packages/falador-nodes/test/translate-and-approve.test.ts packages/falador-nodes/test/first-class-providers.test.ts
git commit -m "feat(nodes): unify human.approve mode on ask_all, non_readonly, approve_all"
```

---

### Task 2: Consolidate the 3 Workflows in `apps/tui/flows/` and Propagate `human.approve.params.mode` in `run-flow.mjs`

**Files:**
- Delete: `apps/tui/flows/ti-diagnostico.json`
- Delete: `apps/tui/flows/traducao-transcricao.json`
- Modify: `apps/tui/flows/especialista-ti.json:45,80`
- Modify: `apps/tui/flows/entrevista.json:92`
- Modify: `apps/tui/flows/agente-workflows.json` (verify `approvalPolicy: "non_readonly"`)
- Modify: `packages/falador-cli/run-flow.mjs:72-93`
- Test: `packages/falador-cli/test/run-flow.test.mjs:349-382`

**Interfaces:**
- Consumes: `HumanApproveMode` (`'ask_all' | 'non_readonly' | 'approve_all'`) from Task 1.
- Produces:
  - Only `especialista-ti.json`, `agente-workflows.json`, and `entrevista.json` exist in `apps/tui/flows/*.json`.
  - `run-flow.mjs` resolves `approvalLevel` from:
    1. The first enabled `human.approve` node's `params.mode` if valid (`'ask_all' | 'non_readonly' | 'approve_all'`), else
    2. `flow.approvalLevel` if valid, else
    3. `'non_readonly'`.
  - `run-flow.mjs` applies `approvalLevel` at runtime to:
    - `human.approve`: `n.params.mode = approvalLevel`
    - `agent.tools`: `n.params.approvalPolicy = APPROVAL_LEVELS[approvalLevel].agent` (`'always' | 'non_readonly' | 'never'`)
    - `exec.command`: `n.params.approvalLevel = APPROVAL_LEVELS[approvalLevel].exec` (`'ask_all' | 'non_readonly' | 'approve_all'`)
    - `decision.llm` (when `approvalLevel === 'ask_all'` and the `decision.llm` node has an outgoing edge to a `human.approve` node's `.in` port, as in `entrevista.json`): rewrites its outgoing edges or `options`/`defaultOption` so all decisions route through the port connected to `human.approve` (forcing human review on every suggestion).

- [ ] **Step 1: Update `packages/falador-cli/test/run-flow.test.mjs` to use `mode: 'ask_all'` and add tests for `human.approve.params.mode` propagation and the 3 canonical workflows**

In `packages/falador-cli/test/run-flow.test.mjs`:
1. Change line 356 from `{ id: 'gate', type: 'human.approve', params: { mode: 'manual' } }` to `{ id: 'gate', type: 'human.approve', params: { mode: 'ask_all' } }`.
2. Add a test verifying that `apps/tui/flows/` contains exact 3 JSON workflows (`agente-workflows.json`, `entrevista.json`, `especialista-ti.json`) and each validates cleanly with `validateFlow`.
3. Add a test verifying that in a `decision.llm -> human.approve` flow (like `entrevista.json`), setting `human.approve.params.mode = 'ask_all'` routes even the `'auto'` branch through `human.approve`, and setting `mode = 'approve_all'` bypasses the gate without prompting.

- [ ] **Step 2: Run `packages/falador-cli/test/run-flow.test.mjs` to verify it fails**

Run: `node --test --test-force-exit packages/falador-cli/test/run-flow.test.mjs`
Expected: FAIL (`ti-diagnostico.json` and `traducao-transcricao.json` still exist; `especialista-ti.json` and `entrevista.json` still have `"mode": "manual"`).

- [ ] **Step 3: Delete `ti-diagnostico.json` and `traducao-transcricao.json`, update `especialista-ti.json` and `entrevista.json`, and update `packages/falador-cli/run-flow.mjs`**

1. Delete `apps/tui/flows/ti-diagnostico.json` and `apps/tui/flows/traducao-transcricao.json`.
2. In `apps/tui/flows/especialista-ti.json`:
   - Set `agente.params.approvalPolicy` (line 45) to `"non_readonly"`.
   - Set `gate_humano.params.mode` (line 80) to `"non_readonly"`.
3. In `apps/tui/flows/entrevista.json`:
   - Set `revisao.params.mode` (line 92) to `"non_readonly"`.
4. In `packages/falador-cli/run-flow.mjs` (lines 72–93):
   - Resolve `approveNode = (flow.nodes ?? []).find((n) => n.type === 'human.approve' && n.enabled !== false)`.
   - Determine `rawLevel = approveNode?.params?.mode ?? flow.approvalLevel`.
   - `const approvalLevel = typeof rawLevel === 'string' && APPROVAL_LEVELS[rawLevel] ? rawLevel : 'non_readonly';`
   - Set `n.params.mode = approvalLevel` on `human.approve` nodes, `n.params.approvalPolicy = APPROVAL_LEVELS[approvalLevel].agent` on `agent.tools` nodes, and `n.params.approvalLevel = APPROVAL_LEVELS[approvalLevel].exec` on `exec.command` nodes.
   - When `approvalLevel === 'ask_all'`, for any `decision.llm` node that has an outgoing edge `decNodeId.<approvePort> -> approveNodeId.in` where `approveNodeId` is a `human.approve` node, restrict `decNode.params.options = [approvePort]` and `decNode.params.defaultOption = approvePort` (and remove unused non-approval outgoing edges from `flow.edges`) so every message goes through `human.approve`.

- [ ] **Step 4: Run `run-flow.test.mjs` and node flow validation tests to verify they pass**

Run: `node --test --test-force-exit packages/falador-cli/test/run-flow.test.mjs packages/falador-nodes/test/capture-cleanup.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git rm apps/tui/flows/ti-diagnostico.json apps/tui/flows/traducao-transcricao.json
git add apps/tui/flows/especialista-ti.json apps/tui/flows/entrevista.json packages/falador-cli/run-flow.mjs packages/falador-cli/test/run-flow.test.mjs
git commit -m "feat(flows,cli): keep only 3 workflows and drive approval level from human.approve.mode"
```

---

### Task 3: Unify Approval Options (A/B/C) in Builder & Runner Stage Box and Remove Duplicate `LogsPanel` Dropdown

**Files:**
- Modify: `apps/web/src/data.ts:380-390`
- Modify: `apps/web/src/views/BuilderView.tsx:122-124`
- Modify: `apps/web/src/live-utils.ts:285-295,412-423`
- Modify: `apps/web/src/views/LiveView.tsx:96-97,160-168,415-417,1533-1534`
- Modify: `apps/web/src/components/LogsPanel.tsx:112-114,125-131,148-149,522-536`
- Modify: `apps/web/src/App.tsx:360-400,515-520`
- Modify: `apps/web/tests/approval-level.spec.ts:1-30`

**Interfaces:**
- Consumes: `HumanApproveMode = 'ask_all' | 'non_readonly' | 'approve_all'` from Task 1 & Task 2.
- Produces:
  - `PARAM_HELP['human.approve'].mode` in `apps/web/src/data.ts` has `def: 'non_readonly'` and options:
    - `{ val: 'ask_all', label: 'A · Perguntar tudo' }`
    - `{ val: 'non_readonly', label: 'B · Só destrutivos/alteração' }`
    - `{ val: 'approve_all', label: 'C · Aprovar tudo' }`
  - `stageItems` in `apps/web/src/views/LiveView.tsx` for `stage.kind === 'approve-mode'` returns:
    - `{ id: 'ask_all', label: 'A · Perguntar tudo' }`
    - `{ id: 'non_readonly', label: 'B · Só destrutivos/alteração' }`
    - `{ id: 'approve_all', label: 'C · Aprovar tudo' }`
  - `deriveStages` in `apps/web/src/live-utils.ts`:
    - For `human.approve`: `value: String(p.mode ?? 'non_readonly')`.
    - For synthesized `Approval` stage on `agent.tools` (when flow has no `human.approve` node, e.g. `agente-workflows.json`): maps `ap.approvalPolicy` (`'always' -> 'ask_all'`, `'never' -> 'approve_all'`, default `'non_readonly'`).
  - `onUpdateStage` in `apps/web/src/App.tsx`:
    - When updating `human.approve` (`param === 'mode'`) or `agent.tools` (`param === 'approvalPolicy'`), normalizes the selected `A/B/C` ID (`'ask_all' | 'non_readonly' | 'approve_all'`), writes `mode` on `human.approve`, maps `'ask_all' -> 'always'`, `'non_readonly' -> 'non_readonly'`, `'approve_all' -> 'never'` onto `agent.tools.params.approvalPolicy`, and sets `flow.approvalLevel = value`.
  - `LogsPanel.tsx` no longer renders `.approval-level-wrap` or accepts `approvalLevel` / `onSetApprovalLevel`.

- [ ] **Step 1: Update `apps/web/tests/approval-level.spec.ts` to test the `Approval` stage box in the Runner bar and verify `.approval-level-wrap` is gone from `LogsPanel`**

In `apps/web/tests/approval-level.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

test('box Approval na barra do Runner exibe A/B/C (default B), não existe duplicata ao lado de Pensamentos e o run leva mode=approve_all', async ({ page }) => {
  let posted: {
    flow?: {
      approvalLevel?: string;
      nodes?: Array<{ id: string; type: string; params?: Record<string, unknown> }>;
    };
  } | null = null;
  await page.route('**/api/run', async (route) => {
    posted = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: ended\ndata: {"code":0}\n\n',
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Runner' }).click();

  // Não existe mais o dropdown duplicado ao lado de Pensamentos
  await expect(page.locator('.approval-level-wrap')).toHaveCount(0);

  // Box Approval na barra de etapas do Runner mostra default B · Só destrutivos/alteração
  const approvalStage = page.locator('.live2-stage', { hasText: 'Approval' });
  await expect(approvalStage).toBeVisible();
  await expect(approvalStage.getByText(/B · Só destrutivos\/alteração/)).toBeVisible();

  // Escolhe C · Aprovar tudo no box Approval
  await approvalStage.locator('.cds--dropdown').click();
  await page.getByRole('option', { name: /C · Aprovar tudo/ }).click();
  await expect(approvalStage.getByText(/C · Aprovar tudo/)).toBeVisible();

  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();
  await expect.poll(() => {
    const gateNode = posted?.flow?.nodes?.find((n) => n.type === 'human.approve');
    return gateNode?.params?.mode;
  }).toBe('approve_all');
});
```

- [ ] **Step 2: Update `apps/web/src/data.ts`, `BuilderView.tsx`, `live-utils.ts`, `LiveView.tsx`, `LogsPanel.tsx`, and `App.tsx`**

1. `apps/web/src/data.ts` (lines 380–390):
```ts
  'human.approve': {
    mode: {
      help: 'A = pergunta tudo no gate humano; B = só ações destrutivas/alteração ou sensíveis (decisão); C = aprova tudo direto (bypass)',
      def: 'non_readonly',
      control: 'dropdown',
      options: [
        { val: 'ask_all', label: 'A · Perguntar tudo' },
        { val: 'non_readonly', label: 'B · Só destrutivos/alteração' },
        { val: 'approve_all', label: 'C · Aprovar tudo' },
      ],
    },
  },
```
2. `apps/web/src/views/BuilderView.tsx` (lines 122–124):
   - Change `: type === 'human.approve' ? { mode: 'manual' }` to `: type === 'human.approve' ? { mode: 'non_readonly' }`.
3. `apps/web/src/live-utils.ts`:
   - Line 294: `value: String(p.mode ?? 'non_readonly'),`
   - Lines 412–423 (synthesized `Approval` stage when only `agent.tools` is present):
     ```ts
     const rawPolicy = String(ap.approvalPolicy ?? 'non_readonly');
     const mappedMode =
       rawPolicy === 'always' || rawPolicy === 'ask_all'
         ? 'ask_all'
         : rawPolicy === 'never' || rawPolicy === 'approve_all'
           ? 'approve_all'
           : 'non_readonly';
     ```
     and set `value: mappedMode`.
4. `apps/web/src/views/LiveView.tsx`:
   - Lines 160–168:
     ```ts
     if (stage.kind === 'approve-mode') {
       return [
         { id: 'ask_all', label: 'A · Perguntar tudo' },
         { id: 'non_readonly', label: 'B · Só destrutivos/alteração' },
         { id: 'approve_all', label: 'C · Aprovar tudo' },
       ];
     }
     ```
   - Remove `onSetApprovalLevel` prop from `LiveView` and from `<LogsPanel ... />`.
5. `apps/web/src/components/LogsPanel.tsx`:
   - Remove `APPROVAL_LEVEL_OPTIONS`, `approvalLevel`, `onSetApprovalLevel`, and the `{!forceService && onSetApprovalLevel && (<div className="approval-level-wrap">...</div>)}` block.
6. `apps/web/src/App.tsx`:
   - In `onUpdateStage`: when updating `human.approve` (`param === 'mode'`) or `agent.tools` (`param === 'approvalPolicy'`), map `'ask_all' | 'non_readonly' | 'approve_all'` to both `human.approve.params.mode` and `agent.tools.params.approvalPolicy` (`'always' | 'non_readonly' | 'never'`) and set `approvalLevel: String(value)` on `next`.
   - Remove `onSetApprovalLevel` function and prop passed to `<LiveView />`.

- [ ] **Step 3: Typecheck and build the web app**

Run: `cd apps/web && npx tsc --noEmit && npx vite build`
Expected: PASS with 0 TypeScript errors and clean Vite bundle build.

- [ ] **Step 4: Run the Playwright test `apps/web/tests/approval-level.spec.ts` and full verification suite**

Run: `cd apps/web && npx playwright test tests/approval-level.spec.ts tests/runner-bar-layout.spec.ts tests/ui-smoke.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/data.ts apps/web/src/views/BuilderView.tsx apps/web/src/live-utils.ts apps/web/src/views/LiveView.tsx apps/web/src/components/LogsPanel.tsx apps/web/src/App.tsx apps/web/tests/approval-level.spec.ts
git commit -m "feat(web): move A/B/C approval selector into Approval component and remove LogsPanel duplicate"
```
