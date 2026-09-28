# Cosmos Planning Documents

**If you have lost the conversation you were planning in, start here.** These
documents are the system of record for the Cosmos plan. They live in git, not in
a chat transcript, and they are written so that a new session (human or model)
can pick the project up cold.

Read them in this order:

| # | Document | What it answers |
|---|---|---|
| 0 | [00-MASTER-PLAN.md](00-MASTER-PLAN.md) | What Cosmos is, the rules it must not break, and the single strategic decision that drives everything else |
| 1 | [01-OS-LEDGER.md](01-OS-LEDGER.md) | What actually exists in code today, verified against the repos, not against the docs |
| 2 | [02-CONTRACTS.md](02-CONTRACTS.md) | The real interfaces that already exist between systems, and the ones still to be defined |
| 3 | [03-ROADMAP.md](03-ROADMAP.md) | The staged build order with an explicit exit test for every stage |
| 4 | [04-CONTINUATION-LOG.md](04-CONTINUATION-LOG.md) | What each working session changed. Append to this every time |
| 5 | [specs/MEMORYOS_SPEC.md](specs/MEMORYOS_SPEC.md) | Full build spec for the next system |
| 6 | [specs/MODELOS_SPEC.md](specs/MODELOS_SPEC.md) | Full build spec for the system after that |
| 7 | [specs/COSMOS_CORE_SPEC.md](specs/COSMOS_CORE_SPEC.md) | The thin coordinator, specified early so it is not improvised late |

## Source material

The architecture narrative these documents are built on is
`Cosmos_Intelligence_Stack_Guide.pdf` (September 2026). That guide is the vision
layer. These documents are the execution layer: they bind the vision to the code
that exists at `~/ToolOS`, `~/AgentOS`, `~/ResearchOS` and `~/EvalOS`.

Where the guide and the code disagree, the code wins and the ledger records it.

## How to not lose the plan again

1. Every working session appends a dated entry to `04-CONTINUATION-LOG.md`
   before it ends. What changed, what was verified, what is next.
2. Status claims live in `01-OS-LEDGER.md` only, and every claim names the
   command that proves it. Nowhere else asserts status.
3. Interfaces live in `02-CONTRACTS.md`, and it points at the real file that
   defines each one. No interface is described from memory.
4. Commit after every session. A plan that is not committed does not exist.
