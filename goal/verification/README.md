# Formal verification of the control protocol

TLA+ specifications and TLC **finite-state model checking** examine selected my-pi-goal control properties. Models are manual abstractions of state, runtime, store and auditor code, not automatically extracted TypeScript or a machine-checked refinement proof. A positive result means no counterexample was found within the stated finite model and assumptions; it does not establish correctness at every scale or validate LLM judgments.

See the [coverage inventory](COVERAGE.md), [report](REPORT.md), [machine receipt](results/summary.json) and raw `results/*.log`. Fourteen models plus direct bounded implementation checks cover the reviewed inventory. This is not a claim that every possible property of every line is formally proved.

## Reproduce

Java and Node.js are required. Official TLA+ tools release **1.7.1**, containing TLC **2.16**, revision `cdddf55`, is pinned to SHA-256:

```text
d532ba31aafe17afba1130f92410d9257454ff7393d1eb2fe032f0c07f352da5
```

```sh
npm run verify:setup
npm run verify:coverage
npm run check:compat
npm run verify:formal
npm run verify:evidence
npm test
```

Setup downloads the fixed official artifact or validates an existing one. Offline use accepts `TLA_TOOLS_JAR` or `${XDG_CACHE_HOME:-$HOME/.cache}/my-pi-goal/tla/1.7.1/tla2tools.jar` with that checksum. Verification does not call models, access user goal journals or require networking. Default resources: one TLC process at a time, two workers and a 2 GiB JVM heap. `TLC_WORKERS=1` reduces parallelism. These are verification resources, not product execution budgets.

A positive case requires exit zero, an explicit success message and an empty search queue. A safety control requires exit 12, the exact expected invariant and a trace. A temporal control requires exit 13, a temporal violation and a trace, with its expected property declared in the configuration. Parse errors, deadlocks, out-of-memory, cancellation or arbitrary nonzero exits are not successful controls.

The receipt records timestamps, tool checksum, source/model/config/test/mapping hashes, exit codes, state counts, depth and log hashes. Source changes during a run fail it; `verify:evidence` rejects stale receipts or altered logs. This is reproducibility evidence, not a tamper-proof signature.

## Models and implementation mapping

| Model | Finite bounds | Implementation |
| --- | --- | --- |
| [AuditProtocol](AuditProtocol.tla) | One goal, two abstract store/owner identities, two single-use tickets, generations 1–5, two obligations, repair threshold reduced to one | `GoalRuntime.current/require`, goal_submit, stop/input/goal_plan, state transitions/refinement, auditor inspection gates |
| [QueueProtocol](QueueProtocol.tla) | Three goals in creation order, approvals, selected goal and pause state | goal.create, approve, queue.advance, resume, queue.remove, nextQueued |
| [JournalProtocol](JournalProtocol.tla) | Two writer instances, up to four commits, interleaved lock/read/commit | ProjectStore locked/read/commit/claim/release, delta/snapshot entries, cached reads and ownerAlive |
| [SessionProtocol](SessionProtocol.tla) | Two session records; at most two creations in total; at most two ownership periods per session and three total acquisitions; two tickets | Session-keyed store routing, panel preference, clear, token rotation and result fences |
| [LifecycleProtocol](LifecycleProtocol.tla) | One current session plus a foreign request identity, two creation tickets, revisions 0–5, at most two later user inputs and two abstract contracts | goal_create session/revision guards, pending goal_plan approval, goal_resume stop-input and budget gates |

The automatic-clear model checks the decision to remove finished state after a real input, preserving queued work, metered final usage and the message itself. Its five input statuses, Boolean environment and one-input bound are documented in the inventory.

Eight earlier additional models are described with their finite domains and source mapping in the [coverage inventory](COVERAGE.md): PermissionProtocol, AccountingProtocol, RecoveryProtocol, ContextProtocol, InspectionProtocol, CheckProtocol, SchedulingProtocol and VerificationProtocol.

These fourteen layers have **no composition or machine refinement proof**. Audit treats authorized synchronous store transactions as atomic; Journal examines the lock/commit discipline separately. Queue abstracts a valid audit as Complete. Session abstracts scope approval/checks, queue contents and generations away: its active goal stands for approved work, while detailed completion gates and generations remain in Audit. Its Switch changes the viewed session without modeling the host's full shutdown/replacement lifecycle; runtime/SDK tests cover that behavior. Panel visibility is a state binding, not pixel layout. Lifecycle treats ownership transactions as atomic and omits queues, file I/O, approval UI and detailed generation fencing, which are covered separately. Its initial plan abstracts an allowed initial acceptance; objective classification and semantic authorization are outside the model. Revision/input counters do not wrap. ContextProtocol now checks structural projection of current/empty state, filtering of stale controls and a single policy copy over two projections; runtime/SDK fixtures connect it to implementation behavior. Neither proves LLM obedience.

