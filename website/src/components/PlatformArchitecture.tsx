import React, { useState } from 'react';
import { APPLICATION_PATTERNS } from '../data/cosmosData';

const deploymentTopologies = [
  {
    id: 'cloud', name: 'Cloud-hosted', tag: 'Managed SaaS',
    desc: 'Fully managed multi-tenant and dedicated VPC clusters on resilient global infrastructure.'
  },
  {
    id: 'private', name: 'Private enterprise', tag: 'Air-gapped / VPC',
    desc: 'Cosmos subsystems inside your AWS, GCP or Azure perimeter with zero external egress.'
  },
  {
    id: 'local', name: 'Local & edge', tag: 'On-prem',
    desc: 'Lightweight node runtimes on developer machines, private workstations or edge servers.'
  },
  {
    id: 'hybrid', name: 'Hybrid mesh', tag: 'Federated',
    desc: 'Sensitive data, private tools and memory stay on-premise; heavy reasoning offloads to cloud.'
  }
];

export const PlatformArchitecture: React.FC = () => {
  const [selectedAppId, setSelectedAppId] = useState(APPLICATION_PATTERNS[0].id);
  const activeApp = APPLICATION_PATTERNS.find((a) => a.id === selectedAppId) || APPLICATION_PATTERNS[0];

  return (
    <section id="platform-architecture" className="relative bg-paper py-24 sm:py-36 grain">
      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 relative">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-8 mb-14">
          <div className="lg:col-span-6">
            <div className="eyebrow mb-7"><span>Modular consumption</span></div>
            <h2 className="font-display text-[length:var(--text-d2)] font-semibold tracking-display leading-[1.02] text-ink reveal">
              Cosmos is a platform, <span className="ed font-normal">not one app.</span>
            </h2>
          </div>
          <div className="lg:col-span-5 lg:col-start-8 lg:pt-4">
            <p className="text-[17px] leading-[1.6] text-ink-2 reveal">
              Nothing obliges you to adopt every module. Consume only the operating systems your
              product actually needs, through the same contracts.
            </p>
          </div>
        </div>

        {/* Archetype mixer */}
        <div className="card overflow-hidden mb-20 reveal">
          <div className="px-7 sm:px-9 pt-7 pb-6 border-b border-rule">
            <span className="label">Application archetype — select to inspect its composition</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border-b border-rule">
            {APPLICATION_PATTERNS.map((app) => {
              const isSelected = selectedAppId === app.id;
              return (
                <button
                  key={app.id}
                  onClick={() => setSelectedAppId(app.id)}
                  aria-pressed={isSelected}
                  className={`relative text-left p-6 border-b sm:border-b-0 border-rule sm:border-r last:sm:border-r-0 transition-colors cursor-pointer ${
                    isSelected ? 'bg-paper-2/60' : 'hover:bg-paper-2/30'
                  }`}
                >
                  <span
                    className={`absolute left-0 top-0 right-0 h-[2px] transition-colors ${
                      isSelected ? 'bg-accent' : 'bg-transparent'
                    }`}
                    aria-hidden="true"
                  />
                  <span className="label label-accent block mb-2">{app.tag}</span>
                  <span className="font-display text-[17px] font-semibold tracking-display-sm text-ink block leading-snug mb-2">
                    {app.title}
                  </span>
                  <span className="font-mono text-[11.5px] text-ink-3 tabular-nums">
                    {app.activeSystems.length} subsystems
                  </span>
                </button>
              );
            })}
          </div>

          <div className="px-7 sm:px-9 py-8 bg-paper-2/40">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-10 gap-y-7">
              <div className="lg:col-span-5">
                <h3 className="font-display text-[21px] font-semibold tracking-display-sm text-ink mb-2">
                  {activeApp.title}
                </h3>
                <p className="text-[14.5px] leading-[1.6] text-ink-3">{activeApp.description}</p>
              </div>

              <div className="lg:col-span-7">
                <span className="label block mb-3">Active contract mesh</span>
                <div className="flex flex-wrap gap-2 mb-6">
                  {activeApp.activeSystems.map((sys) => (
                    <span
                      key={sys}
                      className="font-mono text-[12px] px-3 py-1.5 rounded-full bg-card border border-rule text-ink-2"
                    >
                      {sys}
                    </span>
                  ))}
                </div>
                <p className="text-[14px] leading-[1.6] text-ink-3 pt-4 border-t border-rule">
                  <span className="text-ink font-medium">Sample workload.</span> {activeApp.sampleUse}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Deployment */}
        <div id="deployment" className="pt-16 border-t border-rule-2">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-6 mb-12">
            <div className="lg:col-span-6">
              <div className="eyebrow mb-6"><span>Deployment topologies</span></div>
              <h3 className="font-display text-[clamp(1.6rem,3vw,2.5rem)] font-semibold tracking-display leading-[1.05] text-ink">
                Local, cloud, or <span className="ed font-normal">somewhere in between.</span>
              </h3>
            </div>
            <div className="lg:col-span-5 lg:col-start-8 lg:pt-3">
              <p className="text-[16px] leading-[1.6] text-ink-2">
                Built from first principles for varied topologies, from air-gapped enclaves to
                federated hybrid meshes.
              </p>
              <p className="text-[14px] leading-[1.6] text-ink-3 mt-4 pl-4 border-l-2 border-accent-line">
                Every deployment mode below is roadmap specification, not shipped product.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-10 border-t border-rule-2 pt-10">
            {deploymentTopologies.map((dep) => (
              <div key={dep.id} className="reveal">
                <div className="flex items-baseline justify-between gap-3 mb-2">
                  <h4 className="font-display text-[18px] font-semibold tracking-display-sm text-ink">
                    {dep.name}
                  </h4>
                  <span className="status status-plan shrink-0">Planned</span>
                </div>
                <span className="label label-accent block mb-2.5">{dep.tag}</span>
                <p className="text-[14px] leading-[1.55] text-ink-3">{dep.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
