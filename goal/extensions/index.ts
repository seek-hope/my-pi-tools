import { VERSION, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { assertSupportedPi } from '../src/compatibility.ts';
import { GoalRuntime } from '../src/runtime.ts';
export default function goalExtension(pi: ExtensionAPI) {
  assertSupportedPi(VERSION);
  new GoalRuntime(pi).register();
}
