# AgentOS — PHASE A/B DELTA VERIFICATION AUDIT

## Why this prompt exists

The AgentOS Frontier Readiness Audit scored the repository 3.4/10 and recorded
six P0 and six P1 findings. **That audit is now stale.** The working tree has
since changed substantially and appears to already contain remediation for most
of those findings. Version is `0.2.0-phase-a`. There are 53 uncommitted files.

Issuing a "Phase A" repair task now would cause rework or conflict with work
already in the tree.

**This task therefore determines what is actually fixed, what is partially
fixed, and what remains open, before any further repair work is authorised.**

Repository under audit:

```
/Users/thedeepakreddy/AgentOS
```

---

## TASK MODE: REPORT ONLY

DO NOT:

- edit any file under `src/`, `tests/`, `docs/`
- fix any finding, even a trivial one
- refactor, rename, reformat or "tidy" anything
- change `package.json`, `tsconfig*.json`, migrations or schemas
- add tests to the repository
- run `git add`, `commit`, `tag`, `push`, `branch`, `stash`, or alter history
- move, delete or re-point the existing `agentos-v0.1.0-mvp-certified` tag
- touch ToolOS, ResearchOS, EvalOS, MemoryOS, ModelOS, Cosmos, Echo or Aira

ONE permitted exception, which must be reported:

> `npm test` currently fails to start with `Cannot find native binding` from
> `rolldown`, a broken optional-dependency install. You MAY repair
> `node_modules` (for example `rm -rf node_modules && npm install`) because
> `node_modules` is gitignored and the suite cannot otherwise run. You MAY NOT
> change `package.json` or `package-lock.json` to achieve this. If the suite
> still cannot run without a manifest change, STOP and report that.

Temporary harnesses go in `/tmp/agentos-delta/` only. Never inside the repo.

---

## EVIDENCE STANDARD

Use only: `VERIFIED`, `PARTIALLY_VERIFIED`, `IMPLEMENTED_BUT_UNVERIFIED`,
`BLOCKED`, `NOT_FOUND`, `FAILED`, `DEFERRED`.

**NO EVIDENCE = NOT VERIFIED.**

Specifically, and this matters more than usual here:

- A migration file existing does not prove the schema changed at runtime
- A `claim-protocol.test.ts` existing does not prove a claim protocol works
- A test name matching a finding does not prove the finding is fixed
- A passing test does not prove the test would fail if the fix were removed

The previous audit found that `tests/resumability.node.js` ended with
`.catch(console.error)` and therefore exited 0 even when it failed. Assume other
tests may be similarly incapable of failing until you check.

**Where practical, prove a fix by breaking it:** temporarily revert the fix in a
copy under `/tmp/agentos-delta/`, confirm the test then fails, and restore.
A test that passes both with and without the fix proves nothing.

---

## PHASE 0 — STATE CAPTURE

Record and report, without changing any of it:

```
pwd
git status --short | wc -l
git branch --show-current
git log --oneline -3
git tag --list
git tag --points-at HEAD
node --version
npm --version
```

Report the count of modified, added and untracked files separately.

---

## PHASE 1 — DELTA VERIFICATION AGAINST THE TWELVE FINDINGS

For **each** finding below, report:

```
FINDING:
STATUS:            one of the evidence-standard values
IMPLEMENTATION:    the file and line where the fix lives, or NOT_FOUND
RUNTIME EVIDENCE:  the command run and what was observed
FAILS WITHOUT FIX: YES / NO / NOT_TESTED
RESIDUAL RISK:
```

### P0 findings

**1. Task IDs globally scoped.** The original audit submitted task `T1` to two
different runs and watched one run overwrite the other's data, after which the
second run reported COMPLETED having executed none of its work.
Expected remediation: `src/db/migrations/003_task_identity_and_ownership.sql`
declaring `PRIMARY KEY (run_id, task_id)`.
**Reproduce the original failure exactly.** Two runs, both submitting `T1`.
Report whether the collision still occurs.

**2. Duplicate task IDs accepted within one graph.** Submit a graph containing
two tasks with the same id. Report whether it is rejected, and with what error.

**3. No claim / lease / ownership protocol.** Expected remediation: `ownerId`,
`leaseExpiresAt`, `fence`, `attempt`, `notBefore` on `Task`, plus `ClaimTicket`,
`ClaimOptions` and `TaskCompletion` in `src/persistence/contracts.ts`.
Verify with **genuinely separate OS processes**, PID evidence required:
- two processes, same database, same run, 8 tasks
- the original audit observed **11 executions for 8 tasks**
- report the actual execution count now
- verify a stale fence is rejected
- verify a task is reclaimed only when its lease has genuinely expired

**4. Double `startRun` causes double execution.** Call `startRun` twice
concurrently on the same run. Report the execution count per task.

**5. Cancellation is not real.** The original audit found cancelled work
continued and could still become SUCCEEDED. Expected remediation:
`AgentExecutionContext.signal: AbortSignal` in `src/engine/Executor.ts`.
Test with **an executor that deliberately ignores the abort signal**. Determine
whether AgentOS still guarantees correct terminal state, or whether a
late-returning ignored task can overwrite CANCELLED.

**6. No authentication.** Expected remediation: bearer tokens in `src/config.ts`
(`authTokens`, `requireAuth`) enforced in `src/api/server.ts`.
Over **a real TCP socket**, not `fastify.inject`:
- no token, auth disabled
- no token, auth enabled
- wrong token
- valid token
- `AGENTOS_REQUIRE_AUTH=true` with no tokens configured: does startup hard-fail
- confirm which paths are exempt via `isPublic` and whether that exemption is safe
- report whether the token comparison is constant-time, and if not, say so plainly

### P1 findings

