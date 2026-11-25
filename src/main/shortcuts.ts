// What a pressed key means to the browser. Pure, so every shortcut can be unit-tested (PLAN 4.5).
export type ShortcutAction =
  | 'new-tab'
  | 'close-tab'
  | 'reopen-closed-tab'
  | 'next-tab'
  | 'previous-tab'
  | 'last-tab'
  | 'focus-address'
  | 'reload'
  | 'reload-ignoring-cache'
  | 'stop'
  | 'back'
  | 'forward'
  | 'toggle-devtools'
  | 'toggle-ui-devtools'
  | 'find'
  | 'toggle-history'
  | 'find-next'
  | 'find-previous'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'toggle-fullscreen'
  | { selectTab: number }; // 1-based position in sidebar order

// The part of Electron's Input that matching needs.
export type ShortcutInput = Pick<
  Electron.Input,
  'type' | 'key' | 'code' | 'control' | 'shift' | 'alt' | 'meta'
>;

// The characters match on key, so layouts that put them elsewhere work. Digit 0 matches the
// physical key (sendInputEvent leaves code empty, so key is the fallback).
function matchZoom({ key, code }: ShortcutInput): ShortcutAction | null {
  if (key === '=' || key === '+' || code === 'NumpadAdd') return 'zoom-in';
  if (key === '-' || key === '_' || code === 'NumpadSubtract') return 'zoom-out';
  if (code === 'Digit0' || code === 'Numpad0' || (code === '' && key === '0')) return 'zoom-reset';
  return null;
}

export function matchShortcut(input: ShortcutInput): ShortcutAction | null {
  if (input.type !== 'keyDown' || input.meta) return null;
  const { key, code, shift, alt } = input;
  const ctrl = input.control;
  // Non-Latin layouts report the typed character in key, so use the physical key for letters.
  const letter = /^[a-z]$/i.test(key)
    ? key.toLowerCase()
    : (/^Key([A-Z])$/.exec(code)?.[1]?.toLowerCase() ?? key.toLowerCase());

  if (ctrl && shift && alt) {
    return letter === 'i' ? 'toggle-ui-devtools' : null;
  }

  if (ctrl && !alt) {
    if (key === 'Tab') return shift ? 'previous-tab' : 'next-tab';
    if (key === 'F5') return 'reload-ignoring-cache';
    // Ctrl+Plus is Ctrl+Shift+= on most layouts, so zoom is matched before the Shift check.
    const zoom = matchZoom(input);
    if (zoom) return zoom;
    if (shift) {
      if (letter === 'r') return 'reload-ignoring-cache';
      if (letter === 'i') return 'toggle-devtools';
      if (letter === 'g') return 'find-previous';
      if (letter === 't') return 'reopen-closed-tab';
      return null;
    }
    // Digits match the physical key so they also work on layouts where the digit row needs Shift.
    // sendInputEvent doesn't set code, so fall back to key.
    const digit = /^Digit([1-9])$/.exec(code)?.[1] ?? (/^[1-9]$/.test(key) ? key : undefined);
    if (digit) return digit === '9' ? 'last-tab' : { selectTab: Number(digit) };
    switch (letter) {
      case 't':
        return 'new-tab';
      case 'w':
        return 'close-tab';
      case 'l':
        return 'focus-address';
      case 'f':
        return 'find';
      case 'h':
        return 'toggle-history';
      case 'g':
        return 'find-next';
      case 'r':
        return 'reload';
    }
    return null;
  }

  if (alt && !ctrl && !shift) {
    if (key === 'ArrowLeft') return 'back';
    if (key === 'ArrowRight') return 'forward';
    if (letter === 'd') return 'focus-address';
    return null;
  }

  if (ctrl || alt) return null;
  if (key === 'F5') return shift ? 'reload-ignoring-cache' : 'reload';
  if (key === 'F3') return shift ? 'find-previous' : 'find-next';
  if (shift) return null;
  if (key === 'F6') return 'focus-address';
  if (key === 'F11') return 'toggle-fullscreen';
  if (key === 'F12') return 'toggle-devtools';
  if (key === 'Escape') return 'stop';
  return null;
}
