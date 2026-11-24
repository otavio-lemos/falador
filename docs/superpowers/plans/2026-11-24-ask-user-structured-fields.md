# Guided Q&A Structured Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ask_user` collect structured data (host, user, credential, mode) via typed Carbon form fields instead of free text, with a single source of truth for the schema.

**Architecture:** Add an optional `fields` array to the `ask_user` tool schema in `agent-tools.ts`. Pass it through gate meta (already happens via `args`). Parse it in `LiveView.parseGateCommand`. Render Carbon `TextInput`/`PasswordInput`/`Select`/`Button` instead of raw HTML inputs. On approve, serialize field values to JSON (or the selected option). Keep free-text fallback when no fields.

**Tech Stack:** React 18, @carbon/react, TypeScript, Vite.

**Spec:** AGENTS.md § "CONSOLE + CONVERSA MELHORADOS" + user request for structured IP/user/cred/bastion fields.

## Global Constraints

- No inline styles; use Carbon components and SCSS tokens.
- No duplicate labels/context text.
- Free-text fallback when `fields` is empty.
- Build must pass (`vite build`).

## Review Focus

- Field validation (required fields) before approve.
- Serialization format consistency between UI and agent answer.
- Carbon component imports verified via MCP, not training data.

---

### Task 1: Formalize `fields` schema in agent-tools.ts

**Files:**
- Modify: `packages/falador-nodes/src/agent-tools.ts` (ASK_USER_TOOL parameters)

**Interfaces:**
- Produces: `fields?: { name, label, type: 'text'|'password'|'select', placeholder?, options?, required? }[]` in tool args, passed to gate meta.

- [ ] **Step 1: Verify current schema already includes fields** (it does from prior edit). Confirm no duplicate `context` in askText (already removed).
- [ ] **Step 2: Add validation** in ask_user handler: if fields present, require all required fields non-empty in answer; reject with message otherwise.
- [ ] **Step 3: Commit.**

### Task 2: Parse fields + context in LiveView

**Files:**
- Modify: `apps/web/src/views/LiveView.tsx` (`parseGateCommand`)

**Interfaces:**
- Consumes: gate meta args.fields, args.context.
- Produces: `gateInfo.fields`, `gateInfo.context`.

- [ ] Already done. Verify no duplicate context rendering (removed). 

### Task 3: Replace raw HTML inputs with Carbon components

**Files:**
- Modify: `apps/web/src/views/LiveView.tsx` (ask_user branch render)

**Interfaces:**
- Consumes: `gateInfo.fields`, `fieldValues` state.

- [ ] **Step 1:** Query Carbon MCP for `TextInput`, `PasswordInput`, `Select`, `SelectItem` import paths.
- [ ] **Step 2:** Replace `<input>`/`<select>` raw elements with Carbon components.
- [ ] **Step 3:** Use Carbon `FormGroup` + `Stack` for layout, no inline styles.
- [ ] **Step 4:** Build and verify.

### Task 4: Remove leftover "Sua resposta" and duplicate tags

**Files:**
- Modify: `apps/web/src/views/LiveView.tsx`

- [ ] Already done (label removed, duplicate tag removed).

### Task 5: Build + push

- [ ] Build in paralelo-novo worktree.
- [ ] Commit + push to main.

---

**Plan complete.** Which execution approach? Subagent-driven or native?