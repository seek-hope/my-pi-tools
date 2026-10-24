# Main-session execution and read-only review

Goal manages approved scope, progress, execution evidence and independent completion review. It does not provide an execution sandbox. The main Pi session owns file changes, commands, dependency installation and external actions under its existing permissions.

## Workflow

1. Define and approve the objective, criteria, tasks and check commands as before.
2. The main session implements the work and records criterion/task evidence with `goal_progress`.
3. For each approved check, the main session calls `goal_check` with `goal_id`, `generation` and `check_id`. It delegates the exact approved command to Pi's `bash` tool through `ctx.executeTool`, preserving normal tool hooks and permissions. There is no private command runner. Commands run in the host tool's environment and their writes remain in the project.
4. `goal_submit` requires completed tasks, evidence for every criterion and current passing check records. It starts a fresh temporary read-only reviewer. It never runs commands.
5. The reviewer inspects artifacts and either returns a finding for each criterion or requests specific information from the main session.
6. Completion requires a passing review, unchanged reviewed inputs and the original live session/goal/generation/ownership. Cancellation, budget stops, stale results and unresolved requests cannot complete a goal.

`goal_check` records the actual tool call ID, command, timestamp, structured exit code, error status, bounded output, goal generation and workspace freshness marker. The executed command comes from Pi’s `tool_result.input`, because the returned tool-call object retains arguments from before permission/argument hooks. A rewritten or unobserved command cannot certify the approved check. Starting a rerun invalidates its earlier receipt, including when the new attempt is cancelled or throws. A nested tool’s `terminate` flag is propagated to the main tool result, so a host stop request cannot silently become another model turn. Project stdout cannot manufacture exit metadata. Missing structured exit metadata or a blocked/failed tool call cannot pass. A replacement `bash` tool must preserve Pi's `structuredContent.exit_code` contract; there is no fallback that parses stdout or trusts an executor-written success flag. The host tool implementation and permission hooks are trusted.

Commands run in the normal main-session environment, including its existing variables and tools. Goal does not select a VM, change networking, inject variables or install dependencies on behalf of the reviewer. Check results from ordinary `bash` calls are useful context but do not automatically become certified Goal check records: use `goal_check` for the approved commands.

## Information requests

The reviewer has `audit_request({criterionId, question, checkId?})`. The criterion must exist, and any check ID must already belong to the approved scope. A question can ask for an explanation, the location of an artifact, or a missing check result. It cannot approve new scope or execute a command.

A request ends the current temporary review with `needs_info`. Goal persists an ID, generation, criterion, question and optional check ID, returns it in `goal_submit` and displays the request in the main session. The goal returns to `active`; the request does not consume an implementation repair attempt. There is no child waiting for a reply while holding the main tool call open.

The main session performs authorized work, runs any needed approved check, and calls:

```json
{
  "goal_id": "current goal ID",
  "generation": 1,
  "request_id": "ID returned by the reviewer",
  "answer": "Concrete answer with artifact locations or references to recorded check results"
}
```

This is the parameter shape for `goal_reply`. It records executor evidence, not an audit pass. Unknown or stale request IDs are rejected. Answers are committed as separate values and cannot mutate the original reviewer request in audit history through shared object references. Answers survive reload through the existing journal; fresh reviewers receive current-generation questions and answer previews, and can page full answers through `audit_record` with `source: "request"`.

The main session then resubmits. Unanswered current requests prevent another review. Each resubmission creates a new context, with no inherited execution conversation. It must inspect artifacts again before passing; an answer alone cannot satisfy inspection. A request and passing verdict in one model response cannot bypass this handoff. Genuine missing user input still uses the existing `goal_wait` process after independent authorized work is finished.

Both tool and session cancellation signals stop submission/review. If the active tool policy hides a check tool needed for unfinished checks or a reply tool needed for an unanswered request, automatic continuation pauses with the missing tool name.

The default is one temporary reviewer per submission, using the existing configurable audit model. This implementation does not introduce a parallel reviewer pool or majority voting.

## Read-only capability boundary

The temporary reviewer uses the existing provider-neutral model loop with an explicit tool registry:

