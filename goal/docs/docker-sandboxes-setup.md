# Docker Sandboxes verification

Docker Sandboxes is the only backend for approved checks and independent audit reruns. It uses local microVMs through the standalone `sbx` CLI. Every check receives a fresh VM, a frozen source snapshot and a pinned check image; cleanup must succeed before completion. Missing prerequisites fail closed. The regular Pi process, its ordinary tools and other extensions remain on the host.

See [the boundary design and input policy](sandbox-boundary.md), [acceptance results](docker-sandboxes-acceptance.md) for the tested platform and limits, and [per-goal environments](verification-environment.md) for network controls. The old bubblewrap executor and CI dependency have been removed.

## Prerequisites

- An authenticated **sbx 0.48.0 or 0.49.2** installation. The complete real acceptance run used 0.49.2; an earlier offline smoke also passed on 0.48.0. A newer CLI version requires review. Goal never upgrades or restarts a shared daemon automatically.
- Working hardware virtualization. The local test machine uses CachyOS and `/dev/kvm`; other operating systems need their own acceptance run. Docker Engine alone is not Docker Sandboxes.
- A trusted shell template pinned by OCI digest, with Node.js, a private Docker engine and `iptables`. The official `docker/sandbox-templates:shell-docker` template supplies these; resolve its digest before configuring it.
- A trusted Docker image archive, its SHA-256 and Docker image ID. The image needs `/usr/bin/env`, `/bin/bash`, `/bin/chown` and `/bin/chmod`; the acceptance suite also needs Node.js and npm. Image `VOLUME` declarations are rejected.

The host Docker socket is never used. An inaccessible host Docker daemon is not a reason to change the user's groups. On Linux, sbx credentials use the desktop Secret Service: a locked keyring can block CLI operations, including cleanup. Unlock it locally, then reconcile leases.

## Prepare and pin images

The outer template supplies trusted supervision and the private engine. The inner image supplies the project's tools. Build project-specific toolchains into an image, or use approved online checks to install dependencies into the ephemeral workspace. Host dependency directories and caches are not mounted.

The [example Dockerfile](../sandbox/check-image.Dockerfile) takes a pinned base. On a build machine or in a separate disposable sandbox:

```sh
docker build --build-arg BASE='node:22-bookworm@sha256:<base-digest>' \
  -f sandbox/check-image.Dockerfile -t goal-check:local .
docker image inspect --format '{{.Id}}' goal-check:local
docker image save goal-check:local -o /absolute/private/goal-check.tar
sha256sum /absolute/private/goal-check.tar
```

Image preparation is separate from a check's network permissions. Checks load the archived image rather than pulling an unpinned tag. No writable image/cache state is reused between checks. Refresh images deliberately when updating toolchains or applying security fixes.

## Personal configuration

Add a `sandbox` object to `<agent-dir>/my-pi-goal.json`, normally `~/.pi/agent/my-pi-goal.json`. Project `.pi/my-pi-goal.json` cannot select the executable or trusted images. Replace the placeholders below with actual values:

```json
{
  "sandbox": {
    "backend": "docker-sandboxes",
    "executable": "sbx",
    "template": "docker.io/docker/sandbox-templates@sha256:<64-hex-digest>",
    "imageArchive": "/absolute/private/goal-check.tar",
    "imageArchiveSha256": "<64-hex-digest>",
    "imageId": "sha256:<64-hex-digest>",
    "cpus": 2,
    "memoryMiB": 4096,
    "pids": 256,
    "checkTimeoutMs": 120000,
    "provisionTimeoutMs": 300000,
    "cleanupTimeoutMs": 30000,
    "outputBytes": 24000,
    "snapshotBytes": 268435456,
    "snapshotFiles": 20000
  }
}
```

`executable` can be an absolute path. Reload after changing the profile. Removing it disables verification; it never restores another backend. Existing `network: host` settings migrate to offline, and nonempty host `env` lists must be cleared before verification.

## Isolation and networking

The source project, home directory and host sockets are not mounted in the VM. Source bytes and trusted control files are transferred explicitly. A root supervisor in the VM creates a separate non-root check container with no Docker socket, dropped capabilities, `no-new-privileges`, a read-only root filesystem, bounded writable temporary directories and resource limits. It overrides the image entrypoint and clears environment variables before executing project code.

The trusted outer template may contain Docker's integration sockets and placeholder credential variables. They are not passed to the check container. Goal does not change shared SSH/browser/clipboard/MCP settings. This boundary depends on the inner container configuration as well as the outer microVM; the template and supervisor are trusted.

