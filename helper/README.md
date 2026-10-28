# my-pi-helper

Request-scoped assistance for Pi with an independent model context. The main session sends a task and any necessary context; Helper uses the allowed host tools and returns an answer. Each invocation starts fresh.

[中文说明](README.zh-CN.md) · [Design and boundaries](DESIGN.md)

## Install

Requires Node.js **22.19+** and Pi **1.3.0 or 1.4.0**. This package is independent of the repository's CodeGraph and Search packages and is not published to npm.

From the repository root:

```bash
pi install ./helper
```

Use `pi install -l /absolute/path/my-pi-tools/helper` for project-local installation. To try it without changing configuration:

```bash
pi -e /absolute/path/my-pi-tools/helper/extensions/index.ts
```

For a running Pi session, use `/reload` after updating the installed extensions.

## Delegate a task

Ask the main model to use `helper`, or have it issue these tool arguments. `helper` is a **model-only** orchestration tool: the main model calls it directly; it is not callable from codemode or another tool.

Read-only review:

```json
{
  "task": "Review src/export.ts for Unicode filename handling. Report concrete defects with file and line references.",
  "context": "Expected behavior: preserve Unicode filenames in the downloaded archive. Inspect the code independently; do not change files."
}
```

Explicit work delegation:

```json
{
  "mode": "work",
  "task": "Fix the Unicode filename defect in src/export.ts and run the relevant existing tests.",
  "context": "Keep the exported API unchanged. Follow the project formatting rules. Relevant tests are in test/export.test.ts. Return the changed files, checks run and unresolved issues."
}
```

| Argument | Meaning |
| --- | --- |
| `task` | Required nonempty task, up to 20,000 characters |
| `context` | Optional material and constraints, up to 120,000 characters |
| `mode` | `read` by default; explicitly choose `work` to permit writes and commands |

Supply paths, requirements, relevant project instructions and any prior result needed for a follow-up. Helper receives none of the main conversation automatically. Missing information is returned as an ordinary question or explanation; another call must include the necessary material explicitly.

## Tools and permissions

Helper selects an explicit subset of the host's currently callable tools:

| Mode | Eligible tools |
| --- | --- |
| `read` | `read`, `grep`, `find`, `ls` |
| `work` | Read tools plus `write`, `edit`, `bash`, `powershell` |

Only tools actually exposed by the host are included. Helper does not enable disabled tools. With Pi's default tool selection, read mode may have only `read`; supply exact file paths, or enable `grep`, `find` and `ls` in the host if broader navigation is needed.

Every tool invocation uses Pi's `ctx.executeTool`, preserving native validation, permission hooks and cancellation. Rewritten arguments observed in host tool-result events are reported to the helper. A failed or denied tool stops the invocation with an error and the last tool's output. A host `terminate` request stops Helper and is propagated to the main tool result. Changes already made in work mode remain in the shared workspace; there is no rollback.

Helper does not expose a shell in read mode, an arbitrary dispatcher, MCP, parent-session inspection, Goal tools or recursive delegation. Tool implementations and host extensions are trusted: replacing a conventional read tool with a writing implementation would violate the read-mode assumption. Context separation is not an operating-system or filesystem sandbox.

## Results and stopping

Results include `status`, `mode`, `model`, `output`, `reason`, `partial`, `turns`, `toolCalls`, `toolsUsed`, `usage`, `usageIncomplete`, and truncation flags. For a partial run where a tool returned, `lastTool` contains its name and a bounded output excerpt. Successful answers omit this raw tool output to avoid replaying inspected files into the caller's context.

| Status | Meaning |
| --- | --- |
| `answered` | The model returned a normal final answer, possibly explaining missing information |
| `error` | Model/tool failure, denied or malformed action, or unsupported non-text output |
| `cancelled` | Tool/session cancellation, shutdown or model abort |
| `limited` | Turn, tool-call, time, context, output-token or answer-size limit |
| `terminated` | A host tool requested termination |

Invalid invocation arguments or settings can be rejected before a Helper result exists; Pi reports these as ordinary tool errors.

`answered` means a model answer was returned, not that the user's overall task has been independently verified. Other statuses have `partial: true`; the latest nonempty model text and last tool output are retained when available. `usage` records Helper's model calls; Pi adds nested-tool usage separately. Missing or invalid provider usage is marked `usageIncomplete`, not treated as verified zero cost. Missing aggregate counts and costs fall back to the known components; unrepresentable totals remain partial rather than overflowing. Optional `reasoning` and `cacheWrite1h` breakdowns accumulate when reported; they are subsets of existing token counts and do not increase totals or costs. `turns` counts model requests started, excluding cancellation during a progress update.

