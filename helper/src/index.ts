import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { loadSettings } from './settings.ts';
import { requestSchema, resultSchema, runHelper, READ_TOOLS } from './runner.ts';

export function registerHelper(pi: ExtensionAPI, agentDir = getAgentDir()) {
  const active = new Map<string, { controller: AbortController; inputs: Map<string, unknown> }>();
  pi.on('session_shutdown', () => {
    for (const run of active.values()) run.controller.abort();
    active.clear();
  });
  pi.on('tool_result', (event) => {
    if (!event.parentToolCallId) return;
    active.get(event.parentToolCallId)?.inputs.set(event.toolCallId, structuredClone(event.input));
  });
  pi.registerTool({
    name: 'helper',
    label: 'Helper',
    description:
      'Delegate one explicit read-only task to a fresh, temporary Pi session. Supply the task, relevant paths and context; parent history is not inherited. Only callable host read/grep/find/ls tools are available, through the parent permission hooks. Pi manages tool errors and context compaction. Returns an answer or partial result, then disposes the session. Cannot modify files, run commands or delegate further.',
    parameters: requestSchema,
    outputSchema: resultSchema,
    executionMode: 'sequential',
    exposure: 'model-only',
    reachesTools: () => READ_TOOLS,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async execute(id, request, signal, onUpdate, ctx) {
      const run = { controller: new AbortController(), inputs: new Map<string, unknown>() };
      active.set(id, run);
      try {
        const settings = loadSettings(ctx.cwd, agentDir);
        const combined = AbortSignal.any([run.controller.signal, ...(signal ? [signal] : [])]);
        const result = await runHelper(
          request,
          ctx,
          settings,
          combined,
          (text) => onUpdate?.({ content: [{ type: 'text', text }], details: undefined }),
          (toolCallId) => {
            const input = run.inputs.get(toolCallId);
            run.inputs.delete(toolCallId);
            return input;
          },
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          details: result,
          structuredContent: {
            ...result,
            usage: { ...result.usage, cost: { ...result.usage.cost } },
          },
          // Pi adds nested-tool usage itself; report only our model requests here.
          usage: structuredClone(result.usage),
          isError: result.status !== 'answered',
          ...(result.status === 'terminated' ? { terminate: true } : {}),
        };
      } finally {
        if (active.get(id) === run) active.delete(id);
      }
    },
  });
}
