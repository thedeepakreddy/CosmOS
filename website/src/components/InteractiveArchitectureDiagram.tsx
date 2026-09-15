import React, { useState, useEffect, useRef } from 'react';
import { Play, RotateCcw, ArrowUpRight } from 'lucide-react';

interface DiagramNode {
  id: string;
  name: string;
  role: string;
  status: string;
  statusLabel: string;
  isBuilt: boolean;
  summary: string;
  coreInput: string;
  coreOutput: string;
}

interface InteractiveArchitectureDiagramProps {
  onSelectSystem?: (systemId: string) => void;
}

const SATELLITES = ['research-os', 'agent-os', 'tool-os', 'memory-os', 'model-os', 'eval-os'];

const PULSE_SEQUENCE = [
  'cosmos-core', 'research-os', 'memory-os', 'agent-os',
  'tool-os', 'model-os', 'eval-os', 'cosmos-core'
];

export const InteractiveArchitectureDiagram: React.FC<InteractiveArchitectureDiagramProps> = ({
  onSelectSystem
}) => {
  const [activeNodeId, setActiveNodeId] = useState<string>('cosmos-core');
  const [filterMode, setFilterMode] = useState<'all' | 'built' | 'planned'>('all');
  const [isSimulatingPulse, setIsSimulatingPulse] = useState(false);
  const [pulseStep, setPulseStep] = useState<number>(-1);
  const timers = useRef<number[]>([]);

  // Never let a queued pulse tick fire after unmount
  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  const nodes: Record<string, DiagramNode> = {
    'cosmos-core': {
      id: 'cosmos-core',
      name: 'Cosmos Core',
      role: 'COORDINATE',
      status: 'PLANNED',
      statusLabel: 'PLANNED COORDINATION BUS',
      isBuilt: false,
      summary: 'Central coordination layer that resolves user intent, validates cross-system policies, routes subtasks to specialized OSs, and synthesizes final answers.',
      coreInput: 'Unstructured multi-modal user goals, tenant policies, and security tokens',
      coreOutput: 'Coordinated execution plan, deterministic routing envelopes, and verified syntheses',
    },
    'research-os': {
      id: 'research-os',
      name: 'ResearchOS',
      role: 'INVESTIGATE',
      status: 'BUILT',
      statusLabel: 'BUILT / ADVANCED',
      isBuilt: true,
      summary: 'Deep multi-angle research engine that collects evidence, constructs claim graphs, detects contradictions, and validates facts.',
      coreInput: 'Decomposed research queries, source credibility limits, and investigative hypotheses',
      coreOutput: 'Audit-grade claim graph, provenance records, and synthesized evidence summaries',
    },
    'agent-os': {
      id: 'agent-os',
      name: 'AgentOS',
      role: 'ORCHESTRATE',
      status: 'BUILT',
      statusLabel: 'BUILT / CERTIFIED',
      isBuilt: true,
      summary: 'Workforce orchestration engine that executes dynamic DAG task graphs, coordinates supervisors and workers, and manages resumable checkpoints.',
      coreInput: 'Directed Acyclic Graphs (DAGs), concurrency boundaries, and supervisor policies',
      coreOutput: 'Task execution handles, serialized checkpoint states, and worker completion traces',
    },
    'tool-os': {
      id: 'tool-os',
      name: 'ToolOS',
      role: 'ACT',
      status: 'BUILT',
      statusLabel: 'BUILT / CERTIFIED',
      isBuilt: true,
      summary: 'Secure execution runtime and Model Context Protocol (MCP) broker providing isolated sandboxes and cryptographic audit trails for external tools.',
      coreInput: 'Tool invocation requests, parameter schemas, and least-privilege security scopes',
      coreOutput: 'Sanitized execution artifacts, API payloads, and immutable audit logs',
    },
    'memory-os': {
      id: 'memory-os',
      name: 'MemoryOS',
      role: 'REMEMBER',
      status: 'PLANNED',
      statusLabel: 'PLANNED / IN DEV',
      isBuilt: false,
      summary: 'Persistent episodic, semantic, and failure memory layer that indexes historical lessons, prevents repeated mistakes, and enforces tenant isolation.',
      coreInput: 'Execution traces, lesson embeddings, and contextual recall queries',
      coreOutput: 'Ranked recall candidates, provenance-tagged memory nodes, and eviction receipts',
    },
    'model-os': {
      id: 'model-os',
      name: 'ModelOS',
      role: 'ROUTE',
      status: 'PLANNED',
      statusLabel: 'PLANNED',
      isBuilt: false,
      summary: 'Dynamic model routing gateway and fallback mesh that matches subtasks to optimal frontier, specialized, or local model weights.',
      coreInput: 'Canonical prompts, SLA latency constraints, and token budget ceilings',
      coreOutput: 'Dispatched provider completions, fallback telemetries, and cost accounting matrices',
    },
    'eval-os': {
      id: 'eval-os',
      name: 'EvalOS',
      role: 'MEASURE',
      status: 'BUILT',
      statusLabel: 'BUILT / FINAL STAGE',
      isBuilt: true,
      summary: 'Continuous quality gate and regression detection suite that benchmarks candidate outputs against gold baselines before promotion.',
      coreInput: 'Candidate system artifacts, baseline outputs, and strict threshold rules',
      coreOutput: 'Pass/fail gate verdicts, regression delta reports, and benchmark scorecards',
    }
  };

  const activeNode = nodes[activeNodeId] || nodes['cosmos-core'];

  const startPulseSimulation = () => {
    if (isSimulatingPulse) return;
    setIsSimulatingPulse(true);
    setPulseStep(0);
    setActiveNodeId('cosmos-core');

    PULSE_SEQUENCE.forEach((nodeId, idx) => {
      const t = window.setTimeout(() => {
        setPulseStep(idx);
        setActiveNodeId(nodeId);
        if (idx === PULSE_SEQUENCE.length - 1) {
          const done = window.setTimeout(() => {
            setIsSimulatingPulse(false);
            setPulseStep(-1);
          }, 800);
          timers.current.push(done);
        }
      }, (idx + 1) * 650);
      timers.current.push(t);
    });
  };

  const stopPulse = () => {
    clearTimers();
    setIsSimulatingPulse(false);
    setPulseStep(-1);
  };

  const handleNodeClick = (nodeId: string) => {
    setActiveNodeId(nodeId);
    if (isSimulatingPulse) stopPulse();
  };

  const isDimmed = (node: DiagramNode) => {
    if (filterMode === 'all') return false;
    if (filterMode === 'built') return !(node.isBuilt || node.id === 'cosmos-core');
    return node.isBuilt;
  };

  const filters = [
    { key: 'all' as const, label: 'All' },
    { key: 'built' as const, label: 'Built' },
    { key: 'planned' as const, label: 'Planned' }
  ];

  return (
    <div id="interactive-architecture-diagram" className="w-full">
      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 mb-8 border-b border-rule-2">
        <div className="flex items-center gap-7">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilterMode(f.key)}
              aria-pressed={filterMode === f.key}
              className={`text-[14px] pb-4 -mb-[17px] border-b-2 transition-colors cursor-pointer ${
                filterMode === f.key
                  ? 'text-ink border-accent font-medium'
                  : 'text-ink-3 border-transparent hover:text-ink'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <button
          onClick={isSimulatingPulse ? stopPulse : startPulseSimulation}
          className="btn btn-ghost !min-h-0 !py-2.5 !px-4 !text-[13.5px]"
        >
          {isSimulatingPulse ? <RotateCcw className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          <span>{isSimulatingPulse ? 'Stop trace' : 'Trace a request'}</span>
        </button>
      </div>

      {/* Schematic */}
      <div className="relative card-lift px-5 sm:px-10 py-10 sm:py-14 overflow-hidden">
        <div className="absolute inset-0 grid-paper opacity-60 pointer-events-none" />

        <div className="relative">
          {/* Core */}
          <div className="max-w-[560px] mx-auto">
            <button
              onClick={() => handleNodeClick('cosmos-core')}
              className={`w-full text-left px-6 sm:px-8 py-6 rounded-2xl transition-all duration-300 cursor-pointer ${
                activeNodeId === 'cosmos-core'
                  ? 'bg-ink shadow-[0_18px_44px_-16px_rgba(20,19,15,0.6)]'
                  : 'bg-card border border-rule-2 hover:border-ink'
              } ${isDimmed(nodes['cosmos-core']) ? 'opacity-35' : ''}`}
            >
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <span className={`label ${activeNodeId === 'cosmos-core' ? '!text-onink-2' : ''}`}>
                  Coordination bus
                </span>
                <span className={`status status-plan ${activeNodeId === 'cosmos-core' ? '!text-onink-2' : ''}`}>
                  Planned
                </span>
              </div>
              <h4 className={`font-display text-[26px] font-semibold tracking-display-sm leading-none mb-2 ${
                activeNodeId === 'cosmos-core' ? '!text-onink' : 'text-ink'
              }`}>
                Cosmos Core
              </h4>
              <p className={`text-[14px] leading-[1.55] ${
                activeNodeId === 'cosmos-core' ? 'text-onink-2' : 'text-ink-3'
              }`}>
                Resolves intent, validates policy, routes subtasks, synthesises the answer.
              </p>
            </button>
          </div>

          {/* Fan */}
          <div className="hidden md:block relative h-16 max-w-[1000px] mx-auto" aria-hidden="true">
            <svg className="w-full h-full" viewBox="0 0 1000 64" fill="none" preserveAspectRatio="none">
              <path d="M500 0 v20" stroke="#c9c2b2" strokeWidth="1" />
              <path d="M84 64 V40 H916 V64" stroke="#c9c2b2" strokeWidth="1" />
              <path d="M500 20 H84 M500 20 H916" stroke="#c9c2b2" strokeWidth="1" />
              {[84, 250, 416, 583, 750, 916].map((x) => (
                <path key={x} d={`M${x} 40 v24`} stroke="#c9c2b2" strokeWidth="1" />
              ))}
              {isSimulatingPulse && (
                <circle r="3.5" fill="#d6410f">
                  <animateMotion path="M500 0 v20 H84 v44" dur="2.2s" repeatCount="indefinite" />
                </circle>
              )}
            </svg>
          </div>

          <div className="md:hidden flex justify-center py-5" aria-hidden="true">
            <svg width="10" height="28" viewBox="0 0 10 28" fill="none">
              <path d="M5 0v24m0 0 4-4m-4 4-4-4" stroke="#c9c2b2" strokeWidth="1.2" />
            </svg>
          </div>

          {/* Satellites */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-w-[1000px] mx-auto">
            {SATELLITES.map((id) => {
              const node = nodes[id];
              const isActive = activeNodeId === id;
              const dimmed = isDimmed(node);
              const pulsing = isSimulatingPulse && PULSE_SEQUENCE[pulseStep] === id;

              return (
                <button
                  key={id}
                  onClick={() => {
                    handleNodeClick(id);
                    onSelectSystem?.(id);
                  }}
                  className={`text-left p-5 rounded-xl border transition-all duration-300 cursor-pointer ${
                    isActive || pulsing
                      ? 'bg-card border-accent shadow-[0_12px_30px_-14px_rgba(214,65,15,0.45)]'
                      : 'bg-card border-rule hover:border-rule-2'
                  } ${dimmed ? 'opacity-35' : ''}`}
                >
                  <div className="flex items-baseline justify-between gap-3 mb-2.5">
                    <span className="font-display text-[19px] font-semibold tracking-display-sm text-ink leading-none">
                      {node.name}
                    </span>
                    <span className={`status ${node.isBuilt ? 'status-live' : 'status-plan'} shrink-0`}>
                      {node.isBuilt ? 'Built' : 'Planned'}
                    </span>
                  </div>
                  <span className="label label-accent block mb-2">{node.role}</span>
                  <p className="text-[13.5px] leading-[1.55] text-ink-3 line-clamp-3">{node.summary}</p>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Inspector */}
      <div className="mt-5 card overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-6 sm:px-8 py-6 border-b border-rule">
          <div>
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <span className="label">Node contract</span>
              <span className={`status ${activeNode.isBuilt ? 'status-live' : 'status-plan'}`}>
                {activeNode.statusLabel}
              </span>
            </div>
            <h4 className="font-display text-[26px] font-semibold tracking-display-sm text-ink leading-none">
              {activeNode.name}
              <span className="text-ink-3 font-normal"> · {activeNode.role.toLowerCase()}</span>
            </h4>
          </div>

          {activeNode.id !== 'cosmos-core' && (
            <a
              href={`#${activeNode.id}`}
              className="btn btn-primary !min-h-0 !py-2.5 !px-4 !text-[13.5px] shrink-0 self-start sm:self-auto group"
            >
              <span>Open section</span>
              <ArrowUpRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </a>
          )}
        </div>

        <div className="px-6 sm:px-8 py-7">
          <p className="text-[15.5px] leading-[1.6] text-ink-2 measure mb-8">{activeNode.summary}</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-7 border-t border-rule pt-7">
            <div>
              <span className="label block mb-2">Accepts</span>
              <p className="text-[14.5px] leading-[1.55] text-ink-2">{activeNode.coreInput}</p>
            </div>
            <div>
              <span className="label label-accent block mb-2">Returns</span>
              <p className="text-[14.5px] leading-[1.55] text-ink-2">{activeNode.coreOutput}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