**7. Migration race across replicas.** Start several processes against one fresh
database simultaneously. Report crashes, partial migrations, and whether
migration is idempotent and serialized.

**8. Scheduler effectively O(n²).** Benchmark scheduling throughput at 100,
1,000 and 5,000 tasks. Report wall time per stage and whether the curve is
linear or quadratic. Do not claim a fix from a small test.

**9. Timer leak: one timeout handle retained per executed task.** Expected
remediation: `clearTimeout` calls in `src/engine/Supervisor.ts`. Run a long
deterministic workload and report handle counts and RSS over time. Use
conservative wording; do not claim "no leak" from one short run.

**10. Terminal states strand tasks.** The original fuzz left non-terminal tasks
in **33 of 120 randomized runs**. Re-run a comparable randomized DAG fuzz (at
least 120 runs) and report the stranded count. Check these invariants:
- a task executes at most once simultaneously
- terminal states do not resurrect
- dependencies execute before dependents
- a run reaches a terminal state only when its terminal conditions hold
- attempt count never decreases
- completed output never disappears
- cancelled work is never newly scheduled

**11. Budget zero-value semantics.** `ExecutionBudgetSchema` now documents that
`0` means "zero allowed" and only `undefined` means unset. Test `0`, `1`, the
limit, limit+1, negative and very large values for `maxAgents`, `maxTasks` and
`maxRunDurationMs`.
Separately confirm that `maxModelCalls`, `maxToolCalls` and `maxCostUsd` are
**still DECLARED and NOT enforced**, deferred to Phase G. Do not report them as
fixed and do not implement them.

**12. Zod not validating runtime input.** Send wrong types, coercible strings,
extra fields, missing required fields and malformed JSON over real HTTP. Report
what is silently coerced versus rejected.

---

## PHASE 2 — TEST SUITE HONESTY AUDIT

The previous audit found a certification claim resting on a test that could not
fail. Check whether that class of problem remains.

- Confirm `tests/resumability.node.js` now exits non-zero on failure
- Confirm it is reachable from `npm run verify`
- List every test file, its assertion count, and whether it can actually fail
- Identify any test whose assertions are trivially true
- Identify tests that mock the boundary they claim to prove
- Identify any production composition root that instantiates a test double

Report the real numbers: suites, tests, passed, failed, skipped, duration.

---

## PHASE 3 — WHAT REMAINS

List, with evidence:

- findings now `VERIFIED` fixed
- findings `PARTIALLY_VERIFIED`, and precisely what is missing
- findings still open
- **new** defects introduced by the Phase A/B work that the original audit did
  not cover, including anything in `api/errors.ts`, `api/rateLimit.ts`,
  `config.ts`, pagination, or the `RECOVERING` run state
- whether the code as it stands is internally consistent, or whether it is a
  half-finished refactor with two coexisting models

That last point matters. State plainly whether this tree is a coherent v0.2 or a
work-in-progress that should not be judged yet.

---

## PHASE 4 — REVISED SCORECARD

Re-score only the dimensions where evidence has changed. For each, give the old
score, the new score, and the evidence. Do not re-score from impression.

```
Correctness, Reliability, Recovery, Concurrency, Performance,
Architecture, Type safety, Observability, Security,
API quality, Testing discipline, Production readiness
```

Then:

```
PREVIOUS OVERALL:  3.4 / 10
CURRENT OVERALL:   ? / 10
EVIDENCE FOR THE CHANGE:
```

Do not inflate. If the evidence does not support a higher score, say so.

---

## PHASE 5 — NEXT PHASE RECOMMENDATION

Given what is actually fixed, state which phase should run next and why:

- more Phase A/B work, naming exactly what is unfinished
- Phase C, state machines and cancellation hardening
- Phase D, scheduler performance
- something the original roadmap did not anticipate

Recommend one. Justify it from findings, not from the original roadmap order.

Do not begin it.

---

## FINAL REPORT STRUCTURE

```
AGENTOS PHASE A/B DELTA VERIFICATION

1. REPOSITORY STATE
   Path / branch / commits / tags / modified / added / untracked
   node_modules repaired: YES / NO, and how

2. FINDING-BY-FINDING DELTA
   Twelve blocks, in the format specified in Phase 1

3. TEST SUITE HONESTY
   Suites / tests / passed / failed / skipped
   Tests that cannot fail:
   Tests that mock the boundary they claim:
   Production test doubles:

4. NEW DEFECTS FOUND
   Not covered by the original audit

5. TREE COHERENCE
   Coherent v0.2 / half-finished refactor / unsafe mixed state

6. REVISED SCORECARD
   Old vs new, with evidence

7. WHAT REMAINS OPEN
   P0:
   P1:
   P2:

8. RECOMMENDED NEXT PHASE
   With justification

9. ISOLATION PROOF
   AgentOS source modified:      0
   AgentOS tests modified:       0
   AgentOS docs modified:        0
   package.json modified:        NO
   package-lock.json modified:   NO
   Git commit created:           NO
   Git tag changed:              NO
   Git push performed:           NO
   Other repositories modified:  0
   Generated output (dist/, *.tsbuildinfo, node_modules/): reported separately

10. VERDICT
    One of:
      PHASE A/B SUBSTANTIALLY COMPLETE — PROCEED TO NEXT PHASE
      PHASE A/B PARTIALLY COMPLETE — FINISH NAMED ITEMS FIRST
      PHASE A/B UNVERIFIABLE — SUITE CANNOT RUN
      PHASE A/B REGRESSED — NEW P0 INTRODUCED
```

---

## ABSOLUTE FINAL INSTRUCTION

Do not fix anything. Do not commit anything. Do not start the next phase.

Your job is to tell the truth about what changed since the last audit, and
nothing else.

**NO EVIDENCE = NOT VERIFIED.**
