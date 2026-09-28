# Cosmos Roadmap

Ordered by dependency and by risk retired per unit of effort. Every stage has an
**exit test**: a command or an observation that decides whether the stage is
done. A stage without a passing exit test is not done, regardless of how much
code exists.

Estimates assume solo evening and weekend work and are deliberately rough.

---

## Stage 0. Make the work unlosable

**Why first:** ResearchOS has zero commits, EvalOS is not a repository, and
nothing has a remote. Every other stage is worthless if the code disappears.

- [ ] `git init` EvalOS, add a `.gitignore` that excludes `node_modules`, `*.db`, `*.db-wal`, `*.db-shm`, `dist`, `.env`
- [ ] Commit ResearchOS in full. First commit of 20 packages
- [ ] Commit the 48 outstanding AgentOS files
- [ ] Create four private GitHub repos and push all four
- [ ] Remove the committed `durability_test.db`, `evalos.db*` and `*.log` files from EvalOS and ToolOS working trees
- [ ] Add a one-line `RECOVERY.md` to each repo: what it is, how to run it, where the plan lives

**Exit test:** all four repos show a clean `git status` and a pushed remote, and
`git clone` into a scratch directory followed by `npm install && npm test`
succeeds for each.

**Effort:** one evening. Do it now.

---

## Stage 1. One correlation id and one trace shape

**Why here:** cheap now, very expensive later, and it is what makes EvalOS
useful.

- [ ] Define `CorrelationId` and thread it through ToolOS, AgentOS, ResearchOS and EvalOS: accepted on every request, generated when absent, emitted on every log line and event, returned on every response
- [ ] Define `TraceEnvelope` in this repo, derived from AgentOS `AgentEvent` and ResearchOS observability output rather than invented fresh
- [ ] Give EvalOS a trace ingestion endpoint that accepts `TraceEnvelope`
- [ ] Wire ONE producer: AgentOS run events to EvalOS

**Exit test:** start an AgentOS run, then find every event of that run in EvalOS
by correlation id alone.

**Effort:** a weekend.

**Payoff:** EvalOS stops being a measurement system with nothing to measure, and
cross-service debugging stops being guesswork.

---

## Stage 2. Attach AgentOS to ToolOS and make budgets real

**Why here:** AgentOS coordinates work that nothing performs. This is the
largest gap between what the architecture promises and what runs.

- [ ] Implement an `AgentExecutor` that calls ToolOS over HTTP through the ToolOS SDK
- [ ] Propagate caller identity from `AgentDefinition.toolPermissions` into the ToolOS `AuthorizationRequest`
- [ ] Enforce `maxToolCalls` at that executor boundary, and change the source comment in `ExecutionBudgetSchema` from "declared but NOT enforced" to enforced for that field only
- [ ] Add ToolOS registry persistence so capabilities survive a restart

**Exit test:** an AgentOS run executes a real ToolOS tool, a second run with
`maxToolCalls: 1` is stopped at the budget, and both are visible in EvalOS by
correlation id.

**Effort:** one to two weekends.

---

## Stage 3. MemoryOS by extraction

**Why here:** the port already exists, ResearchOS is a waiting first consumer,
and AgentOS is a waiting second consumer, which is what satisfies the promotion
rule.

Full spec: [`specs/MEMORYOS_SPEC.md`](specs/MEMORYOS_SPEC.md).

**Exit test, and it is a strict one:** ResearchOS runs its entire existing test
suite green with its SQL memory adapter replaced by an HTTP adapter pointing at
MemoryOS, with no change to any ResearchOS package other than the composition
root.

**Effort:** two to three weekends. Most of it is the service shell, migrations
and the HTTP adapter, not new logic.

---

## Stage 4. ModelOS by extraction, and the first live model call

**Why here:** this retires the single largest unknown in the project. Nothing in
ResearchOS has ever spoken to a real model.

Full spec: [`specs/MODELOS_SPEC.md`](specs/MODELOS_SPEC.md).

**Exit test:** one ResearchOS research project completes end to end against a
live model through ModelOS, producing a report with real citations, and its
`ModelCallRecord` ledger shows real token counts and real cost.

**Effort:** two to three weekends, plus whatever the prompts need once a real
model is finally looking at them. Budget for that second part honestly, because
it is where the surprises are.

**Note:** expect the prompts to be worse than the wiring. That is normal and it
is exactly why EvalOS exists.

---

## Stage 5. Give ResearchOS something to research

**Why here:** with a live model but no search, the research engine reasons about
nothing.

- [ ] Add a search capability to ToolOS: one provider first, Brave or Tavily or SerpAPI
- [ ] Add a ToolOS-backed `ResearchTool` adapter in ResearchOS, per the boundary decision in `02-CONTRACTS.md` section 4
- [ ] Build an EvalOS suite of ten research questions with known-good answers
- [ ] Record a baseline

**Exit test:** a research project answers a question using live search and live
models, EvalOS scores the report, and the score is stored as the baseline every
future change is compared against.

**Effort:** one to two weekends.

**This is the milestone that makes Cosmos real.** Everything before it is
infrastructure. This is the first time the system does the thing it exists to
do, and measurably.

---

## Stage 6. Cosmos Core

**Why here, and not earlier:** Core routes between systems. Routing between two
unattached systems is a demo. With stages 1 to 5 done there are five real
services with real contracts and real traces, and Core has something to
coordinate.

Full spec: [`specs/COSMOS_CORE_SPEC.md`](specs/COSMOS_CORE_SPEC.md).

**Exit test:** a single HTTP call to Cosmos Core with a natural-language goal is
routed, executed across at least three OSes, and returns an assembled result
with one correlation id covering the whole trace.

**Effort:** two weekends for the thin version. Resist every impulse to make it
thick.

---

## Stage 7. Safe execution

- [ ] ExecutionOS as a sandbox: container lifecycle, CPU, memory and time limits, filesystem and network policy
- [ ] Replace `LocalProcessRunner` in ResearchOS experiments with it
- [ ] Expose it through ToolOS as a capability

**Exit test:** a model-written script runs, cannot reach the network or the
filesystem outside its sandbox, is killed at its limits, and its artifacts are
captured.

**Trigger:** do this before any model-written code runs unattended. Not before.

---

## Stage 8 and beyond. Earn the frontier

PlanningOS, ContextOS, KnowledgeOS, ReasoningOS, SkillOS, ReflectionOS,
LearningOS, EvolutionOS and the rest stay deferred until the promotion rule is
satisfied. By stage 7 there will be real traces, real failures and real
workloads, and those will say which one is actually needed. That answer will be
better than any guess made today.

The one prediction worth writing down: **ContextOS will earn promotion first**,
because as soon as MemoryOS, KnowledgeOS-style facts and live research evidence
compete for one token budget, something has to arbitrate, and it will be ugly
inside any single consumer.

---

## Sequencing summary

```
Stage 0  safety net          one evening      unblocks everything
Stage 1  correlation + trace  one weekend      makes debugging and EvalOS possible
Stage 2  AgentOS to ToolOS    1-2 weekends     agents can finally act
Stage 3  MemoryOS             2-3 weekends     shared memory, two consumers
Stage 4  ModelOS + live call  2-3 weekends     retires the largest unknown
Stage 5  search + baseline    1-2 weekends     Cosmos does its job, measurably
Stage 6  Cosmos Core          2 weekends       one platform, not five projects
Stage 7  ExecutionOS          as needed        before autonomous code execution
```

Roughly three to four months of part-time work to a real, measured,
coordinated platform. Every stage leaves the system more useful than it found
it, and no stage depends on a system that does not exist yet.
