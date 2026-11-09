import type { Provider } from '@earendil-works/pi-ai';
import { googleProvider } from './google.mjs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createOAuth, type AuthDependencies } from './auth.ts';
import { BASE_URL } from './http.ts';
import { streamGemini } from './stream.ts';

export function createGeminiProvider(
  dependencies: AuthDependencies = {},
): Provider<'google-generative-ai'> {
  const google = googleProvider().getModels();
  // Code Assist's stable Flash backend is named gemini-3-flash (Gemini CLI v0.67.0).
  // Reuse Pi's capabilities and input limits, not AI Studio's pay-as-you-go prices.
  const entries = [
    ['gemini-3.1-pro-preview', 'gemini-3.1-pro-preview'],
    ['gemini-3.5-flash', 'gemini-3-flash'],
    ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite'],
    ['gemini-2.5-pro', 'gemini-2.5-pro'],
  ];
  const models = entries.flatMap(([source, id]) => {
    const original = google.find((model) => model.id === source);
    return original
      ? [
          {
            ...original,
            id: id!,
            name: `${original.name} (Code Assist)`,
            provider: 'gemini-login',
            baseUrl: BASE_URL,
            promptCache: undefined,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ]
      : [];
  });
  return {
    id: 'gemini-login',
    name: 'Google Code Assist (legacy)',
    baseUrl: BASE_URL,
    auth: { oauth: createOAuth(dependencies) },
    getModels: () => models.map((model) => structuredClone(model)),
    stream: (model, context, options) => streamGemini(model, context, options, dependencies.fetch),
    streamSimple: (model, context, options) =>
      streamGemini(model, context, options, dependencies.fetch),
  };
}

export default function geminiLogin(pi: ExtensionAPI) {
  pi.registerProvider(createGeminiProvider({ projectId: process.env.GEMINI_LOGIN_PROJECT }));
}
