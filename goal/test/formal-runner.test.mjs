import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateResult } from '../scripts/verify-formal.mjs';

test('formal runner accepts only exhaustive success or the exact expected counterexample', () => {
  const complete =
    'Model checking completed. No error has been found.\n20 states generated, 10 distinct states found, 0 states left on queue.';
  assert.equal(evaluateResult({ expect: 'pass' }, 0, complete), true);
  assert.equal(
    evaluateResult({ expect: 'pass' }, 0, complete.replace('0 states left', '3 states left')),
    false,
  );
  assert.equal(evaluateResult({ expect: 'pass' }, null, complete, 'SIGTERM'), false);
  assert.equal(evaluateResult({ expect: 'pass' }, 0, 'No error has been found.'), false);
  const control = { expect: 'invariant', property: 'NoStaleApplication' };
  const counterexample =
    'Error: Invariant NoStaleApplication is violated.\nState 1: <Initial predicate>';
  assert.equal(evaluateResult(control, 12, counterexample), true);
  assert.equal(evaluateResult(control, 150, counterexample), false);
  assert.equal(
    evaluateResult(control, 12, counterexample.replace('NoStaleApplication', 'TypeOK')),
    false,
  );
  assert.equal(evaluateResult(control, 12, 'Error: Deadlock reached.'), false);
  assert.equal(
    evaluateResult(control, 12, 'Error: Invariant NoStaleApplication is violated.'),
    false,
  );
  const temporal = { expect: 'temporal', property: 'EventuallyComplete' };
  assert.equal(
    evaluateResult(temporal, 13, 'Error: Temporal properties were violated.\nState 1:'),
    true,
  );
  assert.equal(
    evaluateResult(temporal, 77, 'Error: Temporal properties were violated.\nState 1:'),
    false,
  );
});
