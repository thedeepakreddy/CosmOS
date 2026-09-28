# Cosmos Master Plan

**Status:** reconstructed 2026-09-15 from `Cosmos_Intelligence_Stack_Guide.pdf`
plus a direct read of the four existing repositories.

---

## 1. What Cosmos is

Cosmos is a modular intelligence platform: a set of independently useful systems
with clear responsibility boundaries, coordinated by a thin central layer, so
that products (Aira, Echo, enterprise apps, research tools) get frontier
behaviour without each one reimplementing memory, tools, models, evaluation and
orchestration.

The one-line test for whether something belongs in Cosmos: *would two unrelated
products both need this, and would it be a mistake for each of them to build it
themselves?*

## 2. The strategic decision that drives everything

This is the most important conclusion from reading the actual code, and it is
not in the PDF.

**ResearchOS already contains working implementations of most of the "missing"
OSes.** It ships, as internal packages, a memory substrate, a model router with
retry and fallback and circuit breaking, a permission-checked tool registry, an
evaluation rubric engine, a durable orchestration queue with leases and
budgets, and an external executor seam. These are not sketches. The README
claims 454 passing tests and the architecture graph is machine-enforced.

More importantly, ResearchOS was written in anticipation of this. Its memory
port carries the comment: *"a shared memory service is intended to satisfy it
later, so nothing here names a research concept that a general memory system
could not represent."* The seam for MemoryOS was cut before MemoryOS existed.

So the build strategy is **extraction, not greenfield**:

> MemoryOS and ModelOS are not new systems to invent. They are ResearchOS
> packages promoted to standalone services behind ports that already exist, and
> ResearchOS becomes their first real consumer on day one.

This changes the plan materially:

- The risk profile drops. You are hardening code that already passes tests, not
  writing new code against an imagined interface.
- The integration is proved immediately. A new MemoryOS that cannot swap in
  behind `MemoryProvider` and keep the ResearchOS suite green is not finished.
- The specification is free. `packages/contracts/src/memory.ts` and
  `packages/model-router/src/provider.ts` are the specs.
- You get a second consumer test for free. Once MemoryOS serves both ResearchOS
  and AgentOS, the abstraction is real rather than theoretical.

## 3. The rule that stops this collapsing under its own weight

The guide names roughly thirty operating systems. One person cannot run thirty
services, and most of them should never become services.

**Promotion rule.** A capability becomes a standalone OS (its own repo, process,
API, database) only when all three of these are true:

1. **Two independent consumers.** Two systems that do not depend on each other
   both need it. One consumer means it is a module in that consumer.
2. **Its own durable state.** It owns data whose lifetime is longer than any
   single caller's run. A pure function never earns a service.
3. **A stable contract that has survived a change.** The interface has already
   absorbed at least one real requirement change without breaking callers.

Until all three hold, the capability stays an internal module, and that is the
correct outcome, not a compromise. ContextOS, PlanningOS, PolicyOS, ObserveOS,
CostOS and most of the frontier layer should begin life as modules inside the
system that needs them.

Against this rule, today's promoted set is: ToolOS, AgentOS, ResearchOS, EvalOS,
and soon MemoryOS and ModelOS. That is six services, which one person can hold
in their head. Everything else waits for evidence.

## 4. Architecture rules to protect

These come from the guide and are reinforced by what the repos already do well.
Breaking one of these is the failure mode that ends the project.

1. **Each OS stays independently testable, versioned and runnable.** Cosmos Core
   coordinates. It never absorbs another system's code.
2. **Integrate through published contracts, never through sibling source
   imports.** No `../../ResearchOS/packages/...` anywhere, ever.
3. **Existence is not evidence.** A file, a class or a type does not make a
   feature real. `VERIFIED` means wiring plus an observed execution. ResearchOS
   and EvalOS already hold this line, and it is the single best habit in the
   codebase. Keep it.
4. **Provenance is not optional.** Decisions, claims, memories and learned
   strategies carry traceable origin. A model-generated statement never gets to
   look like a source-derived fact.
5. **EvalOS is the gate, and nothing self-promotes.** Improvements are proposed,
   tested and approved. No system changes production behaviour on its own
   judgement.
6. **Agents are untrusted.** Every capability call passes a default-deny
   permission check, a budget and an audit record, at the ToolOS boundary.
7. **Honest status in code.** AgentOS already annotates unenforced budget fields
   as "declared but NOT enforced". That habit is worth more than a hundred pages
   of architecture. Extend it everywhere.
8. **Frontier layers come last.** ReasoningOS, WorldModelOS, LearningOS and the
   rest get built when real traces from real workloads demonstrate the need, not
   because the diagram has a box for them.

## 5. What Cosmos looks like when it is working

A request arrives at Cosmos Core. Core classifies intent, asks MemoryOS what is
already known, picks the systems that should handle it, and delegates:
ResearchOS to investigate, AgentOS to coordinate the work, ToolOS to expose
capabilities safely, ModelOS to supply the brain, EvalOS to say whether the
result met the bar. Core assembles the answer and MemoryOS keeps what was worth
keeping.

Nothing in that sentence requires a new OS beyond the six named above. That is
the milestone to aim for: **the six-service vertical slice**, end to end, on one
real question, with a trace you can read.

## 6. Honest risks

- **Scope.** Thirty OSes is a vision, not a plan. The promotion rule in section 3
  is the defence. Re-read it whenever a new OS feels urgent.
- **No live model call has been made from ResearchOS.** Everything is verified
  against a scripted provider. The wiring is proved; model behaviour is not. This
  is the single largest unknown in the project and ModelOS is what closes it.
- **Overlap between ToolOS and the ResearchOS `tools` package.** Two permission
  systems exist. Section 4 of `02-CONTRACTS.md` records the boundary decision.
- **Solo maintenance.** Six services means six dependency trees, six CI stories,
  six upgrade paths. Prefer boring, shared choices: Node, TypeScript, Fastify,
  zod, SQLite. The repos already converge on this. Do not diversify.
- **EvalOS has no adapters to anything.** It is standalone and currently
  evaluates nothing real. Until one other OS sends it traces, it is a
  measurement system with nothing to measure.
