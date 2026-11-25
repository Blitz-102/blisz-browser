import { describe, expect, it } from 'vitest';
import { matchShortcut, type ShortcutInput } from './shortcuts';

function press(key: string, modifiers: Partial<ShortcutInput> = {}): ShortcutInput {
  return {
    type: 'keyDown',
    key,
    code: '',
    control: false,
    shift: false,
    alt: false,
    meta: false,
    ...modifiers,
  };
}

describe('matchShortcut', () => {
  it('matches tab commands', () => {
    expect(matchShortcut(press('t', { control: true }))).toBe('new-tab');
    expect(matchShortcut(press('w', { control: true }))).toBe('close-tab');
    expect(matchShortcut(press('Tab', { control: true }))).toBe('next-tab');
    expect(matchShortcut(press('Tab', { control: true, shift: true }))).toBe('previous-tab');
  });

  it('matches letters case-insensitively', () => {
    expect(matchShortcut(press('T', { control: true }))).toBe('new-tab');
    expect(matchShortcut(press('L', { control: true }))).toBe('focus-address');
  });

  it('selects tabs 1 to 8 by position and 9 as the last tab', () => {
    expect(matchShortcut(press('1', { control: true, code: 'Digit1' }))).toEqual({ selectTab: 1 });
    expect(matchShortcut(press('8', { control: true, code: 'Digit8' }))).toEqual({ selectTab: 8 });
    expect(matchShortcut(press('9', { control: true, code: 'Digit9' }))).toBe('last-tab');
  });

  it('falls back to key for digits when code is empty', () => {
    expect(matchShortcut(press('3', { control: true }))).toEqual({ selectTab: 3 });
    expect(matchShortcut(press('9', { control: true }))).toBe('last-tab');
  });

  it('uses the physical key for letters on non-Latin layouts', () => {
    expect(matchShortcut(press('е', { control: true, code: 'KeyT' }))).toBe('new-tab');
    expect(matchShortcut(press('д', { control: true, code: 'KeyL' }))).toBe('focus-address');
  });

  it('hard-reloads on Ctrl+F5', () => {
    expect(matchShortcut(press('F5', { control: true }))).toBe('reload-ignoring-cache');
  });

  it('focuses the address field', () => {
    expect(matchShortcut(press('l', { control: true }))).toBe('focus-address');
    expect(matchShortcut(press('d', { alt: true }))).toBe('focus-address');
    expect(matchShortcut(press('F6'))).toBe('focus-address');
  });

  it('reloads, with and without the cache', () => {
    expect(matchShortcut(press('F5'))).toBe('reload');
    expect(matchShortcut(press('r', { control: true }))).toBe('reload');
    expect(matchShortcut(press('R', { control: true, shift: true }))).toBe('reload-ignoring-cache');
    expect(matchShortcut(press('F5', { shift: true }))).toBe('reload-ignoring-cache');
  });

  it('goes back and forward with Alt+arrows only', () => {
    expect(matchShortcut(press('ArrowLeft', { alt: true }))).toBe('back');
    expect(matchShortcut(press('ArrowRight', { alt: true }))).toBe('forward');
    expect(matchShortcut(press('ArrowLeft'))).toBeNull();
    expect(matchShortcut(press('ArrowLeft', { alt: true, shift: true }))).toBeNull();
  });

  it('toggles window fullscreen on a plain F11', () => {
    expect(matchShortcut(press('F11'))).toBe('toggle-fullscreen');
    expect(matchShortcut(press('F11', { shift: true }))).toBeNull();
    expect(matchShortcut(press('F11', { control: true }))).toBeNull();
    expect(matchShortcut(press('F11', { alt: true }))).toBeNull();
  });

  it('keeps F12 for the page and the UI DevTools on Ctrl+Shift+Alt+I', () => {
    expect(matchShortcut(press('F12'))).toBe('toggle-devtools');
    expect(matchShortcut(press('I', { control: true, shift: true }))).toBe('toggle-devtools');
    expect(matchShortcut(press('I', { control: true, shift: true, alt: true }))).toBe(
      'toggle-ui-devtools',
    );
  });

  it('matches Escape only without modifiers', () => {
    expect(matchShortcut(press('Escape'))).toBe('stop');
    expect(matchShortcut(press('Escape', { shift: true }))).toBeNull();
  });

  it('does not confuse plain Ctrl with Ctrl+Shift or Ctrl+Alt (AltGr)', () => {
    expect(matchShortcut(press('t', { control: true, alt: true }))).toBeNull();
    expect(matchShortcut(press('t'))).toBeNull();
  });

  it('reopens the last closed tab on Ctrl+Shift+T', () => {
    expect(matchShortcut(press('T', { control: true, shift: true }))).toBe('reopen-closed-tab');
    expect(matchShortcut(press('t', { control: true }))).toBe('new-tab');
  });

  it('finds in the page', () => {
    expect(matchShortcut(press('f', { control: true }))).toBe('find');
    expect(matchShortcut(press('g', { control: true }))).toBe('find-next');
    expect(matchShortcut(press('G', { control: true, shift: true }))).toBe('find-previous');
    expect(matchShortcut(press('F3'))).toBe('find-next');
    expect(matchShortcut(press('F3', { shift: true }))).toBe('find-previous');
    expect(matchShortcut(press('f'))).toBeNull();
  });

  it('toggles history on plain Ctrl+H only', () => {
    expect(matchShortcut(press('h', { control: true }))).toBe('toggle-history');
    expect(matchShortcut(press('H', { control: true, shift: true }))).toBeNull();
    expect(matchShortcut(press('h', { control: true, alt: true }))).toBeNull();
    expect(matchShortcut(press('h'))).toBeNull();
  });

  it('zooms with Ctrl and the physical key', () => {
    expect(matchShortcut(press('=', { control: true, code: 'Equal' }))).toBe('zoom-in');
    expect(matchShortcut(press('+', { control: true, shift: true, code: 'Equal' }))).toBe(
      'zoom-in',
    );
    expect(matchShortcut(press('+', { control: true, code: 'NumpadAdd' }))).toBe('zoom-in');
    expect(matchShortcut(press('-', { control: true, code: 'Minus' }))).toBe('zoom-out');
    expect(matchShortcut(press('-', { control: true, code: 'NumpadSubtract' }))).toBe('zoom-out');
    expect(matchShortcut(press('0', { control: true, code: 'Digit0' }))).toBe('zoom-reset');
    expect(matchShortcut(press('0', { control: true, code: 'Numpad0' }))).toBe('zoom-reset');
  });

  it('matches the zoom characters by key whatever the code', () => {
    expect(matchShortcut(press('-', { control: true, code: 'Slash' }))).toBe('zoom-out');
    expect(matchShortcut(press('=', { control: true, code: 'Slash' }))).toBe('zoom-in');
  });

  it('falls back to key for zoom when code is empty', () => {
    expect(matchShortcut(press('=', { control: true }))).toBe('zoom-in');
    expect(matchShortcut(press('+', { control: true }))).toBe('zoom-in');
    expect(matchShortcut(press('-', { control: true }))).toBe('zoom-out');
    expect(matchShortcut(press('0', { control: true }))).toBe('zoom-reset');
  });

  it('does not zoom without Ctrl or with Alt', () => {
    expect(matchShortcut(press('-', { code: 'Minus' }))).toBeNull();
    expect(matchShortcut(press('-', { control: true, alt: true, code: 'Minus' }))).toBeNull();
  });

  it('ignores key releases and the Meta key', () => {
    expect(matchShortcut(press('t', { control: true, type: 'keyUp' }))).toBeNull();
    expect(matchShortcut(press('t', { control: true, meta: true }))).toBeNull();
  });
});
