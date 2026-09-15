import React, { useState } from 'react';
import { Play, Pause } from 'lucide-react';

const workers = [
  {
    id: 'research', name: 'Research agent', role: 'Evidence gatherer', status: 'Active',
    progress: 100, tasksCompleted: 42, concurrency: '4× parallel',
    currentTask: 'Ingesting European Battery Directive amendments'
  },
  {
    id: 'analyst', name: 'Analyst agent', role: 'Quantitative modelling', status: 'Active',
    progress: 78, tasksCompleted: 18, concurrency: '2× parallel',
    currentTask: 'Running CAPEX sensitivity across 12 gigafactories'
  },
  {
    id: 'critic', name: 'Critic agent', role: 'Adversarial red-team', status: 'Active',
    progress: 64, tasksCompleted: 9, concurrency: '1× serial',
    currentTask: 'Challenging the 2028 sodium-ion substitution timeline'
  },
  {
    id: 'reviewer', name: 'Reviewer agent', role: 'Synthesis auditor', status: 'Queued',
    progress: 0, tasksCompleted: 0, concurrency: 'Waiting on critic',
    currentTask: 'Awaiting upstream DAG verification signatures'
  }
];

const capabilities = [
  { name: 'Task DAGs', desc: 'Deterministic acyclic graphs of arbitrary depth and branching' },
  { name: 'Dependencies', desc: 'Strict topological ordering with type-checked output passing' },
  { name: 'Bounded concurrency', desc: 'Rate-limit and token-budget aware parallel execution' },
  { name: 'Retries & timeouts', desc: 'Exponential backoff with jitter and per-step deadlines' },
  { name: 'Pause / resume', desc: 'Zero-loss state serialisation for approval or cold restart' },
  { name: 'Process recovery', desc: 'Node restart without invalidating completed upstream state' },
  { name: 'Persistent execution', desc: 'Durable run state across hardware and network failure' }
];

