// Tela de CRIAÇÃO do workflow — paleta + faixa de nome/descrição + canvas + editor inline.
// Carrega/salva flows, adiciona nós (drag/duplo clique), edita params no próprio nó, testa o fluxo.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Tag, TextInput } from '@carbon/react';
import { Checkmark, Close, Play } from '@carbon/icons-react';
import { useNodesState, useEdgesState, addEdge, type Edge, type Connection } from '@xyflow/react';
import { Palette } from '../components/Palette';
import { FlowCanvas } from '../components/FlowCanvas';
import { fetchFlow, saveFlow, type Catalog, type Flow, type ServiceStatusMap } from '../api';
import { flowToRf, rfToFlow, newNodeId, type FNode } from '../flow-utils';
import { NODE_META, accentOf } from '../data';
import type { Runner } from '../useRunner';

interface Props {
  catalog: Catalog;
  currentFlow: string;
  description: string;
  runner: Runner;
  registerActions: (a: { getFlow: () => Flow; save: () => void }) => void;
  onFlowLoaded?: (flowName: string | null) => void;
  onSaved: () => void;
  onEditFlow: () => void;
  models: { omlx: string[]; cache: string[] };
  apps: string[];
  onRefreshApps: () => void;
  onServiceStatus?: (status: ServiceStatusMap) => void;
}

