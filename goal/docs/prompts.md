# Model prompts

The executor receives request-local control messages assembled from the current session journal. The plugin preserves Pi's system prompt, ordinary conversation, other extensions' messages and tool results. It does not rewrite the persisted transcript. Prompt text cannot override host or user instructions; runtime guards enforce approval, identity and completion separately.

## Executor projection

Every request gets `sessionContext`: current identity, revision, selection, queue and lifecycle guidance, including empty state after clearing. An owned unfinished goal gets one fresh `goalContext` with its contract, supplements, evidence indexes, main-session check records and current reviewer requests. `goal_evidence` pages records, and `goal_status` supports compact or full views. Old generated control snapshots are removed from the request projection.

Exactly one fresh `WORK_RULES` control message is generated when this runtime owns unfinished selected work or a valid nonselected planning request. The rules are rebuilt even after compaction; they are not copied into kickoff, continuation or lifecycle-tool return instructions. This guarantee concerns plugin-generated control messages, not text quoted in ordinary conversation or preserved historical tool results. No rules are generated for an empty, completed or unowned session without eligible planning work.

Startup and continuation messages trigger the host lifecycle but do not accumulate in model context. For a nonselected goal, a valid work-message identity retains the planning request: the plugin regenerates one current snapshot per goal and explicitly prohibits execution, selection changes or FIFO bypass. Wrong session, old generation, missing/finished goals and unowned controls are discarded. The ordinary conversation and tool-call/result sequence remain intact.

`WORK_RULES` covers autonomous work inside approved scope, evidence/checkpoints, completion submission, genuine blockers, research provenance and budget/stop boundaries. Every change to an approved specification requires user approval, including task additions/reordering. Progress, evidence, routine implementation decisions and strategy changes within the approved scope do not require scope approval. Initial simple-plan acceptance and identical-spec no-ops remain runtime decisions.

## Independent audit

The reviewer runs in a fresh temporary context with the complete approved contract and evidence indexes. `audit_read` and `audit_search` inspect artifacts; `audit_list` navigates; `audit_record` pages executor evidence, actual main-session check outputs and replies. `audit_request` yields a question to the main session, which answers with `goal_reply` and resubmits. No execution, mutation, MCP or inherited extension tool is exposed.

The reviewer must receive and review an artifact read/search result before `audit_result` in a later response. Listing directories, reading records and reading replies do not satisfy inspection. Questions cannot accompany a passing verdict, and all criteria require one finding. Missing information can yield `needs_info` without consuming repair attempts. Claims, answers and file contents are treated as data; optional polish cannot expand the approved contract.

## Stagnation diagnosis

A separate diagnostic prompt requests concise English product text while preserving quoted user content in its original language. It identifies repetition, assesses evidence of progress and proposes a different next experiment or necessary user decision. It cannot declare completion or weaken criteria.

The complete diagnostic text is returned, recorded in the journal and passed to the notification; it has no separate 8,000-character truncation. Empty-response validation, cumulative token accounting, an explicitly configured goal budget and cancellation still apply. Host/provider constraints, bounded input excerpts and the journal's general resource boundary remain unchanged.

## Verification

Runtime regressions cover ten repeated continuations, pre-upgrade control messages, fresh evidence, repeated projection, compaction, queued planning, unowned/session/generation boundaries and preserved conversation. Storage regressions cover delta journals, periodic snapshots, cache invalidation and tamper detection; evidence paging is read-only and rejects stale generations and out-of-range requests. Real SDK fixtures assert one policy copy through creation, continuation, audit completion and clearing. Audit tests exercise navigation-only rejection and later-response submission. Diagnostic tests preserve a long multilingual result through return, journal storage and notification, alongside usage/budget/cancellation checks.

The bounded context implementation enumeration and ContextProtocol model check structural projection properties; the model uses two projection steps and an accumulation fault control. They do not prove that a model understands or follows the prompts. Performance claims require measurements with a real provider; character-count fixtures alone do not establish token savings or long-run reliability.
