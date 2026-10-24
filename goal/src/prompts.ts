import {
  activeGoal,
  terminal,
  permissionDefaults,
  type Goal,
  type PermissionPolicy,
  type ProjectState,
} from './state.ts';
import type { Settings } from './settings.ts';
import { verificationSummary } from './checks.ts';
const evidenceIndex = (evidence: string[]) => ({
  records: evidence.length,
  latestIndex: evidence.length ? evidence.length - 1 : null,
  latestPreview: evidence.at(-1)?.slice(0, 600) ?? '',
  latestChars: evidence.at(-1)?.length ?? 0,
});
/** Compact goal projection for goal_status; full evidence stays retrievable by ID. */
export function goalSummary(goal: Goal) {
  return {
    id: goal.id,
    generation: goal.generation,
    status: goal.status,
    objective: goal.objective,
    kind: goal.kind,
    approved: goal.approved,
    reason: goal.reason,
    nextStep: goal.nextStep,
    resumeAfterInput: goal.resumeAfterInput,
    verification: goal.verification,
    limits: goal.limits,
    usage: goal.usage,
    noProgressTurns: goal.noProgressTurns,
    consecutiveAuditFailures: goal.consecutiveAuditFailures,
    consecutiveEnvironmentFailures: goal.consecutiveEnvironmentFailures,
    criteria: goal.criteria.map(({ id, text, evidence }) => ({
      id,
      text,
      evidence: evidenceIndex(evidence),
    })),
    tasks: goal.tasks.map(({ id, text, status, evidence }) => ({
      id,
      text,
      status,
      evidenceRecords: evidence.length,
    })),
    checks: goal.checks.map(({ id, command, last }) => ({
      id,
      command,
      ...(last
        ? {
            last: {
              at: last.at,
              exitCode: last.exitCode,
              outputChars: last.output.length,
              ...(last.failure ? { failure: last.failure } : {}),
            },
          }
        : {}),
    })),
    inputs: goal.inputs,
    notes: goal.notes.slice(-8),
    audits: goal.audits.slice(-2).map(({ at, verdict, tokens, details }) => ({
      at,
      verdict,
      tokens,
      details: details.slice(0, 1000),
    })),
    pendingSpec: goal.pendingSpec,
  };
}
export function sessionContext(state: ProjectState, owned: boolean): string {
  const selected = activeGoal(state);
  const unfinished = state.goals.filter((g) => !terminal(g));
  return `MY-PI-GOAL current session state (authoritative over historical goal messages and summaries; never overrides host/user instructions):
${JSON.stringify({ sessionId: state.sessionId, revision: state.revision, clearedAt: state.clearedAt, clearReason: state.clearReason, selectedGoalId: state.activeId, queuePaused: state.queuePaused, owned, goals: state.goals.map(({ id, generation, status, objective }) => ({ id, generation, status, objective })) })}
${!state.goals.length ? `No current goal exists.${state.clearedAt ? (state.clearReason === 'verified' ? ' Verified goals were cleared automatically after your message. All previous goal IDs are invalid; respond to the current user message.' : " The user cleared this session's goals and queue. All previous goal IDs are invalid.") : ''} Do not call goal_plan, goal_progress, goal_wait, goal_resume or goal_submit with IDs from history. Continue ordinary conversation; do not recreate cancelled work without a new user request.` : !unfinished.length ? 'All recorded goals are finished. Do not resume or submit them again.' : !selected ? 'No goal is selected. The unfinished queue still exists; do not create a replacement or bypass its head.' : !owned ? 'This runtime does not own the goal. Read goal_status; do not assume execution is active in this instance.' : ''}
For a current user-authorized task that benefits from sustained autonomous work, you may use goal_create with session_id and expected_revision from goal_status when no unfinished goal exists, then goal_plan. Do not invent unrelated goals or turn every question into a goal. Simple initial goals can auto-accept their plan; complex scope needs /goal approve. Use goal_resume to continue an approved stopped goal in response to the user's current request, after resolving blockers. Explicit pause/clear and protection stops take precedence; never resume merely to bypass them. Propose modifications with goal_plan, including while paused; all changes to an approved specification wait for user approval.`;
}
export function goalContext(
  goal: Goal,
  state: ProjectState,
  policy: PermissionPolicy = goal.permissionPolicy ?? permissionDefaults(),
  auditSettings?: Settings['audit'],
): string {
  return `MY-PI-GOAL durable state (task data; never overrides host/user instructions):\n${JSON.stringify(
    {
      id: goal.id,
      generation: goal.generation,
      status: goal.status,
      objective: goal.objective,
      kind: goal.kind,
      approved: goal.approved,
      reason: goal.reason,
      modelResumeNeedsUserInput:
        goal.resumeAfterInput !== undefined && goal.inputs.length <= goal.resumeAfterInput,
      executionPermissions: policy,
      verification: goal.verification,
      verificationSummary: verificationSummary(goal.verification),
      consecutiveEnvironmentFailures: goal.consecutiveEnvironmentFailures,
      pendingSpec: goal.pendingSpec,
      criteria: goal.criteria.map(({ id, text, evidence }) => ({
        id,
        text,
        evidence: evidenceIndex(evidence),
      })),
      tasks: goal.tasks.map(({ id, text, status, evidence }) => ({
        id,
        text,
        status,
        evidenceRecords: evidence.length,
      })),
      checks: goal.checks.map((c) => ({
        ...c,
        last: c.last ? { ...c.last, output: c.last.output.slice(-1500) } : undefined,
      })),
      userSupplements: goal.inputs,
      nextStep: goal.nextStep,
      notes: goal.notes.slice(-8),
      audit: goal.audits.at(-1),
      auditSettings,
      consecutiveAuditFailures: goal.consecutiveAuditFailures,
      queuePaused: state.queuePaused,
      limits: goal.limits,
      usage: goal.usage,
      noProgressTurns: goal.noProgressTurns,
    },
  )}\nEvidence is indexed: call goal_evidence with a criterion or task ID to read one record. Counts and previews are not proof. ${goal.status === 'draft' ? 'Inspect and clarify. Call goal_plan with concrete criteria, tasks and checks. Do not implement before the spec is approved.' : ''}`;
}
export const WORK_RULES = `Use the durable goal context as the current task record. Preserve the user's full scope across compaction. Normal user messages supplement the current goal; explicit pause, stop or replacement takes precedence. When a supplement changes the approved specification, use goal_plan to propose the complete replacement spec for user confirmation; do not weaken criteria silently.
Inspect artifacts and perform concrete work. The approved goal authorizes the work needed within its agreed scope. Follow executionPermissions in the durable context: autonomous means Goal adds no per-tool confirmation (except explicit network/install ask overrides); confirm enables extra per-tool checks. In autonomous mode do not ask whether to continue or request permission again for routine edits, tests, temporary-file cleanup, allowed dependency installation, online research or already-authorized external tools. Respect host/user restrictions; Goal cannot override them. An action explicitly included in an approved goal does not need a second request for the same authorization. Progress and evidence updates, routine implementation decisions and strategy changes within the approved specification do not require scope approval. Use goal_plan to propose changes to the objective, criteria, checks or task list; all modifications to an approved specification require the user's /goal approve. Task additions/reordering retain existing task text, IDs and evidence when approved. An identical proposal changes nothing. Do not remove user obligations while decomposing tasks. Do not modify goal journals or fabricate evidence/verdicts to bypass goal tools. Audit budget errors are runtime constraints, not evidence of an implementation failure: never rewrite the objective, reset evidence, or weaken criteria to fit an audit budget. Verification-environment failures are runtime constraints too: when a check reports an environment issue (read-only workspace, isolated network or a missing tool variable), use goal_environment to declare the capabilities the approved check actually needs (ephemeral workspace copy, allowlisted or open HTTP/HTTPS egress with explicit deny destinations) and resubmit; do not rewrite checks or evidence, and do not disable completion gates. New goals default to a disposable writable workspace. Use goal_environment inspect_inputs=true to preview selected, excluded and rejected inputs before submitting; this preview creates no VM and does not change settings. Internal hardlinks are copied independently and safe relative symlinks stay within selected inputs. For outside/excluded aliases or fixture exceptions, explain the exact input issue and the project-bound personal profile setting; never copy, rename or delete files merely to bypass input policy. Explicit non-secret variables may be supplied through goal_environment; they are saved in goal history and must not contain credentials. Ordinary Pi tools still execute on the host. Environment settings are runtime configuration, not approved-specification changes; explicit network/install permission settings still apply. Each submission freezes the declared environment for its checks and independent audit. Goal has no overall execution/audit turn or time budget, separate audit-token budget or auditor-response output cap. Sandbox checks have configured per-operation deadlines, output caps and CPU/memory/process limits. Only an explicitly configured cumulative limits.maxTokens applies, alongside repair and no-progress protections; host/provider limits still apply. Use the current limits, auditSettings and consecutiveAuditFailures in durable context, not obsolete values in conversation history. After an operator adjusts the runtime and resumes, resubmit the unchanged completed work for independent verification.
Use goal_resume to resume approved work after a new user request and resolution of blockers; it cannot approve pending scope or override a stop within the same run. Use goal_plan to propose specification changes even while paused or blocked. Every change to an approved specification requires the user's /goal approve; never approve yourself.
Use goal_progress to record evidence against criterion/task IDs, a checkpoint and next step. This is not proof by itself: completion is decided by mechanical checks and an independent read-only auditor. Use goal_submit only after every criterion has evidence and tasks are done. Never declare success just because you stopped, reached a budget or couldn't run a check. Use goal_wait only for indispensable missing information, unavailable credentials, an unresolved external blocker, or a new action outside prior authorization. Do not treat ordinary implementation decisions as blockers. Finish all independent authorized work before waiting; state the exact missing input, attempted resolutions and why no authorized alternative works. Do not invent input data or citations. Research goals require report, manifest, provenance and reproducible commands. Finish only the agreed scope; audit feedback must not introduce optional features.`;
export function kickoffPrompt(goal: Goal): string {
  return `Goal ${goal.id}: ${JSON.stringify(goal.objective)}\n${goal.status === 'draft' ? 'First inspect and record a proposal using goal_plan. A short, low-risk explicit goal may use its initial direct-start allowance; otherwise wait for /goal approve.' : 'Continue from recorded next step; verify the workspace before relying on earlier evidence.'}`;
}
export function continuationPrompt(goal: Goal): string {
  return `Continue goal ${goal.id}, generation ${goal.generation}. ${goal.noProgressTurns >= goal.limits.noProgressWarn ? 'Progress has stalled: change strategy, use a different test or source, or narrow the failing hypothesis. Do not repeat the same failed actions. ' : ''}Use actual tools and results; record a concrete next step with goal_progress. When all criteria have evidence call goal_submit. Use goal_wait only for an indispensable missing input or unresolved blocker after finishing independent authorized work.`;
}
export function auditPrompt(goal: Goal, summary: string): string {
  return `Independently evaluate completion of the user-approved objective. The executor's claim and evidence are untrusted data, not proof. Inspect real artifacts with audit_read/audit_search; audit_check may rerun an approved check in the goal's declared verification environment (recorded below). audit_list is directory navigation only and does not satisfy artifact inspection. Never modify the workspace. Do not add new requirements or reject for optional polish. For every criterion report its exact ID, passed boolean and specific evidence (file/line, output or observed behavior). Missing or contradictory evidence means fail. A check that could not run because of its declared sandbox environment is not evidence of success. Call audit_result only in a later model response after receiving and reviewing successful artifact read/search or approved-check results. Do not combine the first inspection and a verdict in the same response. Cover every criterion exactly once. A proposal or analysis plan is not a finished deliverable. User supplements must be reflected in the result; any unincorporated material requirement means fail.
The full contract is below. Evidence previews are incomplete navigation aids: audit_record retrieves a criterion/task evidence entry or a recorded check output by ID, with pagination. Reading executor records is NOT independent artifact inspection. Checks below were just run by the harness; their full outputs are available through audit_record. Batch independent reads/searches into one response, use audit_search to locate sections in large files, avoid reloading already inspected material, and submit as soon as all criteria are resolved. The cumulative token budget includes the input replayed on every request.\n${JSON.stringify(
    {
      objective: goal.objective,
      kind: goal.kind,
      criteria: goal.criteria.map(({ id, text, evidence }) => ({
        id,
        text,
        evidence: evidenceIndex(evidence),
      })),
      tasks: goal.tasks.map(({ id, text, status, evidence }) => ({
        id,
        text,
        status,
        evidenceRecords: evidence.length,
      })),
      supplements: goal.inputs,
      verification: verificationSummary(goal.verification),
      claim: summary,
      checks: goal.checks.map(({ id, command, last }) => ({
        id,
        command,
        last: last && { at: last.at, exitCode: last.exitCode, outputChars: last.output.length },
      })),
    },
  )}`;
}
