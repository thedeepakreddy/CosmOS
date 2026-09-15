import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

const tabLabels = {
  typescript: 'TypeScript',
  python: 'Python',
  rest: 'REST',
  events: 'Events'
} as const;

type TabKey = keyof typeof tabLabels;

const surfaces = [
  { name: 'REST API', desc: 'Standard JSON endpoints with granular idempotency keys' },
  { name: 'TypeScript SDK', desc: 'Node and browser client with streaming async iterables' },
  { name: 'Python SDK', desc: 'AsyncIO-native client for ML and research workflows' },
  { name: 'Webhooks', desc: 'Signed HMAC callbacks for long-running completions' },
  { name: 'Event streams', desc: 'Low-latency SSE for real-time trace telemetry' }
];

export const DevelopersSection: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabKey>('typescript');
  const [copied, setCopied] = useState(false);

  const snippets = {
    typescript: `// [Conceptual SDK] - Illustrative Design Only
import { CosmosClient } from '@cosmos/sdk';

const cosmos = new CosmosClient({
  apiKey: process.env.COSMOS_API_KEY,
  policyScope: 'ENTERPRISE_CONFIDENTIAL',
});

// Initialize deep research project with evidence constraints
const project = await cosmos.research.create({
  question: "Analyze the European EV battery market.",
  depth: "EXHAUSTIVE",
  subsystems: {
    agents: ["Market", "Competitor", "Regulatory", "Critic"],
    tools: ["mcp://eu_tariffs", "mcp://filings_db"],
    evaluation: { qualityGate: "ENTERPRISE_v2", blockOnContradiction: false },
  },
});

// Run coordinated execution across AgentOS and ToolOS
const handle = await project.run();

// Stream audit events and claim graphs
for await (const event of handle.streamEvents()) {
  console.log(\`[\${event.subsystem}] \${event.stage}: \${event.detail}\`);
}

// Retrieve finalized, verified report with complete citation provenance
const report = await project.report();
console.log(report.synthesizedFindings, report.claimContradictionGraph);`,

    python: `# [Conceptual SDK] - Illustrative Design Only
from cosmos import CosmosClient, ResearchSpec

cosmos = CosmosClient(
    api_key="cos_live_90432",
    policy_scope="ENTERPRISE_CONFIDENTIAL"
)

# Dispatch research investigation
project = cosmos.research.create(
    question="Analyze the European EV battery market.",
    depth="EXHAUSTIVE",
    require_eval_gate=True
)

run = project.run()

# Synchronously wait for EvalOS certification pass
result = run.wait_until_certified(timeout_seconds=300)

print(f"Verified Claims: {len(result.claims)}")
print(f"Contradictions Isolated: {len(result.contradictions)}")
print(result.to_markdown())`,

    rest: `// [Conceptual REST API] - Illustrative Design Only
POST /v1/research/projects HTTP/1.1
Host: api.cosmos.ai
Authorization: Bearer cos_live_secret_key
Content-Type: application/json

{
  "question": "Analyze the European EV battery market.",
  "parameters": {
    "depth": "EXHAUSTIVE",
    "verification_threshold": 0.90,
    "subsystem_mesh": [
      "ResearchOS",
      "AgentOS",
      "ToolOS",
      "EvalOS"
    ]
  },
  "policy": {
    "max_budget_cents": 500,
    "egress_allowlist": ["*.europa.eu", "sec.gov"]
  }
}`,

    events: `// [Conceptual Event Stream] - Server-Sent Events (SSE)
GET /v1/runs/run_89410a/events HTTP/1.1
Host: api.cosmos.ai
Accept: text/event-stream

event: subsystem_transition
data: {"from": "COSMOS_CORE", "to": "ResearchOS", "status": "DISPATCHED"}

event: agent_spawned
data: {"subsystem": "AgentOS", "agent_id": "critic_01", "role": "ADVERSARIAL_RED_TEAM"}

event: tool_invoked
data: {"subsystem": "ToolOS", "tool": "mcp://eu_tariffs/cbam", "verdict": "ALLOWED"}

event: eval_gate_pass
data: {"subsystem": "EvalOS", "score": 96.4, "verdict": "CERTIFIED"}`
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(snippets[activeTab]);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section id="developers" className="relative bg-ink text-onink py-24 sm:py-36 overflow-hidden">
      <div className="absolute inset-0 grid-ink opacity-60 pointer-events-none" />

      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 relative">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-8 mb-14">
          <div className="lg:col-span-6">
            <div className="eyebrow !text-onink-2 mb-7"><span>Developer experience</span></div>
            <h2 className="font-display text-[length:var(--text-d2)] font-semibold tracking-display leading-[1.02] !text-onink reveal">
              Built for people <span className="ed font-normal">shipping real systems.</span>
            </h2>
          </div>
          <div className="lg:col-span-5 lg:col-start-8 lg:pt-4">
            <p className="text-[17px] leading-[1.6] text-onink-2 reveal">
              Programmatic interfaces for teams who want auditable agency, verifiable research and
              strict separation of concerns.
            </p>
            <p className="text-[14px] leading-[1.6] text-onink-2 mt-4 pl-4 border-l-2 border-accent reveal">
              Everything below is the conceptual SDK and API design — illustrative, not published.
            </p>
          </div>
        </div>

        {/* Code surface */}
        <div className="rounded-[20px] border border-onink/15 overflow-hidden mb-20 bg-[#0d0c09]">
          <div className="px-5 sm:px-7 py-4 border-b border-onink/12 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-6">
              {(Object.keys(tabLabels) as TabKey[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  aria-pressed={activeTab === tab}
                  className={`text-[14px] pb-1.5 border-b-2 transition-colors cursor-pointer ${
                    activeTab === tab
                      ? 'text-onink border-accent font-medium'
                      : 'text-onink-2 border-transparent hover:text-onink'
                  }`}
                >
                  {tabLabels[tab]}
                </button>
              ))}
            </div>

            <button
              id="copy-sdk-code-btn"
              onClick={copyToClipboard}
              className="flex items-center gap-2 text-[13px] text-onink-2 hover:text-onink transition-colors cursor-pointer"
            >
              {copied ? <Check className="w-4 h-4 text-accent" /> : <Copy className="w-4 h-4" />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>

          <pre className="px-5 sm:px-8 py-7 text-[12.5px] sm:text-[13px] font-mono text-onink overflow-x-auto leading-[1.8]">
            <code>{snippets[activeTab]}</code>
          </pre>

          <div className="px-5 sm:px-7 py-4 border-t border-onink/12 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <span className="text-[13px] text-onink-2">
              Full TypeScript typings and Zod schemas for every subsystem payload
            </span>
            <span className="label !text-onink-2">gRPC · HTTP/2 · SSE</span>
          </div>
        </div>

        {/* Surfaces */}
        <div>
          <div className="eyebrow !text-onink-2 mb-8"><span>Interface surfaces</span></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-x-8 gap-y-9 border-t border-onink/15 pt-10">
            {surfaces.map((item) => (
              <div key={item.name} className="reveal">
                <h3 className="font-display text-[16px] font-semibold tracking-display-sm !text-onink mb-1.5">
                  {item.name}
                </h3>
                <p className="text-[14px] leading-[1.55] text-onink-2">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
