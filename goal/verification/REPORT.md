# Control protocol verification report

Current timestamps and source hashes are recorded in the [TLC/implementation receipt](results/summary.json) and [dual-host receipt](results/compatibility.json). These receipts, rather than duplicated counts or dates below, determine whether evidence matches the current tree.

The matrix contains **76 configurations**: **16 positive checks** and **60 deliberate fault/missing-assumption controls**. Fourteen bounded implementation groups are enumerated in [contracts.json](results/contracts.json). Pi **1.3.0 and 1.4.0** are checked with types, the full suite and isolated extension loading; test counts and outcomes are in their receipt and logs. Ordinary CI no longer skips bubblewrap capability tests: that executor has been removed. Real Docker Sandboxes checks are recorded separately in [microVM acceptance](../docs/docker-sandboxes-acceptance.md), outside the formal composition scope. `verify:evidence` checks source hashes, TLC logs, the implementation receipt and both host logs.

The review found gaps in the former five-model coverage: permission confirmation, accounting/stagnation, recovery decisions, context projection, detailed inspection, check cancellation and scheduling. Seven models, 36 configurations and direct implementation enumeration now supplement those areas. No new production defect was confirmed in that coverage review. The subsequent automatic-clear work exposed an omitted final-reply usage charge and fixed it, as described below. A RecoveryProtocol Boolean-assignment error was found and corrected before acceptance; this was a model-writing defect.

The [inventory](COVERAGE.md) accounts for **23 production modules and 15 behavior rows**, including explicit exclusions. It checks registration consistency, not automatic semantic completeness. These are separate finite abstractions and finite implementation domains, with no composition or machine-checked TypeScript refinement theorem. They do not prove LLM judgment, arbitrary-size execution or unbounded termination. [Method and assumptions](README.md) define the scope.

## Positive checks

| Case | Distinct states | Generated states | Complete graph depth | Result |
| --- | ---: | ---: | ---: | --- |
| audit | 960689 | 4450062 | 26 | Passed; queue exhausted |
| queue | 679 | 3044 | 13 | Passed; queue exhausted |
| journal | 13404 | 45565 | 22 | Passed; queue exhausted |
| audit-live | 6 | 7 | 6 | Passed; queue exhausted |
| queue-live | 6 | 12 | 6 | Passed; queue exhausted |
| session | 46904 | 242297 | 21 | Passed; queue exhausted |
| lifecycle | 11197 | 30842 | 10 | Passed; queue exhausted |
| permission | 541 | 9869 | 7 | Passed; queue exhausted |
| accounting | 3177 | 9124 | 12 | Passed; queue exhausted |
| recovery | 98 | 248 | 6 | Passed; queue exhausted |
| context | 216 | 432 | 3 | Passed; queue exhausted |
| inspection | 7 | 72 | 5 | Passed; queue exhausted |
| check | 42 | 100 | 5 | Passed; queue exhausted |
| verification | 80 | 240 | 13 | Passed; queue exhausted |
| scheduling | 680 | 1362 | 6 | Passed; queue exhausted |

The added auto-clear positive case explored 121 distinct / 302 generated states, depth 3, with an empty search queue. All five controls (verification, input source, unfinished queue, final charging, and message cancellation) produced SafeAutomaticClear / exit 12 counterexamples.

The original Audit/Queue/Journal/Session/Lifecycle bounds are in the [model mapping](README.md). Added model bounds are in the [inventory](COVERAGE.md). Stuttering at a bound does not establish progress. Audit/queue liveness remains conditional on successful external responses and fair scheduling.

## Counterexample controls

