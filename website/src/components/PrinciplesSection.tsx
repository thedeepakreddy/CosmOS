import React from 'react';
import { PRINCIPLES } from '../data/cosmosData';

export const PrinciplesSection: React.FC = () => {
  return (
    <section id="principles" className="relative bg-paper py-24 sm:py-36 grain">
      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 relative">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-8 mb-16">
          <div className="lg:col-span-6">
            <div className="eyebrow mb-7"><span>Foundational tenets</span></div>
            <h2 className="font-display text-[length:var(--text-d2)] font-semibold tracking-display leading-[1.02] text-ink reveal">
              Ten things we <span className="ed font-normal">won&rsquo;t trade away.</span>
            </h2>
          </div>
          <div className="lg:col-span-5 lg:col-start-8 lg:pt-4">
            <p className="text-[17px] leading-[1.6] text-ink-2 reveal">
              The constraints behind every architectural decision in Cosmos. They are deliberately
              inconvenient — that is what makes them worth writing down.
            </p>
          </div>
        </div>

        <ol className="border-t border-rule-2">
          {PRINCIPLES.map((principle) => (
            <li
              key={principle.number}
              className="grid grid-cols-1 lg:grid-cols-12 gap-x-8 gap-y-2 py-7 sm:py-8 border-b border-rule group reveal"
            >
              <div className="lg:col-span-1">
                <span className="font-mono text-[13px] font-medium text-ink-3 tabular-nums group-hover:text-accent-ink transition-colors">
                  {principle.number}
                </span>
              </div>
              <div className="lg:col-span-5">
                <h3 className="font-display text-[20px] sm:text-[23px] font-semibold tracking-display-sm text-ink leading-snug">
                  {principle.title}
                </h3>
              </div>
              <div className="lg:col-span-6">
                <p className="text-[15px] leading-[1.65] text-ink-3">{principle.explanation}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
};
