import React from 'react';

const columns = [
  {
    title: 'Systems',
    links: [
      { label: 'ResearchOS', href: '#research-os', state: 'Built' },
      { label: 'AgentOS', href: '#agent-os', state: 'Built' },
      { label: 'ToolOS', href: '#tool-os', state: 'Built' },
      { label: 'EvalOS', href: '#eval-os', state: 'Certifying' },
      { label: 'MemoryOS', href: '#systems', state: 'In dev' },
      { label: 'ModelOS', href: '#systems', state: 'Planned' }
    ]
  },
  {
    title: 'Architecture',
    links: [
      { label: 'Why Cosmos', href: '#platform' },
      { label: 'Cosmos Core', href: '#architecture' },
      { label: 'Request trace', href: '#request-flow' },
      { label: 'Frontier roadmap', href: '#roadmap' },
      { label: 'Governance', href: '#governance-modules' },
      { label: 'Local + cloud', href: '#deployment' }
    ]
  },
  {
    title: 'Foundation',
    links: [
      { label: 'Conceptual SDK', href: '#developers' },
      { label: 'Ten principles', href: '#principles' },
      { label: 'Substrate vision', href: '#vision' },
      { label: 'Topology', href: '#hero-section' }
    ]
  }
];

export const Footer: React.FC = () => {
  const scrollTo = (id: string) => document.querySelector(id)?.scrollIntoView({ behavior: 'smooth' });

  return (
    <footer id="site-footer" className="bg-ink text-onink-2 border-t border-onink/12">
      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 py-20 sm:py-24">
        <div className="grid grid-cols-2 lg:grid-cols-12 gap-x-8 gap-y-14 pb-16 border-b border-onink/12">
          <div className="col-span-2 lg:col-span-5">
            <div className="flex items-center gap-2.5 mb-5">
              <svg width="24" height="24" viewBox="0 0 26 26" fill="none" aria-hidden="true">
                <circle cx="13" cy="13" r="3.2" className="fill-accent" />
                <ellipse cx="13" cy="13" rx="11.4" ry="5.6" stroke="#f2f0ea" strokeOpacity="0.4" strokeWidth="1.1" />
                <ellipse cx="13" cy="13" rx="11.4" ry="5.6" stroke="#f2f0ea" strokeOpacity="0.4" strokeWidth="1.1" transform="rotate(60 13 13)" />
                <ellipse cx="13" cy="13" rx="11.4" ry="5.6" stroke="#f2f0ea" strokeOpacity="0.4" strokeWidth="1.1" transform="rotate(120 13 13)" />
              </svg>
              <span className="font-display text-[19px] font-semibold tracking-display-sm text-onink">Cosmos</span>
            </div>

            <p className="font-display text-[22px] sm:text-[26px] tracking-display-sm text-onink leading-snug max-w-[18ch]">
              Intelligence, <span className="ed font-normal">orchestrated.</span>
            </p>

            <p className="text-[14px] leading-[1.6] text-onink-2 max-w-[42ch] mt-5">
              A modular intelligence infrastructure platform. Specialised operating systems for
              research, agents, tools, memory, models and evaluation, working as one layer.
            </p>

            <p className="text-[13px] leading-[1.6] text-onink-2 max-w-[42ch] mt-6 pt-5 border-t border-onink/12">
              <span className="text-onink">Transparency.</span> No synthetic performance metrics and no
              fabricated customer logos anywhere on this site. Status labels reflect real build state.
            </p>
          </div>

          {columns.map((col) => (
            <div key={col.title} className="lg:col-span-2">
              <span className="label !text-onink-2 block mb-5">{col.title}</span>
              <ul className="space-y-3">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <button
                      onClick={() => scrollTo(link.href)}
                      className="text-[14px] text-onink-2 hover:text-onink transition-colors cursor-pointer text-left flex items-baseline gap-2 group"
                    >
                      <span>{link.label}</span>
                      {'state' in link && link.state && (
                        <span className="font-mono text-[10px] uppercase tracking-wider text-onink-2/70 group-hover:text-accent transition-colors">
                          {link.state}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="pt-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <span className="text-[13px] text-onink-2">
            © {new Date().getFullYear()} Cosmos Infrastructure
          </span>
          <span className="label !text-onink-2">Explicit contracts · Inspectable systems</span>
        </div>
      </div>
    </footer>
  );
};