| Case | Required property | Exit |
| --- | --- | ---: |
| queue-legacy-add | AutomaticFIFO | 12 |
| audit-stale | NoStaleApplication | 12 |
| audit-owner | NoUnauthorizedWrites | 12 |
| audit-checks | CompleteCertified | 12 |
| audit-inspection | CompleteCertified | 12 |
| audit-evidence | EvidencePreserved | 12 |
| queue-approval | NoUnapprovedExecution | 12 |
| queue-bypass | AutomaticFIFO | 12 |
| audit-unfair | EventuallyComplete | 13 |
| queue-no-continuation | EventuallyDrained | 13 |
| journal-no-lock | ChainIntegrity | 12 |
| journal-owner | AuthorizedCommits | 12 |
| session-directory | SessionIsolation | 12 |
| session-panel | PanelBinding | 12 |
| session-clear-all | SessionIsolation | 12 |
| session-stale | NoStaleResult | 12 |
| session-lease | NoStaleResult | 12 |
| lifecycle-stale | NoStaleCreation | 12 |
| lifecycle-approval | ApprovedExecution | 12 |
| lifecycle-stop | StopBoundary | 12 |
| lifecycle-budget | ResumeBudget | 12 |
| permission-stale | AuthorizedOperations | 12 |
| permission-cache | AuthorizedOperations | 12 |
| permission-override | AuthorizedOperations | 12 |
| permission-scope | AuthorizedOperations | 12 |
| accounting-reset | MeteredUsage | 12 |
| accounting-final | MeteredUsage | 12 |
| accounting-reasoning | MeteredUsage | 12 |
| accounting-repeat | ProgressAndBudget | 12 |
| accounting-budget | ProgressAndBudget | 12 |
| recovery-chain | SafeRecovery | 12 |
| recovery-overwrite | SafeRecovery | 12 |
| recovery-session | SafeRecovery | 12 |
| recovery-tail | SafeRecovery | 12 |
| recovery-history | HistoryPreserved | 12 |
| context-stale | OnlyLiveControls | 12 |
| context-empty | EmptyIsExplicit | 12 |
| context-conversation | ConversationPreserved | 12 |
| context-policy | SinglePolicy | 12 |
| inspection-batch | LaterResponse | 12 |
| inspection-record | RealInspection | 12 |
| inspection-coverage | CompleteFindings | 12 |
| inspection-path | ReadBoundary | 12 |
| check-sandbox | CheckBeforeAudit | 12 |
| check-cancel | CheckBeforeAudit | 12 |
| check-stale | CheckBeforeAudit | 12 |
| check-failure | CheckBeforeAudit | 12 |
| verification-snapshot | SnapshotUsed | 12 |
| verification-repair | EnvironmentIsNotRepair | 12 |
| verification-pause | EnvironmentStops | 12 |
| verification-completion | NoEnvironmentCompletion | 12 |
| scheduling-input | SafeContinuationAndRelease | 12 |
| scheduling-outcome | SafeContinuationAndRelease | 12 |
| scheduling-gates | SafeContinuationAndRelease | 12 |
| scheduling-release | SafeContinuationAndRelease | 12 |

Each control must violate the named property with a trace; parse errors, crashes, resource exhaustion and unrelated failures are rejected. Controls demonstrate property sensitivity. Only the historical FIFO control reproduces a previously confirmed implementation bug. All mutation switches are confined to model configurations. Multi-worker counterexample search counts can vary.

## Bounded implementation checks

| Group | Assertions |
| --- | ---: |
| usage | 117649 |
| transitions | 618 |
| completion | 145 |
| findings | 6175 |
| budget-resume | 7579 |
| progress-clock | 134 |
| spec-refinement | 934 |
| queue | 1728 |
| settings-permissions | 2255 |
| context | 288 |
| layout | 261360 |
| environment | 206 |
| storage | 39 |
| host-support | 9 |

These assertions execute production TypeScript functions and the registered context handler over fully enumerated, declared domains. Exact domains are recorded in [contracts.json](results/contracts.json). Assertion totals count individual conditions, not independent proofs or distinct program states. The large layout count is width/height/status/theme enumeration, and usage checks include invalid/non-finite components; neither implies universal coverage of arbitrary inputs.

