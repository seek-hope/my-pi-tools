# Design and boundaries

> Commands and writes belong to the main Pi session. Temporary read-only reviewers inspect completion and can request information. See [execution and review](read-only-review.md) and the [flow diagrams](flow.md) (Chinese).

## Purpose and compatibility

my-pi-goal is a native Pi session extension. The main agent keeps using its normal tools; the extension persists goals, supplies continuation instructions, records evidence, runs checks, requests independent audits and advances a sequential queue. Audits use the public `modelRegistry.streamSimple` API with a fresh message list and a minimal tool set, including custom providers.

Only the current Pi release and the immediately preceding release are supported, currently 1.4.0 and 1.3.0. Exact host peer ranges and an entry guard enforce this window. Host-provided libraries avoid duplicate runtimes. `check:compat` exercises both installed releases in isolated copies; new releases require updating the pair and repeating checks. No compatibility commitment remains for older host APIs. Journal data normalization remains independent of host support. See the [support policy](compatibility/support-window.md).

The interface, prompts, messages, examples and supporting docs are English. Root READMEs are available in English and Chinese. User content and approved historical evidence are not translated. Exact legacy built-in research criteria are recognized as equivalent requirements so task refinement preserves old evidence without duplicating obligations.

## Modules

| Module | Responsibility |
| --- | --- |
| `extensions/index.ts` | Register the extension factory without background startup side effects |
| `runtime.ts` | Commands, model tools, lifecycle, queue and asynchronous result coordination |
| `state.ts` | Goal types, transitions, scope, budgets and research requirements |
| `store.ts` | Session journals, single writer, synchronous commits, hash chain and derived report |
| `auditor.ts` | Fresh audit context, restricted tools, criterion findings and usage |
| `checks.ts` | Environment validation, migration, summaries and failure classification; execution is in `verification/` |
| `permissions.ts` | Autonomous/confirm policies and optional cooperative tool checks |
| `prompts.ts` | Current-state projection, work rules, continuation and audit instructions |
| `stagnation.ts` | Independent diagnosis without changing acceptance criteria |
| `tui.ts` | Theme-aware status, card, progress and narrow-terminal rendering |
| `settings.ts` | Personal/project defaults and validation |

## Session state and ownership

The successful path is `draft -> active/queued -> active -> verifying -> complete`. Audit failure returns to active for repair, eventually blocked. Pause, host errors and cancellation use paused; an explicit cumulative budget can cause budget_limited. Skip/remove record skipped.

Each Pi session uses `.pi/my-pi-goal/sessions/<SHA-256(sessionId)>/state.jsonl`; defaults remain project-wide. A snapshot's session ID must match the store. `ProjectStore` retains its class name for compatibility, but now represents one session under the project root. Separate sessions can own journals concurrently; they still share workspace files.

Every transaction locks a directory, validates the latest journal, checks writer ownership, appends a compact delta or a periodic full snapshot, fsyncs and releases the lock. Reads verify the hash chain and apply deltas; the store reuses the parsed snapshot only while the journal's size, inode and timestamps are unchanged, so external writes or replacement force a re-read. Full snapshots every 25 revisions bound restart replay, while deltas keep storage proportional to changes rather than to events times state. There is no lost-update guarantee without compliant writers and filesystem semantics. A derived `STATUS.md` export failure does not roll back an already committed journal. A partial final line is saved before truncation and append; middle corruption refuses writes. An ambiguous leftover empty lock needs operator recovery after confirming no live writer.

Executor context and the default `goal_status` view project evidence as counts and previews; `goal_evidence` pages exact records by ID. This keeps repeated prompt and tool payloads bounded while preserving access to every recorded claim. Historical journal bytes remain append-only.

Ownership is automatic. Commands, user input, execution startup and goal tools acquire it when necessary. Each acquisition generates a fresh token. An idle pause, wait or draft can release it. Cancellation during execution waits for tool return and final usage accounting, then `agent_settled` releases ownership. A completed selection retains ownership until its queue advances or enters a waiting state. That final notification handler modifies external state/UI only; it does not append transcript instructions or request continuation. Shutdown/reload also release ownership. A dead owner can be recovered; a live or cross-host owner is not forcibly displaced.

Async fences include store object identity, ownership token, goal ID and generation. Pause, resume, scope changes and real supplements rotate generation. A store reacquiring its own journal gets a new token, so an old callback cannot regain authority merely because the same runtime object owns the journal again. Audit usage is attributed to the original goal when that authority remains valid. Cleared goals, replaced stores or old ownership periods cannot accept accounting or verdict writes; unreturned usage may therefore be unavailable.

A real interactive/RPC `input` after verified completion automatically clears finished session state when the selected goal is complete with a passing audit and every queued goal is terminal. This is a non-cancelling path: input is neither transformed nor consumed, no new turn is scheduled, and journal history remains. If the completing response is still streaming, a fenced deferred cleanup runs after `usage.turn`; the final post-verification reply is metered too. A replacement, new queue item, changed owner or session invalidates cleanup. A successful automatic clear records `clearReason: verified`, distinct from manual cancellation; reloaded completed goals follow the same predicate.

