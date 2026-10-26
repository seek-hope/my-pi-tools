import { VERSION, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { assertSupportedPi } from '../src/compatibility.ts';
import { registerHelper } from '../src/index.ts';
export default function (pi: ExtensionAPI) {
  assertSupportedPi(VERSION);
  registerHelper(pi);
}
