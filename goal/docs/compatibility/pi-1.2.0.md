# Pi 1.2.0 compatibility review

> Historical upgrade record. Version pairs, counts and “now” statements describe that review date. See the [support window](support-window.md) and [current receipts](../../verification/results/compatibility.json) for the maintained versions and latest evidence.

Reviewed on 2026-10-15 on Linux x86-64 with Node.js 22.23.3, npm 10.9.9 and the installed official Pi 1.1.0 / 1.2.0 releases. The published 1.2.0 changelog lists 1.1.0 as its immediately preceding release.

## Failure and repair

The 1.2.0 public resource loader reproduced the reported problem: it loaded zero Goal extensions and returned:

```text
Failed to load extension: my-pi-goal supports Pi 1.1.0 and 1.0.4. Installed: 1.2.0. Update the support window and run check:compat before using another release.
```

The support window had not been advanced after the host upgrade. The working package's three Pi library symlinks also still pointed to 1.1.0. This was not evidence that the goal journal or saved goals were corrupt.

The maintenance pair is now **current 1.2.0 / previous 1.1.0** in the manifest, three exact peer ranges and lockfile metadata. `npm run dev:link-host` aligned local Pi libraries with 1.2.0 and host typebox 1.3.27. The entry guard remains enabled for unsupported versions; 1.0.4 is now outside the support window. No goal journal migration, completion policy, permission setting or execution budget was changed.

A second issue affected validation: the former `check:load` command (`pi --no-extensions -e ... --list-models ...`) exited 0 and printed an empty model list despite the entry factory failure. It is now a public resource-loader check in `scripts/check-load.mjs`, with an isolated cwd and agent directory. It rejects a CLI/workspace version mismatch, loader errors and missing `/goal` or any of the seven Goal tool registrations. Negative regressions intentionally throw in a factory and load an empty extension. The dual-host suite runs the same real-entry test independently against each host; its extra CLI model-list invocation is only a smoke check.

## API and lifecycle review

The review used installed 1.2.0 extension, SDK, package, TUI, theme, message and session-format documentation, examples and declaration/release diffs. Production imports remain public host APIs.

| Pi 1.2.0 change | Goal impact and verification |
| --- | --- |
| `before_agent_start` also runs for idle custom-message starts, with `messageType: custom` and no `prompt` | Goal's handler does not access prompt-only fields; it sets context and obtains ownership for unfinished work. The new real-SDK command-start scenario verifies `/goal` planning, autonomous continuation, checks/audit, completion and subsequent auto-clear on both hosts. On 1.2.0 it observes one custom startup event, the correct starting control message, and no prompt property. On 1.1.0 the equivalent command run works without that event. |
| Startup counts as busy, including inside `before_agent_start` | The command-start regression observes `ctx.isIdle() === false` on 1.2.0 and queues a non-triggering marker during startup. The marker reaches the first request of the same run; one settled event and no extension errors are observed. Existing worker/audit cancellation and final-usage tests remain active. |
| Tool namespace aliases and `reachesTools` | Additive optional interfaces, not required by Goal's registered tools. No dedicated MCP adapter is introduced. |
| Stricter startup theme validation; TUI cursor/overlay fixes | Goal uses the host theme rather than shipping custom theme JSON. Existing approval components and public APIs need no changes. Actual 1.2.0 terminal smoke tests cover regular/fullscreen and dark/light, long approval review, resize, cancellation/acceptance, paused panel, reload and clear. |
| Provider, compaction and message improvements | Existing fixture-provider tests cover request-local policy deduplication, accounting and independent audit. Goal does not depend on the removed experimental server/plugin exports. This is not a validation of every provider or extension combination. |

No production lifecycle/TUI API shim was required after updating the version policy. Tests were added instead of weakening the support guard or disabling safety checks.

## Validation and evidence

The current counts and source-hashed receipts are in [the verification report](../../verification/REPORT.md), [dual-host receipt](../../verification/results/compatibility.json), [1.1.0 log](../../verification/results/compat-1.1.0.log) and [1.2.0 log](../../verification/results/compat-1.2.0.log).

Checks include TypeScript, the full test suite, formatting, actual entry loading, isolated dual-host regressions, the existing 71-case finite TLA+/TLC matrix, bounded implementation contracts and source/log-hash evidence validation. The host-support bounded domain now includes retired 1.0.4, future 1.3.0 and the current release's prerelease spelling. Models are unchanged; refreshed receipts are not a proof of Pi internals or LLM behavior.

[Terminal captures](pi-1.2.0-tui.txt) use synthetic data in temporary workspaces/agent directories, no model prompts or paid calls. Approval first/last pages were reached at 80 columns and resized to 48, both Cancel and Approve returned correctly, the paused panel survived `/reload`, and `/goal clear` left no current goals. Temporary tmux sessions and workspaces were removed. No user settings, real goal journals or project artifacts were cleared by the tests. Plain captures establish text/layout behavior, not full accessibility or color-contrast compliance.

## Loading the repair

```sh
npm run dev:link-host
npm run check:load
npm run check:compat
```

Existing Pi sessions must run `/reload` (or restart Pi) so the previously rejected entry can register. Reloading does not automatically resume unfinished goals. Use `/goal resume` only for work the user wants to continue. Do not resume completed historical goals.

Future releases still require advancing the pair and rerunning checks. Non-Linux sandboxing and continuous 5–12-hour real-model stability remain unverified.
