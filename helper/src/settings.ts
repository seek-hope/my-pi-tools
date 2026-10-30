import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

const fields = {
  provider: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(Type.String({ minLength: 1 })),
  thinking: Type.Optional(
    Type.Union(
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((v) => Type.Literal(v)),
    ),
  ),
  timeoutSeconds: Type.Integer({ minimum: 1, maximum: 3600 }),
};
export const settingsSchema = Type.Object(fields, { additionalProperties: false });
const partialSchema = Type.Partial(settingsSchema);
export type Settings = Static<typeof settingsSchema>;
export const defaults: Settings = {
  timeoutSeconds: 1200,
};
export function validateSettings(value: unknown): asserts value is Settings {
  if (!Check(settingsSchema, value)) throw new Error('Invalid Helper settings');
  if (
    Boolean(value.provider) !== Boolean(value.model) ||
    value.provider?.trim() === '' ||
    value.model?.trim() === ''
  )
    throw new Error('Helper provider and model must be nonempty and set together');
}
export function loadSettings(cwd: string, agentDir: string): Settings {
  let settings: Settings = { ...defaults };
  for (const file of [join(agentDir, 'my-pi-helper.json'), join(cwd, '.pi', 'my-pi-helper.json')]) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`Cannot read Helper settings ${file}: ${String(error)}`);
    }
    if (!Check(partialSchema, raw)) throw new Error(`Invalid Helper settings: ${file}`);
    settings = { ...settings, ...raw };
  }
  validateSettings(settings);
  return settings;
}
