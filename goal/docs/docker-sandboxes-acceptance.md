# Docker Sandboxes microVM acceptance

**Result: 14/14 cases passed in one continuous run on 2026-10-24 (05:46–05:56 UTC).** These were real local microVM executions through `sbx`, with a pinned shell template and archived check image. The run used **client and daemon 0.49.2**, confirmed against daemon request logs. An earlier four-case offline smoke also passed on 0.48.0.

The [machine-readable receipt](../verification/results/microvm-acceptance.json) contains the complete run, image identities, CLI version and 147 source hashes captured at startup and checked again at completion. Earlier development batches are retained separately as historical evidence; the continuous run supersedes them.

## Environment

| Item | Value |
| --- | --- |
| Host | CachyOS Linux, amd64, kernel `7.3.0-3-cachyos` |
| Complete acceptance | sbx client/daemon `0.49.2` |
| Earlier isolation probe | sbx `0.48.0`; guest kernel `7.0.14`, different from the host |
| Host Node | `26.12.1` |
| VM resources | 2 CPUs, 4096 MiB; inner check limit 256 processes |
| Shell template | `docker.io/docker/sandbox-templates@sha256:b178ca62ec2e79af2a044e3ec321bdb72188690e1c15d573ea5524b397554d3d` |
| Check image | `node:22-bookworm-slim`, pinned as `sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d` |
| Archive SHA-256 | `ed48a8c2b18f4155b135a18c3733dbe964b36ec85fd91c79e6173c8248c9f3df` |

The inner image was pulled and archived in an owned preparation VM, then copied out and pinned. The host Docker daemon and host Docker socket were not used. The preparation VM and all verification VMs were removed. Both acceptance lease directories were empty at final inspection; unrelated stopped sandboxes remained untouched.

## Cases

| # | Assertion | Result |
| --- | --- | --- |
| 1 | Read-only source volume rejects a write | Pass |
| 2 | Ephemeral writes succeed without changing the host source | Pass |
| 3 | Host canary, Docker/SSH sockets and credential variables are absent; UID is 1000 and sudo cannot elevate | Pass |
| 4 | Offline checks cannot establish external TCP connections | Pass |
| 5 | Allowlisted HTTPS npm metadata download succeeds with the sandbox CA | Pass |
| 6 | An unrelated destination is denied by the allowlist proxy | Pass |
| 7 | Open mode permits public HTTP | Pass |
| 8 | Explicit deny overrides open mode, including DNS names with a trailing root dot | Pass |
| 9 | Online checks cannot bypass the proxy with direct TCP or reach other VM services | Pass |
| 10 | Online checks cannot bypass the proxy with container DNS | Pass |
| 11 | Printing forged success JSON cannot override the actual exit code 7 | Pass |
| 12 | Cancellation after observing a running check removes the VM | Pass |
| 13 | Continuous output with backpressure triggers the output limit and VM cleanup | Pass |
| 14 | The runner deadline rejects the operation and cleans the VM | Pass |

Each case also checked that the host input remained unchanged and no owned resource lease remained. All cases ran against the same listed source hashes and personal profile. Afterward, only the model prompt's description of sandbox deadlines/resource limits changed among the hashed files; the receipt records its before/after hashes. Verification execution code is unchanged.

## Findings resolved during acceptance

1. **Conflicting wildcard policies:** sbx rejects adding `allow **` while the same VM's startup `deny **` exists. Open mode now removes that exact gate before adding allow-all; policy setup completes before project code runs. The inner proxy still enforces the goal deny list. A regression reproduces the CLI conflict contract.
2. **Locked desktop keyring:** a locked Secret Service blocked Docker credential access and CLI operations. The interrupted attempt retained `cleanup_pending`. After the keyring unlocked, exact-ID recovery removed the stopped VM and its lease. No global policy reset or blanket prune was used.
3. **Unstable output-pressure fixture:** an unbounded JavaScript output buffer did not consistently reach the expected supervisor output-limit error. The final fixture honors write backpressure, then continuously produces output. It passed with the final personal profile.
4. **Review fixes:** the proxy canonicalizes trailing DNS root dots before applying deny rules and uses exact special-use IPv4 ranges. The pipeline preserves environment-failure classification during audit reruns. Local regressions cover these cases, and the complete microVM run includes the trailing-dot denial. The suite also refuses to swallow cleanup failures in expected negative cases.

The client/daemon were initially 0.48.0 and later changed to 0.49.2 in the shared environment. The complete numbered batches started after that change. This implementation did not upgrade or restart the shared daemon, alter global integration settings, or change host Docker group membership.

## Reproduce

From `goal/`, with an authenticated, unlocked desktop keyring and a reviewed profile:

```sh
npm run check:sandbox -- --doctor /absolute/personal/my-pi-goal.json
npm run check:sandbox -- --run /absolute/personal/my-pi-goal.json
```

A trailing zero-based case index runs only a suffix and writes a separate receipt. For example, `... --run /absolute/personal/my-pi-goal.json 12` runs cases 13–14. Missing prerequisites and failed assertions exit nonzero; there is no successful skip. The separate [manual CI workflow](../../.github/workflows/sandbox.yml) runs the complete suite on a dedicated authenticated runner and has not been run on GitHub in this session.

The ordinary goal suite passed **152/152**, with no platform skips. Pi **1.3.0 and 1.4.0** passed types, the full suite and isolated extension loading. Existing formal verification passed **76 configurations**, with current-source receipt checks. Those models cover abstract lifecycle and verification gates; the microVM/proxy implementation remains explicitly outside the formal composition proof.

## Scope limits

These cases establish the listed behavior on this platform and pinned images. They are not a general isolation proof, exhaustive IPv6/UDP or kernel exploit testing, cross-platform certification, or a real parent-SIGKILL/daemon-crash matrix. The watchdog parent-exit path has a separate process regression using a fake CLI. Source-scan atomicity, hostile host writers, watchdog survival, PID reuse and disk quotas remain outside this evidence.

The backend isolates approved verification commands. Ordinary Pi tools and host MCP calls remain on the host. Online clients must use the HTTP/HTTPS proxy; raw networking, private-address services, host loopback services and host variable forwarding are not supported by this profile. See [environment controls](verification-environment.md) and [setup](docker-sandboxes-setup.md).
