import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { getSelectListTheme } from '@earendil-works/pi-coding-agent';
import {
  Input,
  SelectList,
  fuzzyFilter,
  type Component,
  type Focusable,
  type SelectItem,
} from '@earendil-works/pi-tui';

/** Pi's input, fuzzy matching and selection controls, shared by ACP pickers. */
export class Picker implements Component, Focusable {
  readonly title: string;
  readonly searchable: boolean;
  private readonly items: SelectItem[];
  private readonly keys: KeybindingsManager;
  private readonly theme: Theme;
  private readonly select: (value: string) => void;
  private readonly cancel: () => void;
  private readonly current?: string;
  readonly capturesViewportInput = true;
  private readonly input = new Input();
  private list!: SelectList;
  private focus = false;

  constructor(
    title: string,
    items: SelectItem[],
    keys: KeybindingsManager,
    theme: Theme,
    select: (value: string) => void,
    cancel: () => void,
    searchable = true,
    current?: string,
    query = '',
  ) {
    this.title = title;
    this.items = items;
    this.keys = keys;
    this.theme = theme;
    this.select = select;
    this.cancel = cancel;
    this.searchable = searchable;
    this.current = current;
    this.input.setValue(query);
    this.filter();
  }

  get focused() {
    return this.focus;
  }
  set focused(value: boolean) {
    this.focus = value;
    this.input.focused = value && this.searchable;
  }

  private filter() {
    const query = this.input.getValue();
    const items = query
      ? fuzzyFilter(
          this.items,
          query,
          (item) => `${item.label} ${item.value} ${item.description ?? ''}`,
        )
      : this.items;
    this.list = new SelectList(items, 8, getSelectListTheme());
    this.list.setSelectedIndex(
      Math.max(
        0,
        items.findIndex((item) => item.value === this.current),
      ),
    );
    this.list.onSelect = (item) => this.select(item.value);
    this.list.onCancel = this.cancel;
  }

  handleInput(data: string) {
    if (
      [
        'tui.select.up',
        'tui.select.down',
        'tui.select.pageUp',
        'tui.select.pageDown',
        'tui.select.confirm',
        'tui.select.cancel',
      ].some((key) => this.keys.matches(data, key as 'tui.select.up'))
    ) {
      this.list.handleInput(data);
    } else if (this.searchable) {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (previous !== this.input.getValue()) this.filter();
    }
  }

  render(width: number): string[] {
    return [
      this.theme.fg('accent', this.title),
      ...(this.searchable ? this.input.render(width) : []),
      ...this.list.render(width),
    ];
  }

  invalidate() {
    this.input.invalidate();
    this.list.invalidate();
  }
}
