import React from 'react';
import { ArrowRight } from 'lucide-react';

interface VisionSectionProps {
  onOpenArchitecture: () => void;
  onExploreCosmos: () => void;
}

export const VisionSection: React.FC<VisionSectionProps> = ({ onOpenArchitecture, onExploreCosmos }) => {
  return (
    <section id="vision" className="relative bg-ink text-onink py-28 sm:py-40 overflow-hidden">
      <div className="absolute inset-0 grid-ink opacity-70 pointer-events-none"
        style={{ maskImage: 'radial-gradient(ellipse 70% 60% at 50% 50%, #000 10%, transparent 75%)' }} />

      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 relative">
        <div className="max-w-[920px]">
          <div className="eyebrow mb-9 !text-onink-2">
            <span>The substrate vision</span>
          </div>

          <h2 className="font-display text-[length:var(--text-d1)] font-semibold tracking-display leading-display !text-onink reveal">
            We are not building
            <br />
            <span className="ed font-normal">another chatbot.</span>
          </h2>

          <div className="mt-10 max-w-[620px] space-y-4 reveal">
            <p className="text-[19px] sm:text-[21px] leading-[1.5] text-onink">
              We are building an intelligence substrate.
            </p>
            <p className="text-[16px] leading-[1.65] text-onink-2">
              A modular architecture where reasoning, research, memory, tools, agents, models and
              evaluation become reusable systems — capable of powering many different products,
              not one.
            </p>
          </div>

          <div className="mt-16 pt-10 border-t border-onink/15 flex flex-col sm:flex-row sm:items-end justify-between gap-8 reveal">
            <div>
              <div className="font-display text-[clamp(1.9rem,4.4vw,3.4rem)] font-semibold tracking-display leading-[1] text-onink">
                This is Cosmos.
              </div>
              <div className="label !text-onink-2 mt-3">Intelligence through coordination</div>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 shrink-0">
              <button
                onClick={onExploreCosmos}
                className="btn bg-paper text-ink border border-paper hover:bg-accent hover:text-white hover:border-accent group"
              >
                <span>Explore the subsystems</span>
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
              </button>
              <button
                onClick={onOpenArchitecture}
                className="btn bg-transparent text-onink border border-onink/25 hover:border-onink hover:bg-onink/5"
              >
                View schematic
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
