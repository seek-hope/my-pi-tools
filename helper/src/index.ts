import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { loadSettings } from './settings.ts';
import { requestSchema, resultSchema, runHelper, permittedTools } from './runner.ts';

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
      'Delegate one explicit task to an independent helper with no parent conversation or prior helper history. Supply all needed context and file paths. Default mode=read offers only host read/grep/find/ls tools that are callable. Explicit mode=work also permits host write/edit/bash/powershell. It returns a normal answer or a partial result on failure/limits; it never resumes the main session or retries a task. Work changes persist in the shared workspace.',
    parameters: requestSchema,
    outputSchema: resultSchema,
    executionMode: 'sequential',
    exposure: 'model-only',
    reachesTools: (input) => permittedTools(input.mode),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
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
