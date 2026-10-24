# Model-driven goal lifecycle

The model can manage a goal from ordinary conversation. Goal tools are available before a goal exists; slash commands remain available for direct user control. Tools operate only in the current Pi session and do not grant authority for unrelated work.

| Tool | Inputs and behavior |
| --- | --- |
| `goal_status` | Read current session ID, journal revision, goals, IDs/generations and lifecycle guidance. The default summary indexes evidence as counts and previews; pass `view: "full"` for the complete projection. |
| `goal_evidence` | Read one exact criterion or task evidence record by ID, with `index`, `offset` and `chars` pagination. Read-only: it never claims ownership or changes goal state. |
| `goal_create` | Pass `session_id`, `expected_revision` and `objective`. Creates only when no unfinished goal exists, returns its ID/generation and planning instructions. A cancelled, stale-revision or foreign-session request cannot create a goal. |
| `goal_plan` | Pass goal ID/generation and the complete objective, kind, criteria, tasks and checks. An eligible simple goal can accept its first plan automatically. All changes to an approved specification become pending proposals requiring user approval, including task changes. |
| `goal_resume` | Pass goal ID/generation. Resume approved stopped work for the user's current request after blockers are resolved. Pending approval, exhausted cumulative budget, another selected goal and an earlier queue head remain barriers. |
| `goal_environment` | Declare the runtime environment for approved checks: `workspace` (`readonly`/`ephemeral`), `network` (`isolated`/`allowlist`/`open`) and DNS `allow`/`deny` lists. Host `env` forwarding is unsupported and must remain empty. This is not a specification change, so it needs no `/goal approve`; explicit network permissions bind the exact policy. A control preflight checks sbx availability before applying it; actual VM provisioning happens during submission. See [verification environments](verification-environment.md). |
| `goal_progress` / `goal_submit` | Record claimed evidence and submit for approved mechanical checks plus independent audit. Creating or resuming a goal never bypasses completion verification. |

## Ordinary conversation

A user can say “Use a goal to fix the export bug and keep working until verified.” The model reads status, creates the goal, inspects the workspace, then submits a plan. Short/simple initial plans follow the same heuristic as `/goal <objective>`; larger or sensitive categories still require `/goal approve`. There is no model-controlled approval or fast-start flag. Classification is a heuristic, not a semantic risk proof.

The creation tool uses the current turn. It does not inject another kickoff or force every conversation into a goal. Once a plan is approved, normal native continuation keeps the goal running until completion or a legitimate stop.

“Continue the saved goal” lets the model read status and call `goal_resume`. A stop records the goal's user-input count; at least one later real user message must arrive before model resume can reset run/protection counters. That guard persists across reload and is projected onto older stopped journals. It prevents the same run from immediately undoing a user pause, cancellation, stagnation stop or failed-audit stop. An already active goal is a no-op, preserving counters. `/goal resume` remains an explicit user action and does not need an additional chat message.

The new-message guard does not classify authorization semantically. For example, “What is the status?” is not an instruction to resume. The model must still follow the actual user request and resolve blockers. Extension-generated continuation messages do not satisfy the guard. A previously blocked `goal_wait` can still resume through the existing input handler when the user supplies the missing input.

After independent verification, the next real user message automatically clears the finished session state if no unfinished queue remains. That message still reaches the model with an authoritative empty-state projection. Cleanup waits for a streaming final reply to be metered and never schedules its own model turn. Explicit `/goal clear` remains available for cancellation.

## Modifying approved work

The model may propose modifications while active, paused, blocked or budget-limited. General paused-tool restrictions no longer prevent `goal_plan` from reaching its own checks. It records a pending specification and stops implementation; it never approves its own proposal. User `/goal approve` or exact-revision approval remains necessary.

This also applies to task additions and reordering. After approval, a refinement that retains the objective, criteria, checks and existing task text keeps task IDs, completed statuses and evidence. Other approved replacements use the existing specification reset behavior. Repeating the identical accepted specification is a no-op. Updating progress, evidence and implementation strategy within that specification does not require another scope approval.

## Clearing a goal

`/goal clear` first commits an empty current snapshot and a `clearedAt` marker, then cancels work, hides the panel/status and releases ownership. It sends a model-visible custom message with `triggerTurn: false` in both interactive and non-interactive modes. It does not start a model request.

Each subsequent model request also gets a fresh session-state projection. An empty goal list explicitly says no current goal exists, old IDs are invalid and cancelled work must not be recreated without a new user request. This projection comes from the journal even after compaction, reload or transcript branch navigation. Forks use their own session state. Chat, files and historical journal entries remain intact.

If a stale model call still uses a removed ID, goal mutation tools return a normal explanatory result with `disposition: stale_goal`. They do not claim ownership, write evidence, pause a replacement goal, run checks or claim a successful audit. Existing-ID generation errors remain guarded. A creation request prepared before clear fails its session/revision guard instead of recreating a goal.

## Validation and limits

Runtime regressions cover empty-state projection, TUI clear messaging, stale calls, creation revision/session/cancellation guards, queue protection, same-run resume rejection, budget/approval guards and evidence-preserving approved task amendments. Real Pi SDK tests exercise model creation from plain text, native continuation, independent audit, clear during worker/auditor requests, subsequent conversation, paused modification, user approval and model resume.

The supported pair is **Pi 1.3.0 / 1.4.0**; current counts and source hashes are recorded in the [dual-host receipt](../verification/results/compatibility.json). The original lifecycle rollout passed 90/90 tests on Pi 1.0.4 / 1.1.0; those [1.0.4](compatibility/model-lifecycle-pi-1.0.4.log) and [1.1.0](compatibility/model-lifecycle-pi-1.1.0.log) logs are historical evidence, not the current support window.

The [finite lifecycle model](../verification/LifecycleProtocol.tla) checks creation identity, pending approval, stop-input boundaries and resume budget checks. [Verification documentation](../verification/README.md) records the bounds and controls. Model compliance with natural-language instructions, real-provider long-run behavior and arbitrary host/extension combinations are not proven by these fixtures or finite models.
