# Pi Helper

[中文说明](README.zh-CN.md) · [Design](DESIGN.md)

Delegate one explicit read-only task to a fresh, temporary Pi session. Pi manages the model loop, ordinary tool errors, context compaction and provider retries. Every file tool runs through the main session's permission hooks. The child returns its answer or partial findings and is disposed.

Supports **Pi 1.3.0 and 1.4.0** and Node.js ≥ 22.19. This package is independent of CodeGraph and Search.

## Install and invoke

From the repository root:

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

Calls run in the foreground, sequentially, in the main session's working directory. Each has its own conversation and receives only the fixed Helper prompt, explicit request and available tools. Parent history, system instructions, reasoning and summaries are not inherited; `AGENTS.md`, skills, prompt templates, extensions and MCP servers are not discovered. Include relevant project rules in `context`.

The child has no TUI or saved transcript and cannot delegate further. A follow-up starts a new call; Helper does not queue background work or resume the main conversation.

## Tools and permissions

The available tools are the intersection of `read`, `grep`, `find`, `ls` and the main session's currently callable tools. There are no writing, editing or command tools. Unavailable host tools have no local fallback.

With Pi's default tool selection, Helper may have only `read`. For discovery and targeted searches, merge this into the project's `.pi/settings.json`, preserving existing tool choices:

```json
{
  "defaultTools": ["+grep", "+find", "+ls"]
}
```

Use `/reload` with the default tool selection, or restart Pi. Explicit `--tools` selections must include these tools too. This setting exposes navigation tools in the main session as well as Helper.

Every tool runs through the main session's permission hooks, preserving validation, argument rewrites, result filtering, cancellation and termination. The child receives filtered content and a notice of rewritten arguments. Other parent session hooks are not copied.

Ordinary tool errors, such as missing files, invalid read ranges or unsupported grep regexes, are returned to the model for correction. A parent rejection before execution stops Helper. Host `terminate` takes precedence and propagates to the main tool result. See [Parent tool hooks](DESIGN.md#parent-tool-hooks) for the forwarding contract.

Tool implementations and host extensions are trusted. A custom tool named `read` must actually be read-only. This is a tool capability boundary and separate model context, not an operating-system or filesystem sandbox.

## Session management and limits

Pi owns conversation growth, context compaction and transient provider retries. The child uses **Pi's built-in settings defaults**, including enabled compaction and retries; it does not inherit personal/project Pi settings or runtime toggles. Cache warming and install/analytics telemetry are disabled for the child. Compaction uses the selected model's context window and incurs model usage. Recovery gives the model a chance to continue; it does not guarantee a correct answer or recovery from every provider error.

A total timeout or cancellation from the caller, parent session or shutdown stops the child, including retry waits and summarization. Cleanup waits for abort and disposes the session. Providers and tools must cooperate with cancellation; an implementation that ignores the signal can delay completion.

Returned fields have separate character limits: `output` and `lastTool.output` are each bounded to 32,000; `reason` is bounded to 4,000. These are not a limit on the whole result object or the child's context. Truncation is explicit, and an oversized answer produces a partial `limited` result. There is no Helper turn, tool-call or serialized-context limit; the timeout is not a token or monetary budget.

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

`turns` counts native turns, including one cancelled before its provider request, but excludes summarization. `toolCalls` counts forwarded parent calls, including rejections; `toolsUsed` lists their unique names.

`usage` includes reported model usage for normal requests, compaction and retry attempts. Missing or invalid usage, failed or aborted requests, and unresolved requests set `usageIncomplete`. Pi accounts for nested host-tool usage separately. See [Usage](DESIGN.md#usage) for aggregation details.

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

Helper reuses the host's configured providers and request-time authentication without copying credentials. It requires a **concrete model**, not a virtual routing selection. If the main session uses a virtual model, set Helper's `provider` and `model` explicitly.

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

Tests use the real SDK with offline providers and temporary files. Navigation tests require `rg` and `fd` (or `fdfind`); CI installs them and disables automatic downloads. See [Verification](DESIGN.md#verification) for coverage. Tests validate integration behavior, not model-answer quality.

[MIT](../LICENSE)
