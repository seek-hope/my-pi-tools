import type { Usage } from '@earendil-works/pi-ai';
import type {
  AgentSession,
  ExtensionToolContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { createHelperSession } from './session.ts';
import { emptyUsage } from './usage.ts';
import { validateSettings, type Settings } from './settings.ts';

export const READ_TOOLS = ['read', 'grep', 'find', 'ls'] as const;
export const requestSchema = Type.Object(
  {
    task: Type.String({ minLength: 1, maxLength: 20000 }),
    context: Type.Optional(Type.String({ maxLength: 120000 })),
  },
  { additionalProperties: false },
);
export type Request = Static<typeof requestSchema>;
export interface Result {
  status: 'answered' | 'error' | 'cancelled' | 'limited' | 'terminated';
  output: string;
  outputTruncated: boolean;
  partial: boolean;
  reason: string;
  model: string;
  turns: number;
  toolCalls: number;
  toolsUsed: string[];
  usage: Usage;
  usageIncomplete: boolean;
  lastTool?: { name: string; output: string; isError: boolean; outputTruncated: boolean };
}
export const resultSchema = Type.Object({
  status: Type.Union(
    ['answered', 'error', 'cancelled', 'limited', 'terminated'].map((v) => Type.Literal(v)),
  ),
  output: Type.String(),
  outputTruncated: Type.Boolean(),
  partial: Type.Boolean(),
  reason: Type.String(),
  model: Type.String(),
  turns: Type.Integer(),
  toolCalls: Type.Integer(),
  toolsUsed: Type.Array(Type.String()),
  usage: Type.Unknown(),
  usageIncomplete: Type.Boolean(),
  lastTool: Type.Optional(
    Type.Object({
      name: Type.String(),
      output: Type.String(),
      isError: Type.Boolean(),
      outputTruncated: Type.Boolean(),
    }),
  ),
});
export function bounded(text: string, limit = 32000) {
  const truncated = text.length > limit;
  return {
    text: truncated
      ? text.slice(0, limit - 100) +
        '\n[Output truncated. Request a narrower result for more detail.]'
      : text,
    truncated,
  };
}

export async function runHelper(
  request: Request,
  ctx: ExtensionToolContext,
  settings: Settings,
  callerSignal?: AbortSignal,
  progress?: (text: string) => void,
  executedInput?: (toolCallId: string) => unknown,
): Promise<Result> {
  if (!Check(requestSchema, request) || !request.task.trim())
    throw new Error('A nonempty Helper task is required; only task and context are accepted');
  validateSettings(settings);
  const model =
    settings.provider && settings.model
      ? ctx.modelRegistry.find(settings.provider, settings.model)
      : ctx.model;
  const result: Result = {
    status: 'error',
    output: '',
    outputTruncated: false,
    partial: true,
    reason: '',
    model: model ? `${model.provider}/${model.id}` : '(unavailable)',
    turns: 0,
    toolCalls: 0,
    toolsUsed: [],
    usage: emptyUsage(),
    usageIncomplete: false,
  };
  const control = new AbortController();
  const signal = AbortSignal.any([
    control.signal,
    ...[callerSignal, ctx.signal].filter((s): s is AbortSignal => !!s),
  ]);
  const expiresAt = performance.now() + settings.timeoutSeconds * 1000;
  let session: AgentSession | undefined;
  let getUsage: (() => Pick<Result, 'usage' | 'usageIncomplete'>) | undefined;
  let stop: { status: Result['status']; reason: string } | undefined;
  const halt = (status: Result['status'], reason: string) => {
    if (!stop || status === 'terminated') stop = { status, reason };
    control.abort();
  };
  const checkpoint = () => {
    if (!signal.aborted && performance.now() >= expiresAt)
      halt('limited', 'Helper time limit reached');
    signal.throwIfAborted();
  };
  const timer = setTimeout(
    () => halt('limited', 'Helper time limit reached'),
    settings.timeoutSeconds * 1000,
  );
  const abort = () => {
    stop ??= { status: 'cancelled', reason: 'Helper invocation cancelled' };
    void session?.abort().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  let unsubscribe: (() => void) | undefined;
  try {
    checkpoint();
    if (!model) throw new Error('No Helper model is available');
    const tools: ToolDefinition[] = ctx.tools
      .filter((t) => (READ_TOOLS as readonly string[]).includes(t.name))
      .map((t) => ({
        name: t.name,
        label: t.name,
        description: t.description,
        parameters: structuredClone(t.parameters),
        executionMode: 'sequential',
        async execute(_id, args, childSignal) {
          checkpoint();
          const combined = AbortSignal.any([signal, ...(childSignal ? [childSignal] : [])]);
          combined.throwIfAborted();
          result.toolCalls++;
          if (!result.toolsUsed.includes(t.name)) result.toolsUsed.push(t.name);
          const outcome = await ctx.executeTool(t.name, args, { signal: combined });
          const actual = executedInput?.(outcome.toolCall.id);
          const adjusted = actual !== undefined && JSON.stringify(actual) !== JSON.stringify(args);
          const content = [...outcome.result.content];
          if (adjusted)
            content.unshift({
              type: 'text',
              text: `Host executed adjusted arguments: ${bounded(JSON.stringify(actual), 8000).text}`,
            });
          const excerpt = bounded(
            content
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join('\n'),
          );
          result.lastTool = {
            name: t.name,
            output: excerpt.text,
            outputTruncated: excerpt.truncated,
            isError: outcome.isError,
          };
          if (outcome.result.terminate)
            halt('terminated', `Host requested termination during ${t.name}`);
          else if (outcome.isError && outcome.durationMs === undefined)
            halt('error', `Host rejected ${t.name} before execution; inspect lastTool.output`);
          checkpoint();
          // Host accounts for nested usage. Forward only model-facing content and status,
          // never re-charge that usage through the child session.
          return { content, details: undefined, isError: outcome.isError };
        },
      }));
    ({ session, getUsage } = await createHelperSession(
      ctx,
      model,
      settings.thinking ?? ctx.thinkingLevel,
      tools,
      checkpoint,
    ));
    checkpoint();
    unsubscribe = session.subscribe((event) => {
      if (event.type === 'turn_start') {
        result.turns++;
        try {
          progress?.(`Helper · turn ${result.turns} · ${result.toolCalls} tool calls`);
        } catch {
          /* UI only */
        }
      }
    });
    await session.prompt(JSON.stringify(request), { expandPromptTemplates: false });
    checkpoint();
    // Recovery edits change the model projection; raw entries retain the terminal attempt.
    const last = session.sessionManager
      .getEntries()
      .flatMap((entry) =>
        entry.type === 'message' && entry.message.role === 'assistant' ? [entry.message] : [],
      )
      .at(-1);
    if (last?.role !== 'assistant') throw new Error('Helper did not return an assistant response');
    const text = last.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    if (last.stopReason === 'length') {
      result.status = 'limited';
      result.reason = 'Pi stopped at the model output limit';
    } else if (last.stopReason === 'aborted') {
      result.status = 'cancelled';
      result.reason = 'Helper model was cancelled';
    } else if (
      last.stopReason === 'stop' &&
      text.trim() &&
      !last.content.some((c) => c.type === 'toolCall')
    ) {
      result.status = 'answered';
      result.reason = 'Model returned a final answer; this is not independent verification';
    } else {
      result.status = 'error';
      result.reason = last.errorMessage || 'Helper did not return a normal final answer';
    }
  } catch (error) {
    result.status = signal.aborted ? 'cancelled' : 'error';
    result.reason = signal.aborted ? 'Helper invocation cancelled' : String(error);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    if (session) {
      try {
        await session.abort();
        const entries = session.sessionManager.getEntries();
        const latestText = entries
          .flatMap((entry) =>
            entry.type === 'message' && entry.message.role === 'assistant'
              ? [
                  entry.message.content
                    .filter((c) => c.type === 'text')
                    .map((c) => c.text)
                    .join('\n'),
                ]
              : [],
          )
          .reverse()
          .find((text) => text.trim());
        const output = bounded(latestText ?? '');
        result.output = output.text;
        result.outputTruncated = output.truncated;
        Object.assign(result, getUsage?.());
      } finally {
        unsubscribe?.();
        session.dispose();
      }
    }
  }
  if (stop) {
    result.status = stop.status;
    result.reason = stop.reason;
  }
  if (result.status === 'answered' && result.outputTruncated) {
    result.status = 'limited';
    result.reason = 'Helper answer exceeded the result size limit';
  }
  result.reason = bounded(result.reason, 4000).text;
  result.partial = result.status !== 'answered';
  if (!result.partial) delete result.lastTool;
  return result;
}
