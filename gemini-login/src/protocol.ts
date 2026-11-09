import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';

// The SDK publishes the protocol's JSON Schema. Reuse it rather than maintaining
// a second set of hand-written message/response validators.
const require = createRequire(import.meta.url);
const schema = require('@agentclientprotocol/sdk/schema/v1/schema.json');
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(schema, 'acp');
const names = [
  'SessionNotification',
  'RequestPermissionRequest',
  'InitializeResponse',
  'AuthenticateResponse',
  'NewSessionResponse',
  'LoadSessionResponse',
  'SetSessionConfigOptionResponse',
  'PromptResponse',
] as const;
export type Shape = (typeof names)[number];
const validators = new Map(names.map((name) => [name, ajv.getSchema(`acp#/$defs/${name}`)!]));

export function validate(shape: Shape, value: unknown): void {
  if (!validators.get(shape)!(value))
    throw new Error(`Invalid ACP ${shape}; the connection was stopped`);
  const object = value as Record<string, unknown>;
  const update =
    object.update && typeof object.update === 'object'
      ? (object.update as Record<string, unknown>)
      : {};
  const tool =
    object.toolCall && typeof object.toolCall === 'object'
      ? (object.toolCall as Record<string, unknown>)
      : {};
  for (const id of [object.sessionId, update.toolCallId, update.messageId, tool.toolCallId]) {
    if (typeof id === 'string' && id.length > 1024)
      throw new Error('ACP identifier exceeds 1024 characters');
  }
}
