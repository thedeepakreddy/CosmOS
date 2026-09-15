import React, { useState } from 'react';
import { CORE_SYSTEMS } from '../data/cosmosData';
import { CosmosSystem } from '../types';
import { ArrowUpRight, ChevronDown } from 'lucide-react';

interface CosmosStackProps {
  onSelectSystem?: (systemId: string) => void;
}

const ORDER = ['research-os', 'agent-os', 'tool-os', 'memory-os', 'model-os', 'eval-os'];

const toneOf = (s: CosmosSystem): 'live' | 'dev' | 'plan' =>
  s.status.includes('BUILT') ? 'live' : s.status.includes('IN_DEVELOPMENT') ? 'dev' : 'plan';

const shortState = (s: CosmosSystem) => {
  if (s.status === 'BUILT_CERTIFIED') return 'Built · certified';
  if (s.status === 'BUILT_ADVANCED') return 'Built · advanced';
  if (s.status === 'BUILT_CERTIFICATION_STAGE') return 'Certifying';
  if (s.status === 'PLANNED_IN_DEVELOPMENT') return 'In development';
  return 'Planned';
};

export const CosmosStack: React.FC<CosmosStackProps> = ({ onSelectSystem }) => {
  const systems = ORDER.map((id) => CORE_SYSTEMS.find((s) => s.id === id)).filter(
    (s): s is CosmosSystem => Boolean(s)
  );

  const [selectedSystem, setSelectedSystem] = useState<CosmosSystem | null>(systems[0]);
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});
  const [filterState, setFilterState] = useState<'all' | 'built' | 'planned'>('all');

  const builtCount = systems.filter((s) => s.status.includes('BUILT')).length;

  const filters: { key: typeof filterState; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: systems.length },
    { key: 'built', label: 'Built', count: builtCount },
    { key: 'planned', label: 'Planned', count: systems.length - builtCount }
  ];

  const filteredSystems = systems.filter((sys) => {
    if (filterState === 'built') return sys.status.includes('BUILT');
    if (filterState === 'planned') return !sys.status.includes('BUILT');
    return true;
  });

  return (
    <section id="systems" className="relative bg-paper py-24 sm:py-36 grain">
      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 relative">
        {/* Header */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-8 mb-14">
          <div className="lg:col-span-6">
            <div className="eyebrow mb-7"><span>02 — The stack</span></div>
            <h2 className="font-display text-[length:var(--text-d2)] font-semibold tracking-display leading-[1.02] text-ink reveal">
              Six systems, <span className="ed font-normal">one boundary each.</span>
            </h2>
          </div>
          <div className="lg:col-span-5 lg:col-start-8 lg:pt-4">
            <p className="text-[17px] leading-[1.6] text-ink-2 reveal">
              Each operating system owns exactly one cognitive duty behind a strict interface.
              Select any system to read its responsibilities and its typed contract.
            </p>
          </div>
        </div>

        {/* Filter — a typeset control, not a pill switcher */}
        <div className="flex items-center gap-7 border-b border-rule-2 pb-4 mb-2">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilterState(f.key)}
              aria-pressed={filterState === f.key}
              className={`relative text-[14px] pb-4 -mb-[17px] border-b-2 transition-colors cursor-pointer ${
                filterState === f.key
                  ? 'text-ink border-accent font-medium'
                  : 'text-ink-3 border-transparent hover:text-ink'
              }`}
            >
              {f.label}
              <span className="font-mono text-[11px] text-ink-3 ml-1.5 tabular-nums">{f.count}</span>
            </button>
          ))}
        </div>

        {/* System grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {filteredSystems.map((system, i) => {
            const isSelected = selectedSystem?.id === system.id;
            const isExpanded = Boolean(expandedCards[system.id]);

            return (
              <div
                key={system.id}
                id={`card-${system.id}`}
                onClick={() => {
                  setSelectedSystem(system);
                  onSelectSystem?.(system.id);
                }}
                className={`group relative flex flex-col cursor-pointer border-b border-rule px-1 py-8 transition-colors md:px-7 lg:px-8 ${
                  i % 3 !== 2 ? 'lg:border-r' : ''
                } ${i % 2 === 0 ? 'md:border-r lg:border-r' : ''} ${
                  isSelected ? 'bg-card' : 'hover:bg-card/60'
                }`}
              >
                {/* Accent spine marks the selected system */}
                <span
                  className={`absolute left-0 top-0 bottom-[-1px] w-[2px] transition-colors ${
                    isSelected ? 'bg-accent' : 'bg-transparent'
                  }`}
                  aria-hidden="true"
                />

                <div className="flex items-baseline justify-between mb-5">
                  <span className="label tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                  <span className={`status status-${toneOf(system)}`}>{shortState(system)}</span>
                </div>

                <div className="flex items-baseline gap-2.5 flex-wrap mb-3">
                  <h3 className="font-display text-[26px] font-semibold tracking-display-sm text-ink leading-none">
                    {system.name}
                  </h3>
                  <span className="label label-accent">{system.role}</span>
                </div>

                <p className="text-[14.5px] leading-[1.6] text-ink-3 flex-1">{system.summary}</p>

                {isExpanded && (
                  <div className="mt-5 pt-5 border-t border-rule">
                    <span className="label block mb-3">Core guarantees</span>
                    <ul className="space-y-2">
                      {system.purpose.slice(0, 3).map((item) => (
                        <li key={item} className="text-[13.5px] text-ink-2 leading-snug flex gap-2.5">
                          <span className="text-accent-ink shrink-0" aria-hidden="true">—</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="mt-6 pt-4 border-t border-rule flex items-center justify-between gap-3">
                  <span className="font-mono text-[12px] text-ink-3 truncate">
                    {system.capabilities[0]}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedCards((prev) => ({ ...prev, [system.id]: !prev[system.id] }));
                    }}
                    aria-expanded={isExpanded}
                    className="text-[13px] text-ink-3 hover:text-ink flex items-center gap-1 shrink-0 cursor-pointer transition-colors"
                  >
                    <span>{isExpanded ? 'Less' : 'Details'}</span>
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Contract inspector */}
        {selectedSystem && (
          <div id="system-spec-sheet" className="mt-16 card overflow-hidden">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5 px-7 sm:px-9 py-7 border-b border-rule">
              <div>
                <div className="flex flex-wrap items-center gap-3 mb-2">
                  <span className="label">System specification</span>
                  <span className={`status status-${toneOf(selectedSystem)}`}>{shortState(selectedSystem)}</span>
                </div>
                <h4 className="font-display text-[28px] font-semibold tracking-display-sm text-ink leading-none">
                  {selectedSystem.name}
                  <span className="text-ink-3 font-normal"> · {selectedSystem.role.toLowerCase()}</span>
                </h4>
              </div>

              <a
                href={`#${selectedSystem.id}`}
                className="btn btn-primary !min-h-0 !py-3 !px-5 !text-[14px] shrink-0 self-start lg:self-auto group"
              >
                <span>Open {selectedSystem.name}</span>
                <ArrowUpRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </a>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2">
              <div className="px-7 sm:px-9 py-8 lg:border-r border-rule">
                <span className="label block mb-4">Responsibilities &amp; guarantees</span>
                <ul className="space-y-3 mb-9">
                  {selectedSystem.purpose.map((item) => (
                    <li key={item} className="flex gap-3 text-[14.5px] text-ink-2 leading-[1.55]">
                      <span className="text-accent-ink shrink-0 mt-px" aria-hidden="true">—</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>

                <span className="label block mb-4">Capabilities</span>
                <div className="flex flex-wrap gap-2">
                  {selectedSystem.capabilities.map((cap) => (
                    <span
                      key={cap}
                      className="font-mono text-[12px] px-3 py-1.5 rounded-full border border-rule text-ink-2 bg-paper"
                    >
                      {cap}
                    </span>
                  ))}
                </div>
              </div>

              <div className="px-7 sm:px-9 py-8 bg-paper-2/50">
                <div className="flex items-baseline justify-between mb-4">
                  <span className="label">Interface contract</span>
                  <span className="label">TypeScript</span>
                </div>
                <pre className="p-5 rounded-xl bg-ink text-onink overflow-x-auto text-[12.5px] leading-[1.75] font-mono">
                  <code>{selectedSystem.contractInterface || `// contract for ${selectedSystem.name}`}</code>
                </pre>
                <p className="text-[13.5px] text-ink-3 leading-relaxed mt-4">
                  Subsystems communicate exclusively through authenticated, typed RPC contracts —
                  no shared mutable state, no implicit coupling.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