| Abstract action/field | Meaning and limits |
| --- | --- |
| Audit Claim/Crash/Release | Store ownership and liveness; each abstract owner represents an authorized store period. Session separately checks reuse of a runtime across ownership periods |
| Audit generation | Goal generation; transitions into complete/pause increment it, so the certificate precedes the completed generation by one |
| Audit Approve/Propose | Replace obligations and reset relevant evidence only after approval; proposals wait in draft |
| Audit Refine | User approval of a pending task refinement, retaining existing obligations/evidence |
| Audit Start/Checks | Require completion evidence and validate passing main-session check records before review; an empty approved check set passes this gate. These are abstract validation stages, not commands executed by goal_submit |
| Audit Inspect/Verdict | Inspect real artifacts, see results in a later response, then submit complete criterion findings |
| Audit Finish/charged | Original authority required for accounting; current generation/status required for a verdict. The implementation additionally checks store object, ownership token and goal ID |
| Queue Add | Appending cannot replace older unfinished work; retain a completed selection until settle advances it |
| Queue Advance | Only an approved FIFO head advances, with no queued user input and no paused queue |
| Queue Resume | Explicit selection may choose another approved goal; it is outside automatic FIFO. Unbounded arrays and explicit start are not modeled |
| Journal Begin/Read/Commit | Atomic mkdir lock, latest snapshot validation, ownership check, append and unlock |
| Journal rev/parent/data | Revision, predecessor chain and successful-update count; SHA-256 itself is not modeled |
| Journal Crash/Recover | Dead instances cannot commit; lock recovery assumes confirmed death. Actual empty leftover locks require operator recovery |
| Session Route/Publish | Actual target records must leave every other session unchanged. Shared-directory routing is a deliberate violating control |
| Session Clear | Empty the selected goal and hide its panel; preserve issued IDs and outstanding tickets. The model abstracts journal append, cancellation and release as one operation |
| Session Acquire/ReleaseIdle | Automatic ownership with a fresh bounded lease number; live conflicts/transaction exclusion are delegated to Journal and runtime tests |
| Session Start/Finish | Stamp session, goal identity and ownership period; reject old results after clear/replacement or release/reacquisition |
| Session Panel/Switch | Restore each session's own preference and hide a panel when its selected session has no goal |
| Lifecycle Read/Create/Clear | Bind creation requests to session and revision; clearing invalidates earlier tickets before any new goal can be created |
| Lifecycle Propose/UserApprove | A changed contract remains pending until the user accepts it; automatic proposal application is a violating control |
| Lifecycle Stop/UserInput/ModelResume | Model resume needs a later real user input and remaining budget; manual command resume is outside this guard model |

## Safety and liveness

[The case matrix](cases.json) declares each model, expected outcome and exact counterexample property.

- Audit: types, approval gates, original-writer authorization, generation fencing, evidence preservation, budget-error classification and certified completion.
- Queue: types, one active goal, active selection, approval and automatic FIFO.
- Journal: types, lock exclusion, authorized commits, predecessor continuity and no lost updates.
- Session: types, no cross-session record changes, panel binding, current goal/ownership-period result application and a certificate bound to the completed goal.
- Lifecycle: types, current-session/revision creation, approved contracts, stop-input boundaries and cumulative-budget checks before model resume.

Explicit stuttering accommodates waiting and finite bounds; absence of deadlock is not proof of progress. Generations, goal IDs, ownership periods and tickets do not wrap or get reused within a model. At a bound, the corresponding increasing action is no longer explored.

Two conditional liveness cases remain: `audit-live` assumes approved/evidenced work, successful external responses, no intervening pause/change/crash/budget exhaustion and weak fairness of start/check/inspect/verdict/apply, yielding eventual completion. `queue-live` assumes approved work and fair successful completion/advancement, yielding eventual draining. Removing fairness or continuation produces the expected temporal counterexamples. These assumptions do not prove tools return or justify adding product time/turn caps.

## Fault controls and implementation tests

The original twenty-one expected controls cover historical add/FIFO behavior, missing audit generation/owner/check/inspection gates, erased evidence, unapproved execution, queue bypass, missing fairness/continuation, absent journal locking/authorization, shared-directory routing, global panel state, clearing every session, ignored result identity and ignored ownership periods. Four lifecycle controls remove creation identity checks, apply proposals without approval, ignore stop-input boundaries or ignore the resume budget.

