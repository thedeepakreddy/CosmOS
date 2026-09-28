# Cosmos Core Spec

**Simple meaning:** COORDINATE.
**Roadmap stage:** 6.
**Design constraint:** Core is thin. Every feature you are tempted to add to it
belongs in an OS.

---

## 1. What Core is, and the failure mode it must avoid

Core is a router and an assembler. It classifies intent, decides which systems
should handle a request, delegates, and composes the result.

The failure mode is well known and it kills platforms: **Core slowly absorbs the
systems it coordinates.** A little planning logic here because PlanningOS does
not exist yet. A little memory handling there. Six months later Core is the
monolith the whole architecture existed to prevent, and the OSes are libraries.

**The test, applied to every line of Core:** if this logic would be useful to a
product calling an OS directly, it does not belong in Core.

Concretely, Core does not: reason, plan, remember, evaluate, execute tools, or
call models directly. It selects which system does those things, and assembles
what they return.

---

## 2. Why Core comes last

Core routes between systems. Until stages 1 through 5 are done there are not
enough attached systems for routing to be more than a demo. Building Core early
means guessing at contracts that do not exist yet, and every guess becomes
coupling.

By stage 6 there will be five real services, real contracts, and real traces,
and Core's job will be obvious rather than imagined.

---

## 3. Responsibilities

**In scope**

- Intent classification: what kind of work is this
- Capability and service registry: which OSes exist, what they claim, are they healthy
- OS selection and routing
- Cross-OS workflow coordination for requests needing more than one system
- Correlation id issuance and propagation, per `02-CONTRACTS.md`
- Result assembly from multiple OS responses
- Failure and fallback strategy when an OS is down or denies
- Policy enforcement hooks, calling out rather than deciding in
- One developer-facing API and gateway

**Out of scope, permanently**

- Any domain logic belonging to an OS
- Its own model provider code. It calls ModelOS
- Its own memory store. It calls MemoryOS
- Its own tool execution. It calls ToolOS
- Business workflows. That is WorkflowOS, and only if it ever earns promotion

---

## 4. Contracts to define

Both are listed as pending in `02-CONTRACTS.md`.

```ts
interface CosmosIntent {
  goal: string;
  caller: { appId: string; userId?: string; tenantId?: string };
  context?: { sessionId?: string; projectId?: string };
  constraints?: { maxCostUsd?: number; deadlineMs?: number; requiredQuality?: string };
  correlationId: string;
}

interface CosmosCapability {
  osId: string;              // "researchos"
  version: string;
  baseUrl: string;
  intents: string[];         // "investigate", "coordinate-work", "evaluate"
  health: "healthy" | "degraded" | "unavailable";
  contractVersion: string;
}
```

Each OS self-describes through `CosmosCapability` at its `/health` endpoint, so
Core routes from live data rather than hardcoded knowledge of its siblings.

---

## 5. Intent classification, staged honestly

**v0.1: rules.** A keyword and pattern table mapping intent to OS. Boring,
deterministic, debuggable, and good enough for the handful of intents that will
actually exist. Ship this.

**v0.2: model-assisted.** Call ModelOS for classification when the rules do not
match, with the rule table as fallback. Log every model classification so it can
be evaluated.

**v0.3: evaluated.** An EvalOS suite for routing decisions, so classifier
changes are measured rather than assumed.

Do not start at v0.2. A model in the routing path before there is a way to
measure routing quality is how you get a system nobody can debug.

---

## 6. Architecture

Core is small. It does not need 20 packages.

```
cosmos-core/
  src/
    intent/       classification, rules then model-assisted
    registry/     service discovery, health polling, capability cache
    routing/      OS selection, fallback chains
    orchestration/ multi-OS request coordination
    assembly/     result composition
    clients/      generated or hand-written SDK wrappers per OS
    api/          the gateway
    correlation/  id issuance and propagation
```

Every entry under `clients/` is the published SDK of that OS, consumed over
HTTP. No sibling source imports, ever.

---

## 7. The first vertical slice

Do not build all of Core. Build one path end to end and make it real:

> `POST /v1/goals` with `{"goal": "Research X and tell me the risks"}` returns an
> assembled answer, having routed to ResearchOS, which used MemoryOS for prior
> context, ModelOS for the brain and ToolOS for search, with EvalOS scoring the
> result, all under one correlation id.

That single path exercises every system in Cosmos. Once it works, adding a
second intent is straightforward. Before it works, breadth is decoration.

---

## 8. Exit test

A single HTTP call to Core with a natural-language goal is routed, executed
across at least three OSes, and returns an assembled result. Pasting the
correlation id into EvalOS shows the complete trace of what happened, in order,
across every service.

When that works, Cosmos is one platform instead of five projects.
