import React, { useState, useEffect } from 'react';
import { REQUEST_FLOW_STEPS } from '../data/cosmosData';
import { Play, Pause, RotateCcw, SkipForward } from 'lucide-react';

const tiers: { ids: string[]; cols: string }[] = [
  { ids: ['cosmos-core'], cols: 'grid-cols-1' },
  { ids: ['research-os', 'agent-os'], cols: 'grid-cols-1 sm:grid-cols-2' },
  { ids: ['tool-os', 'model-os', 'memory-os'], cols: 'grid-cols-1 sm:grid-cols-3' },
  { ids: ['eval-os'], cols: 'grid-cols-1' }
];

const nodeMeta: Record<string, { name: string; role: string; note: string }> = {
  'cosmos-core': { name: 'Cosmos Core', role: 'Coordinate', note: 'Routes the request, assigns policy envelope and budget.' },
  'research-os': { name: 'ResearchOS', role: 'Investigate', note: 'Assembles the claim DAG, hypotheses and contradiction matrix.' },
  'agent-os': { name: 'AgentOS', role: 'Orchestrate', note: 'Spins up market, competitor, regulation and critic specialists.' },
  'tool-os': { name: 'ToolOS', role: 'Act', note: 'MCP bridges and sandboxes.' },
  'model-os': { name: 'ModelOS', role: 'Route', note: 'Model selection per subtask.' },
  'memory-os': { name: 'MemoryOS', role: 'Remember', note: 'Prior lessons and context.' },
  'eval-os': { name: 'EvalOS', role: 'Measure', note: 'Checks citations and assertions, then gates release.' }
};