## Prompt consistency and request projection

The executor now receives one freshly projected execution-policy message and current goal snapshot per eligible request. Historic plugin control messages are excluded from provider context while the persisted transcript, ordinary conversation and tool results remain intact. Valid nonselected planning requests are rebuilt once per goal from current journal data; session/generation/ownership and FIFO boundaries remain enforced. Rules are regenerated after compaction. The guarantee applies to generated controls, not rules quoted in ordinary conversation or historic tool results.

Runtime regressions exercise ten repeated continuations, pre-upgrade control text, current evidence, idempotent projection, compaction, queued planning and unowned/cleared/forked state. Both actual SDK fixtures assert one policy copy through normal lifecycle requests. ContextProtocol models two projections and one eligible policy copy; context-policy deliberately accumulates a second copy and triggers SinglePolicy / exit 12. The expanded bounded implementation context group now has 288 assertions.

Audit instructions and tool descriptions now explicitly require artifact read/search or approved-check results before a later-response verdict; audit_list is navigation and audit_record is recorded evidence. The existing runtime gates are unchanged and regressions verify navigation-only and same-response verdict rejection. Approval wording consistently distinguishes every approved-spec change from progress/evidence and in-scope implementation decisions.

Stagnation diagnostics request English text while preserving quoted user language. The former silent 8,000-character result slice is removed. Regression fixtures preserve long multilingual text through return, journal and notification, with usage, cancellation and goal-budget checks retained. See [model prompts](../docs/prompts.md) for details. No real-provider token-savings benchmark or semantic-compliance proof is claimed.

## Automatic clearing after verified completion

A verified completed selection remains visible until a real interactive/RPC input arrives. When no unfinished queue remains, the plugin appends an empty current snapshot, hides the panel/status and releases ownership, preserving historical journal bytes and processing the incoming message normally. Extension input, unverified/skipped-only goals, unfinished queues and other sessions do not trigger this path. Manual clear still cancels work explicitly.

A fenced cleanup is deferred until `usage.turn` if the final reply is streaming. The actual SDK regression exposed that the prior turn-start handler excluded complete goals, omitting the final post-verification reply from metering. It now retains the completing goal fence until settlement; the queued-input regression verifies its final 15 fixture tokens were recorded before cleanup. Runtime regressions cover reload, old IDs, new goals and live-owner conflicts; a state test enumerates 360 status/verdict/queue combinations. AutoClearProtocol is a separate finite decision model, not a proof of host scheduling or physical persistence. Its first draft had a TLA+ precedence parse error, corrected before the passing matrix.

At the automatic-clear revision, both supported hosts passed 105 tests and the matrix contained 70 cases. The current totals and verified receipts are listed at the top of this report. README.md, README.zh-CN.md, design, requirements, model-tool guidance and coverage mapping describe the behavior.

## Approval presentation update

`src/approval.ts` replaces raw specification JSON with complete labeled plain text and numbered lists, shared by RPC and terminal review. A bounded TUI overlay supports scrolling, resize, configured confirmation/cancellation keys and visible action hints. Existing scope/ownership/generation approval guards remain in runtime. Six added regressions cover content preservation, empty lists, long/multiline/Unicode/control text, scrolling/resize, RPC/no-UI routing, decline/accept behavior, stale confirmation and exact-revision approval. The existing 64-model-configuration matrix was rerun with current source hashes; UI semantics are covered by implementation tests rather than a new TLA+ model.

Real Pi 1.1.0 terminal checks exercised regular/fullscreen modes × dark/light themes, 80-column initial review, final-page access, resizing to 48 columns, cancel and accept, with a synthetic fixture and no model prompt. [Terminal captures](../docs/compatibility/approval-tui.txt) record the results. Fixture parsing was corrected before the successful run; no production change was needed for that fixture error.

## Per-goal verification environments (historical implementation)

