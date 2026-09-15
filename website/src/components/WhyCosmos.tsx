import React from 'react';

const pillars = [
  {
    n: '01',
    title: 'Separation of concerns',
    body: 'Research is decoupled from tool execution. Agent scheduling is decoupled from model selection. Each system is developed, evaluated and upgraded on its own clock.'
  },
  {
    n: '02',
    title: 'Replaceable brains',
    body: 'Models are swappable compute, not architecture. Move from a frontier API to private weights without touching application logic.'
  },
  {
    n: '03',
    title: 'Auditability by design',
    body: 'Every assertion carries a provenance trace. Every external call leaves a signed audit log. Every autonomous update waits on an EvalOS pass.'
  }
];

export const WhyCosmos: React.FC = () => {
  return (
    <section id="platform" className="relative bg-paper-2 border-y border-rule py-24 sm:py-36 grain">
      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 relative">
        {/* Header */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-8 mb-20">
          <div className="lg:col-span-5">
            <div className="eyebrow mb-7">
              <span>01 — The structural thesis</span>
            </div>
            <h2 className="font-display text-[length:var(--text-d2)] font-semibold tracking-display leading-[1.02] text-ink reveal">
              One model is not an <span className="ed font-normal">intelligence system.</span>
            </h2>
          </div>
          <div className="lg:col-span-6 lg:col-start-7 lg:pt-3">
            <p className="text-[17px] leading-[1.6] text-ink-2 reveal">
              Real applications need far more than completions. They need agents, durable memory,
              external tool access, rigorous research, regression evaluation and multi-step workflows.
              Today every team hand-rolls those layers into a brittle, bespoke stack.
            </p>
            <p className="text-[17px] leading-[1.6] text-ink mt-4 font-medium reveal">
              Cosmos isolates each capability into a reusable, inspectable operating system with an
              explicit contract.
            </p>
          </div>
        </div>

        {/* Comparison */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 lg:gap-6 items-stretch">
          {/* Before */}
          <div className="card-flat p-7 sm:p-9 flex flex-col reveal">
            <div className="flex items-baseline justify-between pb-5 mb-7 border-b border-rule">
              <span className="label">Before Cosmos</span>
              <span className="label">Monolith</span>
            </div>

            <div className="font-mono text-[12.5px] leading-[2] text-ink-2 flex-1">
              <div className="text-ink font-medium mb-1">app/</div>
              {[
                ['custom agents', 'brittle retries, no DAG'],
                ['custom memory', 'unbounded context poisoning'],
                ['custom model routing', 'hardcoded fallbacks'],
                ['custom research', 'shallow naive RAG'],
                ['custom evaluation', 'vibe checks, no gates'],
                ['custom tools', 'raw un-sandboxed effects']
              ].map(([name, note], i, arr) => (
                <div key={name} className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-ink-3 select-none">{i === arr.length - 1 ? '└──' : '├──'}</span>
                  <span className="text-ink-2">{name}</span>
                  <span className="text-accent-ink text-[11.5px]">{note}</span>
                </div>
              ))}
            </div>

            <p className="text-[14px] text-ink-3 leading-relaxed mt-8 pt-6 border-t border-rule">
              Every new application rebuilds everything, with diverging failure modes. Hidden
              cross-talk between memory, prompting and tool execution produces errors nobody can see.
            </p>
          </div>

          {/* After */}
          <div className="card p-7 sm:p-9 flex flex-col reveal">
            <div className="flex items-baseline justify-between pb-5 mb-7 border-b border-rule">
              <span className="label label-accent">With Cosmos</span>
              <span className="label">Substrate</span>
            </div>

            <div className="flex-1 flex flex-col gap-2.5">
              <div className="flex items-center justify-between px-4 py-3 rounded-lg border border-rule bg-paper">
                <span className="text-[14px] font-medium text-ink">Your application</span>
                <span className="label text-[10px]">Clean consumer</span>
              </div>

              <div className="flex justify-center py-0.5" aria-hidden="true">
                <svg width="10" height="20" viewBox="0 0 10 20" fill="none">
                  <path d="M5 0v16m0 0 4-4m-4 4-4-4" stroke="#c9c2b2" strokeWidth="1.2" />
                </svg>
              </div>

              <div className="px-4 py-3.5 rounded-lg bg-ink text-center">
                <span className="text-[14px] font-medium text-onink block">Cosmos Core</span>
                <span className="text-[12.5px] text-onink-2">Intent resolution &amp; contract bus</span>
              </div>

              <div className="grid grid-cols-3 gap-2 pt-1.5">
                {[
                  ['ResearchOS', 'Investigate', true],
                  ['AgentOS', 'Orchestrate', true],
                  ['ToolOS', 'Act', true],
                  ['EvalOS', 'Measure', true],
                  ['MemoryOS', 'Remember', false],
                  ['ModelOS', 'Route', false]
                ].map(([name, role, built]) => (
                  <div key={name as string} className="px-2.5 py-3 rounded-lg border border-rule bg-paper text-center">
                    <div className={`text-[12.5px] font-medium ${built ? 'text-ink' : 'text-ink-3'}`}>{name}</div>
                    <div className="text-[11px] text-ink-3 mt-0.5">{role}</div>
                  </div>
                ))}
              </div>
            </div>

            <p className="text-[14px] text-ink-2 leading-relaxed mt-8 pt-6 border-t border-rule">
              Reusable systems with typed, auditable contracts. Isolation means memory corruption,
              tool side-effects and model drift never leak into a sibling system.
            </p>
          </div>
        </div>

        {/* Pillars */}
        <div className="mt-20 sm:mt-28 grid grid-cols-1 md:grid-cols-3 gap-y-10 gap-x-8 border-t border-rule-2 pt-12">
          {pillars.map((p) => (
            <div key={p.n} className="reveal">
              <div className="flex items-baseline gap-3 mb-3">
                <span className="label label-accent tabular-nums">{p.n}</span>
                <h3 className="font-display text-[19px] font-semibold tracking-display-sm text-ink">{p.title}</h3>
              </div>
              <p className="text-[15px] leading-[1.6] text-ink-3">{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
