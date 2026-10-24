# Requirements and decisions

Three interview rounds established the original scope; the user twice approved the recommended implementation. Later requests added improved TUI, Pi compatibility (subsequently narrowed to a rolling two-release window), autonomy after approval, removal of redundant execution budgets, session isolation, clear, automatic ownership, fewer commands and an English interface with bilingual root READMEs.

## User requirements

| Area | Requirement |
| --- | --- |
| Main tasks | Complex repairs, research analysis and building projects from requirements |
| Autonomy | Clarify initially, then continue authorized work while the user is away for 5–12 hours |
| Problems to prevent | Premature stopping, forgotten requirements, scope drift and unsupported completion claims |
| Organization | One active goal with subtasks and a sequential FIFO queue |
| Completion | Actual checks plus an independent AI audit |
| User input | Supplement the current goal unless explicitly pausing or replacing it |
| Session scope | Separate goals, queues and panel preferences by Pi session ID, including same-directory sessions |
| Clear | Manual clear cancels current-session work; after verified completion, the next real message automatically clears finished state if no unfinished queue remains, without cancelling the message; retain journal history |
| Ownership | Automatically acquire/release write ownership; remove manual takeover/release from normal use |
| Simplicity | Minimize commands and routine approval burden; use ordinary conversation for requirements |
| Language | English UI, messages, tools, examples and supporting docs; English and Chinese READMEs |

## Adopted behavior

| Decision | Implementation |
| --- | --- |
| Startup | Inspect and propose scope; short simple goals may accept initial scope automatically, complex goals require approval; legacy start remains an explicit shortcut |
| Audit model | A fresh context using the current model through the public registry; optional provider/model/thinking override |
| Audit tools | Restricted file/search/list/record reads, approved checks and criterion verdicts; no general shell or writes |
| Failure | Repair automatically after the first failure, up to three repair attempts; pause after the fourth consecutive failed audit |
| Budgets | Unlimited by default; only optional cumulative goal tokens remain, alongside repair and stagnation protection |
| Stagnation | Warn after three no-progress turns; independently diagnose and pause after five; no automatic model switching or subagent orchestration |
| Queue | FIFO, per-goal approval, explicit skip, pause and history retention |
| Amendments | Record ordinary messages; goal_plan proposes changes even while paused/blocked; every approved-spec modification, including task changes, requires user approval |
| Permissions | Autonomous by default; explicit network/install ask and host/user restrictions remain effective; optional confirm mode |
| Verification | Main-session `goal_check` records real approved-command results; temporary read-only reviewers inspect artifacts, request information through `audit_request`, and require a fresh review after `goal_reply`; stale inputs and unresolved requests cannot complete |
| Model lifecycle | goal_create creates with session/revision fencing; goal_resume continues approved work after a new user instruction; neither tool approves modifications or bypasses stops |
| Commands | Create, add, approve, pause, resume and clear in main help; /goal shows state; panel/skip/settings in detailed help; old English shortcuts remain compatible |
| UI | Theme-aware English card, separate task/evidence indicators, bounded detail, narrow-width/height support, persistent session-local visibility |
| Persistence | Session-keyed journal under the project root, with revision references in Pi; /tree does not rewind durable records |
| Writers | Independent sessions can own their own journals; same-session instances serialize, rotate ownership tokens and cannot steal a live writer |
| Shutdown | Persist and release; require explicit resume after reload/restart/session replacement; Pi must remain alive for continued work |
| Research | Markdown report, manifest, input/software/reference provenance, actual commands and reproducible scripts; explain inapplicable requirements |
| External tools | Reuse authorized installed tools; dedicated SSH/browser/MCP adapters, notifications and parallel orchestration remain future work |
| Distribution | Private local Pi package registered globally, not an npm release |
| Compatibility | Public Pi APIs; only current and immediately preceding releases (1.4.0/1.3.0), exact peer ranges, entry guard and isolated dual-version checks |

The budget decision superseded the earlier 200-turn/12-hour suggestion: execution/audit turn caps, overall goal/audit time caps, separate audit tokens and diagnosis deadlines remain removed, including for old configurations. Checks use the main session tool settings and cancellation. A configured token budget includes repeated input and cache usage and may overshoot; it is not a hard monetary cap.

Autonomous execution supersedes the early network/install/per-tool approval recommendation. It authorizes routine work within approved scope, not arbitrary unrelated effects. Policies persist per goal. Material specification approval and independent verification remain explicit boundaries.

Model lifecycle support supersedes command-only creation/resumption. Clear now supplies a durable empty-state projection to the model; stale IDs yield non-mutating feedback. The latest amendment rule supersedes automatic task additions/reordering: all approved-spec modifications wait for user approval, while approved refinements preserve evidence.

Session isolation supersedes the former directory-shared journal/manual takeover design. Legacy history is copied intact to its last owning session after validation and release, without deleting the original. Existing target journals, including cleared snapshots, prevent repeated import. User content and approved history retain their original language; exact old research standards are recognized without weakening them.

## Scenarios and boundaries

[Example specifications](../examples/goal-specs.json) are explicitly synthetic: CSV export repair, descriptive analysis of synthetic data, and a local JSON task CLI. They do not represent completed user research. Integration tests use temporary workspaces and offline providers, not paid API calls.

- Read-only review is enforced by its explicit tool registry; all commands and mutations belong to the main session and its existing permission checks. Goal does not provide OS isolation.
- Optional main-agent permission checks are cooperative and cannot detect all side effects of arbitrary scripts.
- Recorded progress and model findings are judgments; an arbitrary completion percentage never lowers acceptance criteria.
- A live writer is not forcibly displaced while shell/tool work may still run. Unknown cross-host liveness is treated conservatively.
- Different sessions share project files despite separate goal journals; branch navigation cannot undo workspace facts.
- Real-model 5–12 hour stability, non-Linux validation remain outstanding. Other Pi releases are outside the rolling support window.

See [research](research.md) for historical design inputs, [design](design.md) for implementation boundaries and the [README](../README.md) for current usage.
