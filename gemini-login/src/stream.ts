import { randomUUID } from 'node:crypto';
import {
  clampThinkingLevel,
  collapseSystemMessages,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type GoogleOptions,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import {
  convertMessages,
  convertTools,
  getDisabledGoogleThinkingConfig,
  mapStopReasonString,
  resolveGoogleFunctionCallingMode,
  resolveGoogleThinkingLevel,
  supportsGoogleStrictToolSampling,
  toGoogleThinkingLevel,
  usesGoogleThinkingLevel,
} from './google.mjs';
import { sanitizeSurrogates } from './google.mjs';
import { getIdentityHeaders } from '@earendil-works/pi-ai';
import { requestCredential } from './auth.ts';
import {
  BASE_URL,
  GeminiError,
  apiError,
  object,
  readJson,
  requiredString,
  sse,
  type Fetch,
  type Json,
} from './http.ts';

type GeminiModel = Model<'google-generative-ai'>;
type Options = Omit<SimpleStreamOptions, 'toolChoice'> & GoogleOptions;

export function buildRequest(
  model: GeminiModel,
  context: TranscriptContext,
  options: Options,
  projectId: string,
): Json {
  const transcript = collapseSystemMessages(context);
  const tools = getCurrentTools(transcript.messages);
  const system = getCurrentSystemPrompt(transcript.messages);
  const strict = supportsGoogleStrictToolSampling(model.id);
  const mode = tools.length
    ? resolveGoogleFunctionCallingMode(tools, options.toolChoice, strict)
    : undefined;
  const generationConfig: Json = { maxOutputTokens: options.maxTokens ?? model.maxTokens };
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (model.reasoning) {
    if (options.thinking) {
      generationConfig.thinkingConfig = options.thinking.enabled
        ? {
            includeThoughts: true,
            ...(options.thinking.level !== undefined
              ? { thinkingLevel: options.thinking.level }
              : { thinkingBudget: options.thinking.budgetTokens ?? -1 }),
          }
        : getDisabledGoogleThinkingConfig(model);
    } else if (options.reasoning) {
      const clamped = clampThinkingLevel(model, options.reasoning);
      if (clamped === 'off')
        generationConfig.thinkingConfig = getDisabledGoogleThinkingConfig(model);
      else {
        const level = resolveGoogleThinkingLevel(model, clamped);
        const budgets = {
          minimal: 128,
          low: 2048,
          medium: 8192,
          high: model.id.includes('2.5-pro') ? 32768 : 24576,
        };
        generationConfig.thinkingConfig = {
          includeThoughts: true,
          ...(usesGoogleThinkingLevel(model)
            ? { thinkingLevel: toGoogleThinkingLevel(level) }
            : { thinkingBudget: options.thinkingBudgets?.[level] ?? budgets[level] }),
        };
      }
    } else generationConfig.thinkingConfig = getDisabledGoogleThinkingConfig(model);
  }
  return {
    model: model.id,
    project: projectId,
    user_prompt_id: randomUUID(),
    request: {
      contents: convertMessages(model, transcript),
      ...(system ? { systemInstruction: { parts: [{ text: sanitizeSurrogates(system) }] } } : {}),
      ...(tools.length ? { tools: convertTools(tools, false, strict) } : {}),
      ...(mode !== undefined ? { toolConfig: { functionCallingConfig: { mode } } } : {}),
      ...(options.sessionId ? { session_id: options.sessionId } : {}),
      generationConfig,
    },
    // Do not opt in to spending additional Google One AI Credits.
  };
}

export function streamGemini(
  model: GeminiModel,
  context: TranscriptContext,
  options: Options = {},
  fetch: Fetch = globalThis.fetch,
) {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    stopReason: 'pending',
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        totalFromProvider: false,
      },
    },
  };
  void (async () => {
    let response: Response | undefined;
    let requestSignal = options.signal;
    let active: number | undefined;
    const close = () => {
      if (active === undefined) return;
      const block = output.content[active]!;
      if (block.type === 'text')
        stream.push({
          type: 'text_end',
          contentIndex: active,
          content: block.text,
          partial: output,
        });
      if (block.type === 'thinking')
        stream.push({
          type: 'thinking_end',
          contentIndex: active,
          content: block.thinking,
          partial: output,
        });
      active = undefined;
    };
    try {
      options.signal?.throwIfAborted();
      if (options.timeoutMs !== undefined) {
        if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0)
          throw new GeminiError('Invalid Gemini request timeout');
        requestSignal = AbortSignal.any([
          ...(options.signal ? [options.signal] : []),
          AbortSignal.timeout(options.timeoutMs),
        ]);
      }
      const credential = requestCredential(options.apiKey);
      const payload = buildRequest(model, context, options, credential.projectId);
      const replacement = await options.onPayload?.(payload, model);
      const headers = new Headers({
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': 'my-pi-gemini-login/0.1.0',
      });
      for (const source of [
        options.identity ? getIdentityHeaders(model, options.identity) : {},
        model.headers,
        options.headers,
      ])
        for (const [key, value] of Object.entries(source ?? {})) {
          if (value === null) headers.delete(key);
          else headers.set(key, value);
        }
      headers.set('Authorization', `Bearer ${credential.access}`);
      requestSignal?.throwIfAborted();
      response = await (options.fetch ?? fetch)(`${BASE_URL}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        redirect: 'error',
        headers,
        signal: requestSignal,
        body: JSON.stringify(replacement === undefined ? payload : replacement),
      });
      await options.onResponse?.(
        { status: response.status, headers: Object.fromEntries(response.headers) },
        model,
      );
      if (!response.ok) {
        const data = await readJson(response).catch(() => undefined);
        throw apiError(response.status, data);
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel();
        throw new GeminiError('Google returned a non-SSE response');
      }
      stream.push({ type: 'start', partial: output });
      for await (const envelope of sse(response, requestSignal)) {
        await options.onProviderStreamEvent?.(envelope, model);
        if (envelope.error) throw apiError(Number(envelope.error.code) || 500, envelope);
        const chunk = object(envelope.response);
        if (typeof envelope.traceId === 'string') output.responseId ??= envelope.traceId;
        const candidate = chunk.candidates?.[0];
        if (chunk.promptFeedback?.blockReason) throw new GeminiError('Gemini blocked the prompt');
        if (candidate?.content?.parts !== undefined && !Array.isArray(candidate.content.parts))
          throw new GeminiError('Google returned invalid content parts');
        for (const raw of candidate?.content?.parts ?? []) {
          const part = { ...object(raw) };
          if (part.thoughtSignature && !part.functionCall) {
            close();
            if (part.text === undefined) part.text = '';
          }
          if (part.text !== undefined) {
            if (typeof part.text !== 'string')
              throw new GeminiError('Google returned invalid text');
            const kind = part.thought === true ? 'thinking' : 'text';
            if (active === undefined || output.content[active]!.type !== kind) {
              close();
              active = output.content.length;
              if (kind === 'text') {
                output.content.push({ type: 'text', text: '' });
                stream.push({ type: 'text_start', contentIndex: active, partial: output });
              } else {
                output.content.push({ type: 'thinking', thinking: '' });
                stream.push({ type: 'thinking_start', contentIndex: active, partial: output });
              }
            }
            const block = output.content[active]!;
            if (block.type === 'text') {
              block.text += part.text;
              if (part.thoughtSignature)
                block.textSignature = requiredString(part.thoughtSignature, 'thought signature');
              stream.push({
                type: 'text_delta',
                contentIndex: active,
                delta: part.text,
                partial: output,
              });
            } else if (block.type === 'thinking') {
              block.thinking += part.text;
              if (part.thoughtSignature)
                block.thinkingSignature = requiredString(
                  part.thoughtSignature,
                  'thought signature',
                );
              stream.push({
                type: 'thinking_delta',
                contentIndex: active,
                delta: part.text,
                partial: output,
              });
            }
            // A signature closes its part. Do not move it onto later text or another signed part.
            if (part.thoughtSignature) close();
          }
          if (part.functionCall) {
            close();
            const call = object(part.functionCall);
            const name = requiredString(call.name, 'function name');
            const supplied = typeof call.id === 'string' && call.id ? call.id : undefined;
            const id =
              supplied && !output.content.some((b) => b.type === 'toolCall' && b.id === supplied)
                ? supplied
                : `${name}_${randomUUID()}`;
            const toolCall = {
              type: 'toolCall' as const,
              id,
              name,
              arguments: object(call.args ?? {}),
              ...(part.thoughtSignature
                ? { thoughtSignature: requiredString(part.thoughtSignature, 'thought signature') }
                : {}),
            };
            const index = output.content.length;
            output.content.push(toolCall);
            stream.push({ type: 'toolcall_start', contentIndex: index, partial: output });
            stream.push({
              type: 'toolcall_delta',
              contentIndex: index,
              delta: JSON.stringify(toolCall.arguments),
              partial: output,
            });
            stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: output });
          }
        }
        if (candidate?.finishReason) {
          output.rawStopReason = requiredString(candidate.finishReason, 'finish reason');
          output.stopReason = mapStopReasonString(output.rawStopReason);
          if (
            output.stopReason === 'stop' &&
            output.content.some((block) => block.type === 'toolCall')
          )
            output.stopReason = 'toolUse';
        }
        if (chunk.usageMetadata) {
          const usage = object(chunk.usageMetadata);
          const count = (name: string, fallback = 0) => {
            const value = usage[name] ?? fallback;
            if (!Number.isSafeInteger(value) || value < 0)
              throw new GeminiError('Google returned invalid token usage');
            return value as number;
          };
          const prompt = count('promptTokenCount'),
            cache = count('cachedContentTokenCount'),
            reasoning = count('thoughtsTokenCount');
          if (cache > prompt) throw new GeminiError('Google returned inconsistent cache usage');
          output.usage.input = prompt - cache;
          output.usage.cacheRead = cache;
          output.usage.reasoning = reasoning;
          output.usage.output = count('candidatesTokenCount') + reasoning;
          output.usage.totalTokens = count('totalTokenCount', prompt + output.usage.output);
        }
      }
      close();
      requestSignal?.throwIfAborted();
      if (output.stopReason === 'pending')
        throw new GeminiError('Google stream ended without a finish reason');
      if (output.stopReason === 'error' || output.stopReason === 'aborted')
        throw new GeminiError('Gemini stopped without a successful completion');
      stream.push({ type: 'done', reason: output.stopReason, message: output });
    } catch (error) {
      close();
      output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = options.signal?.aborted
        ? 'Gemini request cancelled'
        : requestSignal?.aborted
          ? 'Gemini request timed out'
          : error instanceof GeminiError
            ? error.message
            : 'Gemini request failed; check network connectivity and authentication';
      stream.push({ type: 'error', reason: output.stopReason, error: output });
    } finally {
      await response?.body?.cancel().catch(() => {});
      stream.end();
    }
  })();
  return stream;
}
