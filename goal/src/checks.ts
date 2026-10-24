import type { Check, CheckResult, Goal } from './state.ts';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
type AgentToolCallOutcome = Awaited<ReturnType<ExtensionToolContext['executeTool']>>;

/** Only trusted host tool metadata can certify an exit status; stdout cannot. */
export function checkResult(
  goal: Goal,
  check: Check,
  outcome: AgentToolCallOutcome,
  stamp: string,
  executedCommand: string | undefined,
  completedStamp = stamp,
): CheckResult {
  const structured = outcome.result.structuredContent as Record<string, unknown> | undefined;
  const code = structured?.exit_code;
  const exitCode = typeof code === 'number' && Number.isSafeInteger(code) ? code : null;
  // Pi's outcome retains the original toolCall arguments, before tool_call hooks.
  // Only tool_result.input identifies the validated arguments actually executed.
  const requested = (outcome.toolCall.arguments as { command?: unknown } | undefined)?.command;
  const command = executedCommand ?? requested;
  const matches = outcome.toolCall.name === 'bash' && executedCommand === check.command;
  const output = outcome.result.content
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n');
  return {
    at: new Date().toISOString(),
    command: typeof command === 'string' ? command : check.command,
    exitCode,
    output: output.length > 50000 ? '[Earlier output omitted]\n' + output.slice(-50000) : output,
    source: 'main-session',
    toolCallId: outcome.toolCall.id,
    generation: goal.generation,
    workspaceStamp: stamp,
    ...(stamp !== completedStamp ? { inputChanged: true } : {}),
    success: matches && !outcome.isError && exitCode === 0 && stamp === completedStamp,
  };
}
export function checkProblems(goal: Goal, stamp: string): string[] {
  return goal.checks.flatMap((check) => {
    const r = check.last;
    if (
      !r ||
      r.source !== 'main-session' ||
      !r.toolCallId ||
      r.generation !== goal.generation ||
      r.command !== check.command
    )
      return [`${check.id}: run the approved command with goal_check in the main session`];
    if (r.inputChanged)
      return [`${check.id}: source inputs changed during the check; rerun with goal_check`];
    if (!r.success || r.exitCode !== 0)
      return [
        `${check.id}: the last main-session check did not pass; inspect its output and rerun`,
      ];
    if (r.workspaceStamp !== stamp)
      return [`${check.id}: source inputs changed since the check; rerun with goal_check`];
    return [];
  });
}
