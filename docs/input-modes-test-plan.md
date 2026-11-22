# Plano de testes — entrada de áudio dupla (Aplicações vs Microfone + voz→chat)

Escopo: mudança de entrada de áudio conforme ADR-009. Código implantado em 2026-11-22; níveis 1 e 3 executados, nível 2 parcial (validação de flow) e nível 4 manual permanece NÃO VERIFICADO.

## Nível 1 — Unitário

- Resolvedor de device do capture node: dado nome de app/device, resolve para o identificador correto (app name → SCK; device name → PortAudio index).
- Contrato `/api/mics`: resposta contém lista de devices com nome + índice; formato estável.
- Validação de flow com `enabled` alternado: `validateFlow` aceita capture com `enabled:false` + `input.chat` habilitado.
- `validateFlow` com captura desabilitada e chat habilitado: flow válido, sem MISSING_BINDING.

## Nível 2 — Integração headless

- Rodar runner com flow de 3 nós (capture→asr→sink) com backend trocado por mock.
- Garantir NDJSON contínuo (eventos `caption`/`metrics`) e stop limpo (`run_stopped`).
- Nenhum child órfão após stop (capture-sck / capture-sidecar).

## Nível 3 — UI (Playwright)

- Mock de `/api/apps` e `/api/mics`.
- Selecionar Microfone troca dropdown e persiste em localStorage.
- Desligar voz em flow com chat desabilita captura (enabled=false) e habilita input.chat.
- Fluxo sem chat mantém alternância apps/mic.
- Badges e logs intactos; `tsc --noEmit` e `vite build` verdes.

## Nível 4 — Manual ao vivo (checklist, NÃO executar nesta rodada)

- [ ] Concessão de permissão de Microfone (TCC).
- [ ] Fala real no device capturada com energia/RMS > 0.
- [ ] ASR/tradução correta no modo mic.
- [ ] Sem eco (modo mic só-texto ou gate de envelope).
- [ ] Troca em execução sem processo zumbi.
- [ ] Output default do sistema inalterado.

## Critérios de aceite e sinais de falha

| Sinal | Significado |
|---|---|
| RMS zero | TCC não concedido ou routing errado. |
| Sample rate errado (fala 2×) | PortAudio não resampleou (clock nativo). |
| Child órfão | Bug no stop() do runner. |
| HTTP 409 | Run zumbi (run anterior não encerrou). |

## Ordem de execução recomendada

1. Backend (resolvedor + /api/mics).
2. UI (Playwright com mocks).
3. Integração headless (runner + mock).
4. Browser (tsc/build + smoke).
5. Live manual (checklist acima).

## Executado em 2026-11-22

- Nível 1: `resolveSounddeviceInput` (3 asserções), `capture-sidecar --list` real, `/api/mics` 200 + `no-store`, 7/7 flows válidos e voz/chat válidos no `validateFlow`.
- Nível 3: `tsc --noEmit` + `vite build` verdes; browser real confirmou dropdown Captura com Aplicações/Microfone, device picker e persistência em localStorage. Playwright não executado: binário não instalado neste worktree.
- Suíte Node completa: 211 testes, 210 pass, 1 skip (gate de mic).

## NÃO VERIFICADO

- Nível 2 headless com backend trocado por mock (runner completo) — parcial: apenas `validateFlow` executado.
- Nível 4 manual ao vivo (fala real/TCC/eco) não executado.
- Playwright não executado (binário ausente).
- Comportamento em macOS < 15 para SCK mic.
