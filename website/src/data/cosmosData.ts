import { CosmosSystem, ClaimNode, RequestFlowStep } from '../types';

export const CORE_SYSTEMS: CosmosSystem[] = [
  {
    id: 'research-os',
    name: 'ResearchOS',
    role: 'INVESTIGATE',
    simpleMeaning: 'INVESTIGATE',
    status: 'BUILT_ADVANCED',
    statusLabel: 'BUILT / ADVANCED',
    summary: 'Deep research, evidence collection, claim verification, contradiction detection, experiments, debate, synthesis, research evolution, and reports.',
    purpose: [
      'Evidence collection and claim provenance',
      'Contradiction and counter-evidence detection',
      'Hypothesis generation and experiment tracking',
      'Structured academic and strategic report synthesis',
      'Scientific research evolution across iterations'
    ],
    capabilities: [
      'Claim Graph Assembly',
      'Multi-Angle Debate Engine',
      'Source Provenance Preservation',
      'Contradiction Matrix Analysis',
      'Audit-grade Evidence Reports'
    ],
    contractInterface: `interface ResearchContract {
  investigate(query: ResearchIntent): Promise<VerifiedClaimGraph>;
  verifyEvidence(claim: ClaimRef): Promise<ContradictionAnalysis>;
  evolveReport(draft: Report, critique: Critique): Promise<FinalSynthesis>;
}`,
    category: 'specialized',
    layer: 1
  },
  {
    id: 'agent-os',
    name: 'AgentOS',
    role: 'ORCHESTRATE',
    simpleMeaning: 'ORCHESTRATE',
    status: 'BUILT_CERTIFIED',
    statusLabel: 'BUILT / CERTIFIED',
    summary: 'Agent orchestration, task graphs, supervision, concurrency, retries, resumability, failure recovery.',
    purpose: [
      'Deterministic DAG execution and task graphs',
      'Hierarchical supervisor-worker agent coordination',
      'Bounded concurrency and rate-aware scheduling',
      'Pause, resume, and persistent execution recovery',
      'Process failure isolation and retry policies'
    ],
    capabilities: [
      'Dynamic Task Graphs (DAGs)',
      'Supervisor & Specialist Roles',
      'Resumable State Checkpointing',
      'Circuit Breakers & Retries',
      'Parallel Worker Pools'
    ],
    contractInterface: `interface AgentOrchestrator {
  dispatchGraph(dag: TaskGraph, supervisor: SupervisorPolicy): Promise<ExecutionHandle>;
  pause(runId: string): Promise<Checkpoint>;
  resume(checkpoint: Checkpoint): Promise<RunStatus>;
}`,
    category: 'specialized',
    layer: 1
  },
  {
    id: 'tool-os',
    name: 'ToolOS',
    role: 'ACT',
    simpleMeaning: 'ACT',
    status: 'BUILT_CERTIFIED',
    statusLabel: 'BUILT / CERTIFIED',
    summary: 'Controlled access to tools, APIs, capabilities, MCP, external systems, execution environments.',
    purpose: [
      'Standardized model context protocol (MCP) bridging',
      'Permission-aware and policy-controlled tool execution',
      'Model-neutral tool discovery and call serialization',
      'Deterministic sandbox & container runtime isolation',
      'Full cryptographic audit trail for external side-effects'
    ],
    capabilities: [
      'MCP Bridge & Protocol Adapters',
      'Zero-Trust Tool Sandboxes',
      'Granular RBAC Tool Policies',
      'External API & Database Proxies',
      'Real-time Side-Effect Auditing'
    ],
    contractInterface: `interface ToolBroker {
  invoke(toolName: string, params: unknown, policy: SecurityScope): Promise<ToolResult>;
  registerMCP(server: MCPEndpoint): Promise<RegisteredTools>;
  auditLog(invocationId: string): ToolExecutionTrace;
}`,
    category: 'specialized',
    layer: 1
  },
  {
    id: 'eval-os',
    name: 'EvalOS',
    role: 'MEASURE',
    simpleMeaning: 'MEASURE',
    status: 'BUILT_CERTIFICATION_STAGE',
    statusLabel: 'BUILT / FINAL CERTIFICATION STAGE',
    summary: 'Evaluation, benchmarks, regression detection, quality gates, scoring, comparisons.',
    purpose: [
      'Systematic A/B regression detection between system versions',
      'Multi-metric benchmark suite orchestration',
      'Automated quality gates blocking defective runs',
      'Fine-grained scoring on truthfulness, latency, and cost',
      'Continuous historical performance baselines'
    ],
    capabilities: [
      'Regression Differential Analysis',
      'Automated Quality Gate Enforcers',
      'Domain Benchmarking Suites',
      'Synthesized Failure Traces',
      'Multi-Judge Consensus Scoring'
    ],
    contractInterface: `interface EvaluationEngine {
  evaluate(candidate: SystemOutput, baseline: SystemOutput): Promise<RegressionReport>;
  enforceGate(output: unknown, gateRules: QualityGate): Promise<GateVerdict>;
  recordBenchmark(run: BenchmarkSession): Promise<BenchmarkScorecard>;
}`,
    category: 'specialized',
    layer: 1
  },
  {
    id: 'memory-os',
    name: 'MemoryOS',
    role: 'REMEMBER',
    simpleMeaning: 'REMEMBER',
    status: 'PLANNED_IN_DEVELOPMENT',
    statusLabel: 'PLANNED / IN DEVELOPMENT',
    summary: 'Long-term memory, short-term memory, episodic memory, semantic memory, project memory, lessons, failure memory, retrieval.',
    purpose: [
      'Episodic and semantic memory indexing with provenance',
      'Cross-run organizational and project memory retrieval',
      'Failure memory to prevent repeating past mistakes',
      'Explicit memory forgetting, eviction, and retention policies',
      'Strict tenant-isolated memory vaults'
    ],
    capabilities: [
      'Episodic & Semantic Knowledge Store',
      'Mistake & Failure Indexing',
      'Tenant Isolation & Cryptographic Partitioning',
      'Provenance-Tagged Memory Graph',
      'Contextual Recall Ranking'
    ],
    contractInterface: `interface MemorySubsystem {
  recall(context: QueryVector, tenant: TenantId): Promise<MemoryRecord[]>;
  persistLesson(trace: ExecutionTrace, outcome: OutcomeScore): Promise<MemoryNodeRef>;
  evict(predicate: EvictionRule): Promise<EvictionSummary>;
}`,
    category: 'specialized',
    layer: 2
  },
  {
    id: 'model-os',
    name: 'ModelOS',
    role: 'ROUTE',
    simpleMeaning: 'ROUTE',
    status: 'PLANNED',
    statusLabel: 'PLANNED',
    summary: 'Multi-model provider abstraction, intelligent model routing, fallback, cost/quality/latency optimization.',
    purpose: [
      'Dynamic routing based on task complexity and budget',
      'Zero-downtime provider fallback and failover matrices',
      'Unified request abstraction across all model providers',
      'Granular per-token cost and latency budget enforcement',
      'Self-healing latency anomaly mitigation'
    ],
    capabilities: [
      'Cost / Quality / Latency Optimizer',
      'Dynamic Fallback Mesh',
      'Unified Schema Normalizer',
      'Token Quota Enforcer',
      'Provider Health Probing'
    ],
    contractInterface: `interface ModelGateway {
  route(prompt: CanonicalPrompt, constraints: SLAConstraints): Promise<ModelResponse>;
  fallbackChain(primary: ModelTarget, backup: ModelTarget[]): RouteStrategy;
  estimateCost(workload: WorkloadDescription): CostEstimate;
}`,
    category: 'specialized',
    layer: 2
  },
  {
    id: 'cosmos-core',
    name: 'Cosmos Core',
    role: 'COORDINATE',
    simpleMeaning: 'COORDINATE',
    status: 'PLANNED',
    statusLabel: 'PLANNED',
    summary: 'Understand the user\'s goal, select the correct intelligence systems, coordinate them, enforce policies, and return the final result.',
    purpose: [
      'Intent parsing and capability resolution',
      'Cross-system orchestration and state synchronization',
      'Global policy, budget, and governance enforcement',
      'Unified context assembly across specialized OSs',
      'Final answer synthesis and proof verification'
    ],
    capabilities: [
      'Global Intent Routing',
      'Contract Interop Bus',
      'End-to-End Governance Engine',
      'Capability Discovery Broker',
      'Holistic Synthesis Coordinator'
    ],
    contractInterface: `interface CosmosCoreCoordination {
  coordinate(userIntent: IntentSpec): Promise<CoordinatedResult>;
  verifyContract(sender: CosmosOS, receiver: CosmosOS): boolean;
  synthesizeFinal(artifacts: SubsystemArtifacts[]): CoordinatedResponse;
}`,
    category: 'core',
    layer: 2
  }
];