`/goal clear` appends an empty goal/queue snapshot, cancels work, hides the panel/status and releases ownership. It preserves prior journal entries. Clearing removes the old goal ID, so a newly created goal cannot accept an old result even if its generation starts from the same number. A durable `clearedAt` marker and non-triggering custom message record cancellation. The context hook always rebuilds a session summary, including when empty or unowned. It regenerates one current policy and selected-goal snapshot for eligible owned work on every request, including after compaction. Persisted startup/continuation rules and snapshots are omitted from the projection; valid nonselected planning requests are rebuilt once per goal from current journal data. Ordinary conversation and tool results remain untouched. See [model prompts](prompts.md). Missing-ID goal tools return explanatory no-op results before ownership or writes. They do not forge a successful progress/audit result.

## Legacy migration and transcript projection

A session with old plugin references can import the directory-level `.pi/my-pi-goal/state.jsonl` only when its ID matches the last recorded owning session and that owner is no longer live. The complete original chain is validated first. Migration locks both directories, writes/fsyncs a temporary copy and atomically renames it. The original remains intact; an existing target journal, including a cleared one, prevents repeated import. Previously shared history is assigned intact to the last owner rather than heuristically divided.

The external session journal is authoritative. Pi stores revision references; `/tree` pauses execution without rewinding durable state or workspace files. Every model request receives the current goal projection. Session ID, goal ID and generation tags remove stale control prompts copied by fork/clone or left over after clear. The original conversation is retained.

## Commands and TUI

The main help focuses on creating, adding, approving, pausing, resuming and clearing goals. `/goal` shows state; ordinary messages supply amendments, and the model plans automatically. Panel, skip and optional settings live under `help more`. Old English shortcuts remain compatible; take-over/release only explain their retirement. Explicit skip is already authorization and requires no second dialog. All modifications to approved specifications require user approval, including task additions/reordering.

Approval uses a complete labeled plain-text summary, shared by RPC confirmation and a bounded scrollable TUI overlay via public `ctx.ui.custom`. Text handles Unicode wrapping and ScrollView handles scroll position; fixed action hints remain visible. Decline leaves the proposal pending; the same ownership/generation fence is checked before applying an accepted proposal. No-UI exact-revision approval is unchanged.

Pi's public `setStatus` and `setWidget` APIs render an English card using the current theme. The default six-line card separates task progress and evidence coverage from independent acceptance; only complete displays Verified. Proposed scope displays its new tasks and criteria, not old completion counts. Unknown usage is visible.

`panel` toggles visibility, `panel expand/compact` changes detail and `show/hide` is explicit. Hiding the card keeps the status bar and execution. Clear hides both; a new selected goal shows the compact card. A `my-pi-goal-panel` custom entry stores the session ID and mode. `getEntries()` restores this session-wide preference across tree navigation; copied entries from a different fork/clone session ID do not apply.

The render callback uses an in-memory snapshot, not journal reads. It reads the current theme after invalidation. Terminal-width measurement, truncation and control-sequence cleanup handle Unicode, emoji and long content. Expanded sections show at most three entries, prioritize active tasks and shrink to the available height. At 12–39 columns the card is borderless; below 12 it becomes one line, and at zero it emits nothing. Header clipping also bounds longer English labels.

## Model lifecycle tools

`goal_create` accepts a current session ID, expected journal revision and objective. It shares command creation logic, refuses any unfinished goal (including an unselected queue head), checks the revision inside the ownership transaction and again before appending, and returns the ID plus planning instructions. It uses the existing simple-objective heuristic; no model-controlled fast-start flag or approval tool is exposed. Calls from an aborted operation are rejected without creation. It runs within the current model turn and never schedules a competing kickoff.

`goal_resume` checks ID/generation, pending scope, cumulative budget and the selected goal/queue head, then uses the same resume mutation as the command. An active goal is a no-op; it cannot reset protection counters. Stop transitions record `resumeAfterInput`, the current supplement count. Model resume requires a later real user message; extension-generated input does not satisfy this guard. Old stopped journals gain the guard in their current projection. This is a control boundary, not semantic proof that arbitrary user text authorizes resumption: tool/context guidance still requires the current user request to warrant it. Explicit `/goal resume` remains available.

Lifecycle tools pass the generic paused/draft tool hook so their own checks can run. `goal_plan` therefore supports paused/blocked/budget-limited proposals, but cannot approve them; unapproved implementation tools remain blocked. See [the lifecycle contract](model-goals.md) and real SDK tests.

## Native continuation

`agent_before_settle` appends one custom-message draft and returns `continue: true` when the goal is active, there is no pending user input and no budget/stagnation pause. The extension does not schedule competing timers from `agent_end`.

