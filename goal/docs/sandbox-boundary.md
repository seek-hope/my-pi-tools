# Verification sandbox boundary

Goal isolates approved check commands and audit reruns. The boundary is intended to contain accidental or hostile behavior in project code and its dependencies, keep the host workspace unchanged by verification, and bind results to the submitted inputs and environment. Goal management, ordinary Pi tools and MCP tools still execute with the host user's permissions.

## Trust and guarantees

| Component | Treatment |
| --- | --- |
| Check commands, source, dependencies, stdout and generated files | Untrusted. Run in a fresh non-root container inside a fresh microVM. |
| Host Pi, extensions, goal controller, personal profile and journal | Trusted. A hostile process with the same host user privileges is outside this boundary. |
| Pinned VM template, supervisor, Docker engine, check image and sbx daemon | Trusted execution infrastructure. Inner-container restrictions matter because the template can expose integration capabilities. |
| Local forward proxy and Docker upstream proxy/DNS/policies | Trusted network enforcement. Allowed destinations may still receive any source bytes available to a check. |
| Independent auditor | Separate context and tools, with mechanical gates. Its semantic judgment can still be wrong. |

The isolation layer does not authenticate the meaning of a successful test, prove acceptance criteria complete, prevent ordinary host tools from causing damage, or provide a general credential detector. Hashes bind selected content, not the provenance of every byte. Hostile concurrent host writers and filesystem/VM/kernel exploits remain outside the tested guarantee.

## Source selection

`source-v2` reads current source bytes, including dirty and untracked files. It never runs Git filters, hooks, ignore commands or project-supplied selection code. The personal sandbox profile may select relative file/directory paths; directories include their descendants. Input overrides are not model-controlled fields of `goal_environment`.

```json
{
  "sandbox": {
    "inputs": {
      "project": "/absolute/path/to/project",
      "include": ["src", "test", "package.json", "package-lock.json"],
      "exclude": ["test/large-downloads"],
      "allowFiles": ["test/fixtures/public.pem", "test/fixtures/.env.example"],
      "materializeHardlinks": ["src/generated-table.json"]
    }
  }
}
```

This is an excerpt to merge into an already configured pinned sandbox profile. All input fields are optional. With no `include`, the default project scan applies. Paths are literal, relative and have no globs, traversal or executable hooks; up to 128 paths per list are accepted. An empty `include` is rejected. Explicit includes that are absent or excluded fail preparation rather than silently creating an incomplete verification tree.

- `project` binds the overrides to that canonical workspace. It is required for `allowFiles` or `materializeHardlinks`; a different workspace is rejected. Prefer setting it for any customized selection.
- `exclude` removes a path/subtree and takes precedence over file exceptions.
- `allowFiles` permits exact, reviewed regular fixture files otherwise excluded by sensitive filenames. It cannot grant a directory, symlink, private control path or unknown external content automatically.
- `materializeHardlinks` permits copying an exact selected file whose other inode names cannot all be accounted for inside the selection. Review that file's contents before granting it. The snapshot never retains a link to the host inode.

Private control/credential directories (`.git`, `.pi`, `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.codegraph`) are always excluded. Dependency/generated directories (`node_modules`, `target`, `.venv`, `__pycache__`) are also omitted: build them inside the disposable environment or supply dependencies through the trusted check image. `.npmrc`, `.netrc`, `.pypirc`, `.env`, `.env.*` and `.pem/.key/.p12/.pfx` files are excluded unless an exact file exception applies. These are filename rules, not secret detection; they do not interpret `.gitignore`.

Use `/goal sandbox inputs [offset]` to inspect the selection before starting a VM. The model can use `goal_environment` with `inspect_inputs: true` and optional `input_offset`; inspection cannot be mixed with mutations. The inventory shows included, excluded and rejected paths, reasons, byte totals and pagination. It returns no contents, needs no daemon or image archive, and does not change a goal. It is a preview; submission revalidates the current files.

## Links and immutable evidence

Internal hardlinks are accepted only when every inode name is accounted for in the selected tree. They become independent files. This intentionally preserves bytes and executable bits, not shared-inode semantics; a project whose tests depend on hardlink identity must create those links as part of its check. A missing alias requires the exact personal grant described above. This rule limits accidental inclusion from excluded/outside paths; it cannot prove the origin of an ordinary file's contents.

Relative symlinks are accepted when their resolved targets are selected files/directories inside the same project. The snapshot rewrites them to canonical internal relative targets. Absolute, dangling, outside-scope and excluded-target links are rejected, as are file and directory traversal cycles. Symlink directories are never traversed while selecting host inputs. Special files such as devices, sockets and FIFOs are rejected.

The scanner inventories links before reading regular files, checks file identity/size/timestamps around bounded reads, creates private copies and checks current selected inputs again. It installs validated symlinks only after creating files and directories. The manifest records source link text, snapshot targets and hardlink materialization decisions. Selected content, selection policy and executable bits affect the snapshot identity; changes to excluded content/diagnostic names do not. This is not an atomic filesystem snapshot against a malicious host writer.

## Useful execution without host inheritance

New goals default to `ephemeral`: the check can install dependencies, build and write test output in a disposable workspace. Writes never return to the host. `readonly` remains available for checks that must not modify source. Existing explicit settings, and legacy records without a workspace setting, retain the previous read-only behavior.

`goal_environment.variables` accepts explicit non-secret string values, for example `{"CI":"1","TZ":"UTC","NODE_ENV":"test"}`. Nothing is read from the corresponding host environment variables. Values are canonicalized and included in the frozen environment identity for initial checks and audit reruns. `{}` clears them. They are stored in goal history, so do not put secrets in them.

At most 32 values are allowed, with 4 KiB per value and 16 KiB combined names/values. Credential names and proxy, TLS, shell-startup and core execution-control variables are reserved. This name check is an error-prevention measure, not proof that arbitrary strings contain no secrets. Legacy `env` forwarding lists must remain empty. The supervisor's own environment is separate and is not affected by check values. These reserved names protect the supervisor-supplied defaults from accidental configuration overrides; arbitrary project code can still change its own process environment. Network isolation is enforced by the VM/container network and proxy, not by trusting environment variables.

Each check and rerun still has a fresh VM. Use one approved compound command for stages that depend on each other, for example `npm ci --offline --ignore-scripts && npm run build && npm test`. Bake suitable toolchains/dependencies into a pinned image or use an approved dependency download policy. Mutable shared caches and implicit host execution are not introduced.

## Failures and limits

Invalid input selection fails before contacting the daemon or copying the image archive. Snapshot diagnostics point to the preview and the specific policy adjustment needed. Environment problems never become passes or consume implementation repair attempts. Cleanup failures retain their exact leases and block further verification. A failed audit cannot override a failed check, changed input or incomplete cleanup.

CPU, memory, processes, output and execution/provision/cleanup deadlines remain configurable per personal profile. Aggregate disk use and resource consumption across concurrent sessions are not a host quota; use host resource controls for that requirement. Isolation and network modes are documented in [setup](docker-sandboxes-setup.md). The [acceptance record](docker-sandboxes-acceptance.md) distinguishes unit/contract checks, real microVM cases and untested platform/crash scenarios. The existing TLA+ models describe protocol gates; they do not prove this filesystem or virtualization implementation.
