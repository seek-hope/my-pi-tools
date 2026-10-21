# TeamAgents audit blockage: diagnosis and recovery

> Historical incident: the budget numbers and reserved-verdict behavior below describe the recovery version used at the time. The user subsequently requested removal of separate audit budgets and other execution caps. See the current [budget policy](../../README.md#budgets-and-automatic-pauses); these are not present defaults.

Date: 2026-10-07 UTC+8. Final audit timestamp: `2026-10-06T19:47:52.802Z`.

## Outcome

- Session: `01a0f02b-4129-738f-9bc1-87384bd6526d`.
- Project: `/home/rimuru/Projects/Code/for_fun/TeamAgents`.
- Goal: `fb476184-5af7-4915-b33b-b9adc4ae01e8`.
- Final state: complete, generation 75, directory-journal revision 495, last event `owner.release`, no remaining owner.
- Approved checks K1–K17 reran successfully. Independent findings passed C1–C8 individually.
- The original `deepseek/deepseek-flash`, high thinking and native 1M context were retained: eight requests totaling 171,111 / 200,000 tokens.
- Audit tools: nine reads, eight searches, two directory listings, sixteen independent check reruns, two evidence-record reads and one `audit_result`.
- Final verdict output: 4,354 tokens, exceeding the old universal 4,096-output cap.

## Cause

At inspection, all tasks and criterion evidence were recorded and the last seventeen mechanical checks had exit code zero, but independent auditing had left the goal blocked.

The old prompt repeatedly replayed all task/criterion evidence and full check output. Repeated inputs and cache reads counted toward the audit budget. Two audits consumed 71,323 and 85,846 tokens, exceeding the 60,000 default; those runtime errors and two earlier check-environment failures all consumed the same consecutive-failure counter.

The prompt did not require criterion verdicts before budget exhaustion, and the UI only reported that artifacts were being inspected. Increasing the allowance alone was insufficient: one 200,000-token attempt used ten requests and 180,012 tokens without enough remaining allowance for the next request.

## Recovery-version changes

- [prompts.ts](../../src/prompts.ts) preserved the full contract while preloading evidence indexes and paging long outputs. The same original goal payload was about 63,968 characters; the new complete initial prompt was 21,345 characters, varying with submission summary.
- [auditor.ts](../../src/auditor.ts) added project-local literal search, frozen record paging and bounded reads with continuation positions. Executor records could not substitute for artifact inspection, and prewritten read-and-pass responses were rejected.
- The recovery version estimated repeated input costs, accounted actual provider usage, and reserved a verdict-only response near its then-current token/turn caps. Unverified criteria had to fail.
- It then limited reading responses to 4,096 output tokens and verdict responses to 16,384, also respecting model output capacity and remaining allowance.
- [runtime.ts](../../src/runtime.ts) separated budget errors from implementation repair failures, stopped futile tool-loop retries and exposed current audit settings/counters in durable context and goal_status.
- Diagnostics recorded stop reasons, usage, requests, context size and tool counts; progress became visible.
- TeamAgents temporarily set `audit.maxTokens: 200000`; the then-global default remained 60,000. The cumulative goal budget and native model context were unchanged.

Those separate caps and reserved-verdict mechanics were later removed. Paging, inspection gates, budget-error classification and diagnostics remain.

## Procedure and verification

After the original Pi process exited and released ownership, the public SDK opened the same session file, loaded the fixed extension and ran resume. Goal tools and normal journal transactions performed all transitions, checks and final acceptance.

One backup is `/home/rimuru/.pi/agent/recovery/my-pi-goal-1791315141439/`, containing state and session JSONL. Intermediate failures, cancellation, costs and the final pass remain recorded.

Comparison with the pre-recovery snapshot confirmed identical objective, kind, criteria/evidence, tasks/evidence/status and supplements. Check IDs, commands and then-existing timeout fields were also identical, with no pending proposal. TeamAgents remained a clean Git worktree at HEAD `46105cda`.

The recovery version passed type, format and Pi-load checks and **49 tests**. Regressions covered lossless evidence paging, independent-inspection requirements, path boundaries, same-response verdict rejection, budget preflight/overshoot accounting, reserved verdict/output capacity, paused tool-loop termination and real SDK integration.

The audit followed the goal's previously approved check-environment adjustment. C5's build gate used recorded host evidence rather than rebuilding inside the read-only sandbox; the audit explicitly recorded this limit. This was a short real-model recovery, not validation of continuous 5–12 hour stability or a multi-version Pi compatibility matrix.
