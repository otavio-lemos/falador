// App — shell com duas telas (Criação | Execução). A criação usa a TopBar padrão;
// a execução (LiveView) tem header próprio (LIVE MODE). Estado de execução (useRunner)
// e o flow ao vivo são compartilhados; trocar uma etapa atualiza o param real e reinicia.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Theme, ToastNotification } from '@carbon/react';
import { ReactFlowProvider } from '@xyflow/react';
import { TopBar } from './components/TopBar';
import { BuilderView } from './views/BuilderView';
import { LiveView } from './views/LiveView';
import { useRunner } from './useRunner';
import { fetchCatalog, fetchFlows, fetchFlow, fetchModels, fetchApps, fetchContext, saveFlow, deleteFlow, uploadDoc, removeDoc, clearLogs, resetHistory, type Catalog, type Flow, type ContextDoc, type ServiceStatusMap } from './api';
import { isOmniModel } from './data';
import { applyContext, inferOutputLanguage, isDecisionModel, resolveDefaultNodeId, sanitizeFlow } from './live-utils';

type InputMode = 'apps' | 'mic' | 'chat';
type OutputMode = 'write' | 'speak';

function readSavedInputMode(): InputMode | null {
  try {
    const v = localStorage.getItem('falador.inputMode');
    if (v === 'apps' || v === 'mic' || v === 'chat') return v;
  } catch { /* ignore */ }
  return null;
}

function readSavedOutputMode(): OutputMode | null {
  try {
    const v = localStorage.getItem('falador.outputMode');
    if (v === 'write' || v === 'speak') return v;
  } catch { /* ignore */ }
  return null;
}

function modeFromFlow(f: Flow): InputMode {
  const defId = resolveDefaultNodeId(f, 'capture.ffmpeg');
  const cap = (defId ? f.nodes.find((n) => n.id === defId) : undefined) ?? f.nodes.find((n) => n.type === 'capture.ffmpeg');
  if (cap) {
    const backend = String(cap.params?.backend ?? 'chat');
    if (backend === 'chat' || cap.params?.muted === true || cap.enabled === false) return 'chat';
    if (backend === 'sounddevice') return 'mic';
    return 'apps';
  }
  return 'chat';
}

function outputModeFromFlow(f: Flow): OutputMode {
  const defId = resolveDefaultNodeId(f, 'sink.captions');
  const out = (defId ? f.nodes.find((n) => n.id === defId) : undefined) ?? f.nodes.find((n) => n.type === 'sink.captions');
  if (out) return out.params?.outputMode === 'speak' ? 'speak' : 'write';
  return 'write';
}