On the tested host, `context.canContinue` describes the transcript before the draft. It is often false after a final assistant response; the new message makes it runnable and Pi validates the resulting transcript. Checking that old value before adding the draft would prevent native continuation. Real SDK tests cover the behavior.

## Completion and budgets

Submission requires criterion evidence, finished tasks and current main-session check records from `goal_check`. `goal_submit` enters verifying and creates a temporary independent model context with only read/search/list/record/request/result tools. It receives the approved contract and indexed evidence. A later response must inspect actual artifacts before reporting one finding per criterion. `audit_request` returns a durable `needs_info` request to the main session; `goal_reply` records its answer, and a new submission performs a fresh review. Answers never complete a goal. Source and inspected-artifact changes invalidate a pass; cancellation, generation and ownership fences remain effective.

Only a valid current result can complete a goal and advance FIFO. Failed audits produce actionable repair feedback without adding optional scope. Audit diagnostics record request counts, context sizes, tool counts, stop reasons and usage.

Goal-level protections are three automatic repairs after the initial failure, a three-turn no-progress warning/five-turn diagnosis and pause, and optional cumulative goal tokens (unlimited by default). Overall execution/audit turn and time caps, audit-only tokens, model response-output caps and diagnosis deadlines remain removed. Disposable verification workloads have separate personal-profile CPU/memory/process limits, bounded output and provision/check/cleanup deadlines. Host/provider limits, cancellation, paging and journal-size boundaries also remain.

No `maxTokens` is sent by default. With an explicit cumulative goal budget, estimated input constrains the next request and remaining output; actual provider usage including caches determines accounting. A final request may overshoot. Unknown usage is marked; this is not a hard spending cap. Budget errors do not consume implementation repair attempts, weaken criteria or reset evidence. Old configuration fields are discarded after original journal integrity validation; new snapshots append without rewriting historical records.

The diagnostic prompt requests English product text, retaining quoted user content in its original language. Complete generated diagnoses are preserved in the returned result, journal and notification; the former silent 8,000-character result truncation has been removed.

Stagnation uses tool-result fingerprints and recorded progress. Cancellation propagates to nested main-session checks, audits and diagnosis. The main agent and auditor have no overall plugin time cap; host tools and provider limits still apply.

## Authorization and research

The default autonomous policy removes Goal's repeated per-tool prompts within approved scope. Network/install default to allow; explicit ask settings override that default. Confirm mode adds cooperative command/path/tool checks. These do not override Pi, other extensions, system permissions or the user's scope, and do not sandbox arbitrary scripts. Exact grants are cached per goal; policy changes clear them and invalidate pending dialogs.

Every change to an approved specification first saves a pending proposal and pauses execution until user approval. Task refinement is recognized at approval time and preserves existing objective, kind, criteria, checks, task text, IDs and evidence; new tasks receive new IDs. Repeating an identical specification is a no-op. General scope approval applies the replacement and resets affected specification evidence as before. Research requires a report, manifest, provenance and reproducible scripts/commands; input and citations cannot be fabricated. Semantic/scientific validity still requires domain review.

Execution is delegated to the main session via `ctx.executeTool("bash", ...)`, so normal validation, hooks and permissions apply. Check records use structured exit metadata and cannot be forged by stdout. The reviewer exposes no command, mutation, MCP or inherited extension capability. Source metadata markers and exact read/listing digests detect stale evidence within their documented scope. This is not OS isolation or an atomic filesystem snapshot. See [review boundaries](read-only-review.md).

## Validation scope

Tests cover budgets and legacy migration, request/answer/resubmission, source and artifact freshness, command-result provenance, cancellation, evidence, logs, independent sessions, ownership, clear/stale callbacks, FIFO, approval and permissions. Actual Pi 1.3.0/1.4.0 SDK fixtures execute commands in temporary workspaces and exercise reviewer requests, saved-session reopen, native continuation, release and cancellation using offline providers. Entry-loading tests require `/goal` and all ten tools. Formal models cover finite protocol gates; host execution and semantic judgments remain outside their proof scope.

[Formal verification](../verification/README.md) and its [report](../verification/REPORT.md) describe fourteen finite abstractions: audit, queue, journal transactions, session isolation, lifecycle, permissions, accounting, recovery, context, inspection, checks, verification, scheduling and automatic clearing. A [coverage inventory](../verification/COVERAGE.md) and direct bounded implementation enumeration complement them. They have positive checks, conditional liveness and deliberate fault controls, but no machine-checked TypeScript refinement or composition proof. A historical add/FIFO defect was found and fixed; completed selections remain until settle advances the queue.

Real-model 5–12 hour stability, non-Linux behavior remains untested; Pi releases outside the rolling support window are unsupported. Future work prioritizes real task runs before daemons, dedicated remote/browser adapters, notifications or parallel agents.
