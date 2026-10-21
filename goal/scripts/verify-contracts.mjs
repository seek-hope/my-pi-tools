import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeGoal,
  applySpec,
  completionProblems,
  tokensFromUsage,
  budgetReason,
  resumeGoal,
  transition,
  recordTurn,
  checkpointTime,
  isTaskRefinement,
  refineTasks,
  RESEARCH_CRITERIA,
  normalizeLimits,
  permissionDefaults,
  nextQueued,
} from '../src/state.ts';
import { validateFindings } from '../src/auditor.ts';
import { loadSettings, effectivePermissions } from '../src/settings.ts';
import { permissionReason } from '../src/permissions.ts';
import { renderGoalWidget, goalStatusText } from '../src/tui.ts';
import { GoalRuntime, parseBudget } from '../src/runtime.ts';
import { supportedPi, assertSupportedPi } from '../src/compatibility.ts';
import { diffState, applyStatePatch } from '../src/store.ts';
import {
  DEFAULT_VERIFICATION,
  environmentSignature,
  normalizeVerification,
  sandboxArgs,
  verificationKey,
  verificationSummary,
} from '../src/checks.ts';
import { visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';

const bools = [false, true];
const product = function* (sets, values = []) {
  if (!sets.length) {
    yield values;
    return;
  }
  for (const value of sets[0]) yield* product(sets.slice(1), [...values, value]);
};
const sequences = (alphabet, max) => {
  const out = [[]];
  for (let n = 1; n <= max; n++) out.push(...product(Array.from({ length: n }, () => alphabet)));
  return out;
};
const spec = {
  objective: 'Bounded fixture',
  kind: 'coding',
  criteria: ['A', 'B'],
  tasks: ['A', 'B'],
  checks: [],
};
const goal = () => {
  const g = makeGoal(spec.objective);
  applySpec(g, spec);
  return g;
};
const accepts = (fn) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};
const groups = [];
function group(id, domain, run) {
  groups.push({ id, domain, run });
}

