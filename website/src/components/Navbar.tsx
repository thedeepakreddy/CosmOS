import React, { useState, useEffect } from 'react';
import { Menu, X, ArrowUpRight } from 'lucide-react';

interface NavbarProps {
  onOpenArchitecture: () => void;
  onExploreCosmos: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ onOpenArchitecture, onExploreCosmos }) => {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 24);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Lock body scroll while the mobile sheet is open
  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileMenuOpen]);

  const navLinks = [
    { label: 'Platform', href: '#platform' },
    { label: 'Systems', href: '#systems' },
    { label: 'Research', href: '#research-os' },
    { label: 'Roadmap', href: '#roadmap' },
    { label: 'Developers', href: '#developers' }
  ];

  const handleNavClick = (href: string) => {
    setMobileMenuOpen(false);
    document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <header
      id="site-header"
      className={`fixed top-0 left-0 right-0 z-50 transition-colors duration-300 ${
        scrolled ? 'bg-paper/85 backdrop-blur-xl border-b border-rule' : 'border-b border-transparent'
      }`}
    >
      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 h-[72px] flex items-center justify-between gap-6">
        {/* Wordmark — a drawn mark, not an icon in a tinted box */}
        <a
          href="#"
          id="brand-logo"
          className="flex items-center gap-2.5 shrink-0 group"
          aria-label="Cosmos, home"
        >
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true" className="shrink-0">
            <circle cx="13" cy="13" r="3.2" className="fill-accent" />
            <ellipse cx="13" cy="13" rx="11.4" ry="5.6" stroke="currentColor" strokeWidth="1.1"
              className="text-ink/35 transition-colors group-hover:text-ink/60" />
            <ellipse cx="13" cy="13" rx="11.4" ry="5.6" stroke="currentColor" strokeWidth="1.1"
              transform="rotate(60 13 13)" className="text-ink/35 transition-colors group-hover:text-ink/60" />
            <ellipse cx="13" cy="13" rx="11.4" ry="5.6" stroke="currentColor" strokeWidth="1.1"
              transform="rotate(120 13 13)" className="text-ink/35 transition-colors group-hover:text-ink/60" />
          </svg>
          <span className="font-display text-[19px] font-semibold tracking-display-sm text-ink">Cosmos</span>
        </a>

        {/* Centre nav */}
        <nav className="hidden lg:flex items-center gap-1 absolute left-1/2 -translate-x-1/2" aria-label="Main">
          {navLinks.map((link) => (
            <button
              key={link.label}
              onClick={() => handleNavClick(link.href)}
              className="text-[14px] text-ink-2 hover:text-ink px-3.5 py-2 rounded-full transition-colors cursor-pointer hover:bg-ink/[0.04]"
            >
              {link.label}
            </button>
          ))}
        </nav>

        <div className="hidden sm:flex items-center gap-2 shrink-0">
          <button
            id="nav-view-architecture-btn"
            onClick={onOpenArchitecture}
            className="text-[14px] text-ink-2 hover:text-ink px-4 py-2 rounded-full transition-colors cursor-pointer hover:bg-ink/[0.04]"
          >
            Architecture
          </button>
          <button
            id="nav-explore-cosmos-btn"
            onClick={onExploreCosmos}
            className="btn btn-primary !min-h-0 !py-2.5 !px-5 !text-[14px] group"
          >
            <span>Explore</span>
            <ArrowUpRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </button>
        </div>

        <button
          id="mobile-menu-toggle"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="lg:hidden sm:ml-auto p-2.5 -mr-2.5 text-ink cursor-pointer"
          aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileMenuOpen}
        >
          {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {mobileMenuOpen && (
        <div className="lg:hidden bg-paper border-b border-rule px-5 pb-8 pt-2">
          <nav className="flex flex-col">
            {navLinks.map((link, i) => (
              <button
                key={link.label}
                onClick={() => handleNavClick(link.href)}
                className="text-left py-4 border-b border-rule flex items-baseline gap-4 cursor-pointer"
              >
                <span className="label text-[10px] tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                <span className="font-display text-[22px] tracking-display-sm text-ink">{link.label}</span>
              </button>
            ))}
          </nav>
          <div className="flex flex-col gap-2.5 pt-6">
            <button
              onClick={() => {
                setMobileMenuOpen(false);
                onOpenArchitecture();
              }}
              className="btn btn-ghost w-full"
            >
              View architecture
            </button>
            <button
              onClick={() => {
                setMobileMenuOpen(false);
                onExploreCosmos();
              }}
              className="btn btn-primary w-full"
            >
              Explore Cosmos
              <ArrowUpRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </header>
  );
};
