# Helper replacement design

Status: implemented with per-request capability selection. See [the README](README.md) for the public API and configuration.

## Purpose

The main session delegates a specific task to an independent helper. The helper processes that request and returns its result. The main session decides whether and how to use the result, whether to ask another question, and whether the overall user task is complete.

The independent `helper/` package replaces Goal. Installation instructions, aggregate scripts and CI now reference Helper. Historical Goal code remains available in Git. The Helper runtime does not import Goal's controller, state machine, journal or completion gates.

## Context contract

Each invocation starts with a new message buffer containing only:

1. A short, fixed Helper system prompt.
2. The task and supplementary context explicitly supplied in the invocation.
3. Tool definitions allowed for that invocation.

During the invocation, the helper can retain its own model responses and tool results. The first version discards that conversation at the end; another invocation starts fresh. A follow-up therefore supplies the relevant previous result or missing information explicitly.

Do not copy or summarize the main session's messages, system prompt, reasoning, compaction summaries, Goal records or previous Helper conversations. Do not fork or resume the parent session. Do not automatically discover parent extensions, skills or context files as a side effect of creating a child session. Relevant project instructions can be supplied explicitly with the task.

The implementation may reuse model selection and credential resolution as infrastructure. These are separate from the conversation sent to the model. Sharing a workspace allows the helper to inspect project artifacts; context independence is not filesystem isolation.

## Invocation and termination

Expose one model-only delegation tool, `helper`, with an explicit `task`, optional `context`, and `mode: "read" | "work"` (default `read`). The main model calls it directly; it is not callable through a dispatcher. The initial version uses a foreground invocation; background jobs and persistent helper sessions are separate features.

The helper uses tools as needed and returns its normal final answer. It does not have to satisfy a mandatory audit-result schema to exit. If information is missing, it returns the question or limitation to the main session and ends the invocation; it does not wait indefinitely for a reply.

Return the answer together with execution metadata: model, finish reason, usage when available, and whether the invocation ended normally, failed, was cancelled or reached its configured limit. A normal answer is not an independent certification that the user's overall goal is complete. A limit or error must remain distinguishable from a complete answer, and partial output must remain marked as partial.

Use a finite configurable per-invocation model-turn limit, bounded tool outputs and propagated cancellation. Exhaustion returns control to the caller. The plugin must not automatically retry the task, issue a replacement request, recursively invoke itself or request another main-session turn. The first version should not add a global task queue, mandatory progress records or completion approval protocol.

## Tool capabilities

Per-request capability selection is implemented. Read mode offers only callable host `read`, `grep`, `find` and `ls` tools. Explicit work mode additionally permits callable `write`, `edit`, `bash` and `powershell` tools. Helper never activates disabled tools. When a host exposes only `read`, the caller must provide paths or enable the other read tools itself.

Every call uses the host's `ctx.executeTool` path, preserving validation, permission hooks, cancellation and termination. Adjusted arguments observed in tool-result events are included in the helper's tool result. A failure or denial ends this invocation; it is not automatically retried. This lets reviews remain read-only while a narrowly assigned implementation task can change files. An arbitrary dispatcher, parent-conversation reader, Goal controller and recursive Helper call are not exposed.

A tool-capable helper is not automatically an OS sandbox. Tool errors and host stop requests return as failures or stops, without being converted into successful answers or new autonomous work.

## Implementation approach

Use a small independent model runner with an explicit context and tool registry. The former Goal auditor demonstrated that the host model registry can accept a separately constructed context. Reuse this technique and the tested cancellation/termination handling, rather than its audit protocol or unlimited result-seeking loop.

If an SDK child session becomes necessary, construct its in-memory session, resource loader, settings and tool set explicitly. Pi's default session factory performs resource discovery and may persist state, so default construction alone does not establish the required isolation.

Keep the package independent from CodeGraph and Search. Tool integration with other installed packages must be explicit, without adding mandatory cross-package dependencies.

## Acceptance checks

- Capture the actual provider request: a sentinel in parent messages, system prompt and summaries is absent unless explicitly included in the invocation.
- Explicit task/context is present; the helper's own tool results are available within that invocation.
- Two invocations do not share conversation history or mutable result objects.
- A normal final answer returns immediately; missing information returns to the main session without a waiting or continuation loop.
- Repeated tool requests eventually reach the configured limit and return a partial result, without launching another invocation.
- Tool and session cancellation stop ongoing work, including cancellation in progress callbacks; host termination is preserved. A delayed timer does not permit further actions after the deadline.
- Known model usage is retained even if aggregate fields are missing, invalid totals remain marked incomplete, and native nested-tool usage is counted exactly once.
- Successful answers omit raw tool-result bodies; partial runs retain the last available result for diagnosis.
- A read-only invocation cannot execute commands, write files, read the parent transcript through a session tool or invoke Helper recursively.
- Real SDK tests check allowed writes, command execution and host deny/rewrite/terminate hooks.
- Loading Helper does not inject Goal state or install main-session continuation/completion gates.

## Migration

Goal's runtime, commands, tools, package-specific validation and documentation have been removed from the current tree after replacement tests passed. Root package scripts, README and CI reference Helper. Goal's old formal receipts are not relabeled as evidence for Helper; new tests exercise the new implementation.

Do not rewrite users' historical Goal journals or silently migrate them into Helper tasks. Previously installed Goal instances need to be unloaded when switching to Helper, so the old continuation hooks do not remain active alongside the new extension.
