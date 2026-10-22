# Pi 1.4.0 compatibility review

Reviewed on 2026-10-22 on Linux x86-64 with Node.js 22.23.3, npm 10.9.9 and the installed official Pi 1.3.0 / 1.4.0 releases. Pi's 1.4.0 changelog is dated 2026-10-21 and lists 1.3.0 as its immediately preceding release.

## Previous support window

my-pi-goal previously supported **1.3.0 / 1.2.0**. The installed 1.4.0 release was rejected by the extension's entry guard, and the workspace host links still pointed at 1.3.0. This was a maintenance-window mismatch, not a demonstrated production API failure.

## Updated window

The support pair is now **current 1.4.0 / previous 1.3.0**. The manifest, three exact peer ranges, lockfile root metadata and support documentation agree. `npm run dev:link-host` aligned the workspace libraries with Pi 1.4.0 and host typebox 1.3.27. The entry guard now rejects 1.2.0 and 1.5.0, so the two-release policy is enforced rather than widened implicitly. Goal journal migration, hashes and approved historical evidence are unchanged.

## Public API review

The review compared installed release notes and public declarations, and read the extension, MCP, SDK, TUI, theme and session documentation relevant to these extensions.

| Pi 1.4.0 change | Impact and verification |
| --- | --- |
| Extension event, tool and TUI context declarations | `core/extensions/types.d.ts` is unchanged from 1.3.0. `BeforeAgentStartEvent`, `ExtensionContext`, tool registration and `registerMcpServer` keep their existing signatures. All three packages typecheck against 1.4.0. |
| Extension dialog stacking and overlay concurrency | Goal's approval flow uses the supplied `ctx.ui.custom` completion callback. The 1.4.0 host fixes concurrent dialogs internally; Goal's approval and TUI tests pass without a production change. No new interactive terminal capture was made. |
| Resumed sessions and `/tree` tool activation | The real host-lifecycle regression closes and reopens a paused session and verifies that the dynamically activated `grep` tool is restored on both 1.3.0 and 1.4.0, while stopped Goal work does not restart. |
| MCP no longer lists resources during connection | CodeGraph uses native MCP registration. The real smoke test verifies extension loading, MCP discovery/query, CLI status/init and live/manual sync against Pi 1.4.0. |
| Codemode queues for a free worker instead of failing immediately | CodeGraph's smoke test exercises a codemode MCP call on 1.4.0. |
| `generateSummary()` ignores `reserveTokens` | Goal does not call the summary APIs directly; compaction remains host-owned. No shim is needed. |
| Provider attribution headers change for extensions | Goal does not register `before_provider_headers`; no production code depends on the removed attribution headers. |
| pi-ai/pi-tui declaration updates | Goal imports `StringEnum`, `Context`, `Tool` and TUI text/layout helpers. These imports still typecheck against the 1.4.0 host. |

No production compatibility shim was required. The change set is limited to host dependency versions, the Goal support window, one host-version test expectation and compatibility documentation.

## Verification

- `npm run check` — passed for codegraph, search and goal against Pi 1.4.0.
- `npm test` — codegraph **32/32**, search **56/56**, goal **127 passed + 1 platform-specific sandbox test skipped**.
- `npm run check:load` — `PASS Pi 1.4.0: Goal entry loaded; /goal and 9 tools registered`.
- `npm run check:compat` — **PASS Pi 1.3.0** and **PASS Pi 1.4.0**; both hosts passed types, the complete suite and isolated extension loading, each with 127 passes and one platform skip.
- `npm run smoke` — `PASS: real Pi extension load, CLI status/init, MCP discovery/query, codemode, live sync, and manual sync.`
- Real Pi CLI load for search — `pi --offline -e search/src/index.ts --list-models` exited 0 with no extension-load error; this checks registration only and makes no API call.

The live DeepSeek Search & Fetch smoke test was not run because it requires a real `DEEPSEEK_API_KEY`; search's offline unit/integration suite and typecheck passed. The compatibility checks use offline providers, temporary workspaces and no paid API calls. They do not replace the independent Goal model audit or a full interactive terminal matrix.

The current counts and source-hashed receipts are in [the verification report](../../verification/REPORT.md), [dual-host receipt](../../verification/results/compatibility.json), [1.3.0 log](../../verification/results/compat-1.3.0.log) and [1.4.0 log](../../verification/results/compat-1.4.0.log).