- **Offline:** outer per-sandbox deny-all rule and inner `--network none`.
- **Online:** a private internal Docker network plus VM firewall rules allow the check to reach only a trusted forward proxy. Direct external TCP/UDP, external DNS and other VM services are blocked. The proxy enforces the frozen allow/deny policy before forwarding to Docker's upstream proxy; Docker policies may deny additional traffic.
- **Authorization:** only the newly created VM receives policy rules. Its initial deny gate is removed by exact rule ID; open mode must remove it before adding allow-all because sbx rejects conflicting wildcard rules. All policy setup finishes before any project code runs. Global and organization policies are never reset or edited.
- **TLS:** the template's proxy CA is mounted read-only into the check container and standard certificate variables point to it. Applications with independent trust stores need their own configuration.

`isolated`, `allowlist` and `open` plus `allow`/`deny` are controlled through `goal_environment`. Destinations support DNS names, wildcard subdomains and optional ports. Proxy traffic must resolve to public IPv4 addresses; raw IP targets, private addresses and reserved host integration names are refused. IPv6 egress is not implemented. DNS is resolved again by the upstream proxy, so its resolver and private-network restrictions remain part of the trusted boundary. Arbitrary raw networking, host-local services and private registries on local addresses are not supported by this profile.

## Frozen inputs and evidence

The versioned `source-v2` policy includes dirty/untracked source, applies default control/credential/dependency exclusions, and accepts personal `sandbox.inputs` selection rules. Exact sensitive-fixture and external-hardlink exceptions require a matching project path. Internal hardlinks become independent files; relative symlinks must resolve inside the selected tree. Cycles, outside/excluded targets and special files fail preparation. Use `/goal sandbox inputs` to inspect paths and reasons without creating a VM. See [selection rules, examples and limits](sandbox-boundary.md#source-selection).

Inputs, executable bits, exclusions, approved checks and the environment receive digests. The auditor reads the same frozen copy and can rerun only frozen approved commands. Completion verifies the current selected source inputs and the session/owner/generation fence. A passing audit cannot override a failed rerun or a cleanup failure. Full persistent manifest/artifact export remains future work.

## Diagnostics and real acceptance

```text
/goal sandbox inputs
/goal sandbox doctor
/goal sandbox status
/goal sandbox cleanup
```

`doctor` checks the CLI contract, daemon access and unreconciled leases. It does not create a VM or certify isolation. From `goal/`:

```sh
npm run check:sandbox -- --doctor /absolute/personal/my-pi-goal.json
npm run check:sandbox -- --run /absolute/personal/my-pi-goal.json
```

The real suite creates VMs and tests read-only/ephemeral behavior, host file/socket/credential absence, offline networking, HTTPS npm downloads, allow/deny policies, direct TCP/DNS bypass attempts, forged stdout, cancellation, bounded output, timeout cleanup, internal-link transfer and an offline npm dependency/build/test workflow with explicit variables and approved fixtures. Missing prerequisites cause failure, never a passing skip. Results are written beside the supplied configuration as `acceptance-results.json`, including the CLI version and source hashes. Successful completion requires those hashes to remain unchanged throughout the run. An optional zero-based case index after the configuration resumes a suffix of the suite and writes `acceptance-results-from-<index>.json`; such a file proves only its listed cases. The manual [microVM workflow](../../.github/workflows/sandbox.yml) runs the entire suite on a dedicated self-hosted runner; set the repository variable `GOAL_SANDBOX_CONFIG` to its reviewed personal profile path.

Regular `npm test` injects fake transports for orchestration and host lifecycle tests, tests the local proxy against a controlled upstream, and runs a separate watchdog process against a fake CLI. These tests do not certify a microVM. The existing formal models cover abstract lifecycle and verification gates; the microVM/proxy implementation has no formal composition proof.

## Cancellation and recovery

Cancellation or timeout terminates the CLI subprocess and separately stops/removes the exact leased VM using a fresh cleanup deadline. A watchdog observes parent disconnect and a total deadline. The supervisor also bounds check execution and output.

Failed removal retains `cleanup_pending` under `<agent-dir>/goal-sandboxes`, blocks new verification and pauses the goal. After restoring daemon/login access, `/goal sandbox cleanup` reconciles exact-ID leases owned by a dead process or pending leases of the current process. It never deletes arbitrary sandboxes by prefix. Interrupted creation without a recorded ID requires manual reconciliation of the exact random name; never use blanket pruning as goal cleanup.

The watchdog can itself be killed; PID reuse can delay recovery; a cancelled create may complete later. Source scans are not atomic against a malicious local writer. Host disk quotas, immutable output artifacts and multi-platform/crash testing remain outside the verified scope.
