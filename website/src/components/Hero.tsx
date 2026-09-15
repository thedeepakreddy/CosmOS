import React, { useState } from 'react';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { CORE_SYSTEMS } from '../data/cosmosData';

interface HeroProps {
  onOpenArchitecture: () => void;
  onExploreCosmos: () => void;
  onSelectSystem: (systemId: string) => void;
}

type Tone = 'live' | 'dev' | 'plan';

const nodePositions: {
  id: string; x: number; y: number; label: string; role: string; state: string; tone: Tone;
}[] = [
  { id: 'research-os', x: -232, y: -128, label: 'ResearchOS', role: 'Investigate', state: 'Built', tone: 'live' },
  { id: 'agent-os',    x:  232, y: -128, label: 'AgentOS',    role: 'Orchestrate', state: 'Built', tone: 'live' },
  { id: 'tool-os',     x:  272, y:   52, label: 'ToolOS',     role: 'Act',         state: 'Built', tone: 'live' },
  { id: 'eval-os',     x:  138, y:  192, label: 'EvalOS',     role: 'Measure',     state: 'Certifying', tone: 'dev' },
  { id: 'model-os',    x: -138, y:  192, label: 'ModelOS',    role: 'Route',       state: 'Planned', tone: 'plan' },
  { id: 'memory-os',   x: -272, y:   52, label: 'MemoryOS',   role: 'Remember',    state: 'In dev', tone: 'dev' }
];

