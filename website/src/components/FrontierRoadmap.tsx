import React, { useState } from 'react';
import { ROADMAP_LAYERS, FRONTIER_SYSTEMS, GOVERNANCE_MODULES } from '../data/cosmosData';

export const FrontierRoadmap: React.FC = () => {
  const [selectedLayer, setSelectedLayer] = useState(1);
  const allSystems = [...FRONTIER_SYSTEMS, ...GOVERNANCE_MODULES];
  const getSystemDetail = (name: string) =>
    allSystems.find((s) => s.name.toLowerCase() === name.toLowerCase());
  const activeTier = ROADMAP_LAYERS.find((l) => l.layer === selectedLayer);

  return (
    <section id="roadmap" className="relative bg-paper-2 border-y border-rule py-24 sm:py-36 grain">
      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 relative">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-8 mb-14">
          <div className="lg:col-span-6">
            <div className="eyebrow mb-7"><span>Long-term architecture</span></div>
            <h2 className="font-display text-[length:var(--text-d2)] font-semibold tracking-display leading-[1.02] text-ink reveal">
              Toward a complete <span className="ed font-normal">intelligence architecture.</span>
            </h2>
          </div>
          <div className="lg:col-span-5 lg:col-start-8 lg:pt-4">
            <p className="text-[17px] leading-[1.6] text-ink-2 reveal">
              Cosmos is not a static bundle of tools. It is an evolving blueprint for autonomous
              systems, organised across four maturation tiers.
            </p>
          </div>
        </div>

        {/* Guardrail note */}
        <div className="card-flat p-6 sm:p-8 mb-16 reveal">
          <span className="label label-accent block mb-3">Architectural guardrail — EvolutionOS</span>
          <p className="text-[15.5px] leading-[1.6] text-ink-2 measure">
            EvolutionOS is never uncontrolled self-modification. Its role is strictly deterministic:{' '}
            <span className="font-mono text-[14px] text-ink bg-paper-3 px-2 py-0.5 rounded">
              propose → EvalOS tests → accept or reject
            </span>
            . No change reaches production without passing the regression suite.
          </p>
        </div>

        {/* Tiers */}
        <div className="mb-20">
          <div className="eyebrow mb-7"><span>Roadmap tiers</span></div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 border-t border-rule-2">
            {ROADMAP_LAYERS.map((tier) => {
              const isSelected = selectedLayer === tier.layer;
              return (
                <button
                  key={tier.layer}
                  onClick={() => setSelectedLayer(tier.layer)}
                  aria-pressed={isSelected}
                  className={`relative text-left p-6 lg:p-7 border-b border-rule lg:border-r last:lg:border-r-0 transition-colors cursor-pointer flex flex-col ${
                    isSelected ? 'bg-card' : 'hover:bg-card/60'
                  }`}
                >
                  <span
                    className={`absolute left-0 top-0 right-0 h-[2px] transition-colors ${
                      isSelected ? 'bg-accent' : 'bg-transparent'
                    }`}
                    aria-hidden="true"
                  />
                  <div className="flex items-baseline justify-between gap-3 mb-4">
                    <span className="label tabular-nums">Tier {String(tier.layer).padStart(2, '0')}</span>
                    <span className={`status ${tier.layer === 1 ? 'status-live' : tier.layer === 2 ? 'status-dev' : 'status-plan'}`}>
                      {tier.statusTag}
                    </span>
                  </div>

                  <h3 className="font-display text-[19px] font-semibold tracking-display-sm text-ink mb-2">
                    {tier.name}
                  </h3>
                  <p className="text-[14px] leading-[1.55] text-ink-3 flex-1">{tier.description}</p>

                  <div className="mt-6 pt-4 border-t border-rule flex flex-wrap gap-x-3 gap-y-1">
                    {tier.systems.map((sys) => (
                      <span key={sys} className="font-mono text-[11.5px] text-ink-3">{sys}</span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Tier modules */}
        <div className="mb-24">
          <div className="flex items-baseline justify-between gap-4 mb-8">
            <h3 className="font-display text-[clamp(1.4rem,2.4vw,1.9rem)] font-semibold tracking-display-sm text-ink">
              {activeTier?.name} subsystems
            </h3>
            <span className="label shrink-0 hidden sm:block">
              Tier {String(selectedLayer).padStart(2, '0')}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-10 border-t border-rule-2 pt-10">
            {activeTier?.systems.map((sysName) => {
              const detail = getSystemDetail(sysName);
              const isBuilt = selectedLayer === 1;
              return (
                <div key={sysName}>
                  <div className="flex items-baseline justify-between gap-3 mb-2">
                    <h4 className="font-display text-[19px] font-semibold tracking-display-sm text-ink">
                      {sysName}
                    </h4>
                    <span className={`status ${isBuilt ? 'status-live' : 'status-plan'} shrink-0`}>
                      {isBuilt ? 'Built' : 'Roadmap'}
                    </span>
                  </div>

                  <span className="label label-accent block mb-2.5">
                    {detail?.role || 'Cognitive layer'}
                  </span>

                  <p className="text-[14.5px] leading-[1.6] text-ink-3">
                    {detail?.summary ||
                      'Specialised subsystem handling a discrete slice of computational intelligence.'}
                  </p>

                  {detail?.capabilities && (
                    <div className="mt-4 pt-3.5 border-t border-rule flex flex-wrap gap-x-3 gap-y-1">
                      {detail.capabilities.map((c) => (
                        <span key={c} className="font-mono text-[11.5px] text-ink-3">{c}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Governance */}
        <div id="governance-modules" className="pt-16 border-t border-rule-2">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-6 mb-12">
            <div className="lg:col-span-6">
              <div className="eyebrow mb-6"><span>Infrastructure &amp; governance</span></div>
              <h3 className="font-display text-[clamp(1.6rem,3vw,2.5rem)] font-semibold tracking-display leading-[1.05] text-ink">
                The unglamorous half that <span className="ed font-normal">makes it shippable.</span>
              </h3>
            </div>
            <div className="lg:col-span-5 lg:col-start-8 lg:pt-3">
              <p className="text-[16px] leading-[1.6] text-ink-2">
                Autonomous systems need platform guarantees. These modules govern identity,
                compliance, sandboxing, observability and cost.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-8 gap-y-10 border-t border-rule-2 pt-10">
            {GOVERNANCE_MODULES.map((mod) => (
              <div key={mod.id}>
                <h4 className="font-display text-[17px] font-semibold tracking-display-sm text-ink mb-1.5">
                  {mod.name}
                </h4>
                <span className="label label-accent block mb-2.5">{mod.role}</span>
                <p className="text-[14px] leading-[1.55] text-ink-3">{mod.summary}</p>
                <p className="font-mono text-[11.5px] text-ink-3 mt-3.5 pt-3 border-t border-rule">
                  {mod.purpose[0]}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
