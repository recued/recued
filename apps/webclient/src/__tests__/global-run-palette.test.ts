import { describe, expect, it } from 'vitest';
import {
  isGlobalRunPaletteShortcut,
  type GlobalRunPaletteShortcutEvent,
} from '../shell/global-run-palette.js';

const chord = (
  overrides: Partial<GlobalRunPaletteShortcutEvent> = {},
): GlobalRunPaletteShortcutEvent => ({
  key: 'k',
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...overrides,
});

describe('global Run palette shortcut', () => {
  it('accepts exact Ctrl+K and Cmd+K chords', () => {
    expect(isGlobalRunPaletteShortcut(chord())).toBe(true);
    expect(isGlobalRunPaletteShortcut(chord({
      key: 'K',
      ctrlKey: false,
      metaKey: true,
    }))).toBe(true);
  });

  it('leaves modified, unmodified, and composing keys to their owner', () => {
    expect(isGlobalRunPaletteShortcut(chord({ ctrlKey: false }))).toBe(false);
    expect(isGlobalRunPaletteShortcut(chord({ key: 'p' }))).toBe(false);
    expect(isGlobalRunPaletteShortcut(chord({ altKey: true }))).toBe(false);
    expect(isGlobalRunPaletteShortcut(chord({ shiftKey: true }))).toBe(false);
    expect(isGlobalRunPaletteShortcut(chord({ isComposing: true }))).toBe(false);
  });
});