export const AgentOSSection: React.FC = () => {
  const [activeWorker, setActiveWorker] = useState('critic');
  const [dagStatus, setDagStatus] = useState<'running' | 'paused'>('running');
  const selected = workers.find((w) => w.id === activeWorker) || workers[0];

  return (
    <section id="agent-os" className="relative bg-paper py-24 sm:py-36 grain">
      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 relative">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-8 mb-16">
          <div className="lg:col-span-6">
            <div className="eyebrow mb-7"><span>Deep dive — AgentOS</span></div>
            <h2 className="font-display text-[length:var(--text-d2)] font-semibold tracking-display leading-[1.02] text-ink reveal">
              Intelligence needs <span className="ed font-normal">coordination.</span>
            </h2>
          </div>
          <div className="lg:col-span-5 lg:col-start-8 lg:pt-4">
            <p className="text-[17px] leading-[1.6] text-ink-2 reveal">
              A single agent collapses the moment work needs real concurrency, adversarial critique
              and long-running execution.
            </p>
            <p className="text-[15px] leading-[1.6] text-ink-3 mt-4 reveal">
              AgentOS is the workforce layer: deterministic task DAGs with supervisor hierarchies,
              bounded concurrency and resilient checkpointing.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 mb-16">
          {/* Hierarchy */}
          <div className="lg:col-span-5 card p-6 sm:p-8 flex flex-col">
            <div className="flex items-center justify-between pb-5 mb-6 border-b border-rule">
              <span className="label">Supervisor hierarchy</span>
              <button
                onClick={() => setDagStatus(dagStatus === 'running' ? 'paused' : 'running')}
                className="flex items-center gap-2 text-[13px] text-ink-2 hover:text-ink cursor-pointer transition-colors"
                aria-label={dagStatus === 'running' ? 'Pause the run' : 'Resume the run'}
              >
                {dagStatus === 'running'
                  ? <Pause className="w-3.5 h-3.5" />
                  : <Play className="w-3.5 h-3.5" />}
                <span className="font-mono text-[11px] uppercase tracking-wider">{dagStatus}</span>
              </button>
            </div>

            <div className="px-4 py-3.5 rounded-lg bg-ink mb-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[14px] font-medium text-onink">Supervisor coordinator</span>
                <span className="font-mono text-[10px] uppercase tracking-wider text-onink-2">DAG root</span>
              </div>
              <p className="text-[12.5px] text-onink-2 mt-1">
                Deterministic schedule · 4 sub-agents · checkpointed
              </p>
            </div>

            <div className="flex flex-col gap-2 pl-4 border-l border-rule-2 flex-1">
              {workers.map((worker) => {
                const isSelected = activeWorker === worker.id;
                return (
                  <button
                    key={worker.id}
                    onClick={() => setActiveWorker(worker.id)}
                    aria-pressed={isSelected}
                    className={`text-left p-4 rounded-lg border transition-all cursor-pointer ${
                      isSelected ? 'bg-paper border-accent' : 'bg-paper/50 border-rule hover:border-rule-2'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[14px] font-medium text-ink">{worker.name}</span>
                      <span className="text-[12.5px] text-ink-3 shrink-0">{worker.role}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3 mt-2">
                      <span className="font-mono text-[11px] text-ink-3 tabular-nums">
                        {worker.tasksCompleted} tasks
                      </span>
                      <span className={`status ${worker.status === 'Active' ? 'status-live' : 'status-plan'}`}>
                        {worker.status}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            <p className="text-[13px] text-ink-3 mt-6 pt-5 border-t border-rule">
              Fault isolation through strict process containment.
            </p>
          </div>

          {/* Telemetry */}
          <div className="lg:col-span-7 card p-6 sm:p-8 flex flex-col">
            <div className="flex items-start justify-between gap-4 pb-5 mb-6 border-b border-rule">
              <div>
                <span className="label block mb-1">Worker telemetry</span>
                <h3 className="font-display text-[23px] font-semibold tracking-display-sm text-ink">
                  {selected.name}
                  <span className="text-ink-3 font-normal"> · {selected.role.toLowerCase()}</span>
                </h3>
              </div>
              <span className="font-mono text-[11px] uppercase tracking-wider text-ink-3 shrink-0 mt-1">
                {selected.concurrency}
              </span>
            </div>

            <div className="p-4 rounded-lg bg-ink mb-7">
              <span className="label !text-onink-2 block mb-1.5">Active assignment</span>
              <p className="font-mono text-[13px] text-onink leading-relaxed">{selected.currentTask}</p>
            </div>

            <div className="mb-8">
              <div className="flex justify-between items-baseline text-[13px] mb-2">
                <span className="text-ink-2">Task graph completion</span>
                <span className="font-mono text-ink tabular-nums">{selected.progress}%</span>
              </div>
              <div className="w-full h-[5px] rounded-full bg-paper-3 overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-[width] duration-500"
                  style={{ width: `${selected.progress}%` }}
                />
              </div>
            </div>

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-6 flex-1">
              {[
                ['State checkpointing', 'Durable write-ahead log'],
                ['Retry strategy', 'Max 3 · exponential jitter'],
                ['Timeout deadline', '45,000 ms per node'],
                ['Failure recovery', 'Isolated node rollback']
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="label block mb-1.5">{k}</dt>
                  <dd className="text-[14.5px] text-ink">{v}</dd>
                </div>
              ))}
            </dl>

            <p className="text-[13.5px] text-ink-3 leading-relaxed mt-7 pt-5 border-t border-rule">
              If one worker crashes, the workflow pauses cleanly — completed state is never lost.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-8 border-t border-rule-2 pt-10">
          {capabilities.map((cap, idx) => (
            <div key={cap.name} className="reveal">
              <span className="label label-accent tabular-nums block mb-2">
                {String(idx + 1).padStart(2, '0')}
              </span>
              <h3 className="font-display text-[16px] font-semibold tracking-display-sm text-ink mb-1.5">
                {cap.name}
              </h3>
              <p className="text-[14px] leading-[1.55] text-ink-3">{cap.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