export function BuilderView({
  catalog, currentFlow, description, runner, registerActions, onFlowLoaded, onSaved, onEditFlow, models, apps, onRefreshApps, onServiceStatus,
}: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [meta, setMeta] = useState<Flow>({ version: 1, nodes: [], edges: [], stopWhenSourcesDone: false, description: '' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState('');

  useEffect(() => {
    if (!currentFlow) {
      onFlowLoaded?.(null);
      return;
    }
    let alive = true;
    onFlowLoaded?.(null);
    fetchFlow(currentFlow).then((flow) => {
      if (!alive) return;
      const { nodes: ns, edges: es } = flowToRf(flow, catalog);
      setNodes(ns); setEdges(es); setMeta(flow); setSelectedId(null);
      onFlowLoaded?.(currentFlow);
    }).catch(() => { if (alive) onFlowLoaded?.(currentFlow); });
    return () => { alive = false; };
  }, [currentFlow, catalog, setNodes, setEdges, onFlowLoaded]);

  const buildFlow = useCallback(() => rfToFlow(nodes, edges, { ...meta, description: description || meta.description }), [nodes, edges, meta, description]);

  const onConnect = useCallback((c: Connection) => {
    setEdges((es) => addEdge({ ...c, id: `e-${c.source}-${c.sourceHandle}-${c.target}-${c.targetHandle}`, data: { capacity: 16, overflow: 'block' } }, es));
  }, [setEdges]);

  const onParamsChange = useCallback((id: string, params: Record<string, unknown>) => {
    setNodes((ns) => {
      const target = ns.find((n) => n.id === id);
      const enforceUniqueDefault =
        target &&
        (target.data.type === 'capture.ffmpeg' || target.data.type === 'sink.captions') &&
        params.isDefault === true;
      return ns.map((n) => {
        if (n.id !== id) {
          if (enforceUniqueDefault && n.data.type === target.data.type && n.data.params?.isDefault === true) {
            return { ...n, data: { ...n.data, params: { ...n.data.params, isDefault: false } } };
          }
          return n;
        }
        let outputs = n.data.outputs;
        if (n.data.type === 'decision.llm' && Array.isArray(params.options)) {
          outputs = (params.options as string[]).map((o) => ({ name: o, type: 'tokens_parcial' }));
        }
        return { ...n, data: { ...n.data, params, outputs } };
      });
    });
  }, [setNodes]);

  const onAddNode = useCallback((type: string, pos: { x: number; y: number }) => {
    const cn = catalog.nodes.find((n) => n.type === type);
    const m = NODE_META[type] ?? { title: type, subtitle: '' };
    const id = newNodeId(type);
    const outputs = type === 'decision.llm' ? [{ name: 'auto', type: 'tokens_parcial' }] : (cn?.outputs ?? []);
    const defaultParams: Record<string, unknown> =
      type === 'capture.ffmpeg'
        ? {
            backend: 'sck',
            input: '',
            chunkMs: 80,
            isDefault: !nodes.some((n) => n.data.type === 'capture.ffmpeg'),
            placeholder: 'Digite sua mensagem ou comando (Enter para enviar)...',
          }
        : type === 'sink.captions'
          ? {
              mode: 'callback',
              showParcials: true,
              outputMode: 'write',
              language: 'Portuguese',
              voice: 'female',
              isDefault: !nodes.some((n) => n.data.type === 'sink.captions'),
            }
        : type === 'decision.llm'
          ? { options: ['auto'] }
          : type === 'exec.command'
            ? { transport: 'local', mode: 'readonly', dryRun: true }
            : type === 'tool.mcp'
              ? { transport: 'stdio', dryRun: true, allowedTools: [] }
              : type === 'agent.tools'
                ? { approvalPolicy: 'always', maxSteps: 5, enableThinking: false }
                : type === 'tool.workflow'
                  ? { flowsDir: 'apps/tui/flows', agentsMdPath: 'AGENTS.md', dryRun: false, allowDelete: false }
                  : type === 'tool.web_search'
                    ? { timeoutMs: 8000, maxResults: 5 }
                    : type === 'tool.crawler'
                      ? { maxPages: 5, maxDepth: 1, sameOriginOnly: true }
                      : type === 'translate.llm'
                        ? { model: 'LiquidAI--LFM3-1.7B-MLX-4bit', targetLanguage: 'Portuguese', enableThinking: false }
                        : type === 'human.approve'
                          ? { mode: 'non_readonly' }
                          : {};
    const node: FNode = {
      id, type: 'falador', position: pos,
      data: {
        type, params: defaultParams, enabled: true,
        paramNames: cn?.paramNames ?? [], inputs: cn?.inputs ?? [], outputs,
        accent: accentOf(type), title: m.title, subtitle: m.subtitle,
      },
    };
    setNodes((ns) => [...ns, node]);
    setSelectedId(id);
  }, [catalog, nodes, setNodes]);

  const doSave = useCallback(async () => {
    try { await saveFlow(currentFlow, buildFlow()); onSaved(); }
    catch (e) { console.error(e); }
  }, [currentFlow, buildFlow, onSaved]);

  useEffect(() => {
    registerActions({ getFlow: buildFlow, save: () => void doSave() });
  }, [buildFlow, doSave, registerActions]);

  // feedback real de execução no builder (erros reais, gates, passos de agente, chat e collect)
  // — Logs/Auditoria ficam exclusivamente no Runner (LiveView), não no Builder.
  const errEv = [...runner.events].reverse().find((e) => {
    if (e.type === 'flow_invalid') return true;
    if (e.type !== 'node_error') return false;
    const code = String((e as { code?: string }).code ?? '');
    return code !== 'log_info' && code !== 'log_warn';
  }) as { message?: string; error?: string; nodeId?: string } | undefined;
  const errMsg = errEv
    ? `${errEv.nodeId ? `[${errEv.nodeId}] ` : ''}${errEv.message ?? errEv.error ?? 'Erro no teste'}`
    : (runner.lastRunError ?? '');
  // O runner é compartilhado com o Runner; só o teste iniciado AQUI (testMode) deve
  // mostrar legendas neste canvas. Sem isso, legendas de um run anterior do Runner
  // ficam coladas na barra inferior ao voltar para o Builder.
  const finalCaptions = runner.testMode ? runner.captions.filter((c) => c.final) : [];
  const lastCaption = runner.testMode ? runner.captions.at(-1) : undefined;
  const collectEntries = Object.entries(runner.collectResults ?? {});
  const displayDesc = description || meta.description;
  const chatNode = nodes.find((n) => n.data.type === 'input.chat' || n.data.type === 'capture.ffmpeg');
  const sendBuilderChat = async () => {
    const t = chatDraft.trim();
    if (!t || !runner.running) return;
    setChatDraft('');
    try { await runner.sendChat(t, chatNode?.id); } catch { /* erro já aparece no banner */ }
  };
  const showStatusPanel = Boolean(
    errMsg
    || (runner.running && chatNode)
    || runner.gates.length > 0
    || runner.agentSteps.length > 0
    || finalCaptions.length > 0
    || (lastCaption && !lastCaption.final)
    || collectEntries.length > 0,
  );

  return (
    <div className="builder-wrap">
      <div className="builder">
        <Palette onAdd={(t) => onAddNode(t, { x: 120 + Math.random() * 80, y: 120 + Math.random() * 80 })} />
        <div className="builder-stage">
          {/* Cabeçalho do fluxo na própria tela do canvas: nome + descrição completa */}
          <div className="flow-banner">
            <div className="flow-banner-main">
              <div className="flow-banner-top">
                <h2 className="flow-banner-name">{currentFlow || 'Sem workflow'}</h2>
                <Tag type="cool-gray" size="sm">{nodes.length} nós</Tag>
                <Tag type="cool-gray" size="sm">{edges.length} conexões</Tag>
              </div>
              <p className="flow-banner-desc">
                {displayDesc || 'Sem descrição — clique em "Editar detalhes" para descrever este workflow.'}
              </p>
            </div>
          </div>
          <FlowCanvas
            nodes={nodes} edges={edges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            selectedId={selectedId} onSelect={setSelectedId}
            onParamsChange={onParamsChange} onAddNode={onAddNode}
            metrics={runner.metrics} events={runner.events} running={runner.running}
            models={models} apps={apps} onRefreshApps={onRefreshApps}
          />
        </div>
      </div>
      {showStatusPanel && (
        <div className="builder-status">
          {errMsg && <div className="live2-error">⚠ {errMsg}</div>}
          {runner.running && chatNode && (
            <div className="builder-chat-row">
              <TextInput
                id="builder-chat-input"
                size="sm"
                labelText="Enviar prompt"
                hideLabel
                placeholder={String(chatNode.data.params.placeholder ?? 'Digite seu prompt e pressione Enter…')}
                value={chatDraft}
                onChange={(e) => setChatDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void sendBuilderChat(); } }}
              />
              <Button kind="primary" size="sm" renderIcon={Play} disabled={!chatDraft.trim()} onClick={() => void sendBuilderChat()}>
                Enviar
              </Button>
            </div>
          )}
          {runner.gates.map((g) => (
            <div key={g.nodeId} className="cmd-gate-card">
              <div className="cmd-gate-head">
                <span className="cmd-gate-title">Approval ({g.nodeId})</span>
                <div className="live2-actions">
                  <Button kind="primary" size="sm" renderIcon={Checkmark} onClick={() => runner.gate(g.nodeId, g.text)}>
                    Aprovar
                  </Button>
                  <Button kind="danger--tertiary" size="sm" renderIcon={Close} onClick={() => runner.gate(g.nodeId, null)}>
                    Rejeitar
                  </Button>
                </div>
              </div>
              <pre className="builder-output-line">{g.text}</pre>
            </div>
          ))}
          {runner.agentSteps.length > 0 && (
            <div className="agent-timeline-list">
              {runner.agentSteps.map((s, idx) => (
                <div key={`${s.nodeId}-${s.step}-${s.phase}-${idx}`} className="agent-step-row">
                  <span className="agent-step-num">Passo {s.step}</span>
                  <code className="agent-step-tool">{s.tool}</code>
                  <Tag type={s.phase === 'rejected' ? 'magenta' : s.ok === false ? 'red' : s.phase === 'calling' ? 'blue' : 'green'} size="sm">
                    {s.phase === 'calling' ? 'chamando' : s.phase === 'rejected' ? 'rejeitado' : s.ok === false ? 'erro' : 'ok'}
                  </Tag>
                </div>
              ))}
            </div>
          )}
          {(finalCaptions.length > 0 || (lastCaption && !lastCaption.final) || collectEntries.length > 0) && (
            <div className="builder-output">
              {finalCaptions.map((c, i) => (
                <div key={i} className="builder-output-line">{c.text}</div>
              ))}
              {lastCaption && !lastCaption.final && (
                <div className="builder-output-line builder-output-line--partial">{lastCaption.text}<span className="live-cursor" /></div>
              )}
              {collectEntries.map(([nodeId, items]) => (
                <div key={nodeId} className="builder-output-line">
                  <strong>[{nodeId}]</strong> {items.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' · ')}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
