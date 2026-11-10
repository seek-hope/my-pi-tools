import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  getKeybindings,
  setKeybindings,
} from '@earendil-works/pi-tui';

const appDefaults = {
  'app.interrupt': 'escape',
  'app.clear': 'ctrl+c',
  'app.exit': 'ctrl+d',
  'app.model.select': 'ctrl+l',
  'app.model.cycleForward': 'ctrl+p',
  'app.model.cycleBackward': 'shift+ctrl+p',
  'app.thinking.cycle': 'shift+tab',
  'app.tools.expand': 'ctrl+o',
  'app.thinking.toggle': 'ctrl+t',
  'app.message.followUp': 'alt+enter',
  'app.message.dequeue': 'alt+up',
  'app.clipboard.pasteImage': 'ctrl+v',
  'app.session.new': [],
  'app.session.resume': [],
};

export function testKeys(t, bindings = {}) {
  const previous = getKeybindings();
  const keys = new KeybindingsManager(
    {
      ...TUI_KEYBINDINGS,
      ...Object.fromEntries(
        Object.entries(appDefaults).map(([key, defaultKeys]) => [
          key,
          { defaultKeys, description: key },
        ]),
      ),
    },
    bindings,
  );
  setKeybindings(keys);
  t.after(() => setKeybindings(previous));
  return keys;
}
export const testTheme = { fg: (_color, text) => text, bg: (_color, text) => text };
