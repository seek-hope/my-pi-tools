import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { createHash } from 'node:crypto';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { ProjectStore } from './store.ts';
import { defaults, effectivePermissions, loadSettings, type Settings } from './settings.ts';
import {
  activeGoal,
  applySpec,
  budgetReason,
  canAutoClear,
  checkpointTime,
  completionProblems,
  isRunning,
  isTaskRefinement,
  refineTasks,
  makeGoal,
  nextQueued,
  now,
  permissionDefaults,
  recordTurn,
  resumeGoal,
  terminal,
  tokensFromUsage,
  touch,
  transition,
  type Audit,
  type Goal,
  type ProjectState,
} from './state.ts';
import {
  goalContext,
  goalSummary,
  sessionContext,
  WORK_RULES,
  kickoffPrompt,
  continuationPrompt,
} from './prompts.ts';
import { runIndependentAudit } from './auditor.ts';
import {
  EnvironmentError,
  normalizeVerification,
  type VerificationEnvironment,
  verificationKey,
  verificationSummary,
} from './checks.ts';
import { reviewStagnation } from './stagnation.ts';
import { permissionKey, permissionReason, permissionSummary } from './permissions.ts';
import { goalStatusText, renderGoalWidget } from './tui.ts';
import { confirmPendingScope, formatPendingScope } from './approval.ts';
import { join } from 'node:path';
import { prepareVerification, type VerificationContext } from './verification/pipeline.ts';
import { SandboxError } from './verification/contract.ts';
import { DockerSandboxes } from './verification/docker-sandboxes.ts';