export const RequestFlow: React.FC = () => {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (!isPlaying) return;
    const timer = setInterval(() => {
      setCurrentStepIndex((prev) => {
        if (prev >= REQUEST_FLOW_STEPS.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 3500);
    return () => clearInterval(timer);
  }, [isPlaying]);

  const currentStep = REQUEST_FLOW_STEPS[currentStepIndex];
  const atEnd = currentStepIndex >= REQUEST_FLOW_STEPS.length - 1;

  return (
    <section id="request-flow" className="relative bg-paper py-24 sm:py-36 grain">
      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 relative">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-8 mb-14">
          <div className="lg:col-span-6">
            <div className="eyebrow mb-7"><span>Subsystem trace</span></div>
            <h2 className="font-display text-[length:var(--text-d2)] font-semibold tracking-display leading-[1.02] text-ink reveal">
              One request, <span className="ed font-normal">start to finish.</span>
            </h2>
          </div>
          <div className="lg:col-span-5 lg:col-start-8 lg:pt-4">
            <p className="text-[17px] leading-[1.6] text-ink-2 reveal">
              Watch a high-stakes research goal get decomposed, routed, executed across sandboxes and
              verified before it ever reaches the user.
            </p>
          </div>
        </div>

        <blockquote className="border-l-2 border-accent pl-6 mb-10 reveal">
          <span className="label block mb-2">User query</span>
          <p className="ed text-[clamp(1.25rem,2.4vw,1.75rem)] leading-[1.35] text-ink measure">
            Research whether my company should enter the European EV battery market.
          </p>
        </blockquote>

        {/* Transport */}
        <div className="card-flat px-5 sm:px-7 py-4 mb-3 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <button
              id="flow-play-toggle"
              onClick={() => setIsPlaying(!isPlaying)}
              className="btn btn-primary !min-h-0 !py-2.5 !px-4 !text-[13.5px]"
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              <span>{isPlaying ? 'Pause' : 'Play trace'}</span>
            </button>
            <button
              onClick={() => !atEnd && setCurrentStepIndex(currentStepIndex + 1)}
              disabled={atEnd}
              className="p-2.5 rounded-full border border-rule-2 text-ink-2 hover:text-ink hover:border-ink disabled:opacity-30 disabled:hover:border-rule-2 transition-colors cursor-pointer disabled:cursor-default"
              aria-label="Next step"
            >
              <SkipForward className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                setIsPlaying(false);
                setCurrentStepIndex(0);
              }}
              className="p-2.5 rounded-full border border-rule-2 text-ink-2 hover:text-ink hover:border-ink transition-colors cursor-pointer"
              aria-label="Reset to first step"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-4 font-mono text-[12px] text-ink-3">
            <span className="tabular-nums">
              Step {currentStepIndex + 1} / {REQUEST_FLOW_STEPS.length}
            </span>
            <span className="uppercase tracking-wider text-accent-ink">{currentStep.stage}</span>
          </div>
        </div>

        {/* Step ticks */}
        <div className="grid grid-cols-3 sm:grid-cols-9 gap-x-3 mb-10">
          {REQUEST_FLOW_STEPS.map((step, idx) => {
            const isCompleted = idx < currentStepIndex;
            const isCurrent = idx === currentStepIndex;
            return (
              <button
                key={step.id}
                onClick={() => {
                  setIsPlaying(false);
                  setCurrentStepIndex(idx);
                }}
                aria-current={isCurrent ? 'step' : undefined}
                className={`text-left pt-3 border-t-2 transition-colors cursor-pointer ${
                  isCurrent ? 'border-accent' : isCompleted ? 'border-ink-3' : 'border-rule'
                }`}
              >
                <span className={`font-mono text-[10.5px] tabular-nums block ${
                  isCurrent ? 'text-accent-ink' : 'text-ink-3'
                }`}>
                  {String(step.id).padStart(2, '0')}
                </span>
                <span className={`text-[12.5px] leading-tight block mt-0.5 ${
                  isCurrent ? 'text-ink font-medium' : isCompleted ? 'text-ink-2' : 'text-ink-3'
                }`}>
                  {step.action}
                </span>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Topology */}
          <div className="lg:col-span-7 card p-6 sm:p-8 flex flex-col">
            <div className="flex items-baseline justify-between gap-3 pb-5 mb-6 border-b border-rule">
              <span className="label">Coordination topology</span>
              <span className="font-mono text-[11px] text-ink-3">TRC-EV-904</span>
            </div>

            <div className="flex flex-col gap-3 flex-1">
              {tiers.map((tier, ti) => (
                <React.Fragment key={ti}>
                  {ti > 0 && (
                    <div className="flex justify-center" aria-hidden="true">
                      <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
                        <path d="M5 0v10m0 0 4-4m-4 4-4-4" stroke="#c9c2b2" strokeWidth="1.2" />
                      </svg>
                    </div>
                  )}
                  <div className={`grid ${tier.cols} gap-3`}>
                    {tier.ids.map((id) => {
                      const active = currentStep.activeNodes.includes(id);
                      const meta = nodeMeta[id];
                      return (
                        <div
                          key={id}
                          className={`px-4 py-3.5 rounded-lg border transition-all duration-300 ${
                            active
                              ? 'bg-ink border-ink'
                              : 'bg-paper border-rule opacity-55'
                          }`}
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className={`text-[14px] font-medium ${active ? 'text-onink' : 'text-ink'}`}>
                              {meta.name}
                            </span>
                            <span className={`font-mono text-[10px] uppercase tracking-wider shrink-0 ${
                              active ? 'text-onink-2' : 'text-ink-3'
                            }`}>
                              {meta.role}
                            </span>
                          </div>
                          <p className={`text-[12.5px] leading-snug mt-1 ${active ? 'text-onink-2' : 'text-ink-3'}`}>
                            {meta.note}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </React.Fragment>
              ))}
            </div>

            <div className="flex items-center justify-between gap-3 mt-6 pt-5 border-t border-rule font-mono text-[12px]">
              <span className="text-ink-3">Target: {currentStep.target}</span>
              <span className="text-accent-ink uppercase tracking-wider">{currentStep.action}</span>
            </div>
          </div>

          {/* Inspector */}
          <div className="lg:col-span-5 card p-6 sm:p-8 flex flex-col">
            <div className="flex items-baseline justify-between gap-3 pb-5 mb-6 border-b border-rule">
              <span className="label">Step inspector</span>
              <span className="font-mono text-[11px] text-ink-3 tabular-nums">
                {String(currentStep.id).padStart(2, '0')}
              </span>
            </div>

            <div className="flex flex-col gap-6 flex-1">
              <div>
                <span className="label block mb-1.5">Source</span>
                <span className="text-[16px] font-medium text-ink">{currentStep.source}</span>
              </div>

              <div>
                <span className="label block mb-1.5">Operation</span>
                <p className="text-[14.5px] leading-[1.6] text-ink-2">{currentStep.detail}</p>
              </div>

              <div>
                <span className="label block mb-2.5">Wire payload</span>
                <pre className="p-4 rounded-xl bg-ink text-onink overflow-x-auto text-[12px] leading-[1.7] font-mono whitespace-pre-wrap">
                  <code>{currentStep.payload}</code>
                </pre>
              </div>
            </div>

            <p className="text-[13px] text-ink-3 mt-6 pt-5 border-t border-rule">
              Deterministic RPC across a subsystem interop contract.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};