export const FRONTIER_SYSTEMS: CosmosSystem[] = [
  {
    id: 'planning-os',
    name: 'PlanningOS',
    role: 'PLAN',
    simpleMeaning: 'PLAN',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'ROADMAP / NEXT',
    summary: 'Long-horizon planning, decomposition, dependencies, contingencies.',
    purpose: ['Multi-phase goal decomposition', 'Contingency branch calculation', 'Critical path dependency analysis'],
    capabilities: ['Tree-of-thought exploration', 'Dynamic schedule replanning', 'Resource allocation planning'],
    category: 'frontier',
    layer: 2
  },
  {
    id: 'context-os',
    name: 'ContextOS',
    role: 'SEE THE RIGHT CONTEXT',
    simpleMeaning: 'SEE THE RIGHT CONTEXT',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'ROADMAP / NEXT',
    summary: 'Select, compress, rank and assemble the right context for models and agents.',
    purpose: ['Context window compression without semantic loss', 'Dynamic relevance ranking', 'Cross-source context assembly'],
    capabilities: ['Lossless context pruning', 'Hierarchical context ranking', 'Working memory windowing'],
    category: 'frontier',
    layer: 2
  },
  {
    id: 'reasoning-os',
    name: 'ReasoningOS',
    role: 'REASON',
    simpleMeaning: 'REASON',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'ROADMAP / FRONTIER',
    summary: 'Logical, causal, counterfactual, constraint-based and scenario reasoning.',
    purpose: ['Formal logic verification', 'Causal inference graph generation', 'Counterfactual simulation'],
    capabilities: ['Constraint satisfaction solvers', 'Scenario matrix generator', 'Proof tree generation'],
    category: 'frontier',
    layer: 3
  },
  {
    id: 'knowledge-os',
    name: 'KnowledgeOS',
    role: 'KNOW',
    simpleMeaning: 'KNOW',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'ROADMAP / FRONTIER',
    summary: 'Durable facts, ontologies, knowledge graphs, provenance and canonical knowledge.',
    purpose: ['Canonical enterprise ontology management', 'Cryptographic provenance for every fact', 'Graph-native relational querying'],
    capabilities: ['Ontology inference engine', 'Fact versioning & deprecation', 'Entity disambiguation'],
    category: 'frontier',
    layer: 3
  },
  {
    id: 'skill-os',
    name: 'SkillOS',
    role: 'KNOW HOW',
    simpleMeaning: 'KNOW HOW',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'ROADMAP / FRONTIER',
    summary: 'Reusable learned procedures and strategies.',
    purpose: ['Extraction of repeatable procedures from successful runs', 'Modular skill packaging and parametrization', 'Execution telemetry tracking'],
    capabilities: ['Strategy synthesis', 'Parameter validation', 'Skill registry'],
    category: 'frontier',
    layer: 3
  },
  {
    id: 'world-model-os',
    name: 'WorldModelOS',
    role: 'UNDERSTAND THE WORLD',
    simpleMeaning: 'UNDERSTAND THE WORLD',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'ROADMAP / FRONTIER',
    summary: 'Structured representation of entities, states, relationships, time, uncertainty and possible futures.',
    purpose: ['State transition tracking over continuous time', 'Uncertainty bounds modeling', 'Future state projection'],
    capabilities: ['Temporal state machines', 'Probabilistic state spaces', 'Entity relation graphs'],
    category: 'frontier',
    layer: 3
  },
  {
    id: 'goal-os',
    name: 'GoalOS',
    role: 'KNOW WHAT MATTERS',
    simpleMeaning: 'KNOW WHAT MATTERS',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'ROADMAP / FRONTIER',
    summary: 'Long-term goals, priorities, progress, subgoals and conflicts.',
    purpose: ['Goal hierarchy maintenance', 'Inter-goal conflict arbitration', 'Objective progress measurement'],
    capabilities: ['Priority weights optimization', 'Subgoal dependency graphs', 'Mission drift detector'],
    category: 'frontier',
    layer: 3
  },
  {
    id: 'decision-os',
    name: 'DecisionOS',
    role: 'CHOOSE',
    simpleMeaning: 'CHOOSE',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'ROADMAP / FRONTIER',
    summary: 'Decision-making under uncertainty, cost, risk and competing objectives.',
    purpose: ['Multi-objective utility maximization', 'Risk-adjusted expected value calculations', 'Decision audit trails'],
    capabilities: ['Pareto-frontier analysis', 'Monte Carlo risk modeling', 'Defensible decision rationale'],
    category: 'frontier',
    layer: 3
  },
  {
    id: 'reflection-os',
    name: 'ReflectionOS',
    role: 'REFLECT',
    simpleMeaning: 'REFLECT',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'ROADMAP / LONG-TERM',
    summary: 'Structured self-review after tasks and runs.',
    purpose: ['Post-mortem trace critique', 'Identification of inefficiency and hallucination seeds', 'Systemic failure mode cataloging'],
    capabilities: ['Post-execution critique', 'Efficiency gap analysis', 'Blindspot detection'],
    category: 'frontier',
    layer: 4
  },
  {
    id: 'learning-os',
    name: 'LearningOS',
    role: 'LEARN',
    simpleMeaning: 'LEARN',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'ROADMAP / LONG-TERM',
    summary: 'Extract lessons and strategies from historical execution.',
    purpose: ['Pattern mining across thousands of executions', 'Heuristic rule crystallization', 'Agent prompting optimization'],
    capabilities: ['Historical heuristic extraction', 'Cross-run transfer learning', 'Agent prompt evolution'],
    category: 'frontier',
    layer: 4
  },
  {
    id: 'evolution-os',
    name: 'EvolutionOS',
    role: 'IMPROVE',
    simpleMeaning: 'IMPROVE',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'ROADMAP / LONG-TERM',
    summary: 'Propose system improvements using real evaluation results and historical traces.',
    purpose: [
      'Propose concrete architectural or prompt improvements',
      'EvalOS gated testing before any rollout',
      'Deterministic accept or reject cycle'
    ],
    capabilities: [
      'Gated Hypothesis Testing',
      'Non-Autonomous Self-Improvement',
      'EvalOS Gate Confirmation',
      'Rollback Safety Guarantees'
    ],
    category: 'frontier',
    layer: 4
  }
];