This section records the earlier environment rollout. Its executor, host networking and variable-forwarding details have been superseded by the Docker Sandboxes backend. Current configuration and validation evidence are in [verification environments](../docs/verification-environment.md) and [microVM acceptance](../docs/docker-sandboxes-acceptance.md). The abstract VerificationProtocol remains applicable; it does not prove the new microVM or proxy implementation.

Approved checks previously ran in one fixed posture: the host and project were read-only, networking was isolated, and `/tmp` was writable. Build, dependency-download and local-service checks could therefore fail for environmental reasons and be reported as implementation failures, consuming repair attempts. The earlier audit already recorded one such case: C5 used recorded host evidence because rebuilding inside the read-only sandbox was impossible.

The upgrade adds a main-model-declared environment, `goal_environment`:

- `workspace`: `readonly` (default) or `ephemeral`. Ephemeral binds a temporary writable overlay at the project path; the host project is never written in place.
- `network`: `isolated` (default) or `host` (`--unshare-all --share-net`).
- `env`: up to 32 host variable names passed by name. Values are never stored in the journal.

This is runtime configuration, not an approved-specification change, so no `/goal approve` is required. Explicit `network`/`install` policies remain effective; host network under an asking policy uses the existing exact-grant confirmation. The plugin validates the configuration, probes the sandbox, writes a `verification.update` event and resets the consecutive environment-failure counter. Each submission freezes one environment snapshot for its checks and for the auditor's `audit_check`.

Check failures are classified before repair accounting. Sandbox start/probe failures and failures matching a capability the environment withheld (read-only writes, isolated DNS/connectivity, missing tooling) are reported as environment issues: they do not increment `consecutiveAuditFailures`, do not run the audit and cannot complete the goal. Three consecutive environment failures with unchanged settings pause the goal; an explicit `/goal approve` is not involved, but the model cannot self-resume past the pause. A successful check pass or an environment change resets the counter. The classification is a heuristic and never converts a failed check into success.

VerificationProtocol models the snapshot identity, environment-versus-repair separation, the no-completion rule and the repeated-failure stop: one positive case and four controls. The first model draft failed its own positive case because adjusting the environment while idle left a stale `used` identity; the second draft could not reach two consecutive failures because the retry path was missing. Both were model-writing defects, not production defects, corrected before acceptance. Real sandbox regressions cover read-only versus ephemeral writes, host-only project immutability, isolated versus host networking with a loopback server, named-variable passthrough and hidden undeclared variables. Runtime regressions cover the tool no-op/probe/approval paths, frozen snapshots, classification, repair-count preservation and the pause threshold.

## Storage and context efficiency

The journal previously appended a full state snapshot for every event and re-parsed and re-validated the whole file on every read. A synthetic 66 KB goal with 600 events produced a 78.1 MB journal; one `load()` took 190.7 ms and one commit 197.1 ms, while a TUI `goal_progress` call performed eight loads. The same fixture now produces a 3.4 MB journal (about 23× smaller), a cached `load()` of 0.1 ms and a commit of 0.7 ms. A separate 60-event fixture fell from 4.4 MB to 0.25 MB, and executor `goalContext` from 66,102 to 1,921 characters while retaining 65 KB of evidence.

Implementation:

- Entries store a deterministic delta (`diffState`) or a full snapshot at revision multiples of 25, when a delta exceeds 500 operations, or when it is comparable in size to the state. The hash chain covers the exact entry payload.
- `ProjectStore` caches the parsed and normalized snapshot and reuses it only while size, inode, mtime and ctime are unchanged; external appends, replacement or tampering force a re-read and hash validation. Commits reuse the cache under the lock, so repeated reads and writes avoid replaying history.
- `history()` reconstructs per-event states for derived views and tests without exposing journal internals.
- Executor context and the default `goal_status` view index evidence as counts and previews; `goal_evidence` pages exact records. Bounded `storage` contracts enumerate diff/apply round-trips, removals, append-only evidence, equal states and invalid patches.

