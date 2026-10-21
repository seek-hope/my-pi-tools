# Model prompts

The executor receives request-local control messages assembled from the current session journal. The plugin preserves Pi's system prompt, ordinary conversation, other extensions' messages and tool results. It does not rewrite the persisted transcript. Prompt text cannot override host or user instructions; runtime guards enforce approval, identity and completion separately.

## Executor projection

Every request gets `sessionContext`: session identity, revision, selected goal, queue state and lifecycle guidance, including explicit empty state after manual or automatic clearing. An owned unfinished selected goal gets one current `goalContext` containing its full objective, criteria, tasks and supplements, indexed evidence counts/previews, and the declared verification environment, with the existing bounded check-output/notes views. `goal_evidence` pages a criterion or task record by ID; the default `goal_status` view uses the same compact evidence index and accepts `view: "full"` when the complete projection is needed. Historic snapshots in control messages are removed from the request projection.

Exactly one fresh `WORK_RULES` control message is generated when this runtime owns unfinished selected work or a valid nonselected planning request. The rules are rebuilt even after compaction; they are not copied into kickoff, continuation or lifecycle-tool return instructions. This guarantee concerns plugin-generated control messages, not text quoted in ordinary conversation or preserved historical tool results. No rules are generated for an empty, completed or unowned session without eligible planning work.

Startup and continuation messages trigger the host lifecycle but do not accumulate in model context. For a nonselected goal, a valid work-message identity retains the planning request: the plugin regenerates one current snapshot per goal and explicitly prohibits execution, selection changes or FIFO bypass. Wrong session, old generation, missing/finished goals and unowned controls are discarded. The ordinary conversation and tool-call/result sequence remain intact.

`WORK_RULES` covers autonomous work inside approved scope, evidence/checkpoints, completion submission, genuine blockers, research provenance and budget/stop boundaries. Every change to an approved specification requires user approval, including task additions/reordering. Progress, evidence, routine implementation decisions and strategy changes within the approved scope do not require scope approval. Initial simple-plan acceptance and identical-spec no-ops remain runtime decisions.

## Independent audit

The auditor runs in a fresh context with a read-only system prompt and `auditPrompt` containing the complete approved contract and evidence indexes. `audit_read` and `audit_search` inspect actual artifacts; `audit_check` reruns approved checks in the goal's frozen verification environment. `audit_list` only navigates directories. `audit_record` retrieves frozen executor evidence and recorded check output. Listing directories or reading those records alone does not satisfy the inspection gate.

The auditor must receive and review an artifact inspection or approved-check result before calling `audit_result` in a later model response. A verdict alongside the first inspection is rejected. Findings must cover every criterion exactly once; missing or contradictory evidence fails. These requirements are in both the instructions/tool descriptions and the existing runtime checks. An environment that prevents a check from running is never evidence of success. Optional polish does not expand the approved contract.

## Stagnation diagnosis

A separate diagnostic prompt requests concise English product text while preserving quoted user content in its original language. It identifies repetition, assesses evidence of progress and proposes a different next experiment or necessary user decision. It cannot declare completion or weaken criteria.

The complete diagnostic text is returned, recorded in the journal and passed to the notification; it has no separate 8,000-character truncation. Empty-response validation, cumulative token accounting, an explicitly configured goal budget and cancellation still apply. Host/provider constraints, bounded input excerpts and the journal's general resource boundary remain unchanged.

## Verification

Runtime regressions cover ten repeated continuations, pre-upgrade control messages, fresh evidence, repeated projection, compaction, queued planning, unowned/session/generation boundaries and preserved conversation. Storage regressions cover delta journals, periodic snapshots, cache invalidation and tamper detection; evidence paging is read-only and rejects stale generations and out-of-range requests. Real SDK fixtures assert one policy copy through creation, continuation, audit completion and clearing. Audit tests exercise navigation-only rejection and later-response submission. Diagnostic tests preserve a long multilingual result through return, journal storage and notification, alongside usage/budget/cancellation checks.

The bounded context implementation enumeration and ContextProtocol model check structural projection properties; the model uses two projection steps and an accumulation fault control. They do not prove that a model understands or follows the prompts. Performance claims require measurements with a real provider; character-count fixtures alone do not establish token savings or long-run reliability.