function scenarioLabel(name: string): string {
  if (name === 'agente-workflows') return 'Agente de Workflows';
  if (name.includes('entrevista') || name.startsWith('cenario2')) return 'Entrevista Técnica';
  if (name.includes('ops') || name.includes('servidor')) return 'Ops / Revisão de Servidor';
  if (name.includes('traducao') || name.includes('transcricao') || name.includes('tradutor')) return 'Tradução / Transcrição';
  if (name.includes('legendas') || name.startsWith('cenario1')) return 'Legendas ao vivo';
  if (name.includes('transcricao')) return 'Transcrição ao vivo';
  if (name.includes('tradutor-voz')) return 'Tradutor de voz';
  return name || 'Sessão';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function App() {
  const [view, setView] = useState<'builder' | 'live'>('live');
  const [theme, setTheme] = useState<'g100' | 'white'>(() => {
    try { return localStorage.getItem('falador.theme') === 'white' ? 'white' : 'g100'; } catch { return 'g100'; }
  });
  const [inputMode, setInputMode] = useState<InputMode>(() => readSavedInputMode() ?? 'chat');
  const lastVoiceModeRef = useRef<'apps' | 'mic'>('mic');
  const [outputMode, setOutputMode] = useState<OutputMode>(() => readSavedOutputMode() ?? 'write');
  const [inputResetTick, setInputResetTick] = useState(0);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [flows, setFlows] = useState<{ name: string; description: string }[]>([]);
  const [currentFlow, setCurrentFlow] = useState('');
  const [readyFlow, setReadyFlow] = useState<string | null>(null);
  const [editFlowOpen, setEditFlowOpen] = useState(false);
  const [liveFlow, setLiveFlow] = useState<Flow | null>(null);
  const [models, setModels] = useState<{ omlx: string[]; cache: string[]; details?: { id: string; model_type: string }[] }>({ omlx: [], cache: [] });
  const [apps, setApps] = useState<string[]>([]);
  const [contextDocs, setContextDocs] = useState<ContextDoc[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const runner = useRunner();
  const actionsRef = useRef<{ getFlow: () => Flow; save: () => void } | null>(null);
  const seenAgentStepsRef = useRef(0);

  const syncModels = useCallback((next: { omlx: string[]; cache: string[]; details?: { id: string; model_type: string }[] }) => {
    setModels((prev) => {
      if (
        prev.omlx.length === next.omlx.length &&
        prev.cache.length === next.cache.length &&
        prev.omlx.every((m, i) => m === next.omlx[i]) &&
        prev.cache.every((m, i) => m === next.cache[i])
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const handleServiceStatus = useCallback((status: ServiceStatusMap) => {
    if (status.omlx) {
      fetchModels().then(syncModels).catch(() => {});
    }
  }, [syncModels]);

  const toggleTheme = () => {
    setTheme((cur) => {
      const next = cur === 'g100' ? 'white' : 'g100';
      try { localStorage.setItem('falador.theme', next); } catch { /* ignore */ }
      return next;
    });
  };

  useEffect(() => {
    fetchCatalog().then(setCatalog).catch(() => setToast('Falha ao carregar catálogo'));
    fetchFlows().then((fs) => {
      setFlows(fs);
      const defaultName = (fs.find((f) => f.name === 'especialista-ti') ?? fs[0])?.name;
      setCurrentFlow(defaultName || '');
      if (defaultName) {
        fetchFlow(defaultName).then((f) => {
          const initialMode = readSavedInputMode() ?? modeFromFlow(f);
          const initialOut = outputModeFromFlow(f);
          if (initialMode !== 'chat') lastVoiceModeRef.current = initialMode;
          setInputMode(initialMode);
          setOutputMode(initialOut);
          setLiveFlow(applyOutputMode(applyInputMode(f, initialMode), initialOut));
        }).catch(() => setToast('Falha ao carregar fluxo inicial'));
      }
    }).catch(() => setToast('Falha ao listar flows'));
    fetchModels().then(syncModels).catch(() => {});
    fetchApps().then(setApps).catch(() => {});
    fetchContext().then(setContextDocs).catch(() => {});
  }, [syncModels]);

  // Se o workflow carregado referencia um modelo LLM/Agente/Decisão que não existe mais no /v1/models do omlx,
  // ajusta automaticamente para o primeiro modelo disponível no /v1/models (evitando HTTP 404).
  useEffect(() => {
    if (models.omlx.length === 0 || !liveFlow) return;
    const typeById = new Map<string, string>((models.details ?? []).map((d) => [d.id, d.model_type]));
    const chatModels = models.omlx.filter((m) => {
      const mt = typeById.get(m);
      return (!mt || mt === 'llm' || mt === 'vlm') && !/silero|vad\b|lfm.*audio|voxtral/i.test(m) && !isDecisionModel(m, mt);
    });
    const decisionModels = models.omlx.filter((m) => isDecisionModel(m, typeById.get(m)));
    if (chatModels.length === 0) return;
    const resolveOmlxId = (val: unknown, allowed: string[], fallback: string): string => {
      if (typeof val !== 'string' || !val || val === '-' || val === '—') return fallback;
      if (allowed.includes(val)) return val;
      const shortVal = val.split('/').pop()?.replace(/^models--/, '').replace(/--/g, '/') ?? val;
      const match = allowed.find((m) => {
        const shortM = m.split('/').pop()?.replace(/^models--/, '').replace(/--/g, '/') ?? m;
        return (
          m === val ||
          shortM === shortVal ||
          m.endsWith(`--${val}`) ||
          m.endsWith(`/${val}`) ||
          val.endsWith(`--${m}`) ||
          val.endsWith(`/${m}`)
        );
      });
      return match ?? fallback;
    };
    let changed = false;
    const nextNodes = liveFlow.nodes.map((n) => {
      if (n.type === 'llm.omlx' || n.type === 'translate.llm' || n.type === 'agent.tools' || n.type === 'goal.validator') {
        const nextParams = { ...n.params };
        let nodeChanged = false;
        const resolvedModel = resolveOmlxId(n.params.model, chatModels, chatModels[0]);
        if (n.params.model !== resolvedModel) {
          nextParams.model = resolvedModel;
          nodeChanged = true;
        }
        if (n.type === 'agent.tools') {
          if (typeof n.params.validatorModel === 'string') {
            const resolvedVal = resolveOmlxId(n.params.validatorModel, chatModels, chatModels[0]);
            if (n.params.validatorModel !== resolvedVal) {
              nextParams.validatorModel = resolvedVal;
              nodeChanged = true;
            }
          }
          if (typeof n.params.d1Model === 'string' && decisionModels.length > 0) {
            const resolvedD1 = resolveOmlxId(n.params.d1Model, decisionModels, decisionModels[0]);
            if (n.params.d1Model !== resolvedD1) {
              nextParams.d1Model = resolvedD1;
              nodeChanged = true;
            }
          }
        }
        if (nodeChanged) {
          changed = true;
          return { ...n, params: nextParams };
        }
      }
      if ((n.type === 'decision.llm' || n.type === 'turn.detector') && decisionModels.length > 0) {
        const allowed = n.type === 'decision.llm' ? [...decisionModels, ...chatModels] : decisionModels;
        const resolvedDec = resolveOmlxId(n.params.model, allowed, decisionModels[0]);
        if (n.params.model !== resolvedDec) {
          changed = true;
          return { ...n, params: { ...n.params, model: resolvedDec } };
        }
      }
      return n;
    });
    if (changed) {
      const updated = { ...liveFlow, nodes: nextNodes };
      setLiveFlow(updated);
      if (runner.running) startWithContext(updated, currentFlow);
    }
  }, [models, liveFlow]);

  const registerActions = useCallback((a: { getFlow: () => Flow; save: () => void }) => { actionsRef.current = a; }, []);
  const handleFlowLoaded = useCallback((name: string | null) => { setReadyFlow(name); }, []);
  const refreshFlows = useCallback(() => { fetchFlows().then(setFlows).catch(() => {}); }, []);

  // Atualiza automaticamente o dropdown de workflows quando o agente salvar ou remover um workflow
  useEffect(() => {
    const steps = runner.agentSteps;
    if (steps.length < seenAgentStepsRef.current) {
      seenAgentStepsRef.current = 0;
    }
    const fresh = steps.slice(seenAgentStepsRef.current);
    seenAgentStepsRef.current = steps.length;
    if (
      fresh.some(
        (s) =>
          s.phase === 'result' &&
          s.ok === true &&
          (s.tool === 'workflow_save' || s.tool === 'workflow_delete'),
      )
    ) {
      refreshFlows();
    }
  }, [runner.agentSteps, refreshFlows]);

  const applyInputMode = (f: Flow, mode: InputMode, targetNodeId?: string): Flow => {
    const targetId = targetNodeId ?? resolveDefaultNodeId(f, 'capture.ffmpeg');
    const asrTurnTypes = new Set(['asr.realtime', 'asr.realtime.translate', 'turn.detector']);
    const asrTurnIds = new Set(f.nodes.filter((n) => asrTurnTypes.has(n.type)).map((n) => n.id));
    const voiceOnlySinkIds = new Set<string>();
    for (const n of f.nodes) {
      if (n.type !== 'sink.captions') continue;
      const incoming = f.edges.filter((e) => e.to.split('.')[0] === n.id);
      if (incoming.length > 0 && incoming.every((e) => asrTurnIds.has(e.from.split('.')[0]))) {
        voiceOnlySinkIds.add(n.id);
      }
    }
    const updatedInputs = f.nodes.map((n) => {
      if (n.type === 'capture.ffmpeg' && (!targetId || n.id === targetId)) {
        const params: Record<string, unknown> = { ...n.params };
        delete params.muted;
        if (mode === 'chat') {
          params.backend = 'chat';
        } else if (mode === 'mic') {
          params.backend = 'sounddevice';
          params.input = '';
        } else {
          params.backend = 'sck';
          // NÃO apagar o app configurado no flow: input vazio faz o capture-sck capturar
          // TODOS os apps — inclusive o afplay da própria tradução (eco e texto repetido).
        }
        return { ...n, enabled: true, params };
      }
      return n;
    });
    const voiceOn = updatedInputs.some(
      (n) => n.type === 'capture.ffmpeg' && n.enabled !== false && n.params?.backend !== 'chat' && n.params?.muted !== true,
    );
    return {
      ...f,
      nodes: updatedInputs.map((n) => {
        if (n.type === 'input.chat') {
          return { ...n, enabled: !voiceOn };
        }
        if (asrTurnIds.has(n.id) || voiceOnlySinkIds.has(n.id)) {
          return { ...n, enabled: voiceOn };
        }
        return n;
      }),
    };
  };

  const applyOutputMode = (f: Flow, mode: OutputMode, targetNodeId?: string): Flow => {
    const targetId = targetNodeId ?? resolveDefaultNodeId(f, 'sink.captions');
    return {
      ...f,
      nodes: f.nodes.map((n) => {
        if (n.type === 'sink.captions' && (!targetId || n.id === targetId)) {
          const nextParams: Record<string, unknown> = { ...n.params, outputMode: mode };
          if (mode === 'speak') {
            if (!nextParams.language || typeof nextParams.language !== 'string') {
              nextParams.language = inferOutputLanguage(f, n.id);
            }
            if (!nextParams.model || nextParams.model === '-' || nextParams.model === '—') {
              nextParams.model = String(nextParams.ttsUrl ?? '').includes(':8092')
                ? 'LFM3-Omni-2B-MLX-8bit'
                : 'LiquidAI--LFM3-Audio-2B-MLX-8bit';
            }
          }
          return { ...n, params: nextParams };
        }
        if (n.type === 'sink.playback' || n.type === 'tts.sts') {
          return { ...n, params: { ...n.params, muted: mode === 'write' } };
        }
        return n;
      }),
    };
  };

  const onTest = () => {
    const f = actionsRef.current?.getFlow();
    if (!f) return;
    if (f.nodes.length === 0) {
      setToast('Adicione pelo menos um nó antes de testar');
      return;
    }
    runner.start(applyContext(sanitizeFlow(f, models), contextDocs), currentFlow, true);
  };
  const startWithContext = (f: Flow, name?: string) =>
    runner.start(applyContext(sanitizeFlow(f, models), contextDocs), name ?? currentFlow);

  const setModeAndSync = (next: InputMode, baseFlow = liveFlow, targetNodeId?: string) => {
    const defId = baseFlow ? resolveDefaultNodeId(baseFlow, 'capture.ffmpeg') : null;
    const isDefault = !targetNodeId || !defId || targetNodeId === defId;
    if (isDefault) {
      if (next !== 'chat') lastVoiceModeRef.current = next;
      setInputMode(next);
      try { localStorage.setItem('falador.inputMode', next); } catch { /* ignore */ }
    }
    if (baseFlow) {
      const updated = applyInputMode(baseFlow, next, targetNodeId);
      setLiveFlow(updated);
      if (runner.running) startWithContext(updated, currentFlow);
    }
  };

  const setOutputModeAndSync = (next: OutputMode, baseFlow = liveFlow, targetNodeId?: string) => {
    const defId = baseFlow ? resolveDefaultNodeId(baseFlow, 'sink.captions') : null;
    const isDefault = !targetNodeId || !defId || targetNodeId === defId;
    if (isDefault) {
      setOutputMode(next);
      try { localStorage.setItem('falador.outputMode', next); } catch { /* ignore */ }
    }
    if (baseFlow) {
      const updated = applyOutputMode(baseFlow, next, targetNodeId);
      setLiveFlow(updated);
      if (runner.running) startWithContext(updated, currentFlow);
    }
  };

  const onToggleInputMode = () => {
    const defId = liveFlow ? resolveDefaultNodeId(liveFlow, 'capture.ffmpeg') ?? undefined : undefined;
    setInputResetTick((n) => n + 1);
    if (inputMode === 'chat') {
      setModeAndSync(lastVoiceModeRef.current, liveFlow, defId);
    } else {
      lastVoiceModeRef.current = inputMode;
      setModeAndSync('chat', liveFlow, defId);
    }
  };
  // write/speak do Output vive só no dropdown da etapa (setOutputModeAndSync via onUpdateStage).
  // O botão speaker da topbar é mute local desta janela (estado em LiveView), sem tocar em nós.
  const onGoLive = () => {
    const f = actionsRef.current?.getFlow();
    if (!f) return;
    runner.stop();
    // Ao vir do Builder para o Runner, a fonte da verdade é SEMPRE o grafo editado no Builder
    // (nunca sobrescrever backend/outputMode com localStorage antigo, senão desliga o ASR e a voz).
    const initialMode = modeFromFlow(f);
    const initialOut = outputModeFromFlow(f);
    if (initialMode !== 'chat') lastVoiceModeRef.current = initialMode;
    setInputMode(initialMode);
    setOutputMode(initialOut);
    try {
      localStorage.setItem('falador.inputMode', initialMode);
      localStorage.setItem('falador.outputMode', initialOut);
    } catch { /* ignore */ }
    setLiveFlow(applyOutputMode(applyInputMode(f, initialMode), initialOut));
    setView('live');
    fetchApps().then(setApps).catch(() => {});
    fetchModels().then(setModels).catch(() => {});
  };
  const onSave = () => { actionsRef.current?.save(); setToast('Workflow salvo'); };

  const onNewFlow = async () => {
    const name = `workflow-${Date.now()}`;
    const blank: Flow = { version: 1, nodes: [], edges: [], stopWhenSourcesDone: false, description: 'Novo workflow personalizado' };
    await saveFlow(name, blank);
    await refreshFlows();
    setCurrentFlow(name);
    setEditFlowOpen(true);
    setToast(`Workflow "${name}" criado`);
  };

  const onDuplicateFlow = async () => {
    const f = actionsRef.current?.getFlow();
    if (!f || !currentFlow) return;
    let copyName = `${currentFlow}-copia`;
    let i = 2;
    while (flows.some((x) => x.name === copyName)) copyName = `${currentFlow}-copia-${i++}`;
    await saveFlow(copyName, { ...f });
    await refreshFlows();
    setCurrentFlow(copyName);
    setToast(`Workflow duplicado como "${copyName}"`);
  };

  const onDeleteFlow = async () => {
    if (!currentFlow) return;
    if (!window.confirm(`Remover permanentemente o workflow "${currentFlow}"?`)) return;
    try {
      await deleteFlow(currentFlow);
      const remaining = await fetchFlows();
      setFlows(remaining);
      setCurrentFlow(remaining[0]?.name ?? '');
      setToast(`Workflow "${currentFlow}" removido`);
    } catch {
      setToast('Falha ao remover workflow');
    }
  };

  const onRename = async (newName: string, newDesc: string) => {
    const f = actionsRef.current?.getFlow();
    if (!f) return;
    const updated: Flow = { ...f, description: newDesc };
    await saveFlow(newName, updated, newName !== currentFlow ? currentFlow : undefined);
    setCurrentFlow(newName);
    await refreshFlows();
    setToast('Detalhes do workflow salvos');
  };

  const onUpdateStage = (nodeId: string, param: string, value: unknown) => {
    if (!liveFlow) return;
    const target = liveFlow.nodes.find((n) => n.id === nodeId);
    if (target?.type === 'capture.ffmpeg' && param === 'backend') {
      const mode: InputMode = value === 'mic' ? 'mic' : value === 'chat' ? 'chat' : 'apps';
      setModeAndSync(mode, liveFlow, nodeId);
      return;
    }
    if (target?.type === 'sink.captions' && param === 'outputMode') {
      const mode: OutputMode = value === 'speak' ? 'speak' : 'write';
      setOutputModeAndSync(mode, liveFlow, nodeId);
      return;
    }
    if (target?.type === 'sink.captions' && param === 'model') {
      const defId = resolveDefaultNodeId(liveFlow, 'sink.captions');
      const isDefault = !defId || defId === nodeId;
      const isWriteOnly = !value || value === '-' || value === '—';
      const nextMode: OutputMode = isWriteOnly ? 'write' : 'speak';
      if (isDefault) {
        setOutputMode(nextMode);
        try { localStorage.setItem('falador.outputMode', nextMode); } catch { /* ignore */ }
      }
      const next: Flow = {
        ...liveFlow,
        nodes: liveFlow.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          if (isWriteOnly) {
            return { ...n, params: { ...n.params, model: '-', outputMode: 'write' } };
          }
          const modelStr = String(value);
          const nextParams: Record<string, unknown> = {
            ...n.params,
            model: modelStr,
            outputMode: 'speak',
            language:
              typeof n.params.language === 'string' && n.params.language.trim() !== ''
                ? n.params.language
                : inferOutputLanguage(liveFlow, nodeId),
          };
          const curTtsUrl = String(n.params.ttsUrl ?? '').trim();
          if (!curTtsUrl || curTtsUrl === 'http://127.0.0.1:8091' || curTtsUrl === 'http://127.0.0.1:8092') {
            nextParams.ttsUrl = isOmniModel(modelStr) ? 'http://127.0.0.1:8092' : 'http://127.0.0.1:8091';
          }
          return { ...n, params: nextParams };
        }),
      };
      setLiveFlow(next);
      if (runner.running) startWithContext(next);
      return;
    }
    if (
      (target?.type === 'human.approve' && param === 'mode') ||
      (target?.type === 'agent.tools' && param === 'approvalPolicy')
    ) {
      const level = value === 'ask_all' || value === 'approve_all' ? value : 'non_readonly';
      const policy = level === 'ask_all' ? 'always' : level === 'approve_all' ? 'never' : 'non_readonly';
      const next: Flow = {
        ...liveFlow,
        approvalLevel: level,
        nodes: liveFlow.nodes.map((n) => {
          if (n.type === 'human.approve') return { ...n, params: { ...n.params, mode: level } };
          if (n.type === 'agent.tools') return { ...n, params: { ...n.params, approvalPolicy: policy } };
          return n;
        }),
      };
      setLiveFlow(next);
      if (runner.running) startWithContext(next);
      return;
    }
    const sourceNode = liveFlow.nodes.find((n) => n.id === nodeId);
    const syncSinkLang =
      sourceNode &&
      (sourceNode.type === 'asr.realtime.translate' || sourceNode.type === 'translate.llm' || sourceNode.type === 'llm.omlx') &&
      param === 'targetLanguage' &&
      typeof value === 'string' &&
      value.trim() !== '' &&
      value.trim() !== '-' &&
      value.trim() !== '—'
        ? value.trim()
        : null;
    const next: Flow = {
      ...liveFlow,
      nodes: liveFlow.nodes.map((n) => {
        if (n.id !== nodeId) {
          if (syncSinkLang && n.type === 'sink.captions') {
            return { ...n, params: { ...n.params, language: syncSinkLang } };
          }
          return n;
        }
        // Dropdown do Carbon devolve id string; params numéricos (maxResults/topK/maxPages)
        // precisam virar number senão o validateFlow do motor rejeita o run.
        const prev = n.params[param];
        let coerced =
          typeof value === 'string' &&
          value !== '' &&
          (prev === undefined || typeof prev === 'number') &&
          Number.isFinite(Number(value))
            ? Number(value)
            : value;
        // Stage "Exec/SSH" grava o modo como string: 'ativo' = execução real → dryRun:false.
        if (n.type === 'exec.command' && param === 'dryRun' && typeof coerced === 'string') {
          coerced = coerced === 'ativo' ? false : coerced === 'dry-run' ? true : coerced;
        }
        const nextParams: Record<string, unknown> = { ...n.params, [param]: coerced };
        if (n.type === 'decision.llm' && param === 'model') {
          nextParams.mode = isDecisionModel(String(value)) ? 'systemone' : 'chat';
        }
        if (n.type === 'asr.realtime.translate' && param === 'targetLanguage') {
          delete nextParams.instruction;
        }
        // Trocar o modelo do Speech Translation muda o executor: Omni = :8092 (mlx-vlm),
        // LFM3-Audio = :8091 (mlx-audio). Só mexe em URL padrão; endpoint customizado fica.
        // url === undefined (não consta no JSON) é tratado como default :8091.
        if (n.type === 'asr.realtime.translate' && param === 'model' && typeof value === 'string' &&
            (nextParams.url === undefined || nextParams.url === 'http://127.0.0.1:8091' || nextParams.url === 'http://127.0.0.1:8092')) {
          nextParams.url = isOmniModel(value) ? 'http://127.0.0.1:8092' : 'http://127.0.0.1:8091';
        }
        if (n.type === 'llm.omlx' && param === 'targetLanguage') {
          delete nextParams.template;
        }
        return { ...n, params: nextParams };
      }),
    };
    setLiveFlow(next);
    if (runner.running) startWithContext(next);
  };
  const onRegenerate = () => { if (liveFlow && runner.running) startWithContext(liveFlow); };
  const onExit = () => { runner.stop(); };
  const onReset = async () => {
    runner.reset();
    await Promise.allSettled([clearLogs(), resetHistory('*')]);
    setResetSignal((n) => n + 1);
    setToast('Reset concluído — tela e logs limpos');
  };
  const onSwitchLiveFlow = async (name: string) => {
    try {
      const f = await fetchFlow(name);
      const m = modeFromFlow(f);
      const outM = outputModeFromFlow(f);
      if (m !== 'chat') lastVoiceModeRef.current = m;
      setInputMode(m);
      setOutputMode(outM);
      const updated = applyOutputMode(applyInputMode(f, m), outM);
      setCurrentFlow(name);
      setLiveFlow(updated);
      fetchModels().then(syncModels).catch(() => {});
      if (runner.running) startWithContext(updated, name);
    } catch { setToast('Falha ao carregar o flow'); }
  };

  const onOpenWorkflowAgent = async () => {
    try {
      const f = await fetchFlow('agente-workflows');
      runner.stop();
      const m = modeFromFlow(f);
      const outM = outputModeFromFlow(f);
      if (m !== 'chat') lastVoiceModeRef.current = m;
      setInputMode(m);
      setOutputMode(outM);
      setCurrentFlow('agente-workflows');
      setLiveFlow(applyOutputMode(applyInputMode(f, m), outM));
      setView('live');
      fetchApps().then(setApps).catch(() => {});
      fetchModels().then(setModels).catch(() => {});
    } catch {
      setToast('Falha ao abrir o Agente de Workflows');
    }
  };

  const onUploadDoc = async (file: File, tags?: string[]) => {
    try {
      const isPdf = file.name.toLowerCase().endsWith('.pdf');
      const payload = isPdf
        ? { pdfB64: await fileToBase64(file), tags }
        : { text: await file.text(), tags };
      setToast(`Indexando ${file.name}…`);
      await uploadDoc(file.name, payload);
      const docs = await fetchContext();
      setContextDocs(docs);
      setToast(`${file.name} indexado`);
    } catch (e) {
      setToast(`Falha: ${(e as Error).message}`);
    }
  };
  const onRemoveDoc = async (name: string) => {
    await removeDoc(name);
    setContextDocs(await fetchContext());
  };

  const currentDesc = flows.find((f) => f.name === currentFlow)?.description ?? '';

  return (
    <Theme theme={theme}>
      <div className="app" data-carbon-theme={theme}>
        {view === 'builder' && (
          <TopBar
            view={view}
            canGoLive={Boolean(catalog && currentFlow && readyFlow === currentFlow)}
            latencyMs={runner.latency} running={runner.running}
            theme={theme} onToggleTheme={toggleTheme}
            flows={flows} currentFlow={currentFlow}
            description={currentDesc}
            models={models}
            onRefreshModels={() => fetchModels().then(syncModels).catch(() => {})}
            editOpen={editFlowOpen}
            onOpenEdit={() => setEditFlowOpen(true)}
            onCloseEdit={() => setEditFlowOpen(false)}
            onSelectFlow={setCurrentFlow} onSave={onSave}
            onRename={onRename} onNewFlow={onNewFlow}
            onDuplicateFlow={() => void onDuplicateFlow()}
            onDeleteFlow={() => void onDeleteFlow()}
            onTest={onTest} onGoLive={onGoLive}
            onGoBuilder={() => setView('builder')} onStop={runner.stop}
            onOpenWorkflowAgent={() => void onOpenWorkflowAgent()}
          />
        )}
        <div className="app-body">
          {catalog && (
            <ReactFlowProvider>
              <div className={view === 'builder' ? 'view' : 'view view--hidden'}>
                <BuilderView
                  catalog={catalog} currentFlow={currentFlow} description={currentDesc}
                  runner={runner}
                  registerActions={registerActions} onFlowLoaded={handleFlowLoaded} onSaved={refreshFlows}
                  onEditFlow={() => setEditFlowOpen(true)}
                  models={models} apps={apps}
                  onRefreshApps={() => fetchApps().then(setApps).catch(() => {})}
                  onServiceStatus={handleServiceStatus}
                />
              </div>
            </ReactFlowProvider>
          )}
          {view === 'live' && liveFlow && (
            <LiveView
              runner={runner} flow={liveFlow} scenarioName={scenarioLabel(currentFlow)}
              theme={theme} onToggleTheme={toggleTheme}
              inputMode={inputMode} outputMode={outputMode}
              inputResetTick={inputResetTick}
              onToggleMicMute={onToggleInputMode}
              models={models} apps={apps}
              contextDocs={contextDocs} onUploadDoc={onUploadDoc} onRemoveDoc={onRemoveDoc}
              onStart={startWithContext}
              flows={flows} currentFlow={currentFlow} onSwitchFlow={onSwitchLiveFlow}
              onUpdateStage={onUpdateStage} onRegenerate={onRegenerate}
              onServiceStatus={handleServiceStatus}
              onNotify={(msg) => setToast(msg)}
              onGoBuilder={() => setView('builder')}
              onExit={onExit}
              onReset={() => void onReset()}
              resetSignal={resetSignal}
            />
          )}
        </div>
        {toast && (
          <ToastNotification
            kind="success" title={toast} subtitle="" caption=""
            className="app-toast" timeout={3000} onClose={() => setToast(null)}
          />
        )}
      </div>
    </Theme>
  );
}