export const GOVERNANCE_MODULES: CosmosSystem[] = [
  {
    id: 'policy-os',
    name: 'PolicyOS',
    role: 'WHAT IS ALLOWED',
    simpleMeaning: 'WHAT IS ALLOWED',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'INFRASTRUCTURE MODULE',
    summary: 'Permissions, safety rules, approvals, budgets, model/tool access.',
    purpose: ['Enforce safety boundaries', 'Budget capping per tenant', 'Approval flows for privileged operations'],
    capabilities: ['Dynamic policy compilation', 'Cryptographic access tokens', 'Pre-flight safety inspection'],
    category: 'governance'
  },
  {
    id: 'identity-os',
    name: 'IdentityOS',
    role: 'WHO ARE YOU',
    simpleMeaning: 'WHO ARE YOU',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'INFRASTRUCTURE MODULE',
    summary: 'Users, organizations, tenants, roles, API keys, service identities.',
    purpose: ['Machine-to-machine mutual TLS & auth', 'Tenant boundary enforcement', 'Service account role delegation'],
    capabilities: ['SPIFFE/mTLS integration', 'Fine-grained RBAC', 'Ephemeral agent credentialing'],
    category: 'governance'
  },
  {
    id: 'trust-os',
    name: 'TrustOS',
    role: 'WHAT SHOULD WE TRUST',
    simpleMeaning: 'WHAT SHOULD WE TRUST',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'INFRASTRUCTURE MODULE',
    summary: 'Empirical trust/reliability of agents, models, tools, data sources and systems.',
    purpose: ['Dynamic source credibility scoring', 'Hallucination rate tracking per provider', 'Agent reliability indices'],
    capabilities: ['Empirical trust telemetry', 'Reputation scoring', 'Degraded source dampening'],
    category: 'governance'
  },
  {
    id: 'execution-os',
    name: 'ExecutionOS',
    role: 'RUN SAFELY',
    simpleMeaning: 'RUN SAFELY',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'INFRASTRUCTURE MODULE',
    summary: 'Secure code, browser, sandbox, container and workload execution.',
    purpose: ['Zero-leak sandboxed code runners', 'Ephemeral headless browser environments', 'gVisor & Firecracker micro-VM isolation'],
    capabilities: ['Micro-VM containerization', 'Egress network controls', 'Deterministic teardown'],
    category: 'governance'
  },
  {
    id: 'automation-os',
    name: 'AutomationOS',
    role: 'DO IT LATER / REPEATEDLY',
    simpleMeaning: 'DO IT LATER / REPEATEDLY',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'INFRASTRUCTURE MODULE',
    summary: 'Scheduled jobs, triggers, recurring work, webhooks, condition-based actions.',
    purpose: ['Cron-like distributed triggers', 'Event-driven webhooks', 'Condition evaluation loops'],
    capabilities: ['Reliable task scheduler', 'Deduplication guarantees', 'Backpressure-aware dispatch'],
    category: 'governance'
  },
  {
    id: 'workflow-os',
    name: 'WorkflowOS',
    role: 'RUN PROCESSES',
    simpleMeaning: 'RUN PROCESSES',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'INFRASTRUCTURE MODULE',
    summary: 'Long-running workflows involving agents, APIs, humans, approvals and business systems.',
    purpose: ['Human-in-the-loop pause gates', 'Multi-day resilient execution states', 'ERP/CRM process orchestration'],
    capabilities: ['Stateful workflow machines', 'Human escalation queues', 'Audit replay mechanisms'],
    category: 'governance'
  },
  {
    id: 'data-os',
    name: 'DataOS',
    role: 'WORK WITH DATA',
    simpleMeaning: 'WORK WITH DATA',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'INFRASTRUCTURE MODULE',
    summary: 'Structured datasets, SQL, transformations, analytics, warehouses and data quality.',
    purpose: ['Schema validation and normalization', 'DuckDB/ClickHouse embedded query layer', 'Automated data drift monitoring'],
    capabilities: ['Federated query engine', 'Schema migration safety', 'Data lineage tracking'],
    category: 'governance'
  },
  {
    id: 'artifact-os',
    name: 'ArtifactOS',
    role: 'STORE OUTPUTS',
    simpleMeaning: 'STORE OUTPUTS',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'INFRASTRUCTURE MODULE',
    summary: 'Reports, datasets, code, charts, files, research outputs and generated artifacts.',
    purpose: ['Immutable content-addressed artifact store', 'Diff engine for generated code & papers', 'Asset lifecycle management'],
    capabilities: ['Content-addressable storage (CAS)', 'Artifact version history', 'Signed export bundles'],
    category: 'governance'
  },
  {
    id: 'observe-os',
    name: 'ObserveOS',
    role: 'OBSERVE',
    simpleMeaning: 'OBSERVE',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'INFRASTRUCTURE MODULE',
    summary: 'Logs, traces, events, system activity, latency, failures and execution visibility.',
    purpose: ['OpenTelemetry native distributed tracing', 'Per-step agent decision logs', 'Real-time bottleneck detection'],
    capabilities: ['Distributed trace viewer', 'Flamegraphs for agent runs', 'Structured audit streams'],
    category: 'governance'
  },
  {
    id: 'reliability-os',
    name: 'ReliabilityOS',
    role: 'STAY ALIVE',
    simpleMeaning: 'STAY ALIVE',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'INFRASTRUCTURE MODULE',
    summary: 'Health, failover, retries, rate limits, circuit breakers and graceful degradation.',
    purpose: ['Global circuit breaker mesh', 'Graceful intelligence degradation fallback', 'Adaptive backoff & queue management'],
    capabilities: ['Chaos-tested circuit breakers', 'Adaptive rate limiting', 'Automated health pings'],
    category: 'governance'
  },
  {
    id: 'cost-os',
    name: 'CostOS',
    role: 'CONTROL COST',
    simpleMeaning: 'CONTROL COST',
    status: 'ROADMAP_FUTURE',
    statusLabel: 'INFRASTRUCTURE MODULE',
    summary: 'Compute, model, storage, API and workflow cost measurement and optimization.',
    purpose: ['Per-tenant token and compute billing', 'Real-time budget circuit breaking', 'Cost vs quality frontier recommendation'],
    capabilities: ['Sub-cent ledger allocation', 'Budget ceiling triggers', 'Provider cost arbitrage'],
    category: 'governance'
  }
];

