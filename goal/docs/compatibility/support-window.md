# Rolling Pi support window

my-pi-goal supports only the current Pi release and the immediately preceding release. The current maintenance pair is **1.4.0 / 1.3.0**, based on the installed official release history. This replaces the earlier open-ended compatibility intention. It does not claim automatic support for a future version merely because its number is higher.

`package.json.piCompatibility` declares the pair. Host peer dependencies use the exact same two versions. `src/compatibility.ts` rejects other hosts at extension registration with a clear maintenance instruction; `dev:link-host` validates the selected host before changing links. Goal journal migration, hash validation and preservation of approved historical evidence remain data-integrity obligations, independently of supported host APIs.

Run:

```sh
npm run check:compat
# Alternative managed-release root (containing <version>/node_modules):
npm run check:compat -- /path/to/releases
```

The runner copies source/tests into a temporary checkout per version, links that version's host packages, validates their versions, and runs TypeScript, the complete test suite (including real extension entry loading with command/tool-registration assertions) and an explicit version's model-listing CLI smoke check. The latter can exit 0 despite a factory failure and is not sufficient on its own. It uses an isolated agent directory and offline providers. It neither relinks the working project nor reads real goal journals or user settings. Temporary directories are removed even after test failures. Logs and a source-hashed receipt are saved under `verification/results/compat-*` and `compatibility.json`; `verify:evidence` rejects stale or changed evidence. This does not replace interactive terminal checks when TUI APIs or rendering change.

For a new Pi release:

1. Read the release notes/public API changes and identify the immediately preceding release.
2. Update `piCompatibility`, the three Pi peer ranges and the lockfile root metadata together.
3. Run `npm run dev:link-host` to align workspace libraries with the installed CLI; `check:load` rejects a mismatch. Adapt only the two supported hosts. Remove code branches needed exclusively by older hosts when they are no longer relevant; retain history/data-integrity handling.
4. Run `check`, `test`, `check:format`, `check:load`, `check:compat`, `verify:formal`, `verify:evidence`, and terminal checks if UI behavior changed.
5. Update this policy and the verification report, then reload the extension in existing sessions.

The [1.4.0 upgrade review](pi-1.4.0.md) covers public extension/API stability, resumed-session tool restoration, MCP resource-list changes and overlay dialog concurrency. The [1.3.0 upgrade review](pi-1.3.0.md) covers saved-session tool restoration, malformed-argument rejection and overlapping approval overlays. The historical [1.2.0 upgrade review](pi-1.2.0.md) covers the stale support pair, loader-check false positive and custom-message startup contract. The historical [1.1.0 upgrade review](pi-1.1.0.md) records the earlier 81-test upgrade pass and later 90-test lifecycle pass. Current test counts and receipt dates belong to the [current verification report](../../verification/REPORT.md). The runtime version check does not certify every host platform or extension combination, or prove long-duration real-model stability. Goal now delegates execution to the main session; the former sandbox backend is historical.
