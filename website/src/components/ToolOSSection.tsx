import React, { useState } from 'react';

const toolCategories = [
  {
    id: 'mcp',
    name: 'Model Context Protocol',
    description: 'Standardised universal protocol bridging external servers and local tools.',
    protocols: ['mcp://eu_tariffs', 'mcp://github_repos', 'mcp://slack_workspace'],
    status: 'Verified bridge'
  },
  {
    id: 'apis',
    name: 'External HTTP APIs',
    description: 'Zero-trust proxied egress with per-tenant secret vault injection.',
    protocols: ['GET /v2/market-rates', 'POST /orders/hedge', 'GET /registry/cbam'],
    status: 'Policy controlled'
  },
  {
    id: 'databases',
    name: 'Databases & query engines',
    description: 'Read-only and read-write SQL with automated schema boundary guards.',
    protocols: ['duckdb://analytics.db', 'postgres://enterprise-vault', 'clickhouse://telemetry'],
    status: 'Isolated'
  },
  {
    id: 'sandboxes',
    name: 'Execution sandboxes',
    description: 'Deterministic micro-VM environments for Python, Node and bash.',
    protocols: ['firecracker://py-sandbox-01', 'gvisor://wasm-node-9'],
    status: 'Secure enclave'
  }
];

const highlights = [
  {
    title: 'Permission-aware',
    desc: 'Agents never hold ambient authority. Every invocation checks explicit RBAC permissions and session scope first.'
  },
  {
    title: 'Policy-controlled',
    desc: 'Hard limits on call rate, egress domains, compute timeouts and payload size protect the perimeter.'
  },
  {
    title: 'Cryptographically audited',
    desc: 'Every parameter, header, return code and side-effect lands in an append-only signed ledger.'
  },
  {
    title: 'Model-neutral',
    desc: 'Tools are declared in canonical JSON schema and translated per provider — no vendor lock-in.'
  }
];

export const ToolOSSection: React.FC = () => {
  const [selectedToolCategory, setSelectedToolCategory] = useState('mcp');
  const activeCategory = toolCategories.find((c) => c.id === selectedToolCategory) || toolCategories[0];

  return (
    <section id="tool-os" className="relative bg-paper-2 border-y border-rule py-24 sm:py-36 grain">
      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 relative">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-8 mb-16">
          <div className="lg:col-span-6">
            <div className="eyebrow mb-7"><span>Deep dive — ToolOS</span></div>
            <h2 className="font-display text-[length:var(--text-d2)] font-semibold tracking-display leading-[1.02] text-ink reveal">
              Intelligence becomes useful <span className="ed font-normal">when it can act.</span>
            </h2>
          </div>
          <div className="lg:col-span-5 lg:col-start-8 lg:pt-4">
            <p className="text-[17px] leading-[1.6] text-ink-2 reveal">
              Uncontrolled tool access is how you get prompt injection, catastrophic side-effects and
              security leaks nobody notices for a month.
            </p>
            <p className="text-[15px] leading-[1.6] text-ink-3 mt-4 reveal">
              ToolOS is a hardened broker between autonomous agents and the outside world.
            </p>
          </div>
        </div>

        <div className="card overflow-hidden mb-16 reveal">
          <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-rule">
            {/* Flow */}
            <div className="p-7 sm:p-9">
              <span className="label block mb-6">Invocation path</span>

              <div className="px-4 py-3.5 rounded-lg border border-rule bg-paper flex items-center justify-between gap-3">
                <span className="text-[14px] font-medium text-ink">Autonomous agent</span>
                <span className="font-mono text-[11px] text-ink-3">no raw credentials</span>
              </div>

              <div className="flex justify-center py-2.5" aria-hidden="true">
                <svg width="10" height="22" viewBox="0 0 10 22" fill="none">
                  <path d="M5 0v18m0 0 4-4m-4 4-4-4" stroke="#c9c2b2" strokeWidth="1.2" />
                </svg>
              </div>

              <div className="px-5 py-5 rounded-lg bg-ink">
                <div className="flex items-center justify-between gap-3 mb-4">
                  <span className="text-[15px] font-medium text-onink">ToolOS broker</span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-onink-2">
                    Zero-trust gateway
                  </span>
                </div>
                <ol className="space-y-2">
                  {[
                    'Verify caller scope and role policy',
                    'Inject ephemeral secrets from the vault',
                    'Execute inside an isolated sandbox or MCP bridge',
                    'Sign the cryptographic audit log'
                  ].map((step, i) => (
                    <li key={step} className="flex gap-3 text-[13px] text-onink-2 leading-snug">
                      <span className="font-mono text-onink tabular-nums shrink-0">{i + 1}</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="flex justify-center py-2.5" aria-hidden="true">
                <svg width="10" height="22" viewBox="0 0 10 22" fill="none">
                  <path d="M5 0v18m0 0 4-4m-4 4-4-4" stroke="#c9c2b2" strokeWidth="1.2" />
                </svg>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {toolCategories.map((cat) => {
                  const isSelected = selectedToolCategory === cat.id;
                  return (
                    <button
                      key={cat.id}
                      onClick={() => setSelectedToolCategory(cat.id)}
                      aria-pressed={isSelected}
                      className={`p-3.5 rounded-lg text-left border transition-all cursor-pointer ${
                        isSelected ? 'bg-paper border-accent' : 'bg-paper/50 border-rule hover:border-rule-2'
                      }`}
                    >
                      <span className="text-[13.5px] font-medium text-ink block leading-snug">{cat.name}</span>
                      <span className="label text-[10px] block mt-1.5">{cat.status}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Envelope */}
            <div className="p-7 sm:p-9 bg-paper-2/40">
              <div className="flex items-baseline justify-between gap-3 pb-5 mb-6 border-b border-rule">
                <span className="label">Security envelope</span>
                <span className="font-mono text-[11px] text-ink-3">STRICT_ENTERPRISE</span>
              </div>

              <h3 className="font-display text-[21px] font-semibold tracking-display-sm text-ink mb-2">
                {activeCategory.name}
              </h3>
              <p className="text-[14.5px] leading-[1.6] text-ink-3 mb-7">{activeCategory.description}</p>

              <span className="label block mb-3">Active connectors</span>
              <div className="flex flex-col gap-2 mb-7">
                {activeCategory.protocols.map((proto) => (
                  <div
                    key={proto}
                    className="px-3.5 py-2.5 rounded-lg bg-card border border-rule flex items-center justify-between gap-3"
                  >
                    <code className="font-mono text-[12.5px] text-ink-2 truncate">{proto}</code>
                    <span className="status status-live shrink-0">Ready</span>
                  </div>
                ))}
              </div>

              <p className="text-[13.5px] leading-[1.6] text-ink-3 pt-5 border-t border-rule">
                <span className="text-ink font-medium">Audit guarantee.</span> No direct socket is ever
                exposed to third-party model weights, and every side-effect is deterministically
                reproducible from the ledger.
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-8 border-t border-rule-2 pt-10">
          {highlights.map((h, idx) => (
            <div key={h.title} className="reveal">
              <span className="label label-accent tabular-nums block mb-2">
                {String(idx + 1).padStart(2, '0')}
              </span>
              <h3 className="font-display text-[16px] font-semibold tracking-display-sm text-ink mb-1.5">
                {h.title}
              </h3>
              <p className="text-[14px] leading-[1.55] text-ink-3">{h.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
