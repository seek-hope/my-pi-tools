# Verification environments

Approved checks and their independent rerun need different capabilities for different tasks. A documentation check only reads files; a build writes artifacts; an integration test starts local services or downloads dependencies. A single fixed "read-only, no network" sandbox makes the last two look like implementation failures. This page describes the per-goal verification environment and its boundaries.

## What the model can declare

`goal_environment` updates runtime settings on the current goal:

| Field | Values | Default | Meaning |
| --- | --- | --- | --- |
| `workspace` | `readonly` | `readonly` | The project is visible read-only. |
| | `ephemeral` | | The project is visible through a disposable writable overlay. Writes disappear after the run; the real project is never modified. |
| `network` | `isolated` | `isolated` | No network namespace sharing; local services and downloads are unreachable. |
| | `host` | | The sandbox shares the host network, so local services and approved downloads work. |
| `env` | variable names | `[]` | Host environment variables passed by name (for example `PATH`, `NODE_OPTIONS`, a toolchain or cache variable). Values are read at run time and are never stored in the goal journal. |

Example tool call:

```json
{
  "goal_id": "…",
  "generation": 3,
  "workspace": "ephemeral",
  "network": "host",
  "env": ["PATH", "CARGO_HOME"],
  "reason": "cargo build writes target/ and fetches the approved lockfile dependencies"
}
```

The plugin validates the values, runs a sandbox probe, records the change and resets the consecutive environment-failure counter. An identical configuration is a no-op.

## What does not change

- **The approved specification is unchanged.** Objective, criteria, tasks, check commands and existing evidence stay exactly as approved. Environment changes need no `/goal approve` because they do not weaken or expand what "done" means.
- **The real project is never writable in place.** `ephemeral` uses an overlay or temporary copy; writes are discarded after the run and cannot rewrite evidence.
- **The audit stays independent.** The auditor still reads real artifacts and can rerun approved checks, but cannot change the environment, criteria or findings thresholds.
- **Permissions still apply.** Explicit `network: ask` and `install: ask` policies remain effective. Scheduling `network: "host"` under an asking policy shows a confirmation and stores an exact grant for the goal. Rejection leaves the environment unchanged.
- **Checks are not silently disabled.** A check that cannot run is not a pass.

## Environment failures versus implementation failures

`goal_submit` runs approved checks with a snapshot of the declared environment. If a check cannot start, or its output indicates a capability the environment withheld, the result is classified as an environment issue:

- read-only workspace while the command tried to write (`Read-only file system`);
- isolated network while the command needed DNS, a local service or a download;
- a missing executable or tool variable.

The tool result explains the observed problem, the current environment, and the suggested change. It does **not** increment the implementation repair counter, does not run the independent audit and cannot complete the goal.

Three consecutive environment failures with unchanged settings pause the goal instead of repeating the same blocked run. Changing the environment resets the counter. An explicit `/goal resume` after a pause is still required; models cannot self-resume past the stop.

Classification is a conservative heuristic: it points at a likely environment cause but never converts a failed check into success. A genuine test failure that merely prints a matching phrase can be misclassified; the remedy is to declare the capability (`ephemeral` or `host`) and rerun, not to remove the check. Conversely, a declared environment that is still wrong may require a real dependency installation or a different toolchain.

## Audit behavior

The independent auditor receives the verification summary in its contract and uses the same frozen environment for `audit_check`. It is told that a check which could not run because of the sandbox is not evidence of success. It still must inspect real artifacts in a later model response before submitting findings.

## Contracts and limits

- Linux and `bubblewrap` are still required; missing isolation fails closed.
- `ephemeral` relies on bubblewrap overlay support. If the probe fails, the change is rejected with the sandbox error and nothing is applied.
- Host-readable data is not fully hidden. The sandbox isolates writes and, unless declared, networking; it is not a security boundary against deliberately malicious commands. Only run approved commands from trusted scope.
- Passing an environment variable exposes its value to the check. List only variables the check actually needs and avoid secrets in approved check commands.
- GPU devices, writable host caches, Docker/SSH sockets and remote executors are not implicitly available. They would need explicit future capabilities rather than broad host access.
- No timeout is imposed; cancellation terminates the process group. Environment configuration is per goal and persists in the journal.

## Related

- [Model lifecycle tools](model-goals.md)
- [Prompts and projections](prompts.md)
- [Design](design.md)
- [Formal verification](../verification/COVERAGE.md)