Limits: these measurements are synthetic and local. The first read after restart still replays the nearest snapshots and deltas. Cache validation is filesystem-stat based, not a cryptographic re-read; a same-size in-place rewrite that also preserves timestamps is outside the assumption. Journal entries now carry `patch` instead of `state` for most commits, so older plugin builds cannot read new journals; downgrade only with a backup. Historical bytes remain append-only and tamper-evident.

## Rolling host support

The supported pair is **current 1.4.0 / previous 1.3.0**. Exact peer dependencies, extension registration and host-link validation enforce the pair; `check:load` verifies `/goal` and all nine tools. The isolated runner verifies both installations without modifying working dependency links or reading real user settings/journals. Workspace links were refreshed to 1.4.0. Host releases outside the pair are unsupported; journal history remains protected. See the [maintenance policy](../docs/compatibility/support-window.md), [dual-host receipt](results/compatibility.json), [1.3.0 log](results/compat-1.3.0.log) and [1.4.0 log](results/compat-1.4.0.log).

The [1.3.0 review](../docs/compatibility/pi-1.3.0.md) reproduced the stale-window rejection and found no breaking extension API change requiring a production shim. New regressions verify saved-session tool restoration/modifiers without automatically restarting Goal work, subsequent authorized model resume, and malformed-JSON empty-argument rejection by all audit tools. The initial saved-session fixture tried to activate a tool outside its own explicit allowlist; correcting that fixture did not require a production change. Both supported hosts now unconditionally exercise the 1.2+ custom-start lifecycle contract.

The [1.4.0 review](../docs/compatibility/pi-1.4.0.md) found no breaking public extension API change. It records the unchanged extension/MCP declarations, the 1.3.0-to-1.4.0 host dependency refresh, and the actual type, test, load, dual-host and CodeGraph smoke results. The only test adjustment was the expected restored-tool behavior on the new supported pair.

Pi 1.3.0 [terminal captures](../docs/compatibility/pi-1.3.0-tui.txt) cover regular/fullscreen × dark/light, long Unicode reviews, scrolling/resizing, cancellation/acceptance, paused panel/reload/clear, and closing an underlying review without closing a second overlay. The current 76-configuration matrix and 399,119 bounded assertions were rerun; the host-support domain includes retired 1.2.0 and future 1.5.0. These checks neither backport the host's overlay fix to 1.2.0 nor validate every provider or extension combination. They are not a new real-model independent Goal audit.

The [1.2.0 repair](../docs/compatibility/pi-1.2.0.md) reproduced entry rejection under the former version pair. It also found that the model-listing CLI smoke command exited 0 even when the entry factory failed. `check:load` now inspects public resource-loader errors and actual command/tool registrations, with negative tests for failed/empty factories and mismatched CLI libraries. The real SDK command-start regression verifies the new custom before_agent_start event, busy startup and a non-triggering message delivered into the same run, plus continuation/audit/completion/clear on both hosts. No production lifecycle shim or relaxation of completion gates was needed.

Pi 1.2.0 [terminal captures](../docs/compatibility/pi-1.2.0-tui.txt) cover regular/fullscreen × dark/light, long review scrolling, 80-to-48-column resize, cancel/accept, paused panel, reload and clear. Tests used temporary workspaces and agent directories, no paid calls and no real journal mutations. The model matrix later grew with VerificationProtocol; the current 76 configurations and 399,119 bounded assertions are the valid receipt. These are finite checks, not host-internals or unbounded semantic proofs.

## Historical FIFO defect and repair

The old create branch selected a new goal whenever the current selection was absent or terminal:

```ts
if (!existing || terminal(existing)) s.activeId = g.id;
```

