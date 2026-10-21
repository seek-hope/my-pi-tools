# Pi goal extension research and design trade-offs

Research date: 2026-10-06. Historical inspection environment: Pi 1.0.4 and Node.js 26.10.0. Current compatibility policy is in [design.md](design.md). This document records pre-interview design inputs, not the subsequently approved product specification.

## Method and limits

Candidates were discovered through npm registry and GitHub repository search. Eight npm latest release archives were downloaded for static README/manifest inspection and selected source review covering continuation, verification, recovery and stagnation. No third-party extension was installed, loaded or executed. Host capabilities were checked against local Pi 1.0.4 docs and declarations.

There is no empirical quality, speed, cost or success-rate ranking, nor a controlled experiment establishing independent audit effectiveness. [sources.json](sources.json) records versions, release artifacts and integrity metadata. Published artifacts can differ from GitHub default branches; these findings refer to the listed releases.

## Compared designs

| Package and inspected version | Useful design | Trade-offs |
| --- | --- | --- |
| [pi-goal 0.1.7](https://www.npmjs.com/package/pi-goal/v/0.1.7), [repository](https://github.com/Michaelliv/pi-goal) | Same-session continuation, pause/resume, token budgets, branch-local state and compact UI | Executor declares completion after prompted self-review; archive still uses the old `@mariozechner` namespace |
| [@recynie/pi-goal 0.2.1](https://github.com/recynie/pi-goal) | Clarification into GoalSpec, subtasks, acceptance criteria, fresh-context workspace verification and repair feedback | One goal per session branch; extra model calls; verifier has bash, so a separate context is not filesystem read-only |
| [pi-goal-x 0.32.3](https://github.com/tmonk/pi-goal-x) | Conversational planning, multiple project goals, task trees, free/strict execution, optional audit and expandable panel | More concepts/configuration; audit can be disabled or explicitly bypassed, so verified completion must be distinguished from user acceptance |
| [pi-goal-list-loop-audit 0.39.12](https://github.com/DraconDev/pi-goal-list-loop-audit) | Single-goal, queue and improvement modes; durable completion claims, independent audit process, recovery and visible state | Larger maintenance scope; peer range excludes Pi 1.0.4; AGPL-3.0-only, so this work borrows ideas without copying implementation |
| [@signalridge/pi-goal 1.4.4](https://github.com/signalridge/pi-extensions/tree/main/packages/pi-goal) | User-input priority, continuation deduplication, stale-ID rejection, distinct pause/block/limit states, branch state and optional queue | Executor still self-reviews; repeated-output detection is heuristic; peer range excludes Pi 1.0.4 |
| [pi-goal-pro 1.3.1](https://github.com/izzzzzi/pi-goal-pro) | Turn limits, criterion evidence fields, stagnation pause and yielding to user input | Output-token-based stagnation can misclassify concise useful work; budget implementation counts output tokens rather than total usage/cost |
| [@astrosheep/pi-goal-next 0.1.12](https://github.com/astrosheep-zero/pi-goal-next) | Cumulative usage survives updates, journaled transitions, revision checks and persistence before continuation | Completion/blocking mainly rely on prompts; runtime revision checks alone are not cross-process transactions |
| [pi-supervisor 0.5.0](https://github.com/tintinweb/pi-supervisor) | Independent drift observer, optional steering and configurable review frequency | Observer has no workspace tools; after five idle steers its prompt permits roughly 80% core completion, unsuitable as strict final acceptance |

## Findings from source inspection

### Evidence records, evidence checks and independent review are distinct

`pi-goal` lets the executor submit complete. `pi-goal-pro` also requires evidence strings for defined criteria, but presence does not establish truth.

`@recynie/pi-goal/src/verifier.ts` creates a fresh in-memory session with the goal, submitted result and workspace tools, disabling ordinary extensions, skills, templates and context files. A result tool is mandatory; missing results, errors and cancellation fail. The release reuses the main model, so independent context does not imply a different model.

`pi-goal-x/extensions/goal-auditor.ts` labels executor summaries as unverified claims and supports audit-model selection. Its `goal-completion.ts` also explicitly supports user acceptance after aborting an audit. The pre-interview recommendation was to distinguish executor claims, mechanical checks, independent audit and user acceptance rather than collapse them into one green status.

### Progress cannot be inferred from output length or tool count alone

`pi-goal-pro/index.ts` uses `extractOutputTokens()` at turn_end for noProgressCount. Concise replies, file reads and long external jobs can distort this signal. `@signalridge/pi-goal/src/safety.ts` fingerprints normalized visible output and counts repetition only without tool calls. That avoids one problem but lets repeated failing tool attempts reset the counter.

A better signal combines task changes, verification outcomes, repeated actions/results and external-job state, first requesting a changed strategy and then pausing. Failed attempts must never lower acceptance criteria. Eliminating a research hypothesis can be useful progress without a code diff.

### Steering does not replace acceptance

The supervisor model client has no tools. `MAX_IDLE_STEERS=5` and the engine's approximately 80% completion suggestion can guide an observer, but are not reproducible acceptance criteria and must not override user requirements. Low-frequency drift review and configurable models can be useful separately from final artifact inspection.

### Lifecycle boundaries determine continuation correctness

Older implementations often schedule continuation from agent_end while the host may still retry, compact or process queued input. Goal-x and signalridge address settled boundaries and stale continuation.

Pi 1.0.4 exposes `agent_before_settle` with outcome, pendingMessages and canContinue and permits entries plus one continuation. `agent_settled` is final notification. Native before-settle continuation should be tested against interruption, queued input and retries rather than copying timer loops from older hosts.

### Durable work needs an explicit owner

Branch state fits alternative histories; external storage can support resuming durable work. They must not both silently claim authority. Next's `goal-commit.ts` checks expected revisions, serializes commits and persists before notifications. GLLA's audit lifecycle distinguishes saved claim, start, running, recovery wait and committed result, avoiding successful labels for disconnected work.

At research time, cross-session, cross-workspace and cross-machine ownership were open interview questions. The later session-isolation decision is recorded in [requirements.md](requirements.md), not inferred retroactively here.

### Budget and compatibility claims need precise definitions

Total tokens, output tokens, responses, elapsed time and money are different quantities. Provider usage usually arrives after completion and can overshoot a budget. Audit/subagent usage and unknown values must be included honestly. A token limit is not a hard spending cap.

The local host uses `@earendil-works/*`; several candidate peer ranges stop at 0.x. README claims alone cannot establish Pi 1.0.4 compatibility. The custom implementation needs type, state and actual-load tests.

## Historical recommendations and follow-up

The pre-interview direction combined recynie's clarification, pi-goal's compact entry point, signalridge's input/stale-state protection, optional goal-x task/queue ideas, real checks plus fresh-context review, and next/GLLA persistence and recovery practices. It recommended a compact default panel and deferred broad daemons/subagent orchestration. Interface language was still undecided at that time; the current decision is English with bilingual root READMEs.

Representative validation scenarios include real completion, premature executor stopping, missing/error audit verdicts, requirement changes during audit, stale callbacks after pause, repeated failure, budget exhaustion, compaction, restart, branch navigation and custom-provider audits. These are protocol tests, not a quality benchmark for the surveyed packages. See [requirements.md](requirements.md) for the decisions adopted after interviews.
