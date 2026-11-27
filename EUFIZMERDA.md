# Registro de Alterações e Erros da Sessão — 2026-11-27

> Documento criado em **2026-11-27** para registrar exatamente o que foi alterado nesta sessão, o que foi testado e o que ficou quebrado/pendente para correção pelo próximo modelo.

---

## 1. Arquivos Criados e Modificados (2026-11-27)

### Criados
1. `apps/tui/flows/tradutor.json` *(já existia untracked no workspace e foi sobrescrito)*
   - Substituiu a configuração antiga (`asr.lfm3` com `model: "mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit"` e `url: "http://127.0.0.1:8090/asr-translate"`) por um pipeline streaming:
     - `capture1` (`capture.ffmpeg`, `backend: "sck"`, `input: "Google Chrome"`, `chunkMs: 80`, `isDefault: true`)
     - `asr2` (`asr.realtime`, `url: "ws://127.0.0.1:8090/v1/realtime"`, `model: "/Users/otaviolemos/.lmstudio/models/mlx-community/nemotron-3.5-asr-streaming-0.6b"`, `serverVad: true`, `inputRate: 16000`)
     - `translate3` (`translate.llm`, `baseUrl: "http://127.0.0.1:8080"`, `model: "LiquidAI--LFM3-1.7B-MLX-4bit"`, `targetLanguage: "Portuguese"`, `enableThinking: false`, `temperature: 0.1`, `maxTokens: 256`)
     - `sink4` (`sink.captions`, `mode: "callback"`, `showParcials: true`, `outputMode: "speak"`, `language: "Portuguese"`, `voice: "male"`, `isDefault: true`, `ttsUrl: "http://127.0.0.1:8091"`)
     - Arestas: `capture1.out -> asr2.in` (`drop_oldest`, `ttlMs: 1500`), `asr2.out -> translate3.parcs` (`drop_oldest`), `capture1.out_text -> translate3.in` (`block`), `translate3.out -> sink4.in` (`drop_oldest`).
2. `apps/tui/flows/tradutor-omni.json`
   - Pipeline usando apenas o `LFM3-Omni-2B-MLX-8bit` via `:8092`:
     - `capture1` (`capture.ffmpeg`, `backend: "sck"`, `input: "Google Chrome"`, `chunkMs: 80`, `isDefault: true`)
     - `asr2` (`asr.lfm3`, `url: "http://127.0.0.1:8092"`, `model: "LiquidAI/LFM3-Omni-2B-MLX-8bit"`, `targetLanguage: "Portuguese"`, `sampleRateHz: 16000`, `flushSec: 6`)
     - `sink4` (`sink.captions`, `mode: "callback"`, `showParcials: true`, `outputMode: "write"` *(alterado erroneamente de `"speak"` para `"write"`)*, `language: "Portuguese"`, `voice: "male"`, `isDefault: true`, `ttsUrl: "http://127.0.0.1:8092"`)
3. `services/omni-sidecar.py`
   - Sidecar HTTP na porta `8092` carregando `LFM3-Omni-2B-MLX-8bit` via `mlx_vlm` (`load`, `generate`, `generate_audio`, `apply_chat_template`).
   - Endpoints: `GET /health`, `POST /asr-translate`, `POST /tts`.

### Modificados
4. `faladorctl`
   - Adicionado `SNAP_NEMOTRON_ASR="$HOME/.lmstudio/models/mlx-community/nemotron-3.5-asr-streaming-0.6b"` (trocando `--realtime-model` do serviço `asr :8090` de `SNAP_VOXTRAL` para `SNAP_NEMOTRON_ASR`; `SNAP_VOXTRAL` ficou comentado).
   - Adicionado `SNAP_LFM3_OMNI="$HOME/.lmstudio/models/LiquidAI/LFM3-Omni-2B-MLX-8bit"` e o 5º serviço residente `omni|8092|/health` executando `services/omni-sidecar.py`.
5. `services/sts-sidecar.py`
   - Substituído `pass` em `log_message` (mantendo `GET /health` silencioso) e adicionados logs com `flush=True`, status HTTP e duração em ms para `POST /asr-translate` e `POST /tts` (para aparecerem em `logs/tts.log`).
6. `packages/falador-nodes/src/asr-lfm3.ts`
   - Normalização de `ctx.params.url` removendo barra final e sufixo `/asr-translate` duplicado antes de chamar `${url}/asr-translate`.
7. `apps/web-server.mjs`
   - Adicionado `omni: 'omni.log'` em `LOG_FILES`.
   - Adicionado `getOmniUrl()` (`FALADOR_OMNI_URL || 'http://127.0.0.1:8092'`) e probe `/health` em `GET /api/services/status`.
8. `apps/web/src/api.ts`
   - Adicionado `omni: boolean` em `ServiceStatusMap`.
9. `apps/web/src/data.ts`
   - `serviceOfNode(type, params)` passou a aceitar `params` e mapear `tts.sts` / `asr.lfm3` com `:8092` para `'omni'`.
10. `apps/web/src/components/LogsPanel.tsx`
    - Renomeados cabeçalhos para `ASR Streaming (mlx-audio)` (`:8090`) e `TTS / STS (LFM3-Audio)` (`:8091`).
    - Adicionado bloco `Omni · mlx-vlm (LFM3-Omni)` (`:8092`) em `BASE_SERVICES` e atualizado polling de `ServiceStatusMap`.
11. `apps/web/src/components/NodeEditor.tsx`
    - Separado filtro de modelos em `modelsForNode`: `asr.realtime` exclui `/lfm.*audio/i`; `asr.lfm3` filtra apenas `/lfm.*audio/i`.
