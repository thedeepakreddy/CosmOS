import React, { useState } from 'react';
import { RESEARCH_WORKFLOW_STEPS, SAMPLE_CLAIM_GRAPH } from '../data/cosmosData';
import { ClaimNode } from '../types';

const preservedAttributes = [
  { label: 'Sources', desc: 'Exact primary URL, PDF or API origin' },
  { label: 'Claims', desc: 'Atomic, verifiable propositions' },
  { label: 'Evidence', desc: 'Direct excerpt with byte offsets' },
  { label: 'Provenance', desc: 'Cryptographic chain of custody' },
  { label: 'Contradictions', desc: 'Adversarial counter-evidence pairing' },
  { label: 'Confidence', desc: 'Bayesian calibrated probability' },
  { label: 'Experiments', desc: 'Re-executable empirical checks' },
  { label: 'Limitations', desc: 'Documented knowledge boundaries' },
  { label: 'History', desc: 'Ancestral revision tree' }
];

export const ResearchOSSpotlight: React.FC = () => {
  const [selectedClaim, setSelectedClaim] = useState<ClaimNode>(SAMPLE_CLAIM_GRAPH[0]);
  const [selectedWorkflowStep, setSelectedWorkflowStep] = useState<number>(7);
  const activeStep = RESEARCH_WORKFLOW_STEPS[selectedWorkflowStep];

  return (
    <section id="research-os" className="relative bg-paper-2 border-y border-rule py-24 sm:py-36 grain">
      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 relative">
        {/* Header */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-8 mb-16">
          <div className="lg:col-span-6">
            <div className="eyebrow mb-7"><span>Deep dive — ResearchOS</span></div>
            <h2 className="font-display text-[length:var(--text-d2)] font-semibold tracking-display leading-[1.02] text-ink reveal">
              Research that can explain <span className="ed font-normal">why it believes something.</span>
            </h2>
          </div>
          <div className="lg:col-span-5 lg:col-start-8 lg:pt-4">
            <p className="text-[17px] leading-[1.6] text-ink-2 reveal">
              Most AI research tools query a search API and hallucinate a smooth summary. ResearchOS
              treats research as an audit-grade investigation.
            </p>
            <p className="text-[15px] leading-[1.6] text-ink-3 mt-4 reveal">
              Every statement lives in an immutable claim–evidence graph with explicit contradiction
              detection, source provenance and calibrated confidence bounds.
            </p>
          </div>
        </div>

        {/* Pipeline */}
        <div className="card p-7 sm:p-9 mb-6 reveal">
          <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-3 pb-6 mb-7 border-b border-rule">
            <div>
              <h3 className="font-display text-[21px] font-semibold tracking-display-sm text-ink">
                The 15-stage research pipeline
              </h3>
              <p className="text-[14px] text-ink-3 mt-1">Select any stage to read its operational contract.</p>
            </div>
            <span className="label shrink-0">15 stages</span>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-5 gap-x-5 gap-y-1">
            {RESEARCH_WORKFLOW_STEPS.map((step, idx) => {
              const isSelected = selectedWorkflowStep === idx;
              return (
                <button
                  key={step.step}
                  onClick={() => setSelectedWorkflowStep(idx)}
                  aria-pressed={isSelected}
                  className={`text-left py-3 border-t-2 transition-colors cursor-pointer group ${
                    isSelected ? 'border-accent' : 'border-rule hover:border-rule-2'
                  }`}
                >
                  <span className={`font-mono text-[11px] tabular-nums block mb-0.5 transition-colors ${
                    isSelected ? 'text-accent-ink' : 'text-ink-3'
                  }`}>
                    {step.step}
                  </span>
                  <span className={`text-[13.5px] leading-tight block transition-colors ${
                    isSelected ? 'text-ink font-medium' : 'text-ink-3 group-hover:text-ink-2'
                  }`}>
                    {step.name}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-7 pt-6 border-t border-rule">
            <span className="label label-accent block mb-2">
              Stage {activeStep.step} · {activeStep.name}
            </span>
            <p className="text-[15px] leading-[1.6] text-ink-2 measure">{activeStep.desc}</p>
          </div>
        </div>

        {/* Claim graph */}
        <div className="mb-20">
          <div className="flex items-baseline justify-between gap-4 mb-7 mt-16">
            <h3 className="font-display text-[clamp(1.5rem,2.6vw,2.1rem)] font-semibold tracking-display-sm text-ink">
              Claim &amp; contradiction graph
            </h3>
            <span className="label shrink-0 hidden sm:block">Interactive</span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Claims */}
            <div className="lg:col-span-5">
              <span className="label block mb-4">Synthesised claims</span>
              <div className="flex flex-col gap-2.5">
                {SAMPLE_CLAIM_GRAPH.map((claim, idx) => {
                  const isSelected = selectedClaim.id === claim.id;
                  const hasContradiction = claim.evidence.some((e) => e.contradicts);

                  return (
                    <button
                      key={claim.id}
                      onClick={() => setSelectedClaim(claim)}
                      aria-pressed={isSelected}
                      className={`text-left p-5 rounded-xl border transition-all cursor-pointer ${
                        isSelected
                          ? 'bg-card border-accent shadow-[0_10px_28px_-16px_rgba(214,65,15,0.5)]'
                          : 'bg-card/60 border-rule hover:border-rule-2'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <span className="label tabular-nums">Claim {String(idx + 1).padStart(2, '0')}</span>
                        {hasContradiction && (
                          <span className="font-mono text-[10px] uppercase tracking-wider text-accent-ink">
                            Contradiction found
                          </span>
                        )}
                      </div>

                      <p className="text-[15px] leading-[1.5] text-ink font-medium">{claim.text}</p>

                      <div className="mt-4 pt-3 border-t border-rule flex items-center gap-3">
                        <div className="h-[3px] flex-1 rounded-full bg-paper-3 overflow-hidden" aria-hidden="true">
                          <div className="h-full bg-accent rounded-full" style={{ width: `${claim.confidence * 100}%` }} />
                        </div>
                        <span className="font-mono text-[11px] text-ink-3 tabular-nums shrink-0">
                          {Math.round(claim.confidence * 100)}% confidence
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Evidence inspector */}
            <div className="lg:col-span-7 card p-6 sm:p-8 flex flex-col">
              <div className="flex items-start justify-between gap-4 pb-5 mb-6 border-b border-rule">
                <div>
                  <span className="label block mb-1">Provenance inspector</span>
                  <h4 className="font-display text-[19px] font-semibold tracking-display-sm text-ink">
                    Evidence for the selected claim
                  </h4>
                </div>
                <div className="text-right shrink-0">
                  <span className="label block">Confidence</span>
                  <span className="font-mono text-[19px] text-ink tabular-nums">
                    {(selectedClaim.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              </div>

              <blockquote className="pl-5 border-l-2 border-accent mb-7">
                <p className="ed text-[19px] leading-[1.4] text-ink">{selectedClaim.text}</p>
              </blockquote>

              <span className="label block mb-4">
                Linked evidence — {selectedClaim.evidence.length} items
              </span>

              <div className="flex flex-col gap-3 flex-1">
                {selectedClaim.evidence.map((ev) => (
                  <div
                    key={ev.id}
                    className={`p-4 rounded-xl border ${
                      ev.contradicts ? 'border-accent-line bg-accent-soft' : 'border-rule bg-paper'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <span className="text-[14px] font-medium text-ink">{ev.title}</span>
                      <span className={`font-mono text-[10px] uppercase tracking-wider shrink-0 ${
                        ev.contradicts ? 'text-accent-ink' : 'text-ink-3'
                      }`}>
                        {ev.contradicts ? 'Contradicts' : 'Supports'}
                      </span>
                    </div>

                    <p className="text-[13.5px] leading-[1.6] text-ink-2 italic">&ldquo;{ev.quote}&rdquo;</p>

                    <div className="flex items-center justify-between gap-3 text-[11.5px] font-mono text-ink-3 pt-3 mt-3 border-t border-rule">
                      <span className="truncate">{ev.source}</span>
                      <span className="shrink-0">{ev.date}</span>
                    </div>
                  </div>
                ))}
              </div>

              <p className="text-[13.5px] text-ink-3 leading-relaxed mt-6 pt-5 border-t border-rule">
                ResearchOS preserves opposing evidence rather than resolving it away — that is what
                makes the resulting report defensible.
              </p>
            </div>
          </div>
        </div>

        {/* Preserved attributes */}
        <div>
          <div className="eyebrow mb-8"><span>What ResearchOS preserves</span></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-7 border-t border-rule-2 pt-10">
            {preservedAttributes.map((attr) => (
              <div key={attr.label} className="reveal">
                <h4 className="font-display text-[16px] font-semibold tracking-display-sm text-ink mb-1">
                  {attr.label}
                </h4>
                <p className="text-[14px] leading-[1.55] text-ink-3">{attr.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
