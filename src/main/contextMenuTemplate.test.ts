import { describe, expect, it } from 'vitest';
import { buildPageMenu, type MenuEntry, type MenuParams } from './contextMenuTemplate';

const NO_EDITING = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canSelectAll: false,
};

function params(overrides: Partial<MenuParams> = {}): MenuParams {
  return {
    linkURL: '',
    srcURL: '',
    mediaType: 'none',
    hasImageContents: false,
    selectionText: '',
    isEditable: false,
    misspelledWord: '',
    dictionarySuggestions: [],
    editFlags: NO_EDITING,
    ...overrides,
  };
}

const navigation = { canGoBack: true, canGoForward: false };

function labels(entries: MenuEntry[]): string[] {
  return entries.map((entry) => (entry === 'separator' ? '-' : entry.label));
}

describe('buildPageMenu', () => {
  it('shows navigation and Inspect on a plain page', () => {
    const menu = buildPageMenu(params(), navigation);
    expect(labels(menu)).toEqual(['Back', 'Forward', 'Reload', '-', 'Inspect']);
    expect(menu[0]).toMatchObject({ enabled: true });
    expect(menu[1]).toMatchObject({ enabled: false });
  });

  it('offers both link items for a web link', () => {
    const menu = buildPageMenu(params({ linkURL: 'https://example.com/a' }), navigation);
    expect(labels(menu)).toEqual([
      'Open link in new tab',
      'Save link as…',
      'Copy link address',
      '-',
      'Inspect',
    ]);
    expect(menu[0]).toMatchObject({ action: { type: 'open-link', url: 'https://example.com/a' } });
  });

  it('only copies links that are not web URLs', () => {
    const menu = buildPageMenu(params({ linkURL: 'javascript:alert(1)' }), navigation);
    expect(labels(menu)).toEqual(['Copy link address', '-', 'Inspect']);
    expect(menu[0]).toMatchObject({ action: { type: 'copy-text', text: 'javascript:alert(1)' } });
  });

  it('offers the image items for a web image', () => {
    const menu = buildPageMenu(
      params({ mediaType: 'image', srcURL: 'https://example.com/i.png', hasImageContents: true }),
      navigation,
    );
    expect(labels(menu)).toEqual([
      'Open image in new tab',
      'Save image as…',
      'Copy image',
      'Copy image address',
      '-',
      'Inspect',
    ]);
  });

  it('does not open or save a data: image, and disables Copy image without contents', () => {
    const menu = buildPageMenu(
      params({ mediaType: 'image', srcURL: 'data:image/png;base64,AAAA' }),
      navigation,
    );
    expect(labels(menu)).toEqual(['Copy image', 'Copy image address', '-', 'Inspect']);
    expect(menu[0]).toMatchObject({ enabled: false });
  });

  it('groups link and image items for a linked image', () => {
    const menu = buildPageMenu(
      params({
        linkURL: 'https://example.com/',
        mediaType: 'image',
        srcURL: 'https://example.com/i.png',
        hasImageContents: true,
      }),
      navigation,
    );
    expect(labels(menu).filter((label) => label === '-')).toHaveLength(2);
    expect(labels(menu)).not.toContain('Back');
  });

  it('shows Copy and a search for a selection, with & escaped', () => {
    const menu = buildPageMenu(
      params({ selectionText: 'Tom & Jerry', editFlags: { ...NO_EDITING, canCopy: true } }),
      navigation,
    );
    expect(labels(menu)).toEqual(['Copy', '-', 'Search Google for "Tom && Jerry"', '-', 'Inspect']);
    expect(menu[2]).toMatchObject({ action: { type: 'search', text: 'Tom & Jerry' } });
  });

  it('shortens a long selection in the label by code point, and keeps the full search text', () => {
    const selection = `${'\u{1F600}'.repeat(50)}\n  tail`;
    const menu = buildPageMenu(params({ selectionText: selection }), navigation);
    const search = menu.find((entry) => entry !== 'separator' && entry.action.type === 'search');
    expect(search).toMatchObject({
      label: `Search Google for "${'\u{1F600}'.repeat(30)}..."`,
      action: { text: selection.trim() },
    });
  });

  it('follows editFlags in an editable field', () => {
    const menu = buildPageMenu(
      params({
        isEditable: true,
        editFlags: { ...NO_EDITING, canPaste: true, canSelectAll: true },
      }),
      navigation,
    );
    expect(labels(menu)).toEqual([
      'Undo',
      'Redo',
      '-',
      'Cut',
      'Copy',
      'Paste',
      'Paste as plain text',
      '-',
      'Select all',
      '-',
      'Inspect',
    ]);
    const enabled = Object.fromEntries(
      menu.flatMap((entry) => (entry === 'separator' ? [] : [[entry.label, entry.enabled]])),
    );
    expect(enabled).toMatchObject({
      Undo: false,
      Cut: false,
      Paste: true,
      'Paste as plain text': true,
      'Select all': true,
    });
  });

  it('puts spelling suggestions first, escaped and limited to five', () => {
    const menu = buildPageMenu(
      params({
        isEditable: true,
        misspelledWord: 'teh',
        dictionarySuggestions: ['the', 'ten', 'T&H', 'tech', 'tea', 'tee'],
      }),
      navigation,
    );
    expect(labels(menu).slice(0, 6)).toEqual(['the', 'ten', 'T&&H', 'tech', 'tea', '-']);
    expect(menu[2]).toMatchObject({ action: { type: 'replace-misspelling', word: 'T&H' } });
  });

  it('ignores suggestions when no word is misspelled', () => {
    const menu = buildPageMenu(
      params({ isEditable: true, dictionarySuggestions: ['stale'] }),
      navigation,
    );
    expect(labels(menu)).not.toContain('stale');
  });

  it('shows a disabled "No suggestions" for a misspelled word without any', () => {
    const menu = buildPageMenu(params({ isEditable: true, misspelledWord: 'xyzzy' }), navigation);
    expect(menu[0]).toMatchObject({ label: 'No suggestions', enabled: false });
  });

  it('keeps the edit items and adds a search for a selection inside an editable field', () => {
    const menu = buildPageMenu(
      params({
        isEditable: true,
        selectionText: 'hello',
        editFlags: { ...NO_EDITING, canCut: true, canCopy: true },
      }),
      navigation,
    );
    const shown = labels(menu);
    expect(shown).toContain('Cut');
    expect(shown).toContain('Search Google for "hello"');
    expect(shown.filter((label) => label === 'Copy')).toHaveLength(1);
    expect(shown).not.toContain('Back');
  });

  it('removes bidi controls before shortening the search label', () => {
    const menu = buildPageMenu(params({ selectionText: '‮abc‬' }), navigation);
    expect(labels(menu)).toContain('Search Google for "abc"');
  });

  it('caps the search text by code point', () => {
    const menu = buildPageMenu(params({ selectionText: '\u{1F600}'.repeat(2500) }), navigation);
    const search = menu.find((entry) => entry !== 'separator' && entry.action.type === 'search');
    const text =
      search !== 'separator' && search?.action.type === 'search' ? search.action.text : '';
    expect(Array.from(text)).toHaveLength(2000);
    expect(() => encodeURIComponent(text)).not.toThrow();
  });
});