group(
  'usage',
  'All four usage components in {-1,0,1,2,undefined,NaN,Infinity}; totalTokens and reasoning in the same set.',
  (check) => {
    const values = [-1, 0, 1, 2, undefined, NaN, Infinity];
    for (const [input, output, cacheRead, cacheWrite, totalTokens, reasoning] of product(
      Array(6).fill(values),
    )) {
      const u = { input, output, cacheRead, cacheWrite, totalTokens, reasoning };
      const expected = Number.isFinite(totalTokens)
        ? Math.max(0, totalTokens)
        : [input, output, cacheRead, cacheWrite]
            .filter(Number.isFinite)
            .reduce((s, n) => s + Math.max(0, n), 0);
      check(
        tokensFromUsage(u) === expected,
        'usage must count caches, prefer metered total, exclude double reasoning',
      );
    }
  },
);
group(
  'transitions',
  'Every source/destination status, approval and last-audit-pass combination.',
  (check) => {
    const statuses = [
      'draft',
      'queued',
      'active',
      'verifying',
      'paused',
      'blocked',
      'budget_limited',
      'complete',
      'skipped',
    ];
    for (const [from, to, approved, passed] of product([statuses, statuses, bools, bools])) {
      const g = goal();
      Object.assign(g, {
        status: from,
        approved,
        inputs: ['input'],
        audits: passed ? [{ verdict: 'pass' }] : [],
      });
      const generation = g.generation;
      const expected =
        !['complete', 'skipped'].includes(from) &&
        (to !== 'complete' || passed) &&
        (!['active', 'verifying'].includes(to) || approved);
      const accepted = accepts(() => transition(g, to));
      check(accepted === expected, 'terminal/approval/audit transition gates');
      if (accepted) {
        check(
          g.status === to &&
            g.generation === generation + (['active', 'verifying'].includes(to) ? 0 : 1),
          'generation fencing',
        );
        if (['paused', 'blocked', 'budget_limited'].includes(to))
          check(g.resumeAfterInput === 1, 'stop records input boundary');
      }
    }
  },
);
group(
  'completion',
  'Two criteria with every evidence subset, two tasks with all three statuses, approval/pending Boolean combinations.',
  (check) => {
    for (const [approved, pending, a, b, ta, tb] of product([
      bools,
      bools,
      bools,
      bools,
      ['pending', 'active', 'done'],
      ['pending', 'active', 'done'],
    ])) {
      const g = goal();
      Object.assign(g, { approved, pendingSpec: pending ? spec : undefined });
      g.criteria[0].evidence = a ? ['x'] : [];
      g.criteria[1].evidence = b ? ['x'] : [];
      g.tasks[0].status = ta;
      g.tasks[1].status = tb;
      check(
        (completionProblems(g).length === 0) ===
          (approved && !pending && a && b && ta === 'done' && tb === 'done'),
        'completion gate',
      );
    }
    const g = goal();
    g.criteria = [];
    g.tasks = [];
    check(completionProblems(g).length > 0, 'empty criteria cannot pass');
  },
);
group(
  'findings',
  'Every finding sequence of length 0..3 over IDs C1/C2/X, blank/nonblank evidence and both verdicts.',
  (check) => {
    const alphabet = [...product([['C1', 'C2', 'X'], ['', ' ', 'observed'], bools])].map(
      ([criterionId, evidence, passed]) => ({ criterionId, evidence, passed }),
    );
    const g = goal();
    for (const findings of sequences(alphabet, 3)) {
      const valid =
        findings.length === 2 &&
        findings.filter((f) => f.criterionId === 'C1' && f.evidence.trim()).length === 1 &&
        findings.filter((f) => f.criterionId === 'C2' && f.evidence.trim()).length === 1;
      check(
        accepts(() => validateFindings(g, findings)) === valid,
        'exact coverage, no duplicate/unknown IDs or whitespace evidence',
      );
    }
  },
);
group(
  'budget-resume',
  'All nine statuses, approval/pending booleans, worker/audit usage 0..4 and budgets unlimited/1/3/6.',
  (check) => {
    for (const [status, approved, pending, worker, audit, limit] of product([
      [
        'draft',
        'queued',
        'active',
        'verifying',
        'paused',
        'blocked',
        'budget_limited',
        'complete',
        'skipped',
      ],
      bools,
      bools,
      [0, 1, 2, 3, 4],
      [0, 1, 2, 3, 4],
      [null, 1, 3, 6],
    ])) {
      const g = goal();
      Object.assign(g, { status, approved, pendingSpec: pending ? spec : undefined });
      g.usage.tokens = worker;
      g.usage.auditTokens = audit;
      g.limits.maxTokens = limit;
      const exhausted = limit !== null && worker + audit >= limit;
      check(Boolean(budgetReason(g)) === exhausted, 'budget boundary');
      const before = structuredClone(g.usage);
      const ok = accepts(() => resumeGoal(g));
      check(
        ok === (approved && !pending && !exhausted && !['complete', 'skipped'].includes(status)),
        'resume eligibility',
      );
      if (ok)
        check(
          JSON.stringify(g.usage) === JSON.stringify(before) &&
            g.status === 'active' &&
            g.noProgressTurns === 0,
          'resume preserves cumulative usage',
        );
    }
    for (const suffix of ['', 'k', 'K', 'm', 'M'])
      for (const n of [1, 2, 99])
        check(
          parseBudget(`${n}${suffix}`) ===
            n * (suffix.toLowerCase() === 'm' ? 1e6 : suffix ? 1000 : 1),
          'budget parser',
        );
    for (const text of ['', '0', '-1', '1.5k', 'Infinity', 'NaN', '9007199254740992'])
      check(!accepts(() => parseBudget(text)), 'invalid budget rejected');
  },
);
group(
  'progress-clock',
  'No-progress counters 0..6, progress versions 0..2, meaningful progress booleans; clock absent/backward/equal/forward.',
  (check) => {
    for (const [n, version, last, meaningful] of product([
      [0, 1, 2, 3, 4, 5, 6],
      [0, 1, 2],
      [0, 1, 2],
      bools,
    ])) {
      const g = goal();
      g.noProgressTurns = n;
      g.progressVersion = version;
      g.lastProgressVersion = last;
      recordTurn(g, 2, meaningful);
      check(
        g.noProgressTurns === (meaningful || version > last ? 0 : n + 1) &&
          g.usage.tokens === 2 &&
          g.usage.turns === 1,
        'stagnation resets only with progress',
      );
    }
    for (const [started, delta] of product([bools, [-1000, 0, 1000, 3000]])) {
      const g = goal();
      g.usage.activeSeconds = 2;
      g.epoch.seconds = 1;
      if (started) g.clockAt = new Date(10000).toISOString();
      checkpointTime(g, 10000 + delta);
      const elapsed = started ? Math.max(0, delta / 1000) : 0;
      check(
        g.usage.activeSeconds === 2 + elapsed && g.epoch.seconds === 1 + elapsed,
        'offline/backward time not charged',
      );
    }
  },
);
group(
  'spec-refinement',
  'Task sequences over A/B: old length 0..2, new length 0..3, six scope mutations; every research default subset.',
  (check) => {
    for (const old of sequences(['A', 'B'], 2))
      for (const proposed of sequences(['A', 'B'], 3))
        for (const mutation of ['none', 'objective', 'kind', 'criteria', 'checks', 'pending']) {
          const g = goal();
          applySpec(g, { ...spec, tasks: old });
          g.status = 'active';
          g.criteria.forEach((c) => (c.evidence = ['original']));
          g.tasks.forEach((t) => {
            t.status = 'done';
            t.evidence = ['original'];
          });
          const proposal = { ...structuredClone(spec), tasks: proposed };
          if (mutation === 'pending') g.pendingSpec = spec;
          else if (mutation === 'objective') proposal.objective = 'Changed';
          else if (mutation === 'kind') proposal.kind = 'general';
          else if (mutation === 'criteria') proposal.criteria = ['weaker'];
          else if (mutation === 'checks') proposal.checks = [{ command: 'false' }];
          const contains = ['A', 'B'].every(
            (x) => proposed.filter((y) => y === x).length >= old.filter((y) => y === x).length,
          );
          const expected = mutation === 'none' && contains;
          check(
            isTaskRefinement(g, proposal) === expected,
            'refinement retains every occurrence and full contract',
          );
          if (expected) {
            const before = structuredClone(g);
            const pools = {
              A: before.tasks.filter((t) => t.text === 'A'),
              B: before.tasks.filter((t) => t.text === 'B'),
            };
            refineTasks(g, proposed);
            check(new Set(g.tasks.map((t) => t.id)).size === g.tasks.length, 'unique task IDs');
            check(
              JSON.stringify(g.criteria) === JSON.stringify(before.criteria),
              'criterion evidence preserved',
            );
            for (const t of g.tasks) {
              const oldTask = pools[t.text].shift();
              if (oldTask)
                check(
                  JSON.stringify(t) === JSON.stringify(oldTask),
                  'task identity/status/evidence preserved',
                );
              else
                check(
                  t.status === 'pending' && t.evidence.length === 0,
                  'new task has no forged evidence',
                );
            }
          }
        }
    for (const bits of product(Array(4).fill(bools))) {
      const g = goal();
      applySpec(g, {
        ...spec,
        kind: 'research',
        criteria: ['User requirement', ...RESEARCH_CRITERIA.filter((_, i) => bits[i])],
      });
      check(
        RESEARCH_CRITERIA.every((c) => g.criteria.some((x) => x.text === c)),
        'mandatory research obligations',
      );
    }
  },
);
group('queue', 'All ordered three-goal status/approval combinations.', (check) => {
  for (const tuple of product(
    Array(3).fill(['draft', 'queued', 'active', 'paused', 'complete', 'skipped']),
  ))
    for (const approvals of product(Array(3).fill(bools))) {
      const goals = tuple.map((status, i) => ({ id: String(i), status, approved: approvals[i] }));
      const idx = tuple.findIndex((s) => s === 'draft' || s === 'queued');
      const expected =
        idx >= 0 && tuple[idx] === 'queued' && approvals[idx] ? String(idx) : undefined;
      check(nextQueued({ goals })?.id === expected, 'queue selector must not jump draft head');
    }
});
group(
  'settings-permissions',
  'All 27 partial permission policies at each configuration level; eight full policies and classified tool fixtures.',
  (check) => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-contract-config-'));
    const agent = join(cwd, 'agent');
    mkdirSync(agent);
    mkdirSync(join(cwd, '.pi'));
    try {
      const partials = [
        ...product([
          [undefined, 'autonomous', 'confirm'],
          [undefined, 'ask', 'allow'],
          [undefined, 'ask', 'allow'],
        ]),
      ].map(([mode, network, install]) =>
        Object.fromEntries(
          Object.entries({ mode, network, install }).filter(([, v]) => v !== undefined),
        ),
      );
      for (const global of partials)
        for (const project of partials) {
          writeFileSync(
            join(agent, 'my-pi-goal.json'),
            JSON.stringify({
              permissions: global,
              audit: { maxTokens: 1 },
              limits: { maxTurns: 1 },
            }),
          );
          writeFileSync(join(cwd, '.pi/my-pi-goal.json'), JSON.stringify({ permissions: project }));
          const s = loadSettings(cwd, agent);
          const merged = { ...global, ...project };
          const expected = { ...permissionDefaults(merged.mode), ...merged };
          check(
            JSON.stringify(s.permissions) === JSON.stringify(expected),
            'project precedence and explicit ask preservation',
          );
          check(
            !('maxTokens' in s.audit) && !('maxTurns' in s.limits),
            'removed budgets never restored',
          );
          check(
            effectivePermissions(s, { permissionPolicy: permissionDefaults('confirm') }).mode ===
              'confirm',
            'saved goal policy precedes configuration',
          );
        }
      for (const [mode, network, install] of product([
        ['autonomous', 'confirm'],
        ['ask', 'allow'],
        ['ask', 'allow'],
      ])) {
        const p = { mode, network, install };
        for (const [name, input, expected] of [
          ['read', { path: '../outside' }, false],
          ['goal_status', {}, false],
          ['write', { path: 'inside' }, false],
          ['write', { path: '../outside' }, mode === 'confirm'],
          ['external', {}, mode === 'confirm'],
          ['bash', { command: 'curl https://example.test' }, network === 'ask'],
          ['bash', { command: 'npm install sample' }, install === 'ask'],
          ['bash', { command: 'rm inside' }, mode === 'confirm'],
        ])
          check(
            Boolean(permissionReason(name, input, cwd, p)) === expected,
            'policy decision on declared command vocabulary',
          );
      }
      for (const removed of [0, 1, 200, Infinity])
        check(normalizeLimits({ maxTurns: removed }).maxTokens === null, 'retired cap ignored');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);
group(
  'context',
  'Every session/goal/generation identity over two values, ownership/terminal booleans and present/absent current goal, with all control message kinds.',
  (check) => {
    const events = new Map();
    const pi = { on: (name, fn) => events.set(name, fn), registerTool() {}, registerCommand() {} };
    const rt = new GoalRuntime(pi);
    rt.register();
    for (const [sessionId, goalId, generation, owned, finished, present] of product([
      ['s1', 's2'],
      ['g1', 'g2'],
      [1, 2],
      bools,
      bools,
      bools,
    ])) {
      const g = goal();
      Object.assign(g, { id: goalId, generation, status: finished ? 'complete' : 'active' });
      const state = {
        schemaVersion: 1,
        sessionId,
        revision: 2,
        queuePaused: !owned,
        activeId: present ? goalId : null,
        owner: null,
        goals: present ? [g] : [],
        clearedAt: present ? undefined : 'cleared',
      };
      rt.store = { sessionId, load: () => structuredClone(state), owns: () => owned };
      const user = { role: 'user', content: 'Preserve chat', timestamp: 1 };
      const controls = [
        ...product([
          [
            'my-pi-goal-work',
            'my-pi-goal-continue',
            'my-pi-goal-context',
            'my-pi-goal-current',
            'my-pi-goal-session',
            'my-pi-goal-cleared',
            'my-pi-goal-rules',
          ],
          ['s1', 's2'],
          ['g1', 'g2'],
          [1, 2],
        ]),
      ].map(([customType, s, id, gen]) => ({
        role: 'custom',
        customType,
        content: 'historical',
        display: false,
        timestamp: 1,
        details: { sessionId: s, goalId: id, generation: gen },
      }));
      const result = events.get('context')({ messages: [...controls, user] });
      check(result.messages.includes(user), 'ordinary chat preserved');
      check(
        !result.messages.some((m) => m.content === 'historical'),
        'historical controls are regenerated, never replayed',
      );
      check(
        result.messages.filter((m) => m.customType === 'my-pi-goal-rules').length ===
          Number(owned && present && !finished),
        'exactly one eligible current policy',
      );
      check(
        result.messages.filter((m) => m.customType === 'my-pi-goal-session').length === 1,
        'one authoritative session projection',
      );
      if (!present)
        check(
          result.messages.some((m) => String(m.content).includes('No current goal exists')),
          'empty state always explicit',
        );
    }
  },
);
group(
  'layout',
  'All nine statuses, widths 0..120, heights 6..20, compact/expanded and plain/ANSI themes; adversarial Unicode/control text.',
  (check) => {
    const g = goal();
    g.objective = 'Unicode 中 e\u0301 👩‍💻 \x1b]0;bad-title\x07\n' + 'long '.repeat(25);
    const themes = [
      { fg: (_c, t) => t, bold: (t) => t },
      { fg: (_c, t) => `\x1b[34m${t}\x1b[39m`, bold: (t) => `\x1b[1m${t}\x1b[22m` },
    ];
    for (const [status, width, height, expanded, theme] of product([
      [
        'draft',
        'queued',
        'active',
        'verifying',
        'paused',
        'blocked',
        'budget_limited',
        'complete',
        'skipped',
      ],
      Array.from({ length: 121 }, (_, i) => i),
      [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
      bools,
      themes,
    ])) {
      g.status = status;
      const lines = renderGoalWidget(g, '/fixture', expanded, theme, width, false, height);
      check(
        lines.every((line) => visibleWidth(line) <= width && !/[\r\n]/.test(line)),
        'terminal width and single-line contract',
      );
      check(lines.length <= height, 'terminal height contract');
      check(
        !lines.map(stripTerminalSequences).join('').includes('bad-title'),
        'control sequences removed',
      );
      check(
        goalStatusText(g).includes('Verified') === (status === 'complete'),
        'only accepted completion is labelled verified',
      );
    }
  },
);
group(
  'environment',
  'Workspace {readonly,ephemeral} x network {isolated,host} x env sets with duplicates; invalid configs; failure signatures.',
  (check) => {
    const cwd = process.cwd();
    const workspaces = ['readonly', 'ephemeral'];
    const networks = ['isolated', 'host'];
    const envSets = [[], ['PATH'], ['B', 'A'], ['PATH', 'PATH']];
    for (const [workspace, network, env] of product([workspaces, networks, envSets])) {
      const config = { workspace, network, env };
      const normalized = normalizeVerification(config);
      check(
        normalized.workspace === workspace && normalized.network === network,
        'declared workspace and network are preserved',
      );
      check(
        JSON.stringify(normalized.env) === JSON.stringify([...new Set(env)]),
        'environment names are deduplicated in declaration order',
      );
      check(
        verificationKey(config) === verificationKey({ ...config, env: [...env].reverse() }),
        'environment identity ignores variable order',
      );
      const summary = verificationSummary(config);
      check(
        summary.includes(network === 'host' ? 'host network' : 'isolated network'),
        'summary states network capability',
      );
      check(
        summary.includes(workspace === 'readonly' ? 'read-only' : 'ephemeral'),
        'summary states workspace capability',
      );
      const args = sandboxArgs(cwd, config, 'run-check');
      check(args.includes('--unshare-all'), 'namespaces are always isolated');
      check(
        args.includes('--share-net') === (network === 'host'),
        'host network only when declared',
      );
      check(
        args.includes('--overlay-src') === (workspace === 'ephemeral') &&
          args.includes('--tmp-overlay') === (workspace === 'ephemeral'),
        'write access only through an ephemeral overlay',
      );
      const workspaceReadOnlyBind = args.some(
        (arg, index) => arg === '--ro-bind' && args[index + 1] === cwd && args[index + 2] === cwd,
      );
      check(
        args.some((arg, index) => arg === '--ro-bind' && args[index + 1] === '/'),
        'the host root is bound read-only',
      );
      check(
        workspaceReadOnlyBind === (workspace === 'readonly'),
        'the host project is bound read-only outside ephemeral runs',
      );
      check(
        args.includes('--tmpfs') && args.includes('--dev') && args.includes('--proc'),
        'temporary storage, devices and proc are bounded',
      );
      check(args.at(-1) === 'run-check' && args.at(-2) === '-c', 'the approved command is last');
      check(
        !args.includes('--bind') && !args.includes('--dev-bind'),
        'no writable host bind exists',
      );
    }
    check(
      JSON.stringify(normalizeVerification(undefined)) === JSON.stringify(DEFAULT_VERIFICATION),
      'missing configuration means read-only and isolated',
    );
    for (const value of [
      'readonly',
      [],
      { workspace: 'rw' },
      { network: 'offline' },
      { env: ['1BAD'] },
      { env: Array.from({ length: 33 }, () => 'PATH') },
      { extra: true },
    ])
      check(
        !accepts(() => normalizeVerification(value)),
        'invalid environment configuration is rejected',
      );
    const networkPattern = 'Could not resolve host: example.com';
    check(
      Boolean(environmentSignature(networkPattern, DEFAULT_VERIFICATION, 6)),
      'isolated network is suggested for a network failure',
    );
    check(
      !environmentSignature(networkPattern, { ...DEFAULT_VERIFICATION, network: 'host' }, 6),
      'no network advice when host network is already declared',
    );
    const readonlyPattern = 'cannot create output: Read-only file system';
    check(
      Boolean(environmentSignature(readonlyPattern, DEFAULT_VERIFICATION, 1)),
      'ephemeral workspace is suggested for a read-only failure',
    );
    check(
      !environmentSignature(
        readonlyPattern,
        { ...DEFAULT_VERIFICATION, workspace: 'ephemeral' },
        1,
      ),
      'no workspace advice when writes are already enabled',
    );
    check(
      Boolean(environmentSignature('cc: command not found', DEFAULT_VERIFICATION, 127)),
      'missing tooling is reported as environmental',
    );
    check(
      !environmentSignature('2 tests failed', DEFAULT_VERIFICATION, 1),
      'ordinary assertion failures are not classified as environmental',
    );
  },
);
group(
  'storage',
  'Nested state mutations, append-only evidence, object/array removal, equal snapshots and invalid patches.',
  (check) => {
    const storageSpec = {
      objective: 'Storage fixture',
      kind: 'coding',
      criteria: ['A'],
      tasks: ['T'],
      checks: [{ command: 'true' }],
    };
    const base = () => {
      const g = makeGoal(storageSpec.objective);
      applySpec(g, storageSpec);
      g.criteria[0].evidence.push('old');
      g.tasks[0].evidence.push('task');
      return {
        schemaVersion: 1,
        revision: 3,
        queuePaused: true,
        activeId: g.id,
        owner: null,
        goals: [g],
      };
    };
    const mutations = [
      (s) => s.goals[0].notes.push('note'),
      (s) => {
        s.goals[0].criteria[0].evidence.push('one');
        s.goals[0].criteria[0].evidence.push('two');
      },
      (s) => {
        s.goals[0].limits.maxTokens = 5000;
        s.goals[0].usage.turns = 4;
      },
      (s) => {
        delete s.goals[0].reason;
      },
      (s) => {
        s.goals.push(makeGoal('Second'));
        s.activeId = s.goals[1].id;
      },
      (s) => {
        s.goals[0].tasks[0].status = 'done';
        s.goals[0].tasks[0].evidence.push('done');
      },
      (s) => {
        s.goals[0].checks[0].last = {
          at: 'now',
          command: 'true',
          exitCode: 0,
          output: 'output',
        };
      },
      (s) => {
        s.goals[0].criteria[0].evidence.splice(0, 1);
      },
      (s) => {
        s.goals[0].notes = [];
      },
      (s) => {
        s.queuePaused = false;
        s.revision++;
      },
    ];
    for (const mutate of mutations) {
      const before = base();
      const snapshot = JSON.stringify(before);
      const after = structuredClone(before);
      mutate(after);
      const patch = diffState(before, after);
      check(
        JSON.stringify(applyStatePatch(before, patch)) === JSON.stringify(after),
        'a delta round-trips to the exact next state',
      );
      check(JSON.stringify(before) === snapshot, 'diffing does not mutate its inputs');
      check(JSON.stringify(patch).length > 2, 'a real change produces a nonempty delta');
    }
    const appendBefore = base();
    const appendAfter = structuredClone(appendBefore);
    appendAfter.goals[0].criteria[0].evidence.push('only-new');
    const appendPatch = diffState(appendBefore, appendAfter);
    check(
      appendPatch.set.some(
        ([path, value]) => path.at(-1) === 1 && path.at(-2) === 'evidence' && value === 'only-new',
      ) && !appendPatch.set.some(([path]) => path.at(-1) === 'evidence'),
      'appending evidence stores only the new record, not the whole array',
    );
    check(
      JSON.stringify(appendPatch).length * 2 < JSON.stringify(appendAfter).length,
      'an append-only delta is smaller than the full state',
    );
    check(
      diffState(appendBefore, structuredClone(appendBefore)).set.length === 0 &&
        diffState(appendBefore, structuredClone(appendBefore)).unset.length === 0,
      'an unchanged snapshot produces an empty delta',
    );
    for (const bad of [
      null,
      {},
      { set: [[[], 1]], unset: [] },
      { set: [['x', 1]], unset: [] },
      { set: [[['goals', 99], 1]], unset: [] },
      { set: [], unset: [['missing', 0]] },
    ])
      check(!accepts(() => applyStatePatch(base(), bad)), 'invalid deltas are rejected');
  },
);
group(
  'host-support',
  'Declared current/previous versions and known older/future/prerelease versions.',
  (check) => {
    for (const version of [
      supportedPi.current,
      supportedPi.previous,
      '0.99.2',
      '1.0.4',
      '1.1.0',
      '1.1.1',
      '1.4.0',
      `${supportedPi.current}-beta`,
      '',
    ])
      check(
        accepts(() => assertSupportedPi(version)) ===
          [supportedPi.current, supportedPi.previous].includes(version),
        'exact rolling two-release support',
      );
  },
);

export const contractGroups = groups.map(({ id, domain }) => ({ id, domain }));
export function runContracts() {
  const results = [];
  for (const { id, domain, run } of groups) {
    let assertions = 0;
    run((condition, message) => {
      assertions++;
      assert.ok(condition, `${id}: ${message} (assertion ${assertions})`);
    });
    assert.ok(assertions > 0, `${id}: vacuous domain`);
    results.push({ id, domain, assertions, passed: true });
  }
  return { passed: true, groups: results };
}