export const PRINCIPLES = [
  {
    number: '01',
    title: 'Specialized systems over one giant agent.',
    explanation: 'General-purpose monolithic agents accumulate hidden state, brittle failure cascades, and unobservable hallucinations. Cosmos partitions intelligence into distinct operating systems with explicit boundaries.'
  },
  {
    number: '02',
    title: 'Evidence over confident language.',
    explanation: 'Fluent generation is not verification. Every substantive claim must retain auditable evidentiary citations, contradictory evidence detection, and calibrated uncertainty.'
  },
  {
    number: '03',
    title: 'Explicit contracts over hidden wiring.',
    explanation: 'Intelligence layers must interface via type-safe, inspectable protocols. When an agent delegates to research or tools, the contract is formal, auditable, and enforceable.'
  },
  {
    number: '04',
    title: 'Measurement before improvement.',
    explanation: 'Changes to models, prompts, or agents mean nothing without empirical regression detection. EvalOS verifies performance baselines before accepting any modification.'
  },
  {
    number: '05',
    title: 'Memory with provenance.',
    explanation: 'Unchecked memory poisoning degrades intelligence. Retained context must record its origin, timestamp, empirical reliability score, and explicit eviction criteria.'
  },
  {
    number: '06',
    title: 'Capabilities with permissions.',
    explanation: 'Autonomous agency without deterministic boundary enforcement is dangerous. Every action, tool invocation, and resource access must execute under explicit policy controls.'
  },
  {
    number: '07',
    title: 'Models are replaceable infrastructure.',
    explanation: 'Foundational models are commodities. Cosmos abstracts providers through ModelOS so applications never bind their architecture to a single vendor or API.'
  },
  {
    number: '08',
    title: 'Failure should be observable.',
    explanation: 'When multi-step execution fails, it must fail legibly with pause-and-resume checkpoints, full DAG execution logs, and root-cause isolation.'
  },
  {
    number: '09',
    title: 'Intelligence should degrade honestly.',
    explanation: 'When models or context fall short, the system must clearly signal limitations rather than hallucinating plausibility. Honest uncertainty is a core capability.'
  },
  {
    number: '10',
    title: 'Every autonomous action should remain accountable.',
    explanation: 'From enterprise database queries to code execution in sandboxes, side effects require cryptographically signed audit logs and reproducible execution traces.'
  }
];

