# Helper design

Helper handles one explicit delegation in an independent model context and returns the result to the main session. The main session decides how to use that result and whether another request is needed.

See the [English README](README.md) or [中文说明](README.zh-CN.md) for installation, invocation examples and configuration.

## Invocation

The extension registers one `helper` tool with an explicit `task`, optional `context`, and `mode: "read" | "work"`. The default mode is `read`. The tool is model-only: the main model calls it directly. Invocations run in the foreground and use sequential execution.

A normal model answer ends the invocation. If essential information is missing, the helper returns a question or explanation. The caller supplies any follow-up material in a new request. Helper does not automatically retry tasks, resume the main session or create persistent child sessions.

## Context

Each invocation constructs a new model context containing:

1. A fixed Helper system prompt.
2. The task, mode and supplementary context supplied by the caller.
3. Definitions for the tools allowed in that invocation.

The helper retains its own model responses and tool results during the call. Another invocation starts with a new message buffer and does not reuse that conversation.

The runner does not copy the main session's messages, system prompt, hidden reasoning or compaction summaries. It does not use a child-session factory that discovers extensions, skills or context files. The caller supplies relevant project instructions explicitly.

Model selection, thinking level and credential resolution use the host's configured model infrastructure. The initial context contains only the inputs listed above. Workspace access does not provide filesystem isolation.

## Tool capabilities

The tool set is the intersection of an explicit allowlist and the host's currently callable tools:

| Mode | Eligible tools |
| --- | --- |
| `read` | `read`, `grep`, `find`, `ls` |
| `work` | Read tools plus `write`, `edit`, `bash`, `powershell` |

The runner copies tool definitions into the model context and sends every execution through `ctx.executeTool`. Native argument validation, permission hooks, cancellation and termination remain in effect. Host tool-result events supply the arguments actually executed after hook rewrites.

Before any member of a tool batch runs, the runner checks the available tool names, schemas, SDK argument-parsing errors and call IDs. Invalid or reused IDs reject the batch. A failed or denied tool ends the invocation with a partial result. Host termination is propagated to the main tool result.

Tool implementations and host extensions are trusted. Work-mode changes remain in the shared workspace; Helper does not provide rollback or an operating-system sandbox.

## Limits and cancellation

Settings bound model requests, tool calls, elapsed time and serialized context size. Defaults and allowed ranges are listed in the [configuration reference](README.md#configuration). Each model request uses the selected model's own output-token limit. Tool-result excerpts and returned answers have separate character limits.

A model request may use the last tool result to produce an answer after the tool-call allowance is exhausted, provided the other limits permit it. Any further tool batch is rejected. On the last allowed model turn, tool calls are rejected because no later model request could consume their results.

Tool, session, shutdown and deadline cancellation signals are combined. A timer aborts pending work, and monotonic-clock checks between operations prevent further actions when synchronous code has delayed the timer. Cancellation is cooperative with providers and host tools; it does not forcibly interrupt arbitrary extension code.

## Results and usage

Results distinguish normal answers, errors, cancellation, limits and host termination. A normal answer is assistance; the main session assesses whether the overall task is complete.

Partial runs retain the latest nonempty model text and last available tool result, with truncation marked explicitly. Successful answers omit raw tool-result bodies so inspected files are not unnecessarily replayed into the caller's context.

Usage records the helper's model requests. Known components are retained when aggregate fields are missing, and incomplete or invalid usage is marked. Optional reasoning and cache-retention breakdowns are accumulated without increasing totals twice. Pi accounts for nested-tool usage separately; the extension returns a copy of model usage so host aggregation does not mutate the recorded result.

## Implementation

| File | Responsibility |
| --- | --- |
| [extensions/index.ts](extensions/index.ts) | Pi extension entry and supported-version check |
| [src/index.ts](src/index.ts) | Tool registration, shutdown handling and observation of executed arguments |
| [src/runner.ts](src/runner.ts) | Independent model context, bounded execution, host tool routing and result accounting |
| [src/settings.ts](src/settings.ts) | Defaults, validation and personal/project configuration loading |
| [src/compatibility.ts](src/compatibility.ts) | Supported Pi release pair |

The runner calls `ctx.modelRegistry.streamSimple` with its own context. The package has no runtime dependency on the repository's CodeGraph or Search packages.

## Verification

Offline provider fixtures and real Pi SDK tests cover:

- Absence of parent-session sentinels from provider requests and presence of explicitly supplied material.
- Tool-result retention within one invocation and independent state across invocations.
- Read-only capability boundaries, allowed work-mode edits and commands, and native deny/rewrite/terminate hooks.
- Batch rejection before side effects, cancellation, delayed timers and execution limits.
- Model selection, use of the model's output limit, usage accounting and partial-result preservation.
- Registration of one model-only tool and observation/shutdown hooks, without main-session continuation hooks.

The [compatibility script](scripts/check-compat.mjs) checks types, the full Helper suite and isolated extension loading against both supported Pi releases. CI runs the repository checks with Node 22 and 24. These checks validate runtime behavior and integration, not model-answer quality.
