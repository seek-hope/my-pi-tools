# Pi 1.3.0 compatibility review

> Historical upgrade record. Version pairs, counts and “now” statements describe that review date. See the [support window](support-window.md) and [current receipts](../../verification/results/compatibility.json) for the maintained versions and latest evidence.

Reviewed on 2026-10-16 on Linux x86-64 with Node.js 22.23.3, npm 10.9.9 and installed official Pi 1.2.0 / 1.3.0 releases. Pi's 1.3.0 changelog is dated 2026-10-15 and lists 1.2.0 immediately below it.

## Result and maintenance changes

The existing `check:load` correctly failed after upgrading the CLI:

```text
my-pi-goal supports Pi 1.2.0 and 1.1.0. Installed: 1.3.0. Update the support window and run check:compat before using another release.
```

The support policy, not a demonstrated breaking extension API change, prevented loading. Workspace Pi libraries were also still linked to 1.2.0.

The support pair is now **current 1.3.0 / previous 1.2.0**. The manifest, three exact peer ranges, lockfile root metadata and support documentation agree. `npm run dev:link-host` aligned the workspace libraries with Pi 1.3.0 and host typebox 1.3.27. The entry guard remains strict: 1.1.0 is retired, and future 1.4.0 is not automatically supported. Historical goal data protection is unchanged.

No production lifecycle, audit or TUI shim was necessary. No approval boundary, completion gate, permission, budget, user setting or real goal journal was changed. The new work consists of version metadata, regression tests, documentation and refreshed verification evidence.

## Changes reviewed

The review compared installed release notes and public declarations, and read the extension, SDK, TUI, settings, package, theme, message and session-format documentation and relevant examples. Extension event/tool declarations, the model runtime declaration and TUI index exports are unchanged from 1.2.0. Other relevant changes are covered below.

| Pi change | Goal impact and check |
| --- | --- |
| Restore a resumed session's active tools; apply tool modifiers to that restored set | A real SDK regression persists a paused Goal after user-approved scope modification, closes and reopens the session, and verifies unchanged goal state/identity with no automatic model request. All seven Goal tools remain available. On 1.3.0 the dynamically activated `grep` tool is restored; on 1.2.0 it is not. The `-bash` modifier remains effective on both. A new user instruction then resumes the approved goal through its model tool and completes independent fixture auditing. |
| Reject malformed final tool JSON and expose optional `ToolCall.argumentsError`, with `arguments: {}` | Goal tools keep the host's validation. The nested auditor uses its own schema validation; a new fixture verifies that all six audit tools reject the documented empty-argument shape, invalid calls do not establish inspection, and an invalid verdict after inspection cannot complete an audit. Subsequent valid calls recover normally and all request usage is charged. This tests the output contract, not every provider's JSON parser. |
| `ctx.ui.custom` completion closes its own overlay instead of the topmost overlay | Goal already uses the supplied completion callback. Actual 1.3.0 terminal checks close an underlying Goal review while a second fixture overlay is open: the second remains visible and accepts input until independently dismissed. No direct overlay-hide workaround was added. |
| Exact internal Pi dependencies | Workspace linking and the isolated compatibility runner continue checking matching host package versions. Host packages remain peers rather than bundled runtime dependencies. |
| Drop previous-model thinking blocks on model switch; provider/cache/retry fixes | Goal leaves ordinary conversation transformation to Pi and meters reported usage rather than reasoning text length. There is no new provider-specific integration. Kimi Code base-URL overrides now require `/v1` according to Pi's release notes; this review did not modify user provider configuration or test paid provider endpoints. |

The saved-session fixture initially attempted to activate `grep` outside an explicitly restricted initial tool allowlist. That fixture error was corrected by using modifier-based defaults before activation and asserting the tool was active before saving. It was not a Goal production defect. Obsolete pre-1.2 startup-event branches in host tests were removed; both supported hosts must now satisfy the same custom-start/busy-startup assertions.

## Validation

- `npm run check`, `npm test`, `npm run check:format`, `PI_OFFLINE=1 npm run check:load` and `npm run verify:coverage` passed.
- Both Pi **1.2.0 and 1.3.0 passed 113/113 tests**, with no failed, cancelled or skipped tests, plus TypeScript and isolated real-entry registration checks.
- Real loading registered `/goal` and all seven tools. The separate model-list CLI invocation remains only a smoke check, not proof of extension registration.
- **13 finite models / 71 configurations** met their expected outcomes: 15 positive checks and 56 designated counterexamples. **398,874 bounded implementation assertions** passed. The models are unchanged; the nine-value host-support domain now includes retired 1.1.0 and future 1.4.0.
- `verify:evidence` validated current source and log hashes, including both host receipts.

Receipts: [dual-host](../../verification/results/compatibility.json), [Pi 1.2.0 log](../../verification/results/compat-1.2.0.log), [Pi 1.3.0 log](../../verification/results/compat-1.3.0.log), [formal](../../verification/results/summary.json), [bounded implementation](../../verification/results/contracts.json). The [verification report](../../verification/REPORT.md) records current timestamps and assumptions.

Subsequent historical releases added verification environments and storage/context efficiency. The sandbox executor has since been replaced by main-session checks and temporary read-only review. Counts and skipped-test figures from earlier revisions are historical; see the [current verification report](../../verification/REPORT.md) and current source-bound receipts.

[Terminal captures](pi-1.3.0-tui.txt) cover regular/fullscreen × dark/light, a 50-task Unicode review, first/last pages at 80 columns, resize to 48 columns, Home/End, Cancel/Approve, overlapping overlays, a synthetic paused goal panel after reload, and clear. Tests use temporary workspaces, agent directories and a dedicated tmux server, with no model requests or paid calls. Temporary test workspaces and tmux sessions were removed. Plain captures are layout evidence, not a full accessibility or color-contrast assessment. The overlapping-overlay fix is a 1.3.0 host behavior, not a backport to 1.2.0 or a claim about arbitrary extension combinations.

These are mechanical and offline integration checks, not a new real-model independent Goal audit. They do not prove Pi internals, natural-language judgments, non-Linux sandboxing, every provider/extension combination or continuous 5–12-hour real-model stability.

## Load the update

The workspace dependencies have already been aligned. In an existing Pi session run:

```text
/reload
```

Restarting Pi is an alternative. Reloading does not authorize automatic recovery of unfinished goals or resurrection of completed work. Future Pi releases still require updating the support pair and rerunning the checks in the [support policy](support-window.md).