Helper uses ordinary final answers, without a mandatory audit-result tool. It never installs main-session continuation hooks, retries a task, persists a goal queue or waits indefinitely for a reply. The caller can choose to make another explicit request. At the last allowed model turn, further tool calls are not executed without a remaining opportunity to consume their results. Tool batches are validated before any member runs, including SDK argument-parsing errors and missing, malformed or reused call IDs. Exhausting the tool-call budget still permits a model request to interpret the last result and answer, within the remaining turn, time and context limits; any further tool batch is rejected.

Each invocation has a cancellable deadline, also checked against a monotonic clock between operations so a delayed timer cannot start further work after expiry. Cancellation is cooperative with host tools and providers; Helper does not provide process isolation or forcibly terminate arbitrary extension code. The model-turn limit is finite even when a model repeatedly asks to use tools.

## Configuration

Optional settings are read from:

1. `<Pi agent directory>/my-pi-helper.json`
2. `<workspace>/.pi/my-pi-helper.json`, overriding personal values

```json
{
  "maxTurns": 20,
  "maxToolCalls": 200,
  "timeoutSeconds": 1200,
  "maxContextChars": 200000
}
```

| Setting | Default | Allowed range |
| --- | --- | --- |
| `maxTurns` | 20 | 1–200 model requests |
| `maxToolCalls` | 200 | 1–1,000 tool calls |
| `timeoutSeconds` | 1,200 | 1–3,600 seconds |
| `maxContextChars` | 200,000 | 1,000–2,000,000 characters in the serialized context, including tools |

Each model request uses the selected model's own maximum output-token allowance (`model.maxTokens`); Helper imposes no additional per-turn token cap. The former `maxOutputTokens` setting has been removed; delete it from existing configuration files. The separate 32,000-character returned-answer limit still applies.

The context character limit is not an exact token or monetary budget. Each model request is metered by the provider, including replayed inputs.

Optional `provider` and `model` select a different configured model; set both together. Otherwise Helper uses the current main model's identity. Optional `thinking` is `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`; otherwise it uses the current thinking level. Only model configuration and credential resolution are reused, never the conversation or hidden reasoning.

Unknown settings, invalid limits and incomplete model configuration are rejected. Historical Goal settings are ignored. Tool-output excerpts and answers are limited to 32,000 characters with explicit truncation; request narrower output or smaller read ranges for more detail. This first version supports text outputs, foreground calls and fresh contexts only.

## Migrate from Goal

Goal has been removed from the current repository. Its previous implementation remains in [Git history](https://github.com/seek-hope/my-pi-tools/tree/d12c27f/goal).

Use `pi list` to find the old Goal source, then remove that **same source** and install Helper. For an installation using local absolute paths:

```bash
pi remove /absolute/path/my-pi-tools/goal
pi install /absolute/path/my-pi-tools/helper
```

Use `-l` for project-local package declarations. If Goal was loaded through an explicit extension entry instead of a package, disable that entry with `pi config` or remove it from the original launch arguments. Then run `/reload`, or start a new Pi process. A Goal instance already loaded in memory keeps its old hooks until it is unloaded.

Helper itself does not edit personal Pi settings, rewrite historical journals or turn old goals into Helper tasks. Installation entries are changed through the Pi package commands above. Old Goal state remains ignored by Git. There is no `/goal` compatibility command and no automatic conversion of pending goals.

## Development and verification

```bash
npm --prefix helper ci --ignore-scripts
npm --prefix helper run check
npm --prefix helper test
npm --prefix helper run check:format
npm --prefix helper run check:compat
```

`check:compat` uses installed releases from `~/.pi/agent/install/releases` by default; pass another releases directory after `--` if needed. It copies the package into temporary directories and checks types, the full suite and isolated extension loading on both supported Pi releases, without relinking a live installation.

Tests use offline providers with the actual Pi SDK. They capture provider inputs to check context separation; exercise fresh calls, cancellation, limits and usage accounting; perform real file edits and command execution; and test host deny/rewrite/terminate hooks. CI runs Node 22 and 24 with Pi 1.3.0 and 1.4.0. These tests do not claim paid-model quality evaluation or formal verification. Goal's historical verification receipts are not Helper evidence.

[MIT](../LICENSE)
