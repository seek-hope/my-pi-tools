import { Type } from 'typebox';
import { defaults } from '../src/settings.ts';
export const model = {
  id: 'fixture',
  provider: 'offline',
  api: 'openai-completions',
  maxTokens: 4096,
};
export function message(content = 'Done', stopReason = 'stop', overrides = {}) {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason,
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    usage: {
      input: 2,
      output: 1,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      cost: { input: 0.1, output: 0.1, cacheRead: 0.1, cacheWrite: 0.1, total: 0.4 },
    },
    ...overrides,
  };
}
export const call = (name, args = {}, id = 'call-1') => ({
  type: 'toolCall',
  name,
  arguments: args,
  id,
});
export function fixture(responses, options = {}) {
  const contexts = [],
    executions = [],
    requests = [];
  const tools = [
    'read',
    'grep',
    'find',
    'ls',
    'write',
    'edit',
    'bash',
    'powershell',
    'helper',
    'goal_status',
    'codemode',
    'web_fetch',
  ].map((name) => ({ name, description: name, parameters: Type.Object({}) }));
  const ctx = {
    cwd: '/fixture',
    model,
    thinkingLevel: 'off',
    tools,
    signal: options.signal,
    modelRegistry: {
      find: (provider, id) => options.resolve?.(provider, id),
      streamSimple: (m, context, config) => {
        contexts.push(structuredClone(context));
        requests.push({ model: m, ...config });
        return {
          result: async () =>
            typeof responses === 'function'
              ? responses(context, config, contexts.length)
              : responses.shift(),
        };
      },
    },
    executeTool: async (name, args, opts) => {
      executions.push({ name, args, signal: opts.signal });
      return options.execute
        ? options.execute(name, args, opts)
        : {
            toolCall: { id: `nested-${executions.length}`, name, arguments: args },
            result: { content: [{ type: 'text', text: 'FILE_VALUE' }], details: undefined },
          };
    },
  };
  for (const property of ['sessionManager', 'systemPrompt', 'messages'])
    Object.defineProperty(ctx, property, {
      get() {
        throw new Error(`Parent context accessed: ${property}`);
      },
    });
  return { ctx, contexts, executions, requests, settings: { ...defaults } };
}