export const REQUEST_FLOW_STEPS: RequestFlowStep[] = [
  {
    id: 1,
    stage: 'INTENT RESOLUTION',
    source: 'User Query',
    target: 'Cosmos Core',
    action: 'Parse & Route',
    detail: 'User submits: "Research whether my company should enter the European EV battery market."',
    payload: '{ intent: "STRATEGIC_MARKET_ENTRY", domain: "EV_BATTERY_EU", depth: "EXHAUSTIVE", policy: "ENTERPRISE_CONFIDENTIAL" }',
    activeNodes: ['cosmos-core']
  },
  {
    id: 2,
    stage: 'SUBSYSTEM DISPATCH',
    source: 'Cosmos Core',
    target: 'ResearchOS',
    action: 'Initialize Research Project',
    detail: 'Cosmos Core verifies governance policies, assigns budget envelope, and dispatches project definition to ResearchOS.',
    payload: '{ project_id: "res_eu_ev_904", hypotheses: ["RAW_MATERIAL_SUPPLY", "REGULATORY_CBAM", "OEM_OVERSUPPLY"] }',
    activeNodes: ['cosmos-core', 'research-os']
  },
  {
    id: 3,
    stage: 'WORKFORCE DELEGATION',
    source: 'ResearchOS',
    target: 'AgentOS',
    action: 'Request Specialist Agents',
    detail: 'ResearchOS generates task graph and delegates workforce orchestration to AgentOS for parallel domain investigation.',
    payload: 'AgentOS.spawnGraph({ roles: ["Market Analyst", "Competitor Specialist", "EU Regulatory Auditor", "Adversarial Critic"] })',
    activeNodes: ['research-os', 'agent-os']
  },
  {
    id: 4,
    stage: 'TOOL EXECUTION & MCP',
    source: 'AgentOS Workers',
    target: 'ToolOS',
    action: 'Execute Controlled Actions',
    detail: 'Specialist agents access European Commission regulatory filings, trade tariff databases, and OEM supply manifests via ToolOS sandboxes.',
    payload: 'ToolOS.invoke("mcp://eu_tariffs/cbam_query", { sector: "lithium_ion", date_range: "2024-2030" }) [PERMISSION_ALLOWED]',
    activeNodes: ['agent-os', 'tool-os']
  },
  {
    id: 5,
    stage: 'MODEL ARBITRATION',
    source: 'Agents & ToolOS',
    target: 'ModelOS',
    action: 'Route Optimal Brains',
    detail: 'ModelOS dynamically routes quantitative data extraction to high-throughput models and adversarial critique to deep reasoning models.',
    payload: 'ModelOS.route({ task: "CRITIQUE_CONTRADICTIONS", provider_preference: "REASONING_OPTIMAL", latency_ceiling_ms: 3200 })',
    activeNodes: ['tool-os', 'model-os']
  },
  {
    id: 6,
    stage: 'HISTORICAL RECALL',
    source: 'ResearchOS',
    target: 'MemoryOS',
    action: 'Retrieve Project Memory',
    detail: 'Retrieves prior organizational learnings on automotive supply chain risks and historical battery cell manufacturing margins.',
    payload: 'MemoryOS.recall({ query: "automotive battery cell margin volatility 2021-2025", scope: "ENTERPRISE_VAULT" })',
    activeNodes: ['research-os', 'memory-os']
  },
  {
    id: 7,
    stage: 'SYNTHESIS & CONTRADICTIONS',
    source: 'ResearchOS',
    target: 'ResearchOS Engine',
    action: 'Construct Verified Claim Graph',
    detail: 'ResearchOS aggregates 142 source documents, validates 28 core claims, and exposes 4 direct contradictions regarding EU gigafactory overcapacity.',
    payload: '{ claims: 28, verified_sources: 142, contradictions_isolated: 4, confidence_index: 0.884 }',
    activeNodes: ['research-os']
  },
  {
    id: 8,
    stage: 'QUALITY GATE EVALUATION',
    source: 'ResearchOS',
    target: 'EvalOS',
    action: 'Enforce Quality Gate',
    detail: 'EvalOS audits synthesis against truthfulness benchmarks, fact-checking gates, and citation coverage rules before release.',
    payload: 'EvalOS.enforceGate({ benchmark: "ENTERPRISE_RESEARCH_v2", score: 96.4, citation_coverage: 1.0, verdict: "PASS" })',
    activeNodes: ['research-os', 'eval-os']
  },
  {
    id: 9,
    stage: 'FINAL COHERENT DELIVERY',
    source: 'EvalOS & Cosmos Core',
    target: 'User Decision Interface',
    action: 'Deliver Evidence-Backed Result',
    detail: 'Cosmos returns an audit-grade, defensible strategic intelligence report with complete claim provenance and contradiction map.',
    payload: 'OUTPUT: Strategic Market Entry Analysis [Verified Evidence: 100%, Contradictions Mapped: 4, Gate Status: CERTIFIED]',
    activeNodes: ['cosmos-core', 'eval-os']
  }
];