Only `queue-legacy-add` reproduces a previously confirmed TypeScript bug. Other deliberate mutations demonstrate sensitivity of the specified properties and must not be reported as additional defects in the current implementation. All switches live exclusively in model configuration. Twenty-nine additional controls cover the seven added models: stale/exact-key/override/scope permission gates; usage reset/final-turn/reasoning/repeat-progress/budget errors; unvalidated/overwriting/wrong-session/tail-dropping/history-rewriting recovery; stale/empty/chat context handling; same-response/record-only/incomplete/outside-path inspection; missing-metadata/cancelled/stale/failed main-session checks; and input/outcome/gate/release scheduling. AutoClearProtocol adds a positive case and five controls for missing verification, absent/extension input, unfinished queues, lost final usage and cancellation of the incoming message. The context-policy control checks that repeated projection does not accumulate execution-policy copies. VerificationProtocol adds a positive case and four controls: ignored version identity, information requests counted as repairs, replies accepted without fresh inspection, and completion with unanswered requests. There are 76 configurations: 16 positive and 60 required counterexamples.

Runtime regressions cover both historical FIFO paths, stale owner and generation callbacks, separate sessions, same-session automatic handoff, clear during checks/audits, copied control prompts and panel restoration. Store tests exercise hash chains, partial tails, session-ID routing, migration and writer exclusion. Real Pi SDK tests cover model creation from ordinary input, native continuation, audit, automatic release, clear during worker/auditor requests, empty context after clear, paused modifications, user approval and model resume. The 1.3.0/1.4.0 upgrades add saved-session reopen/tool-restoration coverage without automatically restarting Goal work; malformed-JSON empty arguments are rejected by every audit tool's schema. The host-support domain includes retired 1.2.0 and future 1.5.0. These are manual model-to-code connections, not replay of every TLC state against TypeScript.

The four lifecycle controls must produce the named violation; a configuration that merely completes successfully is a failed control. An initial model draft omitted parentheses around three Boolean ghost assignments, which accidentally constrained away the faulty transitions. The stale-creation control exposed that modeling error; the corrected model assigns the Boolean conjunction explicitly. This was a model defect, not a production-code defect.

Maintain models, mapping, fault controls and relevant regressions together when the protocol changes, then regenerate and check the receipts. A first RecoveryProtocol draft similarly lacked parentheses around a disjunction assigned to a Boolean; the positive case exposed an impossible backup transition. It was corrected before acceptance, together with inspection Boolean assignments. This was a specification defect, not a production defect.

## Bounded implementation enumeration

`verify:formal` also runs `scripts/verify-contracts.mjs` against actual TypeScript functions and the registered context handler. Fourteen groups enumerate usage components, completion/evidence combinations, verdict findings, budget/resume conditions, counters/clocks, task refinements/research obligations, queue selection, permission/configuration precedence, context identities, main-session receipt provenance, exit metadata and source freshness, storage deltas, Unicode layout bounds and the two-release host policy. Independent expected predicates compare outcomes; exact finite domains and assertion counts are recorded in `results/contracts.json`. This is exhaustive testing in the declared domains, not an unbounded proof, a generated refinement relation or replay of every TLC state.

`verify:coverage` checks all production modules, model/configuration files, positive cases and implementation groups against `coverage.json`. It checks registration consistency, not semantic completeness of the inventory. The dual-host suite loads the actual extension entry and checks its command/tool registrations; the separate model-listing CLI invocation is only a smoke check, because a successful exit can hide factory errors. `verify:evidence` validates the TLC logs, contract receipt and both isolated host-version receipts against current source hashes. Stale/altered receipts fail; missing installations are a failed compatibility run, not a skipped version.

## Exclusions and assumptions

No proof covers LLM judgment, complete semantic requirement coverage, scientific results, host command execution safety or a complete dependency/environment model, filesystem power loss/fsync behavior, PID reuse, cross-host liveness, malicious filesystem changes, unbounded logs/counters, host scheduling implementation or arbitrary long-run termination. Journal assumes atomic mkdir, compliant writers and durable successful append/fsync. RecoveryProtocol now abstracts migration and partial-tail decisions, but real file I/O, panel persistence APIs and host command timing still rely on tests and external assumptions.

TLC deduplicates states using fingerprints and reports an estimated collision risk; this is not a probability-free theorem-prover result. Tool references: [official repository](https://github.com/tlaplus/tlaplus), [pinned release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.1), [TLC command line](https://docs.tlapl.us/using:tlc:start).
