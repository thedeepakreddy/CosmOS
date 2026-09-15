import React from 'react';
import { InteractiveArchitectureDiagram } from './InteractiveArchitectureDiagram';

interface CosmosCoreSectionProps {
  onSelectSystem?: (systemId: string) => void;
}

const coreCapabilities = [
  { title: 'Intent understanding', desc: 'Deconstruct unstructured objectives into formal capability requests.' },
  { title: 'Capability discovery', desc: 'Query which operating systems are available, active and certified.' },
  { title: 'OS routing', desc: 'Direct each subtask to the system engineered for that responsibility.' },
  { title: 'Cross-system coordination', desc: 'Enforce state sync, message envelopes and transaction boundaries.' },
  { title: 'Policy enforcement', desc: 'Validate tenant boundaries, budget limits, regulatory and security scope.' },
  { title: 'Context assembly', desc: 'Aggregate MemoryOS, ToolOS output and live research into clean payloads.' },
  { title: 'Result synthesis', desc: 'Unify reports, datasets, code and audits into one coherent deliverable.' }
];

export const CosmosCoreSection: React.FC<CosmosCoreSectionProps> = ({ onSelectSystem }) => {
  return (
    <section id="architecture" className="relative bg-paper py-24 sm:py-36 grain">
      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 relative">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-8 mb-16">
          <div className="lg:col-span-6">
            <div className="eyebrow mb-7"><span>Coordination layer</span></div>
            <h2 className="font-display text-[length:var(--text-d2)] font-semibold tracking-display leading-[1.02] text-ink reveal">
              One coordination layer. <span className="ed font-normal">Many kinds of mind.</span>
            </h2>
          </div>
          <div className="lg:col-span-5 lg:col-start-8 lg:pt-4">
            <p className="text-[17px] leading-[1.6] text-ink-2 reveal">
              Specialised systems are useless if they cannot talk to each other reliably. Cosmos Core
              routes intent, enforces policy and orchestrates the subsystems as one intelligence.
            </p>
            <p className="text-[14px] leading-[1.6] text-ink-3 mt-4 pl-4 border-l-2 border-accent-line reveal">
              Cosmos Core is planned architecture. Today the subsystems run on direct peer contracts —
              we would rather say so than draw it as shipped.
            </p>
          </div>
        </div>

        <div className="mb-20 reveal">
          <InteractiveArchitectureDiagram onSelectSystem={onSelectSystem} />
        </div>

        <div>
          <div className="eyebrow mb-8"><span>What Cosmos Core handles</span></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-9 border-t border-rule-2 pt-10">
            {coreCapabilities.map((cap, idx) => (
              <div key={cap.title} className="reveal">
                <span className="label label-accent tabular-nums block mb-2.5">
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <h3 className="font-display text-[17px] font-semibold tracking-display-sm text-ink mb-2">
                  {cap.title}
                </h3>
                <p className="text-[14px] leading-[1.6] text-ink-3">{cap.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