export const RESEARCH_WORKFLOW_STEPS = [
  { step: '01', name: 'Question', desc: 'Precise intent decomposition and hypothesis framing' },
  { step: '02', name: 'Plan', desc: 'Dynamic DAG generation of investigation tracks' },
  { step: '03', name: 'Discover', desc: 'Federated source discovery across academic, regulatory & web indexes' },
  { step: '04', name: 'Ingest Sources', desc: 'Full-text retrieval and content-addressed immutable storage' },
  { step: '05', name: 'Extract Evidence', desc: 'Micro-fragment extraction with exact offsets and context preservation' },
  { step: '06', name: 'Extract Claims', desc: 'Atomic proposition isolation from raw narrative sources' },
  { step: '07', name: 'Verify', desc: 'Cross-document cross-examination and primary citation validation' },
  { step: '08', name: 'Detect Contradictions', desc: 'Adversarial pairing of conflicting evidence statements' },
  { step: '09', name: 'Critique', desc: 'Red-team challenger agents probe methodological assumptions' },
  { step: '10', name: 'Debate', desc: 'Multi-perspective structured thesis vs antithesis rounds' },
  { step: '11', name: 'Generate Hypotheses', desc: 'Synthesizing coherent explanatory models from vetted facts' },
  { step: '12', name: 'Experiments', desc: 'Data simulation, scenario stress-testing, and calculation checking' },
  { step: '13', name: 'Research Evolution', desc: 'Iterative revision tracking preserving evolutionary ancestry' },
  { step: '14', name: 'Report', desc: 'Hierarchical, defensible report with full interactive citation anchors' },
  { step: '15', name: 'Evaluate', desc: 'Final EvalOS quality gate audit before external distribution' }
];