export const Hero: React.FC<HeroProps> = ({ onOpenArchitecture, onExploreCosmos, onSelectSystem }) => {
  const [activeNode, setActiveNode] = useState<string>('cosmos-core');
  const selectedSys = CORE_SYSTEMS.find((s) => s.id === activeNode) || CORE_SYSTEMS[0];

  return (
    <section id="hero-section" className="relative pt-[132px] sm:pt-[152px] pb-20 sm:pb-28 grain overflow-hidden">
      <div className="absolute inset-0 grid-paper opacity-[0.55] pointer-events-none"
        style={{ maskImage: 'radial-gradient(ellipse 80% 55% at 50% 12%, #000 20%, transparent 78%)' }} />

      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 relative">
        {/* ---- Headline block: asymmetric, left-weighted ---- */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-12 items-end">
          <div className="lg:col-span-7">
            <div className="eyebrow mb-7 max-w-[380px]">
              <span>Modular intelligence substrate</span>
            </div>

            <h1 className="font-display text-[length:var(--text-d1)] font-semibold tracking-display leading-display text-ink">
              Intelligence,
              <br />
              <span className="ed font-normal">orchestrated.</span>
            </h1>

            <p className="mt-8 text-[17px] sm:text-[19px] leading-[1.55] text-ink-2 measure">
              Six specialised operating systems — research, agents, tools, memory, models and
              evaluation — coordinated through explicit, inspectable contracts. Not a wrapper
              around a model. An intelligence layer you can reason about.
            </p>

            <div className="mt-10 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <button id="hero-explore-btn" onClick={onExploreCosmos} className="btn btn-primary group">
                <span>Explore the stack</span>
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
              </button>
              <button id="hero-view-architecture-btn" onClick={onOpenArchitecture} className="btn btn-ghost">
                View architecture
              </button>
            </div>
          </div>

          {/* ---- System index: a typeset table, not six more cards ---- */}
          <div className="lg:col-span-5 lg:pb-2">
            <div className="flex items-baseline justify-between mb-1 pb-3 border-b border-rule-2">
              <span className="label">System index</span>
              <span className="label tabular-nums">06</span>
            </div>
            <ul>
              {nodePositions.map((n, i) => (
                <li key={n.id}>
                  <button
                    onClick={() => {
                      setActiveNode(n.id);
                      onSelectSystem(n.id);
                    }}
                    className="w-full text-left py-3.5 border-b border-rule flex items-baseline gap-4 group cursor-pointer"
                  >
                    <span className="label text-[10px] tabular-nums w-5 shrink-0 group-hover:text-accent-ink transition-colors">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="font-display text-[17px] font-medium text-ink tracking-display-sm shrink-0 group-hover:text-accent-ink transition-colors">
                      {n.label}
                    </span>
                    <span className="text-[14px] text-ink-3 truncate">{n.role}</span>
                    <span className={`status status-${n.tone} ml-auto shrink-0`}>{n.state}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* ---- Topology: the product visual ---- */}
        <div className="mt-24 sm:mt-32">
          <div className="eyebrow mb-8">
            <span>Subsystem topology — select a node to inspect its contract</span>
          </div>

          <div className="relative card-lift px-6 py-10 sm:px-10 sm:py-14 overflow-hidden">
            <div className="absolute inset-0 grid-paper opacity-60 pointer-events-none" />

            {/* Desktop orbit */}
            <div className="relative w-full h-[470px] hidden md:flex items-center justify-center select-none">
              <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="-360 -240 720 480" aria-hidden="true">
                <circle cx="0" cy="20" r="168" fill="none" stroke="#14130f" strokeOpacity="0.09" strokeDasharray="2 5" />
                <circle cx="0" cy="20" r="286" fill="none" stroke="#14130f" strokeOpacity="0.07" />

                {nodePositions.map((pos) => {
                  const lit = activeNode === pos.id || activeNode === 'cosmos-core';
                  return (
                    <g key={pos.id}>
                      <line
                        x1="0" y1="20" x2={pos.x} y2={pos.y}
                        stroke={lit ? '#d6410f' : '#14130f'}
                        strokeOpacity={lit ? 0.45 : 0.14}
                        strokeWidth="1"
                        strokeDasharray={pos.tone === 'plan' ? '4 5' : undefined}
                      />
                      {pos.tone !== 'plan' && (
                        <circle r="2.5" fill={lit ? '#d6410f' : '#635e55'} opacity={lit ? 0.9 : 0.4}>
                          <animateMotion
                            path={`M0,20 L${pos.x},${pos.y}`}
                            dur={pos.tone === 'live' ? '3.6s' : '5.2s'}
                            repeatCount="indefinite"
                          />
                        </circle>
                      )}
                    </g>
                  );
                })}
              </svg>

              {/* Core */}
              <button
                id="node-cosmos-core"
                onClick={() => setActiveNode('cosmos-core')}
                className={`absolute z-30 -translate-x-1/2 -translate-y-1/2 top-[calc(50%+20px)] left-1/2 px-7 py-5 rounded-2xl text-center cursor-pointer transition-all duration-200 ${
                  activeNode === 'cosmos-core'
                    ? 'bg-ink text-onink shadow-[0_16px_40px_-14px_rgba(20,19,15,0.55)]'
                    : 'bg-card border border-rule-2 hover:border-ink shadow-[0_8px_24px_-14px_rgba(20,19,15,0.4)]'
                }`}
              >
                <span className={`block font-display text-[16px] font-semibold tracking-display-sm ${
                  activeNode === 'cosmos-core' ? 'text-onink' : 'text-ink'
                }`}>
                  Cosmos Core
                </span>
                <span className={`block mt-0.5 text-[13px] ${
                  activeNode === 'cosmos-core' ? 'text-onink-2' : 'text-ink-3'
                }`}>
                  Coordinate
                </span>
              </button>

              {/* Satellites */}
              {nodePositions.map((node) => {
                const isSelected = activeNode === node.id;
                return (
                  <button
                    key={node.id}
                    id={`hero-node-${node.id}`}
                    onClick={() => {
                      setActiveNode(node.id);
                      onSelectSystem(node.id);
                    }}
                    style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
                    className={`absolute z-20 px-4 py-3 rounded-xl text-left cursor-pointer transition-all duration-200 min-w-[152px] ${
                      isSelected
                        ? 'bg-card border border-accent shadow-[0_12px_32px_-12px_rgba(214,65,15,0.45)]'
                        : 'bg-card border border-rule hover:border-rule-2 shadow-[0_6px_18px_-12px_rgba(20,19,15,0.35)]'
                    }`}
                  >
                    <span className="block font-display text-[15px] font-medium text-ink tracking-display-sm">
                      {node.label}
                    </span>
                    <span className="block text-[13px] text-ink-3 mt-0.5">{node.role}</span>
                    <span className={`status status-${node.tone} mt-2`}>{node.state}</span>
                  </button>
                );
              })}
            </div>

            {/* Mobile list */}
            <div className="md:hidden relative">
              <button
                onClick={() => setActiveNode('cosmos-core')}
                className={`w-full p-5 rounded-xl text-left cursor-pointer transition-colors ${
                  activeNode === 'cosmos-core' ? 'bg-ink' : 'bg-paper-2 border border-rule'
                }`}
              >
                <span className={`block font-display text-[17px] font-semibold tracking-display-sm ${
                  activeNode === 'cosmos-core' ? 'text-onink' : 'text-ink'
                }`}>
                  Cosmos Core
                </span>
                <span className={`block text-[13px] mt-0.5 ${
                  activeNode === 'cosmos-core' ? 'text-onink-2' : 'text-ink-3'
                }`}>
                  Coordinate — the contract bus every system speaks through
                </span>
              </button>

              <div className="grid grid-cols-2 gap-2.5 mt-2.5">
                {nodePositions.map((node) => (
                  <button
                    key={node.id}
                    onClick={() => {
                      setActiveNode(node.id);
                      onSelectSystem(node.id);
                    }}
                    className={`p-4 rounded-xl text-left cursor-pointer transition-colors ${
                      activeNode === node.id ? 'bg-card border border-accent' : 'bg-card border border-rule'
                    }`}
                  >
                    <span className="block font-display text-[15px] font-medium text-ink tracking-display-sm">
                      {node.label}
                    </span>
                    <span className="block text-[13px] text-ink-3 mt-0.5">{node.role}</span>
                    <span className={`status status-${node.tone} mt-2`}>{node.state}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Inspector strip */}
            <div className="relative mt-8 pt-6 border-t border-rule flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
              <div className="min-w-0">
                <div className="flex items-baseline gap-2.5 flex-wrap">
                  <span className="font-display text-[18px] font-semibold text-ink tracking-display-sm">
                    {selectedSys.name}
                  </span>
                  <span className="label">{selectedSys.role}</span>
                </div>
                <p className="text-[14px] text-ink-3 mt-1.5 measure line-clamp-2">{selectedSys.summary}</p>
              </div>
              <a
                href={`#${selectedSys.id}`}
                className="text-[14px] font-medium text-accent-ink hover:text-ink transition-colors inline-flex items-center gap-1.5 shrink-0 group"
              >
                <span>Deep dive</span>
                <ArrowUpRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
