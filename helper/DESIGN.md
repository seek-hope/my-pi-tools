# Helper design

Helper creates one temporary, read-only Pi SDK session per explicit delegation. The main session waits for the result and decides how to use it. See the [English README](README.md) or [中文说明](README.zh-CN.md) for installation and configuration.

## Responsibilities

Pi owns model/tool scheduling, argument validation, ordinary tool-error feedback, context projection, compaction and transient provider retries. Helper owns the initial task, permitted host-tool proxies, total timeout, cancellation propagation, result extraction and cleanup. There is no separate Helper conversation loop or error-message whitelist.

The single model-only tool accepts `task` and optional `context`, runs sequentially in the foreground, and returns an answer or partial findings. Each follow-up starts a fresh invocation.

## Session construction

`createAgentSession()` uses `SessionManager.inMemory(ctx.cwd)` and an explicit resource loader. The loader supplies a fixed Helper system prompt and empty extensions, skills, prompts, themes and AGENTS files. It never discovers project resources, MCP servers or Helper itself. The child receives no parent history, system prompt, reasoning or compaction summaries. Relevant project instructions belong in the explicit request.

Tools are the intersection of the host's callable tools with `read`, `grep`, `find` and `ls`. Each selected name has an SDK custom tool; the active tool list is explicit, including when empty. No disabled host tool gets a built-in fallback.

A small native provider delegates stream requests through the parent's public model registry, retaining configured provider/authentication behavior without copying credentials or using private runtime fields. The local runtime uses an in-memory credential store and no models file. The runtime has no disposal API; session cleanup is described below. Virtual routing models require an explicitly configured concrete Helper model because their router registrations cannot be obtained from the public registry.

The child uses in-memory Pi default settings, with cache warming and telemetry disabled. Parent settings and runtime toggles are not copied. Pi controls compaction and retries under its defaults and the model's limits.

## Parent tool hooks

Each child tool invokes `ctx.executeTool()` on the original parent tool context. This keeps parent validation, permission hooks, argument rewriting, result filtering and nested-call accounting in place. Child calls are sequential. Helper observes parent `tool_result` events to retrieve the actual post-hook arguments, reporting any rewrite to the child.

The child receives filtered model-facing content and the error flag; it does not receive parent tool usage or details. Ordinary executed errors go back to Pi for model correction. An error without `durationMs` indicates that the supported Pi host rejected execution, so Helper stops. A host `terminate` request takes precedence, aborts later work and propagates to the outer tool result. There is no direct local execution path around parent checks.

This preserves tool hooks, not arbitrary parent session/model hooks. Host extensions and tool implementations remain trusted. Tool-name restrictions do not provide filesystem or operating-system isolation.

## Lifecycle and results

A combined signal covers tool cancellation, parent cancellation, extension shutdown and the total timeout. A timer interrupts asynchronous work; monotonic-clock checks before model requests and host tools stop new work after synchronous code delays the timer. Native retry backoff and summarization are cancelled through `session.abort()`. All created sessions are aborted, unsubscribed and disposed in cleanup. The first cancellation or timeout cause is retained even if cleanup crosses the deadline; host termination takes precedence. Cancellation depends on provider/tool cooperation.

After `session.prompt()` settles, the latest raw persisted assistant attempt determines status. Using the model-facing projection here would lose failures omitted by native overflow recovery. The latest nonempty raw assistant text supplies the answer or partial output. Successful results omit raw tool diagnostics. Truncation and partial status follow the [public result contract](README.md#results-and-usage); output field limits are listed under [Session management and limits](README.md#session-management-and-limits). Pi manages model context, while Helper retains the configurable total timeout.

## Usage

The forwarding provider observes each stream's final result without consuming its events. It counts every reported model usage once, including compaction, summary retries and failed or cancelled attempts that never produce a persisted summary. It does not separately sum session entries, which would duplicate successful requests and omit unsuccessful summary attempts.

Missing/invalid usage and failed, aborted or unresolved requests mark accounting incomplete. Valid components remain available even when aggregate fields are absent or overflow. Optional reasoning and cache-retention breakdowns are subsets and do not increase totals. The tracker returns a snapshot; parent aggregation cannot mutate the Helper result.

Parent nested-tool usage is accounted by Pi. Forwarding it into the child would count it twice, so child tool results omit usage. Native turn events and forwarded host calls are exposed as diagnostic counts, not budgets.

## Implementation

| File | Responsibility |
| --- | --- |
| [extensions/index.ts](extensions/index.ts) | Extension entry and supported-version check |
| [src/index.ts](src/index.ts) | Registration, shutdown cancellation and executed-argument observation |
| [src/session.ts](src/session.ts) | Isolated native session, resource policy and provider forwarding |
| [src/runner.ts](src/runner.ts) | Read-only proxies, deadline, status/output extraction and cleanup |
| [src/usage.ts](src/usage.ts) | Request usage tracking and safe aggregation |
| [src/settings.ts](src/settings.ts) | Timeout/model configuration and validation |
| [src/compatibility.ts](src/compatibility.ts) | Supported Pi release pair |

## Verification

Tests use real Pi sessions and offline providers. They cover context/resource isolation, native error correction, host deny/rewrite/filter/terminate hooks, independent invocations, model selection, compaction/retry, cancellation/deadlines, cleanup and usage. They also verify that unavailable host tools have no local fallback. Recovery tests exercise failures omitted from the native projection and summary usage that is not persisted. No test depends on paid provider access.

The [compatibility script](scripts/check-compat.mjs) checks types, the complete suite and isolated extension loading on Pi 1.3.0 and 1.4.0. CI covers Node 22 and 24. These tests validate integration behavior, not answer quality or operating-system isolation.
