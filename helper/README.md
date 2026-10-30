# Pi Helper

[中文说明](README.zh-CN.md) · [Design](DESIGN.md)

Delegate one explicit read-only task to a fresh, temporary Pi session. Pi manages the model loop, ordinary tool errors, context compaction and provider retries. Every file tool runs through the main session's permission hooks. The child returns its answer or partial findings and is disposed.

Supports **Pi 1.3.0 and 1.4.0** and Node.js ≥ 22.19. This package is independent of CodeGraph and Search.

## Install and invoke

```bash
pi install ./helper
```

Use `/reload` in an existing Pi session. Helper is a model-only tool called by the main model:

```json
{
  "task": "Review src/export.ts for Unicode filename handling. Return concrete issues with file locations.",
  "context": "Expected behavior: downloaded archives preserve original filenames."
}
```

`task` must be nonblank and at most 20,000 characters. Optional `context` is at most 120,000 characters. These are the only accepted request fields. Supply paths, relevant project rules and supporting material explicitly.

Each call creates an in-memory SDK session in the main session's working directory. It receives a fixed Helper prompt, explicit task/context, and available tool definitions. It does not copy the main conversation, system prompt, reasoning or compaction summaries, or reuse another Helper conversation. It does not discover `AGENTS.md`, skills, prompt templates, extensions or MCP servers. The caller supplies relevant instructions in `context`.

Calls run in the foreground, sequentially. There is no TUI, saved child transcript, background queue, recursive delegation or automatic continuation of the main conversation. A follow-up is a new explicit call.

## Tools and permissions

The available tools are the intersection of `read`, `grep`, `find`, `ls` and the main session's currently callable tools. There are no writing, editing or command tools. Unavailable host tools have no local fallback.

With Pi's default tool selection, Helper may have only `read`. For discovery and targeted searches, merge this into the project's `.pi/settings.json`, preserving existing tool choices:

```json
{
  "defaultTools": ["+grep", "+find", "+ls"]
}
```

Use `/reload` with the default tool selection, or restart Pi. Explicit `--tools` selections must include these tools too. This setting exposes navigation tools in the main session as well as Helper.

Child tools are thin proxies to the parent's `ctx.executeTool()`. Parent validation, permission checks, argument rewrites, result filtering, cancellation and termination remain active. The child receives the filtered content and a notice when the host rewrites arguments. This preserves tool hooks; it does not load parent extensions or copy their other session hooks into the child.

Ordinary executed tool errors, including a missing file, an invalid read range or an unsupported grep regex, are returned to Pi as tool errors. The model can correct its request. Helper does not maintain an error-message whitelist. A parent rejection before execution stops the invocation; in the supported Pi releases this is identified by an error outcome without `durationMs`. Host `terminate` takes precedence and is propagated to the main tool result.

Tool implementations and host extensions are trusted. A custom tool named `read` must actually be read-only. This is a tool capability boundary and separate model context, not an operating-system or filesystem sandbox.

## Session management and limits

Pi owns conversation growth, context compaction and transient provider retries. The child uses **Pi's built-in settings defaults**, including enabled compaction and retries; it does not inherit personal/project Pi settings or runtime toggles. Cache warming and install/analytics telemetry are disabled for the child. Compaction uses the selected model's context window and incurs model usage. Recovery gives the model a chance to continue; it does not guarantee a correct answer or recovery from every provider error.

Helper applies a total timeout, checked with a timer and monotonic-clock checkpoints before model requests and host tool calls. Cancellation from the tool, parent session, shutdown or timeout aborts the child, including native retry backoff and summarization. Cleanup awaits abort and disposes the session. Cancellation is cooperative: a provider or host tool that ignores its abort signal can delay completion. No process is forcibly killed.

Returned answers and diagnostic tool excerpts are bounded to 32,000 characters, with explicit truncation. An oversized answer is a partial `limited` result. Child tool content is handled by Pi and the host tools; the diagnostic excerpt does not impose a separate context budget. There is no Helper turn, tool-call or serialized-context limit, and the timeout is not a token or monetary budget.

## Results and usage

Results include `status`, `model`, `output`, `reason`, `partial`, `turns`, `toolCalls`, `toolsUsed`, `usage`, `usageIncomplete` and `outputTruncated`. Partial results may include `lastTool` with its name, error flag and bounded text excerpt. Successful answers omit that raw excerpt.

| Status | Meaning |
| --- | --- |
| `answered` | A normal final answer, including an explanation of missing evidence |
| `error` | Provider/session failure, host rejection, or no normal final answer |
| `cancelled` | Caller, session, shutdown or model cancellation |
| `limited` | Timeout, unrecovered model output limit or oversized answer |
| `terminated` | A host tool requested termination |

`answered` is a model response, not independent verification of the overall task. Other statuses have `partial: true`. The latest nonempty assistant text is retained when possible; it may be an intermediate finding. Invalid arguments or settings can be rejected before a result exists.

Status is determined from the latest persisted assistant attempt, including failures that Pi omits from its model-facing context during recovery. `turns` counts native `turn_start` events, including a turn cancelled before its provider request; summarization requests are separate. `toolCalls` counts forwarded parent calls, including parent rejections, and `toolsUsed` lists their unique names.

Usage is observed at the model forwarding boundary, so normal requests, compaction, failed attempts and summary retries are counted once, even if no summary is saved. Missing, invalid, failed or aborted request accounting is marked `usageIncomplete`. Known components survive missing aggregates; reasoning/cache-retention breakdowns do not increase totals twice. Pi adds nested host-tool usage separately. Helper does not replay that usage through the child or mutate its own recorded totals during host aggregation.

## Configuration

Optional Helper settings are read from:

1. `<Pi agent directory>/my-pi-helper.json`
2. `<workspace>/.pi/my-pi-helper.json`, overriding personal values

```json
{
  "timeoutSeconds": 1200
}
```

| Setting | Default | Values |
| --- | --- | --- |
| `timeoutSeconds` | 1,200 | Integer, 1–3,600 seconds |
| `provider`, `model` | Main session's model | Nonblank configured identifiers; set both together |
| `thinking` | Main session's thinking level | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |

Requests use the host's public model registry, retaining configured providers and request-time authentication without copying credentials. This integration requires a **physical model**. If the main session selects a virtual routing model, configure Helper's `provider` and `model` to a concrete model; virtual routing registrations are not exposed through the registry for reuse in the child.

Unknown settings, invalid ranges and incomplete model selection are rejected. Helper's configuration does not alter the main session's settings.

## Development and verification

```bash
npm --prefix helper ci --ignore-scripts
npm --prefix helper run check
npm --prefix helper test
npm --prefix helper run check:format
npm --prefix helper run check:compat
```

`check:compat` uses releases in `~/.pi/agent/install/releases` by default; pass another directory after `--` if needed. It copies this package into temporary directories to check types, the complete suite and isolated extension loading against both supported Pi versions without changing a live installation. CI covers Node 22 and 24.

Real SDK tests use offline providers and temporary files. They cover native navigation/error recovery, fresh contexts, disabled resource discovery, tool restrictions, parent deny/rewrite/filter/terminate hooks, compaction, retry, cancellation, cleanup, partial results and usage. Native navigation tests need `rg` and `fd` (or `fdfind`); CI installs them and disables automatic downloads. These tests validate integration behavior, not model-answer quality.

[MIT](../LICENSE)