One path created A, appended unapproved B, skipped A (leaving no selection), then appended C. C incorrectly bypassed B. Another path completed A with approved B queued, then appended C, again replacing the older selection. The historical model trace needed five states including the initial state; it could skip A without first approving it.

The repair finds earlier unfinished work before appending. With no selection it retains that earlier goal; with a completed selection it keeps it until the settle hook advances the queue. Explicit selection commands remain distinct from automatic FIFO. [Pre-fix runtime failures](regressions/fifo-before.log) preserve both real failing assertions. The corresponding tests now pass, alongside old-store and stale-generation callbacks.

Automatic ownership release must likewise wait until a completed selection has advanced or entered a queue wait. A regression during the earlier ownership update caught premature release at the command boundary; the fix retains ownership until the normal settle path handles advancement.

## Session and ownership update

Goals and queues now use session-ID-derived journal paths, and panel entries carry their owning session ID. Clear appends an empty current snapshot, cancels work and hides the panel while preserving history. Fork/clone cannot inherit another session's control prompts or panel preference. Legacy import checks the original hash chain and last owner and never reimports into an existing cleared journal.

Ownership is acquired/released automatically. Each acquisition gets a new token; async fences include that token as well as store, goal and generation. Tests cover pending approval after the same runtime reacquires ownership, clear during mechanical checks/audits, final worker usage before release, idle handoff between instances and independence of same-directory sessions. The Session model checks routing, clear, visibility and result identity; actual command/event timing, migration I/O and Pi custom-entry persistence are tested rather than formally refined.

The English interface update also retains approved research history: exact old built-in criteria are recognized without rewriting their text/evidence or adding translated duplicates.

## Model lifecycle update

The empty session state is now projected into every model request, including after clear/reload/compaction. Clear also sends a non-triggering model-visible message. Missing-ID tool calls return explicit no-op feedback. `goal_create` is fenced by session and journal revision; it cannot replace unfinished work. `goal_resume` requires approved scope, a valid stopped goal, sufficient budget and a later user message after a stop. Runtime and real SDK tests cover these tool paths and cancellation during clear.

All modifications to approved specifications now wait for user approval, including task changes. Audit Refine was updated to represent approval of a pending refinement; its evidence-preservation control still produces the expected counterexample. Lifecycle adds the four new fault controls above. Its first draft accidentally constrained away fault transitions through an unparenthesized Boolean ghost assignment; the failing stale-creation control exposed that model error before acceptance. Corrected controls all fail on their intended invariant.

These models do not certify semantic user authorization or whether an LLM obeys a cleared-state instruction. Those remain explicit prompt/tool contracts, backed by deterministic lifecycle fixtures.

## Reproduction and limits

Tooling: official TLA+ tools 1.7.1 / TLC 2.16 (`cdddf55`), pinned jar checksum, Java 27, Node.js 22.23.3 and Linux. TLC uses breadth-first search, one process at a time, two workers and a 2 GiB heap. Model dimensions are finite bounds, not restored product execution budgets.

```sh
npm run verify:setup
npm run check
npm test
npm run check:format
PI_OFFLINE=1 npm run check:load
npm run verify:coverage
npm run check:compat
npm run verify:formal
npm run verify:evidence
```

The [receipt](results/summary.json) hashes current code, tests, models, configurations, coverage documentation and raw TLC logs. The separate compatibility receipt uses the same source hash set. The implementation result is hashed by the formal receipt. Changes require fresh evidence; these hashes are reproducibility records, not tamper-proof signatures. Narrative reports are summaries and do not replace receipts.

TLC fingerprint deduplication has a nonzero collision estimate. Filesystem lock/fsync/rename semantics, cryptographic integrity, host event ordering, kernel isolation and tool responses remain assumptions. Permission command classification and simple-goal/authorization interpretation are heuristics. LLM obedience, scientific truth, complete UI accessibility and real-model 5–12 hour stability are not proved. Non-Linux behavior is unvalidated. See the inventory for the boundary attached to each behavior.
