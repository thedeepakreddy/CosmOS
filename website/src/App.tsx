import React, { useState } from 'react';
import { useReveal } from './hooks/useReveal';
import { Navbar } from './components/Navbar';
import { Hero } from './components/Hero';
import { WhyCosmos } from './components/WhyCosmos';
import { CosmosStack } from './components/CosmosStack';
import { ResearchOSSpotlight } from './components/ResearchOSSpotlight';
import { AgentOSSection } from './components/AgentOSSection';
import { ToolOSSection } from './components/ToolOSSection';
import { EvalOSSection } from './components/EvalOSSection';
import { CosmosCoreSection } from './components/CosmosCoreSection';
import { RequestFlow } from './components/RequestFlow';
import { FrontierRoadmap } from './components/FrontierRoadmap';
import { PlatformArchitecture } from './components/PlatformArchitecture';
import { DevelopersSection } from './components/DevelopersSection';
import { PrinciplesSection } from './components/PrinciplesSection';
import { VisionSection } from './components/VisionSection';
import { Footer } from './components/Footer';
import { ArchitectureModal } from './components/ArchitectureModal';

export default function App() {
  const [architectureModalOpen, setArchitectureModalOpen] = useState(false);
  useReveal();

  const handleOpenArchitecture = () => {
    setArchitectureModalOpen(true);
  };

  const handleExploreCosmos = () => {
    const el = document.querySelector('#systems');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const handleSelectSystem = (systemId: string) => {
    // If it has a dedicated section, scroll there, otherwise scroll to systems cards
    const dedicatedSection = document.querySelector(`#${systemId}`);
    if (dedicatedSection) {
      dedicatedSection.scrollIntoView({ behavior: 'smooth' });
    } else {
      const systemsCard = document.querySelector(`#card-${systemId}`);
      if (systemsCard) {
        systemsCard.scrollIntoView({ behavior: 'smooth' });
      }
    }
  };

  const handleNavigateFromModal = (systemId: string) => {
    setArchitectureModalOpen(false);
    setTimeout(() => {
      handleSelectSystem(systemId);
    }, 150);
  };

  return (
    <div className="min-h-screen bg-paper text-ink relative">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[60] focus:px-5 focus:py-3 focus:rounded-full focus:bg-ink focus:text-onink focus:text-[14px]"
      >
        Skip to content
      </a>

      {/* Top Fixed Navigation */}
      <Navbar
        onOpenArchitecture={handleOpenArchitecture}
        onExploreCosmos={handleExploreCosmos}
      />

      {/* Main Content Sections */}
      <main id="main-content">
        {/* Hero Section with Interactive Orbit */}
        <Hero
          onOpenArchitecture={handleOpenArchitecture}
          onExploreCosmos={handleExploreCosmos}
          onSelectSystem={handleSelectSystem}
        />

        {/* Why Cosmos — One model is not an intelligence system */}
        <WhyCosmos />

        {/* The Cosmos Stack — 6 Core Systems */}
        <CosmosStack onSelectSystem={handleSelectSystem} />

        {/* ResearchOS Dedicated Spotlight with Claim & Contradiction Graph */}
        <ResearchOSSpotlight />

        {/* AgentOS Dedicated Spotlight — Workforce Orchestration & DAG */}
        <AgentOSSection />

        {/* ToolOS Dedicated Spotlight — Controlled Action, MCP & Sandboxes */}
        <ToolOSSection />

        {/* EvalOS Dedicated Spotlight — Regression Detection & Quality Gates */}
        <EvalOSSection />

        {/* Cosmos Core — Central Coordination Layer Diagram */}
        <CosmosCoreSection onSelectSystem={handleSelectSystem} />

        {/* Animated Request Flow — European EV Battery Market Study */}
        <RequestFlow />

        {/* Frontier Roadmap & Governance Modules */}
        <FrontierRoadmap />

        {/* Cosmos is a Platform, Not One App + Local / Cloud Deployment */}
        <PlatformArchitecture />

        {/* Developers Section — Conceptual SDK & APIs */}
        <DevelopersSection />

        {/* Cosmos Principles — 10 Foundational Tenets */}
        <PrinciplesSection />

        {/* Vision — We are not building another chatbot */}
        <VisionSection
          onOpenArchitecture={handleOpenArchitecture}
          onExploreCosmos={handleExploreCosmos}
        />
      </main>

      {/* Site Footer */}
      <Footer />

      {/* Architecture Explorer Modal */}
      <ArchitectureModal
        isOpen={architectureModalOpen}
        onClose={() => setArchitectureModalOpen(false)}
        onNavigateTo={handleNavigateFromModal}
      />
    </div>
  );
}
