# Verification environments

Docker Sandboxes is the only verification backend. Every approved check and audit rerun receives a fresh microVM and the same frozen source inputs. Configure a trusted profile in personal `my-pi-goal.json`; without one, verification fails closed. See [setup](docker-sandboxes-setup.md).

## Per-goal controls

`goal_environment` changes runtime capabilities without changing approved criteria or commands:

| Field | Values | Behavior |
| --- | --- | --- |
| `workspace` | `ephemeral` (new goals), `readonly` | Disposable writable copy, or a read-only source volume. Neither writes back to the host; existing goals retain their settings. |
| `network` | `isolated` (default) | Outer deny-all policy and no check-container network interface except loopback. |
| | `allowlist` | Proxy access only to `allow` destinations, excluding `deny`. |
| | `open` | Proxy access to public DNS destinations, excluding `deny`. Docker organization rules may restrict further. |
| `allow` | Up to 64 DNS patterns | Exact names or `*.example.com`, optionally with a port such as `registry.npmjs.org:443`. Required in allowlist mode. |
| `deny` | Up to 64 DNS patterns | Takes precedence over allowed destinations in either online mode. |
| `env` | `[]` | Host variable forwarding is unavailable. |
| `variables` | Explicit non-secret string map | Frozen values, for example `CI` and `TZ`; never read from the host. Reserved execution/proxy/TLS and credential names are rejected. Values are recorded in goal history. |
| `inspect_inputs` / `input_offset` | `true` / nonnegative offset | Read-only, paged selection preview. Cannot be combined with environment changes; no VM or daemon needed. |

```json
{
  "goal_id": "…",
  "generation": 3,
  "workspace": "ephemeral",
  "network": "allowlist",
  "allow": ["registry.npmjs.org:443", "github.com:443"],
  "deny": ["blocked.example.com"],
  "variables": { "CI": "1", "TZ": "UTC" },
  "reason": "Install locked dependencies and build in a disposable workspace"
}
```

For broader access, use `network: "open"`, retaining any needed `deny` rules. To disable egress again, set `network: "isolated"`. The lists remain stored and can be edited or cleared with `[]`; they have no effect while offline. Domain redirects and artifact CDNs need their own allow entries. Wildcards match subdomains, not the apex name; a name without a port permits any proxy tunnel port.

Online programs must honor `HTTP_PROXY`/`HTTPS_PROXY` (upper- and lower-case forms are provided). npm and typical HTTP clients support these variables. HTTPS uses the sandbox proxy's CA certificate, exposed through standard Node/npm/Python certificate variables. Programs with their own trust stores may need configuration. Direct external TCP/UDP and DNS are blocked; raw sockets, host loopback services, SSH agents and host Docker sockets are not available. A service started by the same approved compound check can use container loopback. An HTTP CONNECT-capable client can tunnel to an approved destination/port.

## Authorization and freezing

An explicit goal permission policy with `network: ask` requires confirmation before online changes are applied. Grants bind the goal and normalized network mode, allow list and deny list; changing destinations or moving to open mode cannot reuse an unrelated grant. Workspace-only changes reuse the same network grant. Under an authorized autonomous policy, routine network configuration needs no extra confirmation. `/goal approve` remains for specification changes, not environment settings.

Each submission freezes the explicit variables, network policy, image/profile and source manifest. Input selection and sensitive-fixture exceptions belong in the personal profile; see the [boundary design](sandbox-boundary.md). Initial checks and audit reruns use these same identities, even if the live goal or workspace later changes. Auditors cannot change the environment or rerun unapproved commands. Completion verifies current inputs and ownership, and requires successful resource cleanup.

## Failure and migration behavior

A missing sandbox/profile, denied network access, read-only write, missing executable, resource limit or failed cleanup is never a passing check. Likely environment problems provide guidance without consuming implementation repair attempts. Three consecutive environment failures pause the goal; cleanup failures pause immediately and retain an exact resource lease for recovery.

The output classifier is a heuristic. A matching error phrase does not prove an environmental cause and never bypasses completion gates. Fix the actual capability or toolchain and rerun the approved command.

New goals use disposable writable workspaces; existing explicit modes and legacy missing-environment records keep their previous read-only setting. Existing `network: host` records normalize to `isolated`. Old host-network grants do not silently authorize open egress: choose a new policy explicitly. Old nonempty `env` lists must be cleared. Historical audit records remain unchanged. Removing the personal sandbox profile disables verification; there is no legacy or unrestricted execution fallback.

CPU, memory, process count, output, provision/check/cleanup deadlines and snapshot limits are personal profile settings. These sandbox resource limits are separate from goal/auditor token budgets. See [acceptance status](docker-sandboxes-acceptance.md) for the actual tested scope and outstanding platform checks.