| Tool | Capability |
| --- | --- |
| `audit_read`, `audit_search` | Read project text and locate literal matches |
| `audit_list` | Browse one project directory |
| `audit_record` | Read frozen executor evidence, main-session check output or an answer |
| `audit_request` | Return an information request to the main session |
| `audit_result` | Return one finding per criterion |

No shell, edit, write, general tool dispatcher, MCP, recursive delegation or project extension discovery is exposed. Unknown tool calls fail schema/registry checks. This is an application-level capability restriction; the controller itself still runs with host permissions.

File paths are canonicalized and must remain inside the project. Internal symlinks and hardlinks are usable without copying files or granting snapshot exceptions. Outside-project links cannot be read by the reviewer. UTF-8 text files are limited to 5 MB. The byte limit is enforced while reading the opened file, including growth after initial metadata inspection; invalid UTF-8 and NUL bytes are rejected instead of silently replacing binary data. Binary artifacts need a reviewable text or statistical export. Reads/searches and check outputs are paged/bounded. Listing directories, reading executor records and reading answers do not count as independent artifact inspection. Findings can be submitted only in a later response after a successful artifact inspection.

## Freshness and limits

Check records bind to a lightweight source inventory of paths, regular-file identity, mode, size and modification/change timestamps, plus symlink text. It does not copy the tree, execute Git hooks/filters, read all file contents or follow directory symlinks. The inventory is capped at 100,000 entries. It omits directories named `.git`, `.pi`, `.codegraph`, `node_modules`, `.venv`, `__pycache__`, `target`, `dist`, `build`, `coverage` and `.cache`, as well as the canonical Pi agent directory and current session log. Ordinary source files with those names remain tracked, and control paths are resolved through workspace symlinks. Ordinary installation/build output and control-record writes therefore do not invalidate source check records.

The reviewer additionally records content digests for every text file it actually reads/searches and for directory listings, including explicitly read generated files. Only paths and digests are retained between reads, rather than full artifact bodies. Before a pass, those observations are read again and the source marker is compared. A failure to re-read the final source inventory also invalidates the review without consuming an implementation repair attempt. Changed or unreadable observations invalidate the review while retaining incurred usage; they do not spend an implementation repair attempt. Changed source makes earlier check records stale and requires rerunning them. Source markers are compared before and after each check as well: changes during execution leave the actual exit code/output intact but mark the receipt unsuccessful. Run formatters or other source edits before the final check; write generated check output under an omitted directory such as `coverage` or `dist` so it does not continuously invalidate source records.

These are freshness checks, not an atomic snapshot or a complete dependency/environment model. Generated/ignored paths, external services, dependencies, environment changes and malicious same-user writers are not fully tracked by the source marker. Rerun checks after relevant changes to those inputs. No OS isolation, hermetic test execution, guaranteed semantic correctness or universally independent test reproduction is claimed. Normal Pi permissions and user authorization govern host execution.

## Migration

The Docker Sandboxes backend, `goal_environment`, `/goal sandbox`, image profiles, proxy rules, leases and VM verification scripts have been removed. Existing personal `sandbox` settings are ignored and need not block startup; they do not cause host commands to run. The extension does not alter those personal files or shared Docker services.

Historical journal bytes and audit reports remain intact. Retired environment settings are omitted from current state projections. Historical sandbox check outputs remain historical evidence but cannot satisfy the new main-session check gate; unfinished goals must rerun approved checks with `goal_check`. A pending review is not resumed automatically after reload: the usual explicit resume and generation guards still apply.

Before upgrading an installation that still has an old verification VM running, stop it and complete recovery using the old version. The new extension does not claim to recover retired backend leases. The previous implementation and its bounded microVM acceptance are preserved in [Git history](https://github.com/seek-hope/my-pi-tools/tree/759dc8f/goal).

## Validation

The regression suite covers actual Pi SDK dispatch and permissions, command receipts, source changes, artifact/link changes, request/answer/resubmission, saved-session reopen, stale replies, cancellation, accounting and legacy state projection. Providers in the SDK tests are offline fixtures; real `bash` calls still execute in temporary projects. The finite CheckProtocol and VerificationProtocol models cover metadata/cancellation/identity gates and request/reply/fresh-review decisions. They do not prove host execution safety or model judgment.
