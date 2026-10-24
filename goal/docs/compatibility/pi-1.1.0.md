# Pi 1.1.0 compatibility review

> Historical upgrade record. Version pairs, counts and “now” statements describe that review date. See the [support window](support-window.md) and [current receipts](../../verification/results/compatibility.json) for the maintained versions and latest evidence.

Reviewed on 2026-10-08 using installed Pi releases **1.0.4** and **1.1.0**, Node.js 26.10.0 and npm 12.2.0 on Linux x86-64.

This is the historical upgrade-only review (81 tests). The subsequent [model lifecycle update](../model-goals.md) changes creation, clearing, resumption and modification behavior and expands the suite to 90 tests; the current [verification report](../../verification/REPORT.md) records the new receipts.

## Result

**No breaking change was found in the public APIs used by my-pi-goal. No production source changes, goal migration or configuration changes were needed for this upgrade.** Local development dependency symlinks still pointed to 1.0.4 after the Pi update; `npm run dev:link-host` refreshed `pi-coding-agent`, `pi-ai` and `pi-tui` to 1.1.0, with host `typebox` 1.3.27. Links were temporarily switched back for the baseline regression and restored to 1.1.0 afterward.

At the time of this historical upgrade review, the package remained private at 0.1.0 and host peer dependencies used `*` to avoid bundled duplicate runtimes. The later [rolling support policy](support-window.md) replaces those ranges with the current/previous release pair and adds an entry guard. No execution/audit budgets or approval boundaries changed during the upgrade review.

## API review

The review compared installed release notes, public extension/SDK/model/message/TUI declarations and the relevant host lifecycle implementation, alongside 1.1.0 documentation and examples. Runtime code continues to use public exports only.

| Host change | Impact and verification |
| --- | --- |
| `AgentSettledEvent.aborted: boolean` | Additive. Goal already handles cancellation before settlement and releases ownership from its notification-only settled handler. New SDK tests observe `true` after cancellation during both worker execution and independent audit; normal completion observes `false`. No continuation is added after cancellation. |
| Optional assistant/tool message durations and `tool_execution_end.durationMs` | Metadata only. Successful tool events carry finite nonnegative durations in the real host test. The progress fingerprint uses tool name, arguments and result content, not timing. A regression varies duration while repeating identical output and still reaches three no-progress turns. Goal elapsed time and token accounting retain their existing semantics. |
| Tool renderer `durationMs` and `outputPad` | Additive callback fields. Goal does not implement custom tool call/result renderers; its panel uses `setWidget` and `setStatus`. No renderer migration is required. |
| Session projection, model streaming, tool selection and TUI changes | No incompatible signature was found for Goal's consumed APIs. Real SDK tests cover continuation, custom provider streaming, fresh audit context, journal references, release and clear. Terminal smoke tests exercise the actual interactive host. New CLI tool-selection features are host-owned; this review does not certify every CLI/MCP combination. |

The new event assertions are version-gated in tests only. Cancellation and ownership behavior run on both versions, including the older host without the new settled-event field.

## Validation

| Check | Pi 1.0.4 | Pi 1.1.0 |
| --- | --- | --- |
| TypeScript public API check | Passed | Passed |
| Full behavior/integration suite | 81/81 passed | 81/81 passed |
| Real SDK worker/auditor cancellation | Passed | Passed, including `aborted` metadata |
| Extension CLI load | Passed using the 1.0.4 CLI explicitly | Passed |
| Formatting | Shared source check passed | Shared source check passed |
| Interactive terminal smoke | Not repeated in this review; earlier baseline checks remain historical | Passed, details below |

Regression sources: [host lifecycle](../../test/host.test.mjs), [host cancellation](../../test/host-cancellation.test.mjs), [runtime behavior](../../test/runtime.test.mjs) and [width/Unicode rendering](../../test/tui.test.mjs). Raw command output: [1.0.4](pi-1.0.4-checks.log), [1.1.0](pi-1.1.0-checks.log).

All **23 TLA+/TLC configurations** were rerun with the updated test-source hashes: six positive checks and seventeen deliberate fault/missing-fairness controls met their expected outcomes. Protocol models and production implementations are unchanged. See [receipt and limits](../../verification/REPORT.md); this is not a new proof of Pi internals or a TypeScript refinement proof.

### Interactive terminal smoke

A synthetic paused goal was displayed in isolated temporary workspaces and agent directories, with automatic networking disabled and no model prompts. Four combinations were checked: regular/fullscreen modes × dark/light themes. Each used 80-column compact and resized 48-column expanded panels, plus hide/show, `/reload` and `/goal clear`. Resize checks waited for the complete right border, rather than accepting an old frame cropped to the new width. Clear removed the panel/status and left an empty current journal with no owner. Global user settings and real goal journals were not used or edited.

[Plain terminal captures](pi-1.1.0-tui.txt) retain compact, narrow expanded and cleared frames. Captures verify text/layout, not a full pixel/color or accessibility audit. The existing preview image was not replaced by this compatibility check. The first temporary fixture attempt called a nonexistent store helper; it was corrected to a filesystem existence check before the successful runs. No production defect was associated with that fixture error.

## Reproduce after an upgrade

```sh
npm run dev:link-host
npm run check
npm test
npm run check:format
PI_OFFLINE=1 npm run check:load
npm run verify:formal
npm run verify:evidence
```

For a second installed release, pass its `node_modules` path to `dev:link-host` and use that release's CLI explicitly for loading; restore the current host links afterward. Tests are offline fixtures in temporary directories. Fifteen-second cancellation-test deadlines protect the test runner only and are not product limits.

Already-open Pi sessions can use `/reload` to reload the package. Reload saves and stops an active goal; use `/goal resume` only if that unfinished goal should continue. Completed goals do not need resuming.

This review does **not** validate continuous real-model 5–12 hour operation, every provider or extension combination, all terminal capabilities, other Pi releases, or non-Linux platforms. Existing finite-model assumptions and sandbox boundaries still apply.
