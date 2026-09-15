import React, { useState } from 'react';
import { ArrowRight } from 'lucide-react';

const benchmarks = {
  hallucination: {
    tab: 'Factuality',
    name: 'Claim & citation factuality gate',
    desc: 'Ground-truth agreement and hallucinated citation rate across 5,000 synthetic test cases.',
    v1: { score: '88.4%', label: 'Baseline v1.4' },
    v2: { score: '97.2%', label: 'Candidate v2.0' },
    delta: '+8.8 pts',
    verdict: 'Gate passed'
  },
  reasoning: {
    tab: 'Reasoning',
    name: 'Counterfactual dependency resolution',
    desc: 'Agent resistance to poisoned assumptions and contradiction resolution across multi-document sets.',
    v1: { score: '76.1%', label: 'Baseline v1.4' },
    v2: { score: '91.5%', label: 'Candidate v2.0' },
    delta: '+15.4 pts',
    verdict: 'Gate passed'
  },
  latency: {
    tab: 'Latency',
    name: 'P99 execution latency overhead',
    desc: 'End-to-end DAG execution duration under 32 concurrent agent workers.',
    v1: { score: '1,420ms', label: 'Baseline v1.4' },
    v2: { score: '840ms', label: 'Candidate v2.0' },
    delta: '−40.8%',
    verdict: 'Gate passed'
  }
} as const;

type BenchKey = keyof typeof benchmarks;

const pillars = [
  { label: 'Quality', desc: 'Factual correctness and rubric scores' },
  { label: 'Latency', desc: 'Token throughput and DAG runtime' },
  { label: 'Reliability', desc: 'Failure rates and retry stability' },
  { label: 'Regressions', desc: 'Automated test suite diffs' },
  { label: 'Benchmarks', desc: 'Domain-specific test vectors' },
  { label: 'Gates', desc: 'Automated deployment block or pass' }
];

export const EvalOSSection: React.FC = () => {
  const [activeBenchmark, setActiveBenchmark] = useState<BenchKey>('hallucination');
  const activeData = benchmarks[activeBenchmark];

  return (
    <section id="eval-os" className="relative bg-paper-2 border-y border-rule py-24 sm:py-36 grain">
      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 relative">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-8 mb-16">
          <div className="lg:col-span-6">
            <div className="eyebrow mb-7"><span>Deep dive — EvalOS</span></div>
            <h2 className="font-display text-[length:var(--text-d2)] font-semibold tracking-display leading-[1.02] text-ink reveal">
              Improvement means nothing <span className="ed font-normal">if you cannot measure it.</span>
            </h2>
          </div>
          <div className="lg:col-span-5 lg:col-start-8 lg:pt-4">
            <p className="text-[17px] leading-[1.6] text-ink-2 reveal">
              Prompt tweaks and model upgrades introduce silent regressions constantly. A change that
              fixes one edge case quietly breaks twenty others.
            </p>
            <p className="text-[15px] leading-[1.6] text-ink mt-4 font-medium reveal">
              EvalOS answers one question, rigorously: did the new version actually improve?
            </p>
          </div>
        </div>

        {/* Gate diagram */}
        <div className="card overflow-hidden reveal">
          <div className="grid grid-cols-1 lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-rule">
            <div className="p-7 sm:p-9">
              <span className="label block mb-4">Baseline</span>
              <div className="font-display text-[26px] font-semibold tracking-display-sm text-ink mb-5">
                System v1.4
              </div>
              <dl className="space-y-2.5 font-mono text-[13px]">
                {[['Quality', '82.1'], ['Latency P99', '1,420ms'], ['Regressions', 'Reference']].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 text-ink-3">
                    <dt>{k}</dt>
                    <dd className="text-ink-2 tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="p-7 sm:p-9 bg-ink text-onink">
              <span className="label !text-onink-2 block mb-4">The gate</span>
              <div className="font-display text-[26px] font-semibold tracking-display-sm text-onink mb-3">
                EvalOS
              </div>
              <p className="text-[14px] leading-[1.55] text-onink-2 mb-6">
                Every candidate is diffed against the baseline across the full benchmark suite before
                it can ship.
              </p>
              <span className="font-mono text-[11px] uppercase tracking-wider text-onink border border-onink/25 rounded-full px-3 py-1.5 inline-block">
                Zero unaudited deployments
              </span>
            </div>

            <div className="p-7 sm:p-9">
              <span className="label label-accent block mb-4">Candidate</span>
              <div className="font-display text-[26px] font-semibold tracking-display-sm text-ink mb-5">
                System v2.0
              </div>
              <dl className="space-y-2.5 font-mono text-[13px]">
                {[['Quality', '94.6', '+12.5'], ['Latency P99', '840ms', '−40%'], ['Regressions', '0', 'none']].map(
                  ([k, v, d]) => (
                    <div key={k} className="flex justify-between gap-3 text-ink-3">
                      <dt>{k}</dt>
                      <dd className="tabular-nums">
                        <span className="text-ink-2">{v}</span>
                        <span className="text-accent-ink ml-2">{d}</span>
                      </dd>
                    </div>
                  )
                )}
              </dl>
            </div>
          </div>

          {/* Benchmark inspector */}
          <div className="border-t border-rule p-7 sm:p-9 bg-paper-2/40">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-7">
              <span className="label">Benchmark suite</span>
              <div className="flex gap-6">
                {(Object.keys(benchmarks) as BenchKey[]).map((key) => (
                  <button
                    key={key}
                    onClick={() => setActiveBenchmark(key)}
                    aria-pressed={activeBenchmark === key}
                    className={`text-[14px] pb-1.5 border-b-2 transition-colors cursor-pointer ${
                      activeBenchmark === key
                        ? 'text-ink border-accent font-medium'
                        : 'text-ink-3 border-transparent hover:text-ink'
                    }`}
                  >
                    {benchmarks[key].tab}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-end">
              <div className="lg:col-span-6">
                <h3 className="font-display text-[20px] font-semibold tracking-display-sm text-ink mb-2">
                  {activeData.name}
                </h3>
                <p className="text-[14.5px] leading-[1.6] text-ink-3">{activeData.desc}</p>
              </div>

              <div className="lg:col-span-6 flex items-end gap-6 sm:gap-10 flex-wrap">
                <div>
                  <span className="label block mb-1.5">{activeData.v1.label}</span>
                  <span className="font-display text-[30px] font-semibold tracking-display-sm text-ink-3 tabular-nums leading-none">
                    {activeData.v1.score}
                  </span>
                </div>

                <ArrowRight className="w-5 h-5 text-ink-3 mb-2 shrink-0" aria-hidden="true" />

                <div>
                  <span className="label label-accent block mb-1.5">{activeData.v2.label}</span>
                  <span className="font-display text-[30px] font-semibold tracking-display-sm text-ink tabular-nums leading-none">
                    {activeData.v2.score}
                  </span>
                  <span className="font-mono text-[13px] text-accent-ink ml-2.5">{activeData.delta}</span>
                </div>

                <span className="status status-live ml-auto mb-2">{activeData.verdict}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Pillars */}
        <div className="mt-16 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-8 gap-y-8 border-t border-rule-2 pt-10">
          {pillars.map((item) => (
            <div key={item.label} className="reveal">
              <h4 className="font-display text-[16px] font-semibold tracking-display-sm text-ink mb-1">
                {item.label}
              </h4>
              <p className="text-[13.5px] leading-[1.5] text-ink-3">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
