import React, { useState, useEffect, useRef } from 'react';
import { CORE_SYSTEMS, FRONTIER_SYSTEMS, GOVERNANCE_MODULES } from '../data/cosmosData';
import { CosmosSystem } from '../types';
import { X, Search, ArrowRight } from 'lucide-react';

interface ArchitectureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateTo: (elementId: string) => void;
}

const categories = ['all', 'specialized', 'frontier', 'governance', 'core'] as const;
type Category = (typeof categories)[number];

const toneOf = (s: CosmosSystem) =>
  s.status.includes('BUILT') ? 'live' : s.status.includes('IN_DEVELOPMENT') ? 'dev' : 'plan';

export const ArchitectureModal: React.FC<ArchitectureModalProps> = ({ isOpen, onClose, onNavigateTo }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterCategory, setFilterCategory] = useState<Category>('all');
  const [activeSystem, setActiveSystem] = useState<CosmosSystem>(CORE_SYSTEMS[0]);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape to close, and lock the page behind the dialog
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const allCombinedSystems = [...CORE_SYSTEMS, ...FRONTIER_SYSTEMS, ...GOVERNANCE_MODULES];
  const q = searchTerm.toLowerCase();

  const filteredSystems = allCombinedSystems.filter((sys) => {
    const matchesSearch =
      sys.name.toLowerCase().includes(q) ||
      sys.role.toLowerCase().includes(q) ||
      sys.summary.toLowerCase().includes(q);
    const matchesCategory = filterCategory === 'all' || sys.category === filterCategory;
    return matchesSearch && matchesCategory;
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-ink/45 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-paper border border-rule-2 w-full max-w-[1120px] rounded-[20px] overflow-hidden flex flex-col max-h-[90vh] shadow-[0_40px_90px_-30px_rgba(20,19,15,0.55)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-arch-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 sm:px-8 py-5 border-b border-rule flex items-center justify-between gap-4 bg-card">
          <div>
            <h3 id="modal-arch-title" className="font-display text-[20px] font-semibold tracking-display-sm text-ink">
              Architecture explorer
            </h3>
            <p className="text-[13.5px] text-ink-3 mt-0.5">
              {allCombinedSystems.length} operating systems and governance layers
            </p>
          </div>

          <button
            ref={closeRef}
            onClick={onClose}
            className="p-2.5 rounded-full border border-rule-2 text-ink-2 hover:text-ink hover:border-ink transition-colors cursor-pointer shrink-0"
            aria-label="Close architecture explorer"
          >
            <X className="w-4.5 h-4.5" />
          </button>
        </div>

        <div className="px-6 sm:px-8 py-4 border-b border-rule flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-card">
          <div className="relative w-full sm:w-80">
            <Search className="w-4 h-4 text-ink-3 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              placeholder="Search by name, role or capability"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              aria-label="Search subsystems"
              className="w-full bg-paper border border-rule rounded-full pl-11 pr-4 py-2.5 text-[14px] text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
            />
          </div>

          <div className="flex items-center gap-5 overflow-x-auto hide-scrollbar">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setFilterCategory(cat)}
                aria-pressed={filterCategory === cat}
                className={`text-[13.5px] capitalize pb-1 border-b-2 whitespace-nowrap transition-colors cursor-pointer ${
                  filterCategory === cat
                    ? 'text-ink border-accent font-medium'
                    : 'text-ink-3 border-transparent hover:text-ink'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 flex-1 overflow-hidden min-h-[420px]">
          {/* List */}
          <div className="md:col-span-5 overflow-y-auto border-b md:border-b-0 md:border-r border-rule max-h-[38vh] md:max-h-full">
            <div className="px-6 py-3 sticky top-0 bg-paper border-b border-rule">
              <span className="label tabular-nums">{filteredSystems.length} matching</span>
            </div>

            {filteredSystems.length === 0 && (
              <p className="px-6 py-8 text-[14px] text-ink-3">
                Nothing matches “{searchTerm}”. Try a broader term.
              </p>
            )}

            {filteredSystems.map((sys) => {
              const isSelected = activeSystem.id === sys.id;
              return (
                <button
                  key={sys.id}
                  onClick={() => setActiveSystem(sys)}
                  aria-pressed={isSelected}
                  className={`relative w-full text-left px-6 py-4 border-b border-rule transition-colors cursor-pointer ${
                    isSelected ? 'bg-card' : 'hover:bg-card/60'
                  }`}
                >
                  <span
                    className={`absolute left-0 top-0 bottom-0 w-[2px] ${isSelected ? 'bg-accent' : 'bg-transparent'}`}
                    aria-hidden="true"
                  />
                  <div className="flex items-baseline justify-between gap-3 mb-1">
                    <span className="font-display text-[16px] font-semibold tracking-display-sm text-ink">
                      {sys.name}
                    </span>
                    <span className={`status status-${toneOf(sys)} shrink-0`}>
                      {sys.status.includes('BUILT') ? 'Built' : 'Planned'}
                    </span>
                  </div>
                  <span className="label label-accent block mb-1.5">{sys.role}</span>
                  <p className="text-[13.5px] text-ink-3 leading-snug line-clamp-2">{sys.summary}</p>
                </button>
              );
            })}
          </div>

          {/* Detail */}
          <div className="md:col-span-7 overflow-y-auto bg-card p-6 sm:p-8 flex flex-col">
            <div className="flex items-start justify-between gap-4 pb-5 border-b border-rule mb-6">
              <div>
                <div className="flex flex-wrap items-center gap-3 mb-2">
                  <span className="label capitalize">{activeSystem.category}</span>
                  <span className={`status status-${toneOf(activeSystem)}`}>{activeSystem.statusLabel}</span>
                </div>
                <h4 className="font-display text-[28px] font-semibold tracking-display-sm text-ink leading-none">
                  {activeSystem.name}
                </h4>
                <span className="label label-accent block mt-2">{activeSystem.role}</span>
              </div>

              <button
                onClick={() => {
                  onClose();
                  onNavigateTo(activeSystem.id);
                }}
                className="btn btn-primary !min-h-0 !py-2.5 !px-4 !text-[13.5px] shrink-0 group"
              >
                <span>Go to section</span>
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
              </button>
            </div>

            <div className="flex flex-col gap-7 flex-1">
              <div>
                <span className="label block mb-2">Purpose &amp; scope</span>
                <p className="text-[15px] leading-[1.6] text-ink-2">{activeSystem.summary}</p>
              </div>

              <div>
                <span className="label block mb-3">Responsibilities</span>
                <ul className="space-y-2.5">
                  {activeSystem.purpose.map((p) => (
                    <li key={p} className="flex gap-3 text-[14.5px] text-ink-2 leading-[1.55]">
                      <span className="text-accent-ink shrink-0 mt-px" aria-hidden="true">—</span>
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {activeSystem.contractInterface && (
                <div>
                  <span className="label block mb-2.5">Interface contract</span>
                  <pre className="p-4 rounded-xl bg-ink text-onink overflow-x-auto text-[12.5px] leading-[1.75] font-mono">
                    <code>{activeSystem.contractInterface}</code>
                  </pre>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 mt-7 pt-5 border-t border-rule">
              <span className="text-[13px] text-ink-3">Isolated operating-system contract</span>
              <span className="label">Architecture v0.9</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
