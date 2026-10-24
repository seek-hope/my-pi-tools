import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_VERIFICATION,
  normalizeVerification,
  type VerificationEnvironment,
} from './checks.ts';

export type GoalStatus =
  | 'draft'
  | 'queued'
  | 'active'
  | 'verifying'
  | 'paused'
  | 'blocked'
  | 'budget_limited'
  | 'complete'
  | 'skipped';
export interface Criterion {
  id: string;
  text: string;
  evidence: string[];
}
export interface Task {
  id: string;
  text: string;
  status: 'pending' | 'active' | 'done';
  evidence: string[];
}
export interface Check {
  id: string;
  command: string;
  last?: CheckResult;
}
export interface CheckResult {
  verification?: import('./verification/contract.ts').VerificationIdentity;
  at: string;
  command: string;
  exitCode: number;
  output: string;
  /** Hash of the verification environment used for this run. */
  environmentKey?: string;
  /** Set when the failure is attributed to the verification environment, not the work. */
  failure?: 'environment';
  /** Actionable hint for adjusting the verification environment. */
  hint?: string;
}
export interface AuditFinding {
  criterionId: string;
  passed: boolean;
  evidence: string;
}
export interface Audit {
  verification?: import('./verification/contract.ts').VerificationIdentity;
  at: string;
  verdict: 'pass' | 'fail' | 'error';
  details: string;
  model: string;
  findings: AuditFinding[];
  tokens: number;
  usageUnknown: boolean;
  errorKind?: 'budget';
  diagnostics?: {
    requests: number;
    initialPromptChars: number;
    maxContextChars: number;
    toolCalls: Record<string, number>;
    responses?: { stopReason: string; inputTokens: number; outputTokens: number; tokens: number }[];
  };
}
export interface Limits {
  maxTokens: number | null;
  maxAuditFailures: number;
  noProgressWarn: number;
  noProgressPause: number;
}
export interface PermissionPolicy {
  mode: 'autonomous' | 'confirm';
  network: 'ask' | 'allow';
  install: 'ask' | 'allow';
}
export function permissionDefaults(
  mode: PermissionPolicy['mode'] = 'autonomous',
): PermissionPolicy {
  const action = mode === 'autonomous' ? 'allow' : 'ask';
  return { mode, network: action, install: action };
}
export function validatePermissionPolicy(policy: PermissionPolicy) {
  if (!policy || !['autonomous', 'confirm'].includes(policy.mode))
    throw new Error('permissions.mode must be autonomous or confirm');
  for (const key of ['network', 'install'] as const)
    if (!['ask', 'allow'].includes(policy[key]))
      throw new Error(`permissions.${key} must be ask or allow`);
  if (Object.keys(policy).some((key) => !['mode', 'network', 'install'].includes(key)))
    throw new Error('Unknown permissions configuration field');
}
export interface GoalSpec {
  objective: string;
  kind: 'coding' | 'research' | 'general';
  criteria: string[];
  tasks: string[];
  checks: { command: string }[];
}
export interface Goal {
  id: string;
  generation: number;
  revision: number;
  objective: string;
  kind: GoalSpec['kind'];
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  approved: boolean;
  criteria: Criterion[];
  tasks: Task[];
  checks: Check[];
  /** Runtime capabilities for approved checks; not part of the approved specification. */
  verification: VerificationEnvironment;
  /** Consecutive environment-classified failures with the current environment. */
  consecutiveEnvironmentFailures: number;
  notes: string[];
  inputs: string[];
  nextStep: string;
  reason?: string;
  pendingSpec?: GoalSpec;
  directStart: boolean;
  completionClaim?: string;
  audits: Audit[];
  limits: Limits;
  usage: {
    tokens: number;
    turns: number;
    activeSeconds: number;
    auditTokens: number;
    unknown: number;
  };
  epoch: { turns: number; seconds: number };
  clockAt?: string;
  noProgressTurns: number;
  progressVersion: number;
  lastProgressVersion: number;
  consecutiveAuditFailures: number;
  auditModel?: { provider: string; model: string; thinking?: string };
  /** Saved execution policy; older journals fall back to the loaded settings. */
  permissionPolicy?: PermissionPolicy;
  /** Input count when execution stopped; model resume requires a later user message. */
  resumeAfterInput?: number;
  permissions: string[];
}
export interface Owner {
  sessionId: string;
  token: string;
  pid: number;
  host: string;
}
export interface ProjectState {
  schemaVersion: 1;
  /** Absent only in legacy directory journals. Current stores bind this to the Pi session. */
  sessionId?: string;
  /** Durable cancellation marker; survives compaction and transcript branching. */
  clearedAt?: string;
  clearReason?: 'user' | 'verified';
  revision: number;
  queuePaused: boolean;
  activeId: string | null;
  owner: Owner | null;
  goals: Goal[];
}
export const DEFAULT_LIMITS: Limits = {
  maxTokens: null,
  maxAuditFailures: 3,
  noProgressWarn: 3,
  noProgressPause: 5,
};
export const now = () => new Date().toISOString();
export const emptyState = (): ProjectState => ({
  schemaVersion: 1,
  revision: 0,
  queuePaused: true,
  activeId: null,
  owner: null,
  goals: [],
});
export const activeGoal = (s: ProjectState) => s.goals.find((g) => g.id === s.activeId);
/** Automatic cleanup must not cancel an unfinished queue or an unverified result. */
export function canAutoClear(state: ProjectState): boolean {
  const selected = activeGoal(state);
  return (
    selected?.status === 'complete' &&
    selected.audits.at(-1)?.verdict === 'pass' &&
    state.goals.every(terminal)
  );
}
export const isRunning = (g: Goal) => g.status === 'active' || g.status === 'verifying';
export const terminal = (g: Goal) => g.status === 'complete' || g.status === 'skipped';
export function validateLimits(limits: Limits) {
  for (const k of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const v = limits[k];
    if (k === 'maxTokens' && v === null) continue;
    if (!Number.isSafeInteger(v) || v! <= 0) throw new Error(`Invalid limit: ${k}`);
  }
  if (limits.noProgressPause <= limits.noProgressWarn)
    throw new Error('The stagnation pause threshold must exceed the warning threshold');
}
/** Drop retired runtime caps without rewriting historical journal entries. */
export function normalizeLimits(limits: Partial<Limits>): Limits {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  const result = Object.fromEntries(
    Object.keys(DEFAULT_LIMITS).map((key) => [key, merged[key as keyof Limits]]),
  ) as unknown as Limits;
  validateLimits(result);
  return result;
}
export function makeGoal(
  objective: string,
  limits: Partial<Limits> = {},
  directStart = false,
): Goal {
  if (!objective.trim() || objective.length > 16_000)
    throw new Error('The objective must contain 1-16000 characters');
  const merged = normalizeLimits(limits);
  return {
    id: randomUUID(),
    generation: 1,
    revision: 1,
    objective: objective.trim(),
    kind: 'general',
    status: 'draft',
    createdAt: now(),
    updatedAt: now(),
    approved: false,
    criteria: [],
    tasks: [],
    checks: [],
    verification: { ...DEFAULT_VERIFICATION, env: [] },
    consecutiveEnvironmentFailures: 0,
    notes: [],
    inputs: [],
    nextStep: '',
    audits: [],
    limits: merged,
    directStart,
    permissions: [],
    usage: { tokens: 0, turns: 0, activeSeconds: 0, auditTokens: 0, unknown: 0 },
    epoch: { turns: 0, seconds: 0 },
    noProgressTurns: 0,
    progressVersion: 0,
    lastProgressVersion: 0,
    consecutiveAuditFailures: 0,
  };
}
export function touch(g: Goal) {
  g.revision++;
  g.updatedAt = now();
}
export function checkpointTime(g: Goal, at = Date.now()) {
  if (g.clockAt) {
    const seconds = Math.max(0, (at - Date.parse(g.clockAt)) / 1000);
    g.usage.activeSeconds += seconds;
    g.epoch.seconds += seconds;
    g.clockAt = new Date(at).toISOString();
  }
}
export function transition(g: Goal, status: GoalStatus, reason?: string) {
  if (terminal(g)) throw new Error('Finished goals cannot resume; create a new goal');
  if (status === 'complete' && g.audits.at(-1)?.verdict !== 'pass')
    throw new Error('The independent audit has not passed');
  if ((status === 'active' || status === 'verifying') && !g.approved)
    throw new Error('The goal is not approved');
  checkpointTime(g);
  delete g.clockAt;
  g.status = status;
  g.reason = reason;
  if (['paused', 'blocked', 'budget_limited'].includes(status))
    g.resumeAfterInput = g.inputs.length;
  if (isRunning(g)) g.clockAt = now();
  else g.generation++;
  touch(g);
}
export function resumeGoal(g: Goal) {
  if (g.pendingSpec || !g.approved) throw new Error('Approve the goal scope first: /goal approve');
  if (g.limits.maxTokens !== null && g.usage.tokens + g.usage.auditTokens >= g.limits.maxTokens)
    throw new Error('Increase the cumulative token budget first: /goal budget');
  g.generation++;
  g.epoch = { turns: 0, seconds: 0 };
  g.noProgressTurns = 0;
  g.consecutiveAuditFailures = 0;
  g.consecutiveEnvironmentFailures = 0;
  transition(g, 'active');
  delete g.resumeAfterInput;
}
export function budgetReason(g: Goal): string | undefined {
  if (g.limits.maxTokens !== null && g.usage.tokens + g.usage.auditTokens >= g.limits.maxTokens)
    return `Cumulative token budget reached: ${g.limits.maxTokens}`;
}
export function applySpec(g: Goal, spec: GoalSpec) {
  if (
    !spec.objective.trim() ||
    !spec.criteria.length ||
    spec.criteria.some((x) => !x.trim()) ||
    spec.checks.some((c) => !c.command.trim())
  )
    throw new Error('Scope requires an objective, nonempty criteria and valid checks');
  g.objective = spec.objective.trim();
  g.kind = spec.kind;
  const requirements = [...spec.criteria];
  if (spec.kind === 'research')
    for (const text of RESEARCH_CRITERIA)
      if (!requirements.some((item) => researchKey(item) === researchKey(text)))
        requirements.push(text);
  g.criteria = requirements.map((text, i) => ({ id: `C${i + 1}`, text, evidence: [] }));
  g.tasks = spec.tasks.map((text, i) => ({
    id: `T${i + 1}`,
    text,
    status: 'pending',
    evidence: [],
  }));
  g.checks = spec.checks.map(({ command }, i) => ({ id: `K${i + 1}`, command }));
  g.approved = true;
  delete g.pendingSpec;
  g.generation++;
  g.progressVersion++;
  touch(g);
}
export function isTaskRefinement(goal: Goal, spec: GoalSpec): boolean {
  if (!goal.approved || goal.pendingSpec || !['active', 'queued'].includes(goal.status))
    return false;
  const remaining = [...spec.tasks];
  for (const task of goal.tasks) {
    const index = remaining.indexOf(task.text);
    if (index < 0) return false; // Removing an approved obligation still requires review.
    remaining.splice(index, 1);
  }
  const candidate = structuredClone(goal);
  applySpec(candidate, spec); // Normalize implicit research criteria before comparison.
  return (
    candidate.objective === goal.objective &&
    candidate.kind === goal.kind &&
    JSON.stringify(
      candidate.criteria.map((c) => (goal.kind === 'research' ? researchKey(c.text) : c.text)),
    ) ===
      JSON.stringify(
        goal.criteria.map((c) => (goal.kind === 'research' ? researchKey(c.text) : c.text)),
      ) &&
    JSON.stringify(candidate.checks.map(({ command }) => command)) ===
      JSON.stringify(goal.checks.map(({ command }) => command))
  );
}
export function refineTasks(goal: Goal, tasks: string[]): boolean {
  if (JSON.stringify(goal.tasks.map((t) => t.text)) === JSON.stringify(tasks)) return false;
  const existing = [...goal.tasks];
  let nextId = Math.max(0, ...existing.map((t) => Number(t.id.slice(1)) || 0)) + 1;
  goal.tasks = tasks.map((text) => {
    const index = existing.findIndex((task) => task.text === text);
    return index >= 0
      ? existing.splice(index, 1)[0]!
      : {
          id: `T${nextId++}`,
          text,
          status: 'pending',
          evidence: [],
        };
  });
  goal.generation++;
  goal.progressVersion++;
  touch(goal);
  return true;
}
export const RESEARCH_CRITERIA = [
  'Produce a Markdown analysis report describing methods, interpretation and limitations; do not fabricate data or citations.',
  'Produce an output manifest listing figures, tables and data artifacts.',
  'Record provenance: input locations and versions, software environment and verifiable references; explain inapplicable items.',
  'Save actual commands, check results and reproducible analysis scripts; disclose missing inputs instead of pretending to finish.',
];
// Recognize exact pre-English built-in criteria without rewriting approved history.
// These SHA-256 values identify the four original localized requirement strings.
const LEGACY_RESEARCH_HASHES = [
  '429a0aae9aa11fe799217d3c578d4959818f0b4be27ba75447d6edc809a24de4',
  'aadcb97fcc6aca8217172f5011495cfaae733f8f1d34b7393e34bb63813dc194',
  '4955f642250b899a5d2e05ee8937ec66031f95bc72048e8070376c3bb4f0e659',
  '106023fdc058c34fb0f10d089179fb0de3af02578862f77709b85f9a56033057',
];
function researchKey(text: string): string | number {
  const current = RESEARCH_CRITERIA.indexOf(text);
  const index =
    current >= 0
      ? current
      : LEGACY_RESEARCH_HASHES.indexOf(createHash('sha256').update(text).digest('hex'));
  return index >= 0 ? index : text;
}
export function completionProblems(g: Goal): string[] {
  const p: string[] = [];
  if (!g.approved || g.pendingSpec) p.push('Goal scope is not approved');
  if (!g.criteria.length) p.push('No acceptance criteria');
  for (const c of g.criteria) if (!c.evidence.length) p.push(`${c.id} missing evidence: ${c.text}`);
  for (const t of g.tasks) if (t.status !== 'done') p.push(`${t.id} is unfinished: ${t.text}`);
  return p;
}
export function recordTurn(g: Goal, tokens: number, meaningfulProgress: boolean) {
  checkpointTime(g);
  g.usage.turns++;
  g.epoch.turns++;
  g.usage.tokens += Math.max(0, tokens);
  g.noProgressTurns =
    meaningfulProgress || g.progressVersion > g.lastProgressVersion ? 0 : g.noProgressTurns + 1;
  g.lastProgressVersion = g.progressVersion;
  touch(g);
}
export function nextQueued(s: ProjectState) {
  const head = s.goals.find((g) => g.status === 'draft' || g.status === 'queued');
  return head?.status === 'queued' && head.approved ? head : undefined;
}
export function tokensFromUsage(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const u = usage as Record<string, unknown>;
  if (typeof u.totalTokens === 'number' && Number.isFinite(u.totalTokens))
    return Math.max(0, u.totalTokens);
  return ['input', 'output', 'cacheRead', 'cacheWrite'].reduce(
    (sum, key) =>
      sum +
      (typeof u[key] === 'number' && Number.isFinite(u[key]) ? Math.max(0, u[key] as number) : 0),
    0,
  );
}
export function validateState(value: unknown): asserts value is ProjectState {
  const s = value as ProjectState;
  if (
    !s ||
    s.schemaVersion !== 1 ||
    !Number.isSafeInteger(s.revision) ||
    !Array.isArray(s.goals) ||
    typeof s.queuePaused !== 'boolean'
  )
    throw new Error('Invalid goal journal structure');
  const ids = new Set<string>();
  for (const g of s.goals) {
    if (
      !g ||
      typeof g.id !== 'string' ||
      ids.has(g.id) ||
      ![
        'draft',
        'queued',
        'active',
        'verifying',
        'paused',
        'blocked',
        'budget_limited',
        'complete',
        'skipped',
      ].includes(g.status) ||
      !Array.isArray(g.criteria) ||
      !Array.isArray(g.tasks) ||
      !Array.isArray(g.checks) ||
      !g.usage ||
      !g.epoch
    )
      throw new Error('Invalid goal record');
    ids.add(g.id);
    validateLimits(g.limits);
    normalizeVerification(g.verification);
    if (
      g.consecutiveEnvironmentFailures !== undefined &&
      (!Number.isSafeInteger(g.consecutiveEnvironmentFailures) ||
        g.consecutiveEnvironmentFailures < 0)
    )
      throw new Error('Invalid verification failure counter');
    if (g.permissionPolicy !== undefined) validatePermissionPolicy(g.permissionPolicy);
  }
  if (s.activeId !== null && !ids.has(s.activeId))
    throw new Error('The selected goal does not exist');
}