12. `apps/web/src/App.tsx` e `apps/web/src/live-utils.ts`
    - Incluído `'translate.llm'` na sanitização de modelos do `omlx`, ajustado `resolveId`/`resolveOmlxId` para match bidirecional entre ID longo e curto, e sincronizado `targetLanguage` do nó tradutor para `sink.captions.params.language` em `App.tsx`.
13. `packages/falador-cli/test/run-flow.test.mjs`
    - Atualizada lista esperada de flows canônicos para incluir `'tradutor-omni.json'` e `'tradutor.json'`.
14. `apps/web-server.test.mjs` e `apps/web-server.routes.test.mjs`
    - Atualizadas asserções de `/api/logs/clear` e `/api/services/status` para os 5 serviços (`omlx`, `asr`, `tts`, `omni`, `web`).
15. `apps/web/dist/*`
    - Rebuild da UI via `npm run build` em `apps/web`.

*(Nota: havia outras modificações pré-existentes no workspace em `apps/web/src/views/LiveView.tsx`, `apps/web/tests/ui-smoke.spec.ts` etc., que já estavam antes desta sessão e não foram alteradas aqui.)*

---

## 2. Erros Cometidos e Problemas em Aberto (O que precisa ser corrigido)

1. **Diagnóstico errado de eco em `tradutor-omni.json` (`outputMode` trocado para `"write"` sem necessidade)**
   - O `tradutor-omni.json` foi alterado de `outputMode: "speak"` para `outputMode: "write"` sob a premissa errada de que o `afplay` estava causando loop de eco.
   - Na realidade, `capture1` usa `backend: "sck"` filtrado em `input: "Google Chrome"`, que captura apenas o áudio do Chrome e **não** captura o `afplay`.
   - **O que causou o texto repetido/quebrado nos prints do usuário:** `asr.lfm3` sem VAD com `flushSec: 6` cortava as falas no meio e enviava o prompt `"Transcribe the audio and translate it to Portuguese..."`, fazendo o `LFM3-Omni` cuspir transcrição em inglês + tradução em português misturadas a cada 6s.

2. **`tradutor.json` travou no `:8090` baixando modelo duplicado (correção do path NÃO testada ao vivo)**
   - Na primeira tentativa ao vivo do usuário, `tradutor.json` tinha `"model": "mlx-community/nemotron-3.5-asr-streaming-0.6b"`, enquanto o servidor `:8090` carregava `/Users/otaviolemos/.lmstudio/models/mlx-community/nemotron-3.5-asr-streaming-0.6b`.
   - O `mlx_audio/server.py` não reconheceu o ID como o mesmo modelo residente e travou tentando baixar 4 arquivos do Hugging Face (`Fetching 4 files`).
   - `tradutor.json` foi atualizado para o caminho local `/Users/otaviolemos/.lmstudio/models/mlx-community/nemotron-3.5-asr-streaming-0.6b`, mas **ainda NÃO foi testado ao vivo** com o servidor `:8090` nem com áudio real.

3. **Streaming vs VAD / Tradução em tempo real**
   - **`translate.llm`** (`packages/falador-nodes/src/translate-llm.ts:71`) ainda tem `if (port === 'parcs' && !pl.final) return;`: embora `asr.realtime` (`:8090`) envie parciais em streaming, a tradução só roda quando o VAD fecha a frase (`final: true`).
   - **`asr.lfm3` (`tradutor-omni.json`)** ainda usa janela fixa `flushSec: 6` sem VAD de áudio antes do nó, continuando sujeito a cortes no meio de frases.
   - **`omni-sidecar.py` (`:8092`)** teve o prompt ajustado para `"Translate the spoken audio directly into <lang>. Output ONLY the translation, nothing else."`, mas **ainda NÃO foi testado ao vivo** após essa edição (nem com `POST /asr-translate`, nem com `POST /tts` depois do restart).

4. **Visual no Builder reportado pelo usuário**
   - O usuário enviou screenshot do Builder mostrando a barra de legendas do run anterior aparecendo na parte inferior do Builder e reclamou do comportamento no Builder/Logs — causa exata na UI do Builder não foi investigada após o envio dos prints.

---

## 3. Verificações Executadas na Sessão (e o que NÃO foi verificado)

### Executado e passou (após as respectivas edições)
- `cd apps/web && npx tsc --noEmit && npm run build` → passou (`1021` módulos transformados).
- `node --test --test-force-exit apps/web-server.test.mjs apps/web-server.routes.test.mjs packages/falador-cli/test/run-flow.test.mjs` (fora do sandbox) → **32/32 passaram**.
- `node --test --test-force-exit packages/falador-nodes/test/decision-turn-translate.test.ts packages/falador-nodes/test/translate-and-approve.test.ts packages/falador-cli/test/run-flow.test.mjs` (fora do sandbox, antes da inclusão do `tradutor-omni.json` e do `omni` no `web-server`) → **35/35 passaram**.
- Última verificação rodada após a última edição em `tradutor.json` / `omni-sidecar.py` / `tradutor-omni.json`:
  - `.venv/bin/python -m py_compile services/omni-sidecar.py` → exit `0`.
  - `node --test --test-force-exit --test-name-pattern="workflows canônicos" packages/falador-cli/test/run-flow.test.mjs` → **1/1 passou**.

### NÃO verificado ao vivo
- `./faladorctl restart` após a última edição de `omni-sidecar.py` e `tradutor.json`.
- Teste E2E real do workflow `tradutor.json` com `nemotron-3.5-asr-streaming-0.6b` no `:8090` + `translate.llm` `:8080` + `sts-sidecar.py` `:8091`.
- Teste E2E real do workflow `tradutor-omni.json` com `omni-sidecar.py` no `:8092` após o ajuste de prompt.
- Teste da suíte completa de `packages/falador-nodes/test/` após todas as edições finais.