export const SAMPLE_CLAIM_GRAPH: ClaimNode[] = [
  {
    id: 'claim-1',
    text: 'EU Gigafactory planned capacity will exceed regional electric vehicle demand by 28% by 2030.',
    confidence: 0.82,
    status: 'supported',
    evidence: [
      {
        id: 'ev-101',
        title: 'European Battery Alliance Annual Forecast 2025',
        source: 'EBA Official Monitor §4.2',
        type: 'regulatory',
        quote: 'Aggregated announced cell manufacturing capacity across EU27 reaches 1,150 GWh/year by 2030 against projected peak adoption demand of 895 GWh.',
        date: 'Oct 2025'
      },
      {
        id: 'ev-102',
        title: 'BloombergNEF Cell Manufacturing Outlook',
        source: 'BNEF Tier-1 Dataset Q3',
        type: 'financial',
        quote: 'European localization quotas accelerate CAPEX commitments, pointing to supply overhang if EV penetration plateaus below 65%.',
        date: 'Nov 2025'
      },
      {
        id: 'ev-103',
        title: 'McKinsey Automotive Supply Disruption Audit',
        source: 'Advanced Industries Bulletin',
        type: 'critical',
        contradicts: true,
        quote: 'Over 35% of announced EU gigafactory projects face indefinite delays or capital reallocations, suggesting real operational yield will trail nominal capacity.',
        date: 'Jan 2026'
      }
    ]
  },
  {
    id: 'claim-2',
    text: 'CBAM (Carbon Border Adjustment Mechanism) tariffs create a +14% cost advantage for localized EU cathode production.',
    confidence: 0.94,
    status: 'supported',
    evidence: [
      {
        id: 'ev-201',
        title: 'EU Regulation 2023/956 Tariff Schedule',
        source: 'Official Journal of the European Union',
        type: 'regulatory',
        quote: 'Embodied carbon reporting thresholds for imported active battery materials incur scope-3 emissions surcharges starting 2026.',
        date: 'Aug 2025'
      },
      {
        id: 'ev-202',
        title: 'Fraunhofer Battery Supply Chain Techno-Economic Model',
        source: 'Fraunhofer ISI Research Memo',
        type: 'empirical',
        quote: 'Grid carbon intensity differences yield average landed tariff penalties of €11.40/kWh on overseas imports.',
        date: 'Dec 2025'
      }
    ]
  },
  {
    id: 'claim-3',
    text: 'Sodium-ion chemistry will displace LFP in European urban compacts before 2029.',
    confidence: 0.46,
    status: 'contradicted',
    evidence: [
      {
        id: 'ev-301',
        title: 'CATL Gen-2 Na-Ion Cell Verification Trials',
        source: 'Automotive Engineering Archive',
        type: 'empirical',
        quote: 'Energy density of 160 Wh/kg meets urban A-segment targets with superior low-temperature performance (-20C).',
        date: 'Sep 2025'
      },
      {
        id: 'ev-302',
        title: 'European OEM Chemistry Adoption Roadmap 2025-2030',
        source: 'ACEA Supply Advisory Report',
        type: 'critical',
        contradicts: true,
        quote: 'OEM vehicle platforms slated for 2026-2028 production freeze chemistry specifications on Gen-3 LFP cells to preserve safety certification schedules.',
        date: 'Feb 2026'
      }
    ]
  }
];

