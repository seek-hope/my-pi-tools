# Control protocol verification report

Current timestamps, source hashes, outcomes and finite-state counts are recorded in the [TLC/implementation receipt](results/summary.json), [bounded contracts](results/contracts.json) and [dual-host receipt](results/compatibility.json). These receipts determine whether evidence matches the current tree. `verify:evidence` also validates the referenced local logs; rerun the documented commands when those generated logs are absent.

## Current architecture

Commands and file changes belong to the main Pi session. `goal_check` delegates an approved command to its `bash` tool and records actual structured exit metadata. `goal_submit` requires current passing records and creates a temporary read-only review context. No Docker, VM, copied-source or proxy execution backend remains.

The reviewer can return `audit_request` with a criterion, question and optional approved check ID. Goal persists the request and yields it to the main session without counting a repair failure. `goal_reply` records an answer; a fresh review must still inspect artifacts before a verdict. Request identity/generation, cancellation, ownership, budget and freshness gates remain enforced. See [the execution and review design](../docs/read-only-review.md).

## Verification matrix

The matrix contains **76 configurations**, comprising **16 positive checks** and **60 deliberate fault/missing-assumption controls**, across fourteen finite models. Fourteen bounded implementation groups exercise actual TypeScript functions; their domains and assertion counts are in the contract receipt.

- Audit, Inspection and Lifecycle cover approved scope, recorded evidence, later-response artifact inspection, unique findings, completion, generation and resume gates.
- CheckProtocol covers main-session result metadata, cancellation, identity and failed-check rejection. Its missing-metadata control replaces the retired sandbox-availability control.
- VerificationProtocol covers current versions, information requests excluded from repair accounting, unanswered requests preventing completion, and fresh inspection after an answer. Its four controls deliberately remove those guards.
- Queue and Scheduling cover FIFO, user-input priority, outcome/gate checks and ownership release.
- Session, Journal, Recovery and AutoClear cover session isolation, writer periods, append continuity, recovery decisions, verified clearing and final usage.
- Permission, Accounting and Context cover exact authorization keys, cumulative usage, stagnation counters and fresh control-message projection.

All negative controls must produce the exact expected invariant or temporal violation. Parse errors, unrelated nonzero exits and missing counterexamples fail verification. These are separate abstractions, not a composition theorem, generated TypeScript refinement or proof that model judgment is correct. The [coverage inventory](COVERAGE.md) records production mappings and exclusions.

## Implementation and SDK evidence

The ordinary suite exercises runtime, store, request/reply, tools and review boundaries. Actual Pi **1.3.0 and 1.4.0** integrations use offline providers and temporary workspaces; they validate tool registration, real main-session command dispatch, native continuation, request/answer/resubmission, saved-session reopening, cancellation and final usage. No paid model call is required or claimed by those fixtures.

New regressions cover:

- Missing, failed, legacy or stale check records cannot open completion review; stdout cannot forge structured exit metadata. Reruns invalidate prior success even when interrupted, and changes during execution prevent certification.
- Actual SDK hooks can deny or rewrite nested commands, or terminate a run without another model request. Receipts bind to the executed command observed in `tool_result.input`, rather than pre-hook arguments.
- Same-generation progress changes during asynchronous submission inventory are revalidated. Stale IDs for the new tools cannot claim ownership of or block a paused replacement goal.
- The read-only registry exposes no execution, mutation, general dispatcher, MCP or recursive delegation tool.
- Requests return to the main session, persist in the journal and do not spend repair attempts. Answers alone cannot pass or satisfy artifact inspection, and replies cannot mutate original audit records through shared references.
- Committed state is a detached JSON tree: cached snapshots and fresh journal reads agree, including optional undefined properties; caller-owned objects cannot mutate the committed cache.
- Derived check reports distinguish recorded passes from zero-exit rejected or legacy receipts, and show rewritten commands and changed inputs.
- Session-only cancellation is honored before and during review. Missing tools required for outstanding checks/replies pause continuation instead of requesting impossible work.
- Unknown/stale request IDs, requests outside approved criteria/checks, and a request alongside a verdict cannot bypass review.
- Source changes invalidate check records. Changes, deletion or retargeting of inspected artifacts, or an unreadable final inventory, invalidate a pass while retaining incurred usage and avoiding repair-failure accounting.
- Internal hardlinks and symlinks remain usable without a copied-source policy. Outside-project reads are rejected. File reads enforce the actual byte limit even after growth and reject invalid UTF-8; read observations retain paths/digests instead of full artifact bodies.
- Canonical Pi control paths and ordinary generated/dependency directories do not invalidate source records, including in symlinked workspaces. Ordinary source files named `build` remain tracked; explicitly reviewed generated files still receive content checks.
- Old sandbox configuration does not block startup or select a command runner; old check records remain historical evidence and need rerunning for unfinished goals.

## Assumptions and limits

Main-session tools, permission hooks, the controller, provider transport and local filesystem are trusted. Source markers use metadata with documented exclusions; inspected text and listings use digests. These are freshness checks, not immutable snapshots, a full dependency/environment model or protection against a malicious process with the same host privileges. Check stdout remains project-generated data even when the tool's exit status is authentic.

The reviewer supplies independent context and read-only capabilities. It does not independently rerun commands, isolate untrusted project execution or guarantee the correctness of every acceptance judgment. No long-running paid-provider benchmark, exhaustive host-extension composition or OS security certification is claimed.

## Historical work

Earlier versions used bubblewrap and later Docker Sandboxes. Their runtime configuration, cleanup mechanisms and microVM acceptance no longer describe the current product. The previous code, detailed historical report and bounded 16-case microVM receipt are preserved at [commit 759dc8f](https://github.com/seek-hope/my-pi-tools/tree/759dc8f/goal). Their source hashes must not be presented as evidence for this implementation.

Historical UI, lifecycle and host-upgrade notes remain under `docs/compatibility/`. Journal history remains append-only; this migration changes current projections and runtime behavior without rewriting historical entries. Current claims should use the new source-bound receipts linked above.
