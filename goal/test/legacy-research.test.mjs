import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGoal, applySpec, transition, isTaskRefinement, refineTasks } from '../src/state.ts';
// Exact pre-English journal fixtures; user and historical content remain verbatim.
const legacy = [
  '\u751f\u6210 Markdown \u5206\u6790\u62a5\u544a\uff0c\u8bb0\u5f55\u65b9\u6cd5\u3001\u7ed3\u679c\u89e3\u91ca\u548c\u5c40\u9650\uff0c\u4e0d\u7f16\u9020\u6570\u636e\u6216\u5f15\u7528\u3002',
  '\u751f\u6210\u7ed3\u679c\u6587\u4ef6\u6e05\u5355\uff0c\u5217\u660e\u56fe\u8868\u3001\u8868\u683c\u548c\u6570\u636e\u4ea7\u7269\u3002',
  '\u751f\u6210\u6765\u6e90\u8bb0\u5f55\uff0c\u5305\u542b\u8f93\u5165\u6570\u636e\u4f4d\u7f6e/\u7248\u672c\u3001\u8f6f\u4ef6\u73af\u5883\u548c\u53ef\u6838\u67e5\u7684\u53c2\u8003\u6765\u6e90\uff1b\u4e0d\u9002\u7528\u9879\u8bf4\u660e\u539f\u56e0\u3002',
  '\u4fdd\u5b58\u5b9e\u9645\u8fd0\u884c\u547d\u4ee4\u3001\u68c0\u67e5\u7ed3\u679c\u548c\u53ef\u91cd\u590d\u6267\u884c\u7684\u5206\u6790\u811a\u672c\uff1b\u7f3a\u5931\u8f93\u5165\u987b\u8bf4\u660e\u800c\u4e0d\u80fd\u5047\u88c5\u5b8c\u6210\u3002',
];
test('English research defaults recognize legacy obligations without rewriting evidence or weakening scope', () => {
  const goal = makeGoal('Analyze observations');
  const spec = {
    objective: goal.objective,
    kind: 'research',
    criteria: ['Report the sample size'],
    tasks: ['Inspect data'],
    checks: [],
  };
  applySpec(goal, spec);
  transition(goal, 'active');
  for (let i = 0; i < legacy.length; i++) goal.criteria[i + 1].text = legacy[i];
  goal.criteria.forEach((c) => c.evidence.push('original evidence'));
  const original = structuredClone(goal.criteria);
  const proposal = { ...spec, tasks: [...spec.tasks, 'Validate the report'] };
  assert.equal(isTaskRefinement(goal, proposal), true);
  refineTasks(goal, proposal.tasks);
  assert.deepEqual(goal.criteria, original);
  const copy = makeGoal(spec.objective);
  applySpec(copy, { ...proposal, criteria: [...spec.criteria, ...legacy] });
  assert.equal(copy.criteria.length, 5);
  assert.deepEqual(
    copy.criteria.map((c) => c.text),
    original.map((c) => c.text),
  );
  assert.equal(
    isTaskRefinement(goal, { ...proposal, criteria: ['A weaker requirement', ...legacy] }),
    false,
  );
  assert.equal(isTaskRefinement(goal, { ...proposal, tasks: ['Validate the report'] }), false);
});