type Context = ExtensionContext;
type PanelMode = 'compact' | 'expanded' | 'hidden';
const textResult = (text: string, details: unknown = {}) => ({
  content: [{ type: 'text' as const, text }],
  details,
});
const identity = Type.Object({ goal_id: Type.String(), generation: Type.Integer({ minimum: 1 }) });
const bounded = (maxLength = 4000) => Type.String({ minLength: 1, maxLength });
const specSchema = Type.Object({
  objective: bounded(16_000),
  kind: StringEnum(['coding', 'research', 'general'] as const),
  criteria: Type.Array(bounded(), { minItems: 1, maxItems: 50 }),
  tasks: Type.Array(bounded(), { maxItems: 50 }),
  checks: Type.Array(Type.Object({ command: bounded() }), { maxItems: 20 }),
});
interface Fence {
  store: ProjectStore;
  token: string;
  id: string;
  generation: number;
}
export interface Dependencies {
  audit?: typeof runIndependentAudit;
  probe?: (
    cwd: string,
    environment: VerificationEnvironment,
    signal?: AbortSignal,
  ) => Promise<{ ok: true } | { ok: false; hint: string }>;
  prepareVerification?: typeof prepareVerification;
  stagnation?: typeof reviewStagnation;
  agentDir?: string;
}
/** Environment problems stop the loop after repeated identical failures, never as a completion. */
const MAX_ENVIRONMENT_FAILURES = 3;
export class GoalRuntime {
  store?: ProjectStore;
  settings: Settings = structuredClone(defaults);
  fault?: string;
  private context?: Context;
  private timer?: ReturnType<typeof setInterval>;
  private auditController?: AbortController;
  private turn?: Fence;
  private clearAfterTurn?: Fence;
  private fingerprints = new Set<string>();
  private toolInputs = new Map<string, unknown>();
  private progressed = false;
  private panel: PanelMode = 'compact';
  private lastClock = 0;
  private readonly pi: ExtensionAPI;
  private readonly deps: Dependencies;
  constructor(pi: ExtensionAPI, deps: Dependencies = {}) {
    this.pi = pi;
    this.deps = deps;
  }
  get state(): ProjectState {
    if (!this.store) throw new Error('Goal runtime has not started');
    return this.store.load();
  }
  private write(event: string, change: (s: ProjectState) => void) {
    if (!this.store) throw new Error('No current session');
    const state = this.store.change(event, change);
    this.pi.appendEntry('my-pi-goal', {
      sessionId: this.store.sessionId,
      projectRevision: state.revision,
      goalId: state.activeId,
      generation: activeGoal(state)?.generation,
      event,
    });
    if (this.context) this.render(this.context);
    return state;
  }
  private fence(g: Goal): Fence {
    return { store: this.store!, token: this.store!.token, id: g.id, generation: g.generation };
  }
  private current(fence: Fence, statuses?: Goal['status'][]): Goal {
    if (
      this.fault ||
      fence.store !== this.store ||
      fence.token !== fence.store.token ||
      !fence.store.owns()
    )
      throw new Error('Session changed or ownership expired');
    const g = this.state.goals.find((g) => g.id === fence.id);
    if (!g || g.generation !== fence.generation || (statuses && !statuses.includes(g.status)))
      throw new Error('Goal version or status changed; read goal_status again');
    return g;
  }
  private require(id: string, generation: number, statuses: Goal['status'][] = ['active']) {
    if (this.fault) throw new Error(this.fault);
    const candidate = this.state.goals.find((goal) => goal.id === id);
    if (!candidate || candidate.generation !== generation || !statuses.includes(candidate.status))
      throw new Error('Goal version or status changed; read goal_status again');
    this.claim();
    const fence: Fence = { store: this.store!, token: this.store!.token, id, generation };
    const g = this.current(fence, statuses);
    if (this.state.activeId !== id && !statuses.includes('draft'))
      throw new Error('Only the selected goal can be modified');
    return g;
  }
  private missingGoalResult(id: string) {
    if (this.fault) throw new Error(this.fault);
    const s = this.state;
    if (s.goals.some((g) => g.id === id)) return;
    return textResult(
      `Goal no longer exists in this session (it may have been cleared or belong to another session). Nothing was changed. Do not retry this ID or recreate cancelled work. Read goal_status and follow the user's current request.\n${sessionContext(s, this.store!.owns(s))}`,
      { disposition: 'stale_goal', goalId: id, state: s },
    );
  }
  private claim(expectedRevision?: number) {
    if (!this.store) throw new Error('Runtime has not started');
    if (!this.store.owns()) this.store.claim(expectedRevision);
  }
  private releaseIdle(ctx: Context, settled = false) {
    if (!this.store?.owns() || this.auditController || (!settled && !ctx.isIdle())) return;
    const state = this.state;
    const g = activeGoal(state);
    if (!settled && g && (isRunning(g) || (g.status === 'complete' && !state.queuePaused))) return;
    // agent_settled is notification-only: update external state/UI, never append
    // transcript entries or request another model turn from this handler.
    if (g && isRunning(g))
      this.store.change('session.idle', (s) => {
        transition(
          activeGoal(s)!,
          'paused',
          'Run stopped; progress saved. Use /goal resume to continue',
        );
      });
    this.store.release();
    this.render(ctx);
  }
  private notify(ctx: Context, text: string) {
    if (ctx.hasUI) ctx.ui.notify(text, 'info');
    else
      this.pi.sendMessage(
        { customType: 'my-pi-goal-status', content: text, display: true },
        { triggerTurn: false },
      );
  }
  private clear(ctx: Context, automatic = false) {
    const before = this.state;
    if (automatic && !canAutoClear(before)) return;
    this.claim(automatic ? before.revision : undefined);
    this.write(automatic ? 'goal.auto-clear' : 'goal.clear', (s) => {
      if (automatic && (s.activeId !== before.activeId || !canAutoClear(s)))
        throw new Error('Goal changed before automatic clearing');
      s.goals = [];
      s.activeId = null;
      s.queuePaused = true;
      s.clearedAt = now();
      s.clearReason = automatic ? 'verified' : 'user';
    });
    this.turn = undefined;
    this.clearAfterTurn = undefined;
    this.fingerprints.clear();
    this.toolInputs.clear();
    this.progressed = false;
    if (!automatic) {
      this.auditController?.abort();
      if (before.goals.length) ctx.abort();
    }
    this.setPanel('hidden', ctx);
    this.store!.release();
    this.pi.sendMessage(
      {
        customType: 'my-pi-goal-cleared',
        content: sessionContext(this.state, false),
        display: false,
        details: this.messageIdentity(),
      },
      { triggerTurn: false },
    );
    if (!automatic)
      this.notify(ctx, 'Session goals and queue cleared; panel closed. Journal history retained.');
  }
  private autoClear(ctx: Context) {
    try {
      this.clear(ctx, true);
    } catch (error) {
      this.notify(ctx, 'Automatic clearing deferred: ' + String(error));
    }
  }
  private async confirm(ctx: Context, title: string, message: string) {
    return ctx.hasUI && (await ctx.ui.confirm(title, message));
  }
  private messageIdentity(goal?: Goal) {
    return { sessionId: this.store!.sessionId, goalId: goal?.id, generation: goal?.generation };
  }
  private startPrompt(ctx: Context, content: string, goal = activeGoal(this.state)) {
    this.pi.sendMessage(
      {
        customType: 'my-pi-goal-work',
        content,
        display: false,
        details: this.messageIdentity(goal),
      },
      { triggerTurn: true, deliverAs: ctx.isIdle() ? undefined : 'followUp' },
    );
  }
  private stop(
    ctx: Context,
    reason: string,
    status: 'paused' | 'blocked' | 'budget_limited' = 'paused',
    abort = true,
  ) {
    this.auditController?.abort();
    if (this.store?.owns())
      this.write('goal.stop', (s) => {
        s.queuePaused = true;
        const g = activeGoal(s);
        if (g && !terminal(g)) transition(g, status, reason);
      });
    if (abort) ctx.abort();
  }
  private setPanel(mode: PanelMode, ctx: Context) {
    this.panel = mode;
    this.pi.appendEntry('my-pi-goal-panel', {
      sessionId: ctx.sessionManager.getSessionId(),
      mode,
    });
    this.render(ctx);
  }
  private render(ctx: Context) {
    if (ctx.mode !== 'tui') return;
    const state = this.state;
    const goal = activeGoal(state);
    const readOnly = Boolean(state.owner && !this.store?.owns(state));
    ctx.ui.setStatus('my-pi-goal', goal ? goalStatusText(goal, readOnly) : undefined);
    ctx.ui.setWidget(
      'my-pi-goal',
      goal && this.panel !== 'hidden'
        ? (tui) => ({
            invalidate() {},
            render: (width: number) =>
              renderGoalWidget(
                goal,
                this.store?.directory ?? '',
                this.panel === 'expanded',
                ctx.ui.theme,
                width,
                readOnly,
                Math.max(6, tui.terminal.rows - 10),
              ),
          })
        : undefined,
    );
  }
  async init(ctx: Context) {
    // init can also be used directly by embedders: invalidate old work and release its journal.
    if (this.store) this.shutdown();
    this.context = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    this.store = new ProjectStore(ctx.cwd, sessionId);
    this.panel = 'compact';
    // This is a session-wide UI preference, not branch task state. A fork/clone copies
    // entries but gets a new session ID, so it must not inherit the parent's panel.
    const entries = ctx.sessionManager.getEntries();
    for (const entry of entries) {
      if (entry.type !== 'custom' || entry.customType !== 'my-pi-goal-panel') continue;
      const data = entry.data as { sessionId?: string; mode?: PanelMode } | undefined;
      if (
        data?.sessionId === sessionId &&
        ['compact', 'expanded', 'hidden'].includes(data.mode ?? '')
      )
        this.panel = data!.mode!;
    }
    if (entries.some((e) => e.type === 'custom' && e.customType === 'my-pi-goal'))
      this.store.migrateLegacy();
    this.settings = loadSettings(ctx.cwd, this.deps.agentDir ?? getAgentDir());
    this.fault = undefined;
    this.turn = undefined;
    this.clearAfterTurn = undefined;
    this.fingerprints.clear();
    this.toolInputs.clear();
    const s = this.state;
    this.render(ctx);
    if (activeGoal(s) && !terminal(activeGoal(s)!))
      this.notify(
        ctx,
        'Saved goals found for this session. Use /goal resume to continue; execution will not restart automatically.',
      );
    this.timer = setInterval(() => {
      try {
        if (!this.store?.owns()) return;
        const g = activeGoal(this.state);
        if (!g || !isRunning(g)) return;
        const reason = budgetReason(g);
        if (reason) {
          this.stop(ctx, reason, 'budget_limited');
          return;
        }
        if (Date.now() - this.lastClock > 15_000) {
          this.lastClock = Date.now();
          this.write('clock.checkpoint', (s) => {
            const g = activeGoal(s);
            if (g) checkpointTime(g);
          });
        }
      } catch (e) {
        this.fault = String(e);
        this.auditController?.abort();
        ctx.abort();
      }
    }, 1000);
    this.timer.unref();
  }
  shutdown() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.auditController?.abort();
    if (this.store?.owns()) {
      this.write('session.shutdown', (s) => {
        const g = activeGoal(s);
        if (g && isRunning(g)) transition(g, 'paused', 'Session closed; waiting to resume');
        s.queuePaused = true;
      });
      this.store.release();
    }
    if (this.context?.mode === 'tui') {
      this.context.ui.setWidget('my-pi-goal', undefined);
      this.context.ui.setStatus('my-pi-goal', undefined);
    }
    this.context = undefined;
    this.clearAfterTurn = undefined;
  }
  register() {
    const pi = this.pi;
    pi.on('session_start', async (_e, ctx) => {
      try {
        await this.init(ctx);
      } catch (e) {
        this.fault = String(e);
        this.notify(ctx, this.fault);
      }
    });
    pi.on('session_shutdown', () => this.shutdown());
    pi.on('agent_settled', (_event, ctx) => this.releaseIdle(ctx, true));
    pi.on('session_before_tree', (_e, ctx) => {
      if (this.store?.owns())
        this.stop(
          ctx,
          'Session branch changed; goal history remains current. Resume explicitly',
          'paused',
          false,
        );
    });
    pi.on('session_tree', (_e, ctx) => {
      this.turn = undefined;
      this.render(ctx);
    });
    pi.on('before_agent_start', (_e, ctx) => {
      this.context = ctx;
      if (!this.store || this.fault) return;
      const prior = activeGoal(this.state);
      if (!prior || terminal(prior)) return;
      this.claim();
    });
    pi.on('context', (event) => {
      if (!this.store || this.fault) return;
      const s = this.state,
        g = activeGoal(s),
        owned = this.store.owns(s);
      const controlTypes = new Set([
        'my-pi-goal-current',
        'my-pi-goal-context',
        'my-pi-goal-work',
        'my-pi-goal-continue',
        'my-pi-goal-session',
        'my-pi-goal-cleared',
        'my-pi-goal-rules',
      ]);
      const planning = new Set<string>();
      // Keep the transcript intact. Rebuild control messages from the journal
      // on every request, including after compaction, rather than replaying old
      // policies or snapshots. Nonselected planning requests retain identity only.
      const messages = event.messages.filter((m) => {
        if (m.role !== 'custom' || !controlTypes.has(m.customType)) return true;
        const data = m.details as ReturnType<GoalRuntime['messageIdentity']> | undefined;
        if (
          owned &&
          m.customType === 'my-pi-goal-work' &&
          data?.sessionId === this.store!.sessionId &&
          s.goals.some(
            (goal) =>
              goal.id === data.goalId &&
              goal.id !== g?.id &&
              goal.generation === data.generation &&
              !terminal(goal),
          )
        )
          planning.add(data!.goalId!);
        return false;
      });
      const projected = (customType: string, content: string, goal?: Goal) => ({
        role: 'custom' as const,
        customType,
        content,
        display: false,
        timestamp: Date.now(),
        details: this.messageIdentity(goal),
      });
      messages.push(projected('my-pi-goal-session', sessionContext(s, owned)));
      const current = owned && g && !terminal(g) ? g : undefined;
      if (current || planning.size)
        messages.push(projected('my-pi-goal-rules', WORK_RULES, current));
      for (const id of planning) {
        const queued = s.goals.find((goal) => goal.id === id)!;
        messages.push(
          projected(
            'my-pi-goal-work',
            'This goal is not selected. Inspect and propose its scope as needed without executing it, switching the active goal or bypassing FIFO.\n' +
              goalContext(
                queued,
                s,
                effectivePermissions(this.settings, queued),
                this.settings.audit,
              ),
            queued,
          ),
        );
      }
      if (current)
        messages.push(
          projected(
            'my-pi-goal-current',
            goalContext(
              current,
              s,
              effectivePermissions(this.settings, current),
              this.settings.audit,
            ),
            current,
          ),
        );
      return { messages };
    });
    pi.on('input', (event, ctx) => {
      if (!['interactive', 'rpc'].includes(event.source) || !this.store || this.fault) return;
      const state = this.state;
      const g = activeGoal(state);
      if (canAutoClear(state)) {
        // A submitted user message may arrive while the completing response is
        // still streaming. Preserve final usage before removing its goal record.
        if (
          this.turn?.store === this.store &&
          this.turn.id === g!.id &&
          this.turn.token === this.store.token &&
          this.store.owns(state)
        )
          this.clearAfterTurn = this.fence(g!);
        else this.autoClear(ctx);
        return; // Do not consume, transform or cancel this user message.
      }
      if (!g || terminal(g)) return;
      this.claim();
      if (
        /^(\u6682\u505c|\u505c\u6b62|stop|pause)(?:\s|$|\u76ee\u6807|\u4efb\u52a1)/i.test(
          event.text.trim(),
        )
      ) {
        this.stop(ctx, 'Paused by the user');
        return;
      }
      this.auditController?.abort();
      this.write('user.supplement', (s) => {
        const current = activeGoal(s)!;
        current.inputs.push(event.text);
        current.generation++;
        touch(current);
        if (current.status === 'verifying')
          transition(current, 'active', 'New requirements received; the previous audit is stale');
        if (
          current.status === 'blocked' &&
          !current.pendingSpec &&
          current.approved &&
          /^(Waiting for user: |\u7b49\u5f85\u7528\u6237\uff1a)/.test(current.reason ?? '')
        ) {
          transition(current, 'active');
          s.queuePaused = false;
        }
      });
    });
    pi.on('turn_start', () => {
      const state = this.store?.owns() ? this.state : undefined;
      const g = state && activeGoal(state);
      this.turn =
        g && (isRunning(g) || (g.status === 'complete' && !state!.queuePaused))
          ? this.fence(g)
          : undefined;
      this.progressed = false;
    });
    pi.on('tool_execution_start', (event) => {
      if (this.turn) this.toolInputs.set(event.toolCallId, event.args);
    });
    pi.on('tool_execution_end', (event) => {
      const input = this.toolInputs.get(event.toolCallId);
      this.toolInputs.delete(event.toolCallId);
      if (!this.turn || event.toolName.startsWith('goal_') || event.isError) return;
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([event.toolName, input, event.result?.content]))
        .digest('hex');
      if (!this.fingerprints.has(fingerprint)) {
        this.progressed = true;
        this.fingerprints.add(fingerprint);
        if (this.fingerprints.size > 500)
          this.fingerprints.delete(this.fingerprints.values().next().value!);
      }
    });
    pi.on('turn_end', (event, ctx) => {
      const turn = this.turn;
      if (
        !turn ||
        turn.store !== this.store ||
        turn.token !== this.store.token ||
        !this.store.owns()
      )
        return;
      // Charge the owning goal, including its final completing response, even if user input rotated its generation.
      this.write('usage.turn', (s) => {
        const g = s.goals.find((g) => g.id === turn.id);
        if (!g) return;
        const usage = event.message.role === 'assistant' ? event.message.usage : undefined;
        recordTurn(
          g,
          tokensFromUsage(usage) +
            event.toolResults.reduce((sum, r) => sum + tokensFromUsage(r.usage), 0),
          this.progressed,
        );
        if (!usage) g.usage.unknown++;
        if (g.status === 'active') {
          const reason = budgetReason(g);
          if (reason) {
            transition(g, 'budget_limited', reason);
            s.queuePaused = true;
          }
        }
      });
      const g = this.state.goals.find((g) => g.id === turn.id);
      this.turn = undefined;
      const pending = this.clearAfterTurn;
      this.clearAfterTurn = undefined;
      if (pending) {
        try {
          this.current(pending, ['complete']);
          this.autoClear(ctx);
        } catch {
          /* Clear/replacement/ownership changes invalidate deferred cleanup. */
        }
      }
      if (g?.status === 'budget_limited') ctx.abort();
    });
    pi.on('agent_before_settle', async (event, ctx) => {
      if (!this.store?.owns() || this.fault) return;
      let s = this.state,
        g = activeGoal(s);
      if (event.outcome !== 'completed') {
        if (g && isRunning(g))
          this.stop(
            ctx,
            event.outcome === 'aborted'
              ? 'User interrupted or operation cancelled'
              : 'Host recovery failed; resolve the error before resuming',
            'paused',
            false,
          );
        return;
      }
      // canContinue describes the transcript BEFORE our draft. Our custom message makes
      // an assistant-final transcript runnable; Pi validates the resulting context again.
      if (event.context.pendingMessages.length || ctx.hasPendingMessages()) return;
      if (g?.status === 'complete' && !s.queuePaused) {
        const next = nextQueued(s);
        if (!next) {
          this.write('queue.wait', (x) => {
            x.queuePaused = true;
          });
          return;
        }
        s = this.write('queue.advance', (x) => {
          x.activeId = next.id;
          const selected = activeGoal(x)!;
          transition(selected, 'active');
        });
        g = activeGoal(s);
      }
      if (!g || g.status !== 'active' || s.queuePaused) return;
      if (!this.pi.getActiveTools().includes('goal_submit')) {
        this.stop(
          ctx,
          'goal_submit is disabled by the tool policy; restore it before resuming',
          'paused',
          false,
        );
        return;
      }
      const reason = budgetReason(g);
      if (reason) {
        this.stop(ctx, reason, 'budget_limited', false);
        return;
      }
      if (g.noProgressTurns >= g.limits.noProgressPause) {
        const fence = this.fence(g);
        // No diagnostic deadline: explicit pause/shutdown must still cancel nested work.
        const controller = new AbortController();
        this.auditController = controller;
        const signal = AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
        let diagnosis;
        try {
          diagnosis = await (this.deps.stagnation ?? reviewStagnation)(
            g,
            ctx,
            this.settings,
            signal,
          );
        } finally {
          if (this.auditController === controller) this.auditController = undefined;
        }
        try {
          this.current(fence, ['active']);
        } catch {
          return;
        }
        this.write('stagnation.review', (s) => {
          const g = activeGoal(s)!;
          g.usage.auditTokens += diagnosis.tokens;
          if (diagnosis.unknown) g.usage.unknown++;
          g.notes.push(diagnosis.details);
        });
        this.stop(ctx, `No progress. ${diagnosis.details}`, 'blocked', false);
        this.notify(ctx, `Goal paused. Independent stagnation review:\n${diagnosis.details}`);
        return;
      }
      return {
        entries: [
          {
            type: 'custom_message' as const,
            customType: 'my-pi-goal-continue',
            content: continuationPrompt(g),
            display: false,
            details: this.messageIdentity(g),
          },
        ],
        continue: true,
      };
    });
    pi.on('tool_call', async (event, ctx) => {
      if (!this.store) return;
      if (this.fault) return { block: true, reason: this.fault, terminate: true };
      let s = this.state;
      // Lifecycle tools enforce their own identity/status/approval guards. Let stale
      // IDs reach the non-mutating response, even when a replacement goal is paused.
      if (
        ['goal_create', 'goal_resume', 'goal_plan', 'goal_status', 'goal_evidence'].includes(
          event.toolName,
        ) ||
        (['goal_progress', 'goal_wait', 'goal_submit'].includes(event.toolName) &&
          !s.goals.some((g) => g.id === (event.input as { goal_id?: string }).goal_id))
      )
        return;
      if (activeGoal(s) && !terminal(activeGoal(s)!) && !this.store.owns(s)) {
        if (['goal_status', 'goal_evidence', 'read', 'grep', 'find', 'ls'].includes(event.toolName))
          return;
        try {
          this.claim();
        } catch (e) {
          return { block: true, reason: String(e), terminate: true };
        }
        s = this.state;
      }
      const g = activeGoal(s);
      if (!g || terminal(g)) return;
      if (
        !['active', 'draft'].includes(g.status) &&
        !['goal_status', 'goal_evidence', 'read', 'grep', 'find', 'ls'].includes(event.toolName)
      )
        return {
          block: true,
          reason: `Goal is ${g.status}; use /goal resume or /goal approve`,
          terminate: true,
        };
      if (
        g.status === 'draft' &&
        ![
          'read',
          'grep',
          'find',
          'ls',
          'goal_status',
          'goal_evidence',
          'goal_plan',
          'goal_wait',
          'goal_environment',
        ].includes(event.toolName)
      )
        return {
          block: true,
          reason: 'Scope is not approved; inspect read-only and submit goal_plan first',
          terminate: false,
        };
      const reason = budgetReason(g);
      if (g.status === 'active' && reason) {
        this.stop(ctx, reason, 'budget_limited', false);
        return { block: true, reason, terminate: true };
      }
      const need = permissionReason(
        event.toolName,
        event.input,
        ctx.cwd,
        effectivePermissions(this.settings, g),
      );
      const key = permissionKey(event.toolName, event.input);
      if (!need || g.permissions.includes(key)) return;
      const fence = this.fence(g);
      const approved = await this.confirm(
        ctx,
        `Approve goal operation: ${need}`,
        JSON.stringify(event.input).slice(0, 6000),
      );
      try {
        this.current(fence);
      } catch {
        return {
          block: true,
          reason: 'Goal changed; the previous authorization is stale',
          terminate: true,
        };
      }
      if (!approved) {
        this.stop(
          ctx,
          `Waiting for user: ${need}; ${JSON.stringify(event.input).slice(0, 1000)}`,
          'blocked',
          false,
        );
        return { block: true, reason: need, terminate: true };
      }
      this.write('permission.grant', (s) => {
        activeGoal(s)!.permissions.push(key);
      });
    });
    this.registerTools();
    const handler = async (args: string, ctx: ExtensionCommandContext) => {
      try {
        await this.command(args, ctx);
      } catch (e) {
        this.notify(ctx, String(e));
      } finally {
        try {
          this.releaseIdle(ctx);
        } catch (e) {
          this.notify(ctx, String(e));
        }
      }
    };
    pi.registerCommand('goal', {
      description: 'Durable goals, queues and independent audits: /goal help',
      handler,
    });
  }
  private registerTools() {
    const pi = this.pi;
    pi.registerTool({
      name: 'goal_status',
      label: 'Goal status',
      description:
        'Read durable goals, IDs, generations and evidence before changing a goal. The default summary replaces large evidence bodies with counts and previews; pass view "full" only when the complete projection is needed.',
      parameters: Type.Object({
        view: Type.Optional(StringEnum(['summary', 'full'] as const)),
      }),
      annotations: { readOnlyHint: true },
      execute: async (_id, p) => {
        const state = this.state;
        const full = p.view === 'full';
        const status = {
          ...state,
          ...(full ? {} : { goals: state.goals.map(goalSummary) }),
          journal: this.store!.file,
          auditSettings: this.settings.audit,
          guidance: sessionContext(state, this.store!.owns(state)),
        };
        return textResult(JSON.stringify(status), status);
      },
    });
    pi.registerTool({
      name: 'goal_evidence',
      label: 'Goal evidence',
      description:
        'Read one recorded criterion or task evidence entry by ID. Durable context and goal_status list counts and previews; this returns the exact recorded text for review. Recorded evidence is an executor claim, not independent verification. Offsets are 1-based characters; nextOffset indicates more text.',
      executionMode: 'sequential',
      annotations: { readOnlyHint: true },
      parameters: Type.Object({
        ...identity.properties,
        source: StringEnum(['criterion', 'task'] as const),
        id: Type.String(),
        index: Type.Optional(Type.Integer({ minimum: 0 })),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 4000 })),
      }),
      execute: async (_id, p) => {
        const missing = this.missingGoalResult(p.goal_id);
        if (missing) return missing;
        const state = this.state;
        const goal = state.goals.find((item) => item.id === p.goal_id)!;
        if (goal.generation !== p.generation)
          return textResult('Goal version changed; read goal_status before reading evidence.', {
            disposition: 'stale_goal',
          });
        const item = (p.source === 'criterion' ? goal.criteria : goal.tasks).find(
          (entry) => entry.id === p.id,
        );
        if (!item) throw new Error('Criterion or task not found in the current goal');
        if (!item.evidence.length)
          return textResult(
            JSON.stringify({ source: p.source, id: p.id, records: 0, text: '', nextOffset: null }),
            { source: p.source, id: p.id, records: 0 },
          );
        const index = Number(p.index ?? item.evidence.length - 1);
        if (!Number.isSafeInteger(index) || index < 0 || index >= item.evidence.length)
          throw new Error('Evidence index is out of range');
        const record = item.evidence[index]!;
        const start = Number(p.offset ?? 1) - 1;
        if (start < 0 || start > record.length) throw new Error('Evidence offset is out of range');
        const text = record.slice(start, start + Number(p.chars ?? 4000));
        const nextOffset = start + text.length < record.length ? start + text.length + 1 : null;
        const details = {
          source: p.source,
          id: p.id,
          index,
          records: item.evidence.length,
          offset: start + 1,
          totalChars: record.length,
          text,
          nextOffset,
        };
        return textResult(JSON.stringify(details), details);
      },
    });
    pi.registerTool({
      name: 'goal_create',
      label: 'Create goal',
      description:
        'Create a durable goal for the current user-authorized task, then call goal_plan to define scope and enter autonomous work. Read goal_status first and pass its sessionId and revision. Requires no unfinished goal; never replace, bypass, or resurrect cancelled work. Simple initial plans may auto-accept; complex scope needs user approval. This tool cannot approve scope.',
      executionMode: 'sequential',
      parameters: Type.Object({
        session_id: bounded(),
        expected_revision: Type.Integer({ minimum: 0 }),
        objective: bounded(16_000),
      }),
      execute: async (_id, p, signal, _update, ctx) => {
        if (this.fault) throw new Error(this.fault);
        const s = this.state;
        if (
          signal?.aborted ||
          ctx.signal?.aborted ||
          p.session_id !== s.sessionId ||
          p.expected_revision !== s.revision
        )
          return textResult(
            'Creation not applied: cancelled request or session/state changed. Read goal_status; do not recreate cleared work without a new user request.',
            { disposition: 'stale_state' },
          );
        if (s.goals.some((g) => !terminal(g)))
          return textResult(
            'An unfinished goal already exists. Use goal_plan to propose modifications or goal_resume for approved stopped work. Nothing was created.',
            { disposition: 'existing_goal', state: s },
          );
        const g = this.createGoal(
          p.objective,
          false,
          simpleObjective(p.objective.trim()),
          ctx,
          p.expected_revision,
        );
        return textResult(
          `Goal created. ${kickoffPrompt(g)}\n${JSON.stringify(this.state)}`,
          this.state,
        );
      },
    });
    pi.registerTool({
      name: 'goal_resume',
      label: 'Resume goal',
      description:
        'Resume approved stopped work for the current user request after resolving blockers. Read goal_status for the current ID/generation. Cannot resume cleared/finished work, approve pending modifications, exceed the cumulative budget, replace running work, or undo a stop without a later user message. Use goal_plan for specification changes; every change to an approved specification requires user approval. Progress, evidence and in-scope implementation decisions need no scope approval.',
      executionMode: 'sequential',
      parameters: identity,
      execute: async (_id, p, signal, _update, ctx) => {
        const missing = this.missingGoalResult(p.goal_id);
        if (missing) return missing;
        if (signal?.aborted || ctx.signal?.aborted)
          return textResult('Resume not applied: the current operation was cancelled.', {
            disposition: 'cancelled',
          });
        const s = this.state;
        const g = s.goals.find((g) => g.id === p.goal_id)!;
        if (g.generation !== p.generation)
          return textResult('Goal version changed; read goal_status before resuming.', {
            disposition: 'stale_goal',
          });
        if (g.status === 'active' && s.activeId === g.id && this.store!.owns(s))
          return textResult(
            'Goal is already active. Continue without resetting progress or protection counters.',
            s,
          );
        if (terminal(g) || isRunning(g))
          return textResult(`Cannot resume a ${g.status} goal. Read goal_status.`, {
            disposition: 'not_resumable',
          });
        if (g.pendingSpec || !g.approved)
          return textResult(
            'Scope is not approved. Present the proposal and wait for the user to approve it with /goal approve.',
            { disposition: 'approval_required' },
          );
        if (g.resumeAfterInput !== undefined && g.inputs.length <= g.resumeAfterInput)
          return textResult(
            'The goal was stopped. Wait for a new user instruction or /goal resume; do not bypass a user pause or runtime protection.',
            { disposition: 'user_input_required' },
          );
        const reason = budgetReason(g);
        if (reason)
          return textResult(`${reason}. The user must adjust /goal budget before resuming.`, {
            disposition: 'budget_limited',
          });
        const selected = activeGoal(s);
        if (
          (selected && !terminal(selected) && selected.id !== g.id) ||
          ((!selected || terminal(selected)) && nextQueued(s)?.id !== g.id)
        )
          return textResult(
            'Another unfinished goal comes first. Read goal_status; do not bypass the selected goal or queue head.',
            { disposition: 'queue_blocked' },
          );
        this.claim();
        // Acquiring an interrupted run may rotate its generation; never silently reuse it.
        this.current(this.fence({ ...g, generation: p.generation }));
        const state = this.resume(g);
        if (this.panel === 'hidden') this.setPanel('compact', ctx);
        this.turn = this.fence(activeGoal(state)!);
        return textResult(
          `Goal resumed. ${kickoffPrompt(activeGoal(state)!)}\n${JSON.stringify(state)}`,
          state,
        );
      },
    });
    pi.registerTool({
      name: 'goal_plan',
      label: 'Goal scope proposal',
      description:
        "Propose or modify the complete goal specification, including while paused or blocked. Every change to an approved specification waits for the user's /goal approve, including task changes. Identical specifications are a no-op. Initial simple goals may auto-accept their first plan. This tool cannot approve modifications. Never remove requirements.",
      executionMode: 'sequential',
      parameters: Type.Object({ ...identity.properties, spec: specSchema }),
      execute: async (_id, p) => {
        const missing = this.missingGoalResult(p.goal_id);
        if (missing) return missing;
        const g = this.require(p.goal_id, p.generation, [
          'draft',
          'active',
          'paused',
          'queued',
          'blocked',
          'budget_limited',
        ]);
        const auto =
          g.directStart && !g.approved && !g.pendingSpec && p.spec.objective.trim() === g.objective;
        const unchanged =
          isTaskRefinement({ ...g, status: 'active' }, p.spec) &&
          JSON.stringify(g.tasks.map((t) => t.text)) === JSON.stringify(p.spec.tasks);
        if (unchanged)
          return textResult(
            'Scope is unchanged. Read the current status before continuing.',
            this.state,
          );
        this.write('spec.propose', (s) => {
          const goal = s.goals.find((x) => x.id === g.id)!;
          if (auto) {
            goal.permissionPolicy ??= structuredClone(this.settings.permissions);
            applySpec(goal, p.spec);
            transition(goal, 'active');
            s.queuePaused = false;
          } else {
            goal.pendingSpec = p.spec;
            transition(goal, 'draft', 'Waiting for scope approval: /goal approve');
            if (s.activeId === goal.id) s.queuePaused = true;
          }
        });
        if (auto) this.turn = this.fence(activeGoal(this.state)!);
        return textResult(
          auto
            ? `Initial scope accepted. Continue. ${permissionSummary(effectivePermissions(this.settings, g))}`
            : "Scope recorded. Present the objective, acceptance criteria, tasks and checks, then wait for the user's /goal approve.",
          this.state,
        );
      },
    });
    pi.registerTool({
      name: 'goal_environment',
      label: 'Verification environment',
      description:
        'Configure Docker Sandboxes verification. workspace "ephemeral" permits disposable writes. network "isolated" blocks egress; "allowlist" permits allow destinations; "open" permits public destinations except deny. Destinations are DNS names, optional *. subdomains and :port. Online checks must use HTTP_PROXY/HTTPS_PROXY; direct TCP/UDP and host services remain unavailable. Network changes follow the goal permission policy. env must currently be empty. Settings are frozen for each submission and audit.',
      executionMode: 'sequential',
      parameters: Type.Object({
        ...identity.properties,
        workspace: Type.Optional(StringEnum(['readonly', 'ephemeral'] as const)),
        network: Type.Optional(StringEnum(['isolated', 'allowlist', 'open'] as const)),
        allow: Type.Optional(Type.Array(Type.String({ maxLength: 260 }), { maxItems: 64 })),
        deny: Type.Optional(Type.Array(Type.String({ maxLength: 260 }), { maxItems: 64 })),
        env: Type.Optional(
          Type.Array(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }), { maxItems: 32 }),
        ),
        reason: Type.Optional(bounded(2000)),
      }),
      execute: async (_id, p, signal, _update, ctx) => {
        const missing = this.missingGoalResult(p.goal_id);
        if (missing) return missing;
        let g = this.require(p.goal_id, p.generation, ['draft', 'active']);
        const next = normalizeVerification({
          ...g.verification,
          ...(p.workspace ? { workspace: p.workspace } : {}),
          ...(p.network ? { network: p.network } : {}),
          ...(p.allow ? { allow: p.allow } : {}),
          ...(p.deny ? { deny: p.deny } : {}),
          ...(p.env ? { env: p.env } : {}),
        });
        if (verificationKey(next) === verificationKey(g.verification))
          return textResult(
            'Verification environment is unchanged. Adjust it or explain why the failure is not environmental.',
            { disposition: 'unchanged', verification: g.verification },
          );
        if (this.settings.sandbox) {
          try {
            new DockerSandboxes(
              this.settings.sandbox,
              join(this.deps.agentDir ?? getAgentDir(), 'goal-sandboxes'),
            ).validateEnvironment(next);
          } catch (error) {
            return textResult(`Verification environment not applied: ${String(error)}`, {
              disposition: 'environment_error',
            });
          }
        }
        if (
          next.network !== 'isolated' &&
          effectivePermissions(this.settings, g).network === 'ask'
        ) {
          const grant = permissionKey('verification.network', {
            goalId: g.id,
            policy: JSON.stringify([next.network, next.allow ?? [], next.deny ?? []]),
          });
          if (!g.permissions.includes(grant)) {
            const fence = this.fence(g);
            const approved = await this.confirm(
              ctx,
              'Approve verification network access',
              `Checks and the independent audit may access these network destinations for goal ${g.id}:\n${verificationSummary(next)}`,
            );
            try {
              g = this.current(fence);
            } catch {
              return textResult('Goal changed; the previous authorization is stale', {
                disposition: 'stale_goal',
              });
            }
            if (!approved)
              return textResult(
                'Verification network access was not approved; the environment is unchanged.',
                { disposition: 'approval_required', verification: g.verification },
              );
            this.write('permission.grant', (s) => {
              activeGoal(s)!.permissions.push(grant);
            });
            g = this.current(fence);
          }
        }
        const fence = this.fence(g);
        const probe = this.deps.probe
          ? await this.deps.probe(ctx.cwd, next, signal)
          : this.settings.sandbox
            ? await (async () => {
                try {
                  const backend = new DockerSandboxes(
                    this.settings.sandbox!,
                    join(this.deps.agentDir ?? getAgentDir(), 'goal-sandboxes'),
                  );
                  backend.validateEnvironment(next);
                  await backend.doctor(signal);
                  return { ok: true as const };
                } catch (error) {
                  return { ok: false as const, hint: String(error) };
                }
              })()
            : {
                ok: false as const,
                hint: 'Configure Docker Sandboxes in personal my-pi-goal.json; no host execution backend exists.',
              };
        if (!probe.ok)
          return textResult(
            `Verification environment not applied: ${probe.hint}\nFix the sandbox or tooling first; this does not count as an implementation failure.`,
            { disposition: 'environment_error', hint: probe.hint },
          );
        try {
          this.current(fence);
        } catch {
          return textResult('Goal or ownership changed; the environment was not applied.', {
            disposition: 'stale_goal',
          });
        }
        this.write('verification.update', (s) => {
          const goal = activeGoal(s)!;
          goal.verification = next;
          goal.consecutiveEnvironmentFailures = 0;
          if (p.reason) {
            goal.notes.push(`Verification environment: ${p.reason}`);
            goal.notes = goal.notes.slice(-40);
          }
        });
        const state = this.state;
        return textResult(
          `Verification environment updated: ${verificationSummary(next)}. It applies to the next goal_submit and to the independent audit. Approved checks are unchanged; resubmit the completed work.`,
          state,
        );
      },
    });
    pi.registerTool({
      name: 'goal_progress',
      label: 'Goal progress',
      description:
        'Record an evidence-backed checkpoint, next step, criterion evidence and task status. Evidence is a claim until independently verified.',
      executionMode: 'sequential',
      parameters: Type.Object({
        ...identity.properties,
        note: bounded(),
        next_step: bounded(),
        criterion_id: Type.Optional(Type.String()),
        task_id: Type.Optional(Type.String()),
        task_status: Type.Optional(StringEnum(['pending', 'active', 'done'] as const)),
        evidence: Type.Optional(bounded(8000)),
      }),
      execute: async (_id, p) => {
        const missing = this.missingGoalResult(p.goal_id);
        if (missing) return missing;
        this.require(p.goal_id, p.generation);
        this.write('goal.progress', (s) => {
          const g = activeGoal(s)!;
          if (p.criterion_id) {
            const c = g.criteria.find((c) => c.id === p.criterion_id);
            if (!c || !p.evidence?.trim())
              throw new Error('Invalid criterion ID or missing evidence');
            if (!c.evidence.includes(p.evidence)) {
              c.evidence.push(p.evidence);
              g.progressVersion++;
            }
          }
          if (p.task_id) {
            const t = g.tasks.find((t) => t.id === p.task_id);
            if (!t || !p.task_status) throw new Error('Invalid task ID or status');
            if (p.task_status === 'done' && !p.evidence?.trim())
              throw new Error('Completed tasks require evidence');
            if (t.status !== p.task_status) g.progressVersion++;
            t.status = p.task_status;
            if (p.evidence && !t.evidence.includes(p.evidence)) t.evidence.push(p.evidence);
          }
          g.notes.push(p.note);
          g.notes = g.notes.slice(-40);
          g.nextStep = p.next_step;
          touch(g);
        });
        return textResult('Progress saved', activeGoal(this.state));
      },
    });
    pi.registerTool({
      name: 'goal_wait',
      label: 'Wait for user',
      description:
        'Pause only for indispensable missing input or credentials, an unresolved external blocker, or a new action outside existing authorization. Finish independent authorized work first. Never ask permission again for routine work allowed by the execution policy.',
      executionMode: 'sequential',
      parameters: Type.Object({ ...identity.properties, reason: bounded() }),
      execute: async (_id, p, _signal, _update, ctx) => {
        const missing = this.missingGoalResult(p.goal_id);
        if (missing) return missing;
        this.require(p.goal_id, p.generation, ['active', 'draft']);
        if (activeGoal(this.state)?.status === 'draft') this.notify(ctx, p.reason);
        else this.stop(ctx, `Waiting for user: ${p.reason}`, 'blocked', false);
        return { ...textResult(`User input needed: ${p.reason}`), terminate: true };
      },
    });
    pi.registerTool({
      name: 'goal_submit',
      label: 'Checks and independent audit',
      description:
        'Submit candidate completion. Runs approved checks in the declared verification environment (goal_environment), then a fresh independent auditor. A check failure attributed to the environment returns environment guidance without counting as an implementation repair; other failures return concrete feedback. Never complete without a passing audit.',
      executionMode: 'sequential',
      parameters: Type.Object({ ...identity.properties, summary: bounded(8000) }),
      execute: async (_id, p, signal, update, ctx) => {
        const missing = this.missingGoalResult(p.goal_id);
        if (missing) return missing;
        let g = this.require(p.goal_id, p.generation);
        const problems = completionProblems(g);
        if (problems.length) throw new Error(problems.join('\n'));
        const fence = this.fence(g);
        this.write('audit.start', (s) => {
          const g = activeGoal(s)!;
          g.completionClaim = p.summary;
          transition(g, 'verifying');
        });
        this.auditController = new AbortController();
        const localController = this.auditController;
        const combined = AbortSignal.any([localController.signal, ...(signal ? [signal] : [])]);
        // Freeze the declared environment for every check in this submission and its audit.
        const environment = structuredClone(g.verification);
        let audit: Audit | undefined;
        let environmentIssue: { check: string; hint: string; cleanup?: boolean } | undefined;
        let verification: VerificationContext | undefined;
        try {
          if (!this.settings.sandbox)
            throw new SandboxError(
              'Configure Docker Sandboxes in personal my-pi-goal.json before verification. No other execution backend is available.',
            );
          {
            update?.(textResult('Preparing frozen inputs for Docker Sandboxes verification.'));
            verification = await (this.deps.prepareVerification ?? prepareVerification)(
              ctx.cwd,
              structuredClone(g),
              structuredClone(this.settings.sandbox),
              join(this.deps.agentDir ?? getAgentDir(), 'goal-sandboxes'),
              combined,
            );
            this.current(fence, ['verifying']);
            this.write('verification.snapshot', (s) => {
              activeGoal(s)!.notes.push(
                `Verification ${verification!.identity.snapshotDigest}: ${verification!.manifest.entries.length} input entries; exclusions: ${verification!.manifest.excluded.join(', ').slice(0, 1500) || 'none'}`,
              );
              activeGoal(s)!.notes = activeGoal(s)!.notes.slice(-40);
            });
          }
          for (const check of g.checks) {
            update?.(
              textResult(`Running check ${check.id} in the declared sandbox: ${check.command}`),
            );
            let result;
            try {
              result = await verification!.check(check, combined);
            } catch (error) {
              if (!(error instanceof EnvironmentError) && !(error instanceof SandboxError))
                throw error;
              environmentIssue = {
                check: check.id,
                hint: String(error),
                cleanup: error instanceof SandboxError && error.kind === 'cleanup',
              };
              break;
            }
            this.current(fence, ['verifying']);
            this.write('check.result', (s) => {
              const target = activeGoal(s)!;
              target.checks.find((c) => c.id === check.id)!.last = result;
            });
            if (result.exitCode !== 0) {
              if (result.failure === 'environment') {
                environmentIssue = {
                  check: check.id,
                  hint: result.hint ?? result.output.slice(-1500),
                };
                break;
              }
              throw new Error(
                `Check ${check.id} failed (exit ${result.exitCode}): ${result.output}`,
              );
            }
          }
          if (!environmentIssue) {
            this.write('verification.ok', (s) => {
              activeGoal(s)!.consecutiveEnvironmentFailures = 0;
            });
            g = this.current(fence, ['verifying']);
            update?.(
              textResult('Checks finished; the independent auditor is inspecting artifacts.'),
            );
            audit = await (this.deps.audit ?? runIndependentAudit)(
              structuredClone(g),
              p.summary,
              ctx,
              this.settings,
              combined,
              (message) => update?.(textResult(message)),
              verification,
            );
            if (verification) audit.verification = verification.identity;
          }
        } catch (error) {
          if (error instanceof SandboxError)
            environmentIssue = {
              check: 'preparation',
              hint: String(error),
              cleanup: error.kind === 'cleanup',
            };
          else
            audit = {
              at: now(),
              verdict: 'error',
              details: String(error),
              model: '(check/audit)',
              findings: [],
              tokens: 0,
              usageUnknown: false,
            };
        } finally {
          try {
            await verification?.finish(audit?.verdict === 'pass', combined);
          } catch (error) {
            if (error instanceof SandboxError && error.kind === 'check') {
              if (audit) audit = { ...audit, verdict: 'error', details: String(error) };
            } else {
              environmentIssue = {
                check: 'finalization',
                hint: String(error),
                cleanup: error instanceof SandboxError && error.kind === 'cleanup',
              };
            }
          }
          if (this.auditController === localController) this.auditController = undefined;
        }
        // Account even when finalization rejects a previously passing audit.
        if (
          audit &&
          fence.store === this.store &&
          fence.token === this.store.token &&
          this.store.owns() &&
          this.state.goals.some((goal) => goal.id === fence.id)
        ) {
          this.write('audit.usage', (s) => {
            const target = s.goals.find((goal) => goal.id === fence.id)!;
            target.usage.auditTokens += audit!.tokens;
            if (audit!.usageUnknown) target.usage.unknown++;
          });
        }
        if (environmentIssue) {
          try {
            this.current(fence, ['verifying']);
          } catch {
            return textResult(
              'Goal, session or ownership changed; the environment failure was not applied.',
              { disposition: 'stale_goal' },
            );
          }
          let stopped = false;
          try {
            this.write('verification.environment_failure', (s) => {
              const goal = activeGoal(s)!;
              goal.consecutiveEnvironmentFailures++;
              goal.notes.push(
                `Verification environment issue at ${environmentIssue!.check}: ${environmentIssue!.hint}`,
              );
              goal.notes = goal.notes.slice(-40);
              if (
                environmentIssue!.cleanup ||
                combined.aborted ||
                goal.consecutiveEnvironmentFailures >= MAX_ENVIRONMENT_FAILURES
              ) {
                transition(
                  goal,
                  'paused',
                  environmentIssue!.cleanup
                    ? `Sandbox cleanup is incomplete; resolve it before resuming. ${environmentIssue!.hint}`
                    : combined.aborted
                      ? 'Verification cancelled; waiting to resume'
                      : `Verification environment failed ${goal.consecutiveEnvironmentFailures} times with unchanged settings; adjust it and resume. ${environmentIssue!.hint}`,
                );
                s.queuePaused = true;
                stopped = true;
              } else {
                transition(
                  goal,
                  'active',
                  `Verification environment issue; adjust goal_environment before resubmitting. ${environmentIssue!.hint}`,
                );
              }
            });
          } catch {
            return textResult(
              'Goal, session or ownership changed; the environment failure was not applied.',
            );
          }
          const message = `Verification environment blocked the check (not an implementation failure):\n${environmentIssue.hint}\nCurrent environment: ${verificationSummary(environment)}\nConsecutive environment failures: ${activeGoal(this.state)?.consecutiveEnvironmentFailures ?? 0}. Use goal_environment to change workspace/network/environment variables, then resubmit. Approved checks, criteria and evidence are unchanged.`;
          this.notify(ctx, message);
          return { ...textResult(message), ...(stopped ? { terminate: true } : {}) };
        }
        if (!audit) return textResult('Checks did not produce an audit result; read goal_status.');
        // Always account incurred audit cost in the old goal, but never apply a stale verdict.
        if (
          fence.store !== this.store ||
          fence.token !== this.store.token ||
          !this.store.owns() ||
          !this.state.goals.some((goal) => goal.id === fence.id)
        )
          return textResult('Audit cancelled or session changed; result not applied');

        try {
          this.current(fence, ['verifying']);
        } catch {
          return textResult(
            'Goal changed during the audit; stale verdict discarded. Check the current requirements',
          );
        }
        this.write('audit.result', (s) => {
          const g = activeGoal(s)!;
          g.audits.push(audit);
          const reason = budgetReason(g);
          if (combined.aborted) {
            transition(g, 'paused', 'Audit cancelled; waiting to resume');
            s.queuePaused = true;
          } else if (audit.verdict === 'pass') {
            transition(g, 'complete', audit.details);
          } else {
            if (audit.errorKind !== 'budget') g.consecutiveAuditFailures++;
            g.notes.push(`Audit feedback: ${audit.details}`);
            if (reason) {
              transition(g, 'budget_limited', reason);
              s.queuePaused = true;
            } else if (audit.errorKind === 'budget') {
              transition(
                g,
                'blocked',
                `Insufficient cumulative token budget; adjust /goal budget, then resume. ${audit.details}`,
              );
              s.queuePaused = true;
            } else if (g.consecutiveAuditFailures > g.limits.maxAuditFailures) {
              transition(
                g,
                'blocked',
                'Audit still fails after repeated repairs; review the evidence',
              );
              s.queuePaused = true;
            } else transition(g, 'active', audit.details);
          }
        });
        this.notify(ctx, `Goal audit: ${audit.verdict}\n${audit.details}`);
        const status = activeGoal(this.state)!.status;
        return {
          ...textResult(
            `Audit ${audit.verdict}: ${audit.details}\nCurrent status: ${status}`,
            audit,
          ),
          ...(['blocked', 'paused', 'budget_limited'].includes(status) ? { terminate: true } : {}),
        };
      },
    });
  }
  private async command(args: string, ctx: ExtensionCommandContext) {
    let [cmd = 'status', ...rest] = args.trim().split(/\s+/);
    if (!cmd) cmd = 'status';
    const tail = rest.join(' ');
    if (cmd === 'sandbox') {
      if (!this.settings.sandbox) {
        this.notify(
          ctx,
          'Docker Sandboxes is not configured. Add sandbox to your personal my-pi-goal.json; see docs/docker-sandboxes-setup.md. Verification is unavailable until configured.',
        );
        return;
      }
      const backend = new DockerSandboxes(
        this.settings.sandbox,
        join(this.deps.agentDir ?? getAgentDir(), 'goal-sandboxes'),
      );
      if (tail === 'doctor') {
        await backend.doctor();
        this.notify(
          ctx,
          'Docker Sandboxes control preflight passed. This does not certify the template or a real check; run the explicit sandbox smoke test.',
        );
      } else if (tail === 'cleanup') {
        this.notify(
          ctx,
          `Recovered sandbox leases: ${(await backend.recover()).join(', ') || 'none'}`,
        );
      } else if (tail === 'status' || !tail) {
        this.notify(
          ctx,
          JSON.stringify(
            {
              backend: 'docker-sandboxes',
              experimental: true,
              leases: await backend.leases.list(),
            },
            null,
            2,
          ),
        );
      } else throw new Error('Usage: /goal sandbox doctor|status|cleanup');
      return;
    }
    if (cmd === 'help') {
      this.notify(ctx, tail === 'more' ? `${HELP}\n\n${MORE_HELP}` : HELP);
      return;
    }
    if (this.fault) throw new Error(this.fault);
    if (cmd === 'settings') {
      this.notify(
        ctx,
        `Global: ${this.deps.agentDir ?? getAgentDir()}/my-pi-goal.json\nProject: ${ctx.cwd}/.pi/my-pi-goal.json\n${JSON.stringify(this.settings, null, 2)}`,
      );
      return;
    }
    if (cmd === 'permissions' && !tail) {
      this.notify(
        ctx,
        permissionSummary(effectivePermissions(this.settings, activeGoal(this.state))),
      );
      return;
    }
    if (cmd === 'status' || cmd === 'list') {
      this.notify(
        ctx,
        this.state.goals
          .map(
            (g) =>
              `${g.id.slice(0, 8)} ${g.status} · revision ${g.revision} · generation ${g.generation} · ${g.objective}\n${g.reason ?? ''}\n${permissionSummary(effectivePermissions(this.settings, g))}${g.pendingSpec ? `\nProposed scope:\n${formatPendingScope(g.pendingSpec, effectivePermissions(this.settings, g))}` : ''}`,
          )
          .join('\n\n') || 'No goals. Use /goal <objective> or /goal help',
      );
      return;
    }
    if (cmd === 'panel') {
      const modes: Record<string, PanelMode> = {
        show: 'compact',
        hide: 'hidden',
        compact: 'compact',
        expand: 'expanded',
      };
      if (tail && !modes[tail]) throw new Error('Usage: /goal panel [show|hide|compact|expand]');
      this.setPanel(tail ? modes[tail] : this.panel === 'hidden' ? 'expanded' : 'hidden', ctx);
      return;
    }
    if (cmd === 'clear') {
      if (tail)
        throw new Error('Usage: /goal clear (clear session goals and queue; keep journal history)');
      this.clear(ctx);
      return;
    }
    if (cmd === 'pause') {
      this.claim();
      this.stop(ctx, 'User paused the current goal and queue');
      return;
    }
    if (cmd === 'release' || cmd === 'take-over') {
      this.notify(
        ctx,
        'Ownership is automatic. Use /goal pause to save progress, /goal resume to continue, or /goal clear to clear session goals.',
      );
      return;
    }
    this.claim();
    const choose = (prefix?: string) => {
      if (!prefix) {
        const g = activeGoal(this.state);
        if (!g) throw new Error('No selected goal');
        return g;
      }
      const matches = this.state.goals.filter((g) => g.id.startsWith(prefix));
      if (matches.length !== 1) throw new Error('Goal ID does not exist or is ambiguous');
      return matches[0];
    };
    if (cmd === 'permissions') {
      if (tail !== 'autonomous' && tail !== 'confirm')
        throw new Error('Usage: /goal permissions autonomous|confirm');
      const g = choose();
      if (terminal(g)) throw new Error('Create a new goal after completion');
      if (g.status === 'verifying')
        throw new Error('Pause the audit before changing execution permissions');
      this.write('permission.policy', (s) => {
        const goal = activeGoal(s)!;
        goal.permissionPolicy = permissionDefaults(tail);
        goal.permissions = [];
        goal.generation++;
        touch(goal);
      });
      this.notify(
        ctx,
        `${permissionSummary(permissionDefaults(tail))}${['paused', 'blocked', 'budget_limited'].includes(g.status) ? '\nUse /goal resume to continue the paused goal.' : ''}`,
      );
      return;
    }
    if (cmd === 'approve') {
      const g = choose(tail || undefined);
      if (!g.pendingSpec) throw new Error('No proposed scope; ask the model to call goal_plan');
      const fence = this.fence(g);
      const accepted = await confirmPendingScope(
        ctx,
        g.pendingSpec,
        effectivePermissions(this.settings, g),
      );
      if (!accepted) {
        this.notify(
          ctx,
          'Not approved. In non-interactive mode use /goal approve-exact <id> <revision> only after reviewing that scope.',
        );
        return;
      }
      this.current(fence);
      this.approve(g, ctx);
      return;
    }
    if (cmd === 'approve-exact') {
      const g = choose(rest[0]);
      if (Number(rest[1]) !== g.revision) throw new Error('Scope version changed; review it again');
      this.approve(g, ctx);
      return;
    }
    if (cmd === 'resume') {
      if (!ctx.isIdle())
        throw new Error('Wait for the current operation to finish before resuming');
      const current = activeGoal(this.state);
      const g = tail
        ? choose(tail)
        : current && !terminal(current)
          ? current
          : nextQueued(this.state);
      if (!g)
        throw new Error(
          'No approved pending goal; review the proposed scope and use /goal approve',
        );
      const s = this.resume(g);
      this.startPrompt(ctx, kickoffPrompt(activeGoal(s)!));
      return;
    }
    if (cmd === 'skip' || cmd === 'remove') {
      const g = choose(tail || undefined);
      const fence = this.fence(g);
      // The explicit user command is already authorization; the journal retains history.
      this.current(fence);
      if (this.state.activeId === g.id) {
        this.auditController?.abort();
        ctx.abort();
      }
      this.write('queue.remove', (s) => {
        const x = s.goals.find((x) => x.id === g.id)!;
        if (!terminal(x))
          transition(
            x,
            'skipped',
            cmd === 'remove' ? 'Removed by user (history retained)' : 'Skipped by user',
          );
        if (s.activeId === x.id) {
          s.activeId = nextQueued(s)?.id ?? null;
          s.queuePaused = true;
        }
      });
      this.notify(
        ctx,
        'Removed from the queue with history retained; use /goal resume for the next goal',
      );
      return;
    }
    if (cmd === 'budget') {
      const value = tail === 'none' ? null : parseBudget(tail);
      if (value !== null && value <= 0)
        throw new Error('budget requires a positive integer or none');
      this.write('limits.tokens', (s) => {
        activeGoal(s)!.limits.maxTokens = value;
        touch(activeGoal(s)!);
      });
      return;
    }
    if (cmd === 'limits') {
      this.notify(
        ctx,
        'Turn and time limits were removed. Only the optional /goal budget cumulative token limit remains.',
      );
      return;
    }
    if (cmd === 'model') {
      if (activeGoal(this.state)?.status === 'verifying')
        throw new Error('Pause the audit before changing its model');
      const slash = tail.indexOf('/');
      if (tail !== 'inherit' && slash < 1)
        throw new Error('model provider/model-id or model inherit');
      this.write('audit.model', (s) => {
        const g = activeGoal(s)!;
        g.auditModel =
          tail === 'inherit'
            ? undefined
            : { provider: tail.slice(0, slash), model: tail.slice(slash + 1) };
      });
      return;
    }
    if (cmd === 'amend') {
      if (!tail) throw new Error('Provide the requested change');
      this.auditController?.abort();
      this.write('goal.amend', (s) => {
        const g = activeGoal(s)!;
        if (terminal(g)) throw new Error('Create a new goal after completion');
        g.inputs.push(tail);
        g.generation++;
        if (g.status === 'verifying') transition(g, 'active');
        touch(g);
      });
      this.startPrompt(
        ctx,
        `User change request: ${JSON.stringify(tail)}. Preserve all user obligations. Use goal_plan for any change to the approved specification, including the objective or task list, and wait for approval. Progress, evidence and in-scope implementation decisions need no scope approval.`,
      );
      return;
    }
    if (cmd === 'plan') {
      const g = choose(tail || undefined);
      this.startPrompt(ctx, `Inspect read-only and submit goal_plan for: ${JSON.stringify(g)}`, g);
      return;
    }
    const explicit = cmd === 'start';
    const add = cmd === 'add';
    const objective = explicit || add ? tail : args.trim();
    if (!objective) throw new Error(HELP);
    const existing = activeGoal(this.state);
    if (!add && existing && !terminal(existing))
      throw new Error(
        'An unfinished goal already exists. Use /goal add for another goal, or send changes as a normal message.',
      );
    if (!ctx.isIdle() && !add) throw new Error('Wait for the current run to finish');
    const g = this.createGoal(
      objective,
      add,
      !add && (explicit || simpleObjective(objective)),
      ctx,
    );
    this.startPrompt(
      ctx,
      `Work on goal ${g.id} (generation ${g.generation}): ${kickoffPrompt(g)}${add ? '\nThis is a queued draft: propose its scope without switching the active goal.' : ''}`,
      g,
    );
  }
  private createGoal(
    objective: string,
    add: boolean,
    directStart: boolean,
    ctx: Context,
    expectedRevision?: number,
  ) {
    const g = makeGoal(objective, this.settings.limits, directStart);
    g.permissionPolicy = structuredClone(this.settings.permissions);
    const wasOwned = this.store!.owns();
    this.claim(expectedRevision);
    this.write('goal.create', (s) => {
      if (expectedRevision !== undefined && s.revision !== expectedRevision + (wasOwned ? 0 : 1))
        throw new Error('Goal state changed; read goal_status before creating a goal');
      const existing = activeGoal(s);
      const waiting = s.goals.find((goal) => !terminal(goal));
      if (!add && waiting)
        throw new Error('An unfinished goal already exists; use goal_plan or goal_resume');
      s.goals.push(g);
      if (!existing || terminal(existing))
        // Appending never bypasses older work. Keep a completed selection so the
        // settle hook can advance its queue; after skip, restore the waiting head.
        s.activeId = add && waiting ? (existing?.id ?? waiting.id) : g.id;
    });
    if (this.panel === 'hidden' && this.state.activeId === g.id) this.setPanel('compact', ctx);
    return g;
  }
  private resume(g: Goal) {
    return this.write('goal.resume', (s) => {
      const old = activeGoal(s);
      if (old && old.id !== g.id && isRunning(old)) throw new Error('Pause the current goal first');
      s.activeId = g.id;
      const x = activeGoal(s)!;
      x.permissionPolicy ??= structuredClone(this.settings.permissions);
      resumeGoal(x);
      s.queuePaused = false;
    });
  }
  private approve(g: Goal, ctx: Context) {
    if (!g.pendingSpec) throw new Error('No proposed scope');
    const s = this.write('spec.approve', (s) => {
      const x = s.goals.find((x) => x.id === g.id)!;
      x.permissionPolicy ??= structuredClone(this.settings.permissions);
      const proposed = x.pendingSpec!;
      if (isTaskRefinement({ ...x, status: 'active', pendingSpec: undefined }, proposed)) {
        refineTasks(x, proposed.tasks);
        delete x.pendingSpec;
      } else applySpec(x, proposed);
      if (s.activeId === x.id) {
        transition(x, 'active');
        s.queuePaused = false;
      } else transition(x, 'queued');
    });
    const current = activeGoal(s);
    if (current?.id === g.id && ctx.isIdle()) this.startPrompt(ctx, kickoffPrompt(current));
    this.notify(
      ctx,
      `Scope approved and saved. ${permissionSummary(
        effectivePermissions(
          this.settings,
          s.goals.find((x) => x.id === g.id),
        ),
      )}`,
    );
  }
}
function simpleObjective(objective: string) {
  return (
    objective.length < 160 &&
    !/\u79d1\u7814|\u5206\u6790|\u7814\u7a76|\u642d\u5efa|\u9879\u76ee|\u8fc1\u79fb|\u90e8\u7f72|\u53d1\u5e03|research|analys|build.*project|deploy|publish|migrat/i.test(
      objective,
    )
  );
}
export function parseBudget(text: string) {
  if (!/^\d+(?:[kKmM])?$/.test(text)) throw new Error('Budget examples: 50000, 50k, 2m');
  const n = parseInt(text, 10) * (/k$/i.test(text) ? 1000 : /m$/i.test(text) ? 1_000_000 : 1);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Budget must be a positive integer');
  return n;
}
const HELP = `/goal                       Show session goals and queue
/goal <objective>           Create a goal and plan automatically
/goal add <objective>       Add a goal to the queue
/goal approve               Review and approve the proposed scope
/goal pause                 Pause and save progress
/goal resume                Continue from saved progress
/goal clear                 Clear session goals and close the panel

Send requirements or changes as normal messages. Ownership is automatic.
/goal help more             Panel, skipping goals and optional settings`;
const MORE_HELP = `Verification: /goal sandbox doctor|status|cleanup
Display: /goal panel [show|hide|compact|expand] (no argument toggles visibility)
Skip: /goal skip [id] (history retained; resume to continue the queue)
Select: /goal approve [id] or /goal resume [id]
Optional: /goal budget 100k|none; /goal model provider/id|inherit
          /goal permissions autonomous|confirm; /goal settings
Non-interactive approval: /goal approve-exact <id> <revision>
Compatibility: status/list mean /goal; start, plan, amend and remove still work.
Read goal_status and use goal_create/goal_resume/goal_plan for model-driven lifecycle changes.
All modifications to approved specifications need user approval. Defaults: inherit the model, unlimited tokens.`;