export const APPLICATION_PATTERNS = [
  {
    id: 'research-product',
    title: 'Research & Intelligence Product',
    tag: 'DEEP INVESTIGATION',
    description: 'Autonomous research workflows, rigorous claim extraction, evidence cross-checking, and publishable strategic dossiers.',
    activeSystems: ['ResearchOS', 'ModelOS', 'ToolOS', 'ArtifactOS', 'EvalOS'],
    sampleUse: 'Investment thesis validation, pharmaceutical prior-art search, regulatory compliance audits'
  },
  {
    id: 'automation-product',
    title: 'Autonomous Operations Platform',
    tag: 'EXECUTION & MCP',
    description: 'Long-running worker orchestration, task DAG supervision, failure recovery, and audited external tool interactions.',
    activeSystems: ['AgentOS', 'ToolOS', 'MemoryOS', 'ExecutionOS', 'ObserveOS'],
    sampleUse: 'Incident triage and remediation, customer operations DAGs, cross-software migration pipelines'
  },
  {
    id: 'enterprise-copilot',
    title: 'Enterprise Coordinated Intelligence',
    tag: 'FULL SUBSYSTEM MESH',
    description: 'The complete coordinated stack uniting reasoning, deep institutional memory, security policy boundaries, and live tool agency.',
    activeSystems: ['Cosmos Core', 'ResearchOS', 'AgentOS', 'ToolOS', 'MemoryOS', 'ModelOS', 'EvalOS', 'PolicyOS', 'IdentityOS'],
    sampleUse: 'Board-level decision support, executive briefing systems, complex enterprise problem solving'
  },
  {
    id: 'developer-platform',
    title: 'Developer Intelligence Substrate',
    tag: 'HEADLESS API & SDK',
    description: 'Embed specialized AI operating systems directly into custom products via type-safe TypeScript/Python client libraries.',
    activeSystems: ['ModelOS', 'ToolOS', 'AgentOS', 'EvalOS', 'TrustOS'],
    sampleUse: 'Custom IDE agents, testing regression bots, programmatic research microservices'
  }
];

export const ROADMAP_LAYERS = [
  {
    layer: 1,
    name: 'Layer 01 — Foundation',
    statusTag: 'CURRENT FOUNDATION',
    statusColor: 'emerald',
    description: 'The core operational modules currently certified or in advanced release testing.',
    systems: ['ToolOS', 'AgentOS', 'ResearchOS', 'EvalOS']
  },
  {
    layer: 2,
    name: 'Layer 02 — Next Subsystems',
    statusTag: 'NEXT / IN DEVELOPMENT',
    statusColor: 'blue',
    description: 'Central orchestration, persistence, provider abstraction, and bounded execution environments.',
    systems: ['MemoryOS', 'ModelOS', 'Cosmos Core', 'ContextOS', 'PlanningOS', 'ExecutionOS']
  },
  {
    layer: 3,
    name: 'Layer 03 — Frontier Modules',
    statusTag: 'FRONTIER RESEARCH',
    statusColor: 'indigo',
    description: 'High-order cognition, formal reasoning graphs, durable knowledge ontologies, and world modeling.',
    systems: ['ReasoningOS', 'KnowledgeOS', 'SkillOS', 'WorldModelOS', 'GoalOS', 'DecisionOS']
  },
  {
    layer: 4,
    name: 'Layer 04 — Long-Term Intelligence',
    statusTag: 'LONG-TERM ROADMAP',
    statusColor: 'violet',
    description: 'Empirical trust, historical learning, self-review, and gated evolutionary adaptation.',
    systems: ['ReflectionOS', 'LearningOS', 'EvolutionOS', 'TrustOS']
  }
];
