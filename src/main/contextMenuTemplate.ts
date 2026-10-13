import { BIDI_CONTROLS } from '../shared/bidi';
import { isWebUrl } from '../shared/url';

const MAX_SEARCH_LABEL_LENGTH = 30;
const MAX_SUGGESTIONS = 5;
const MAX_SEARCH_LENGTH = 2000;

export type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'paste-plain' | 'select-all';

// What a menu item does. It carries its own data, so the template says everything about a menu
// and the code that pops it up only runs these.
export type MenuAction =
  | { type: 'open-link'; url: string }
  | { type: 'copy-text'; text: string } // link and image addresses
  | { type: 'open-image'; url: string }
  | { type: 'save-image'; url: string }
  | { type: 'save-link'; url: string }
  | { type: 'copy-image' }
  | { type: 'search'; text: string }
  | { type: 'replace-misspelling'; word: string }
  | { type: 'edit'; command: EditCommand }
  | { type: 'go'; direction: 'back' | 'forward' | 'reload' }
  | { type: 'inspect' }
  | { type: 'inert' }; // a disabled placeholder

export type MenuEntry = { label: string; enabled: boolean; action: MenuAction } | 'separator';

// The part of Electron's context-menu params that the menu uses.
export interface MenuParams {
  linkURL: string;
  srcURL: string;
  mediaType: string;
  hasImageContents: boolean;
  selectionText: string;
  isEditable: boolean;
  misspelledWord: string;
  dictionarySuggestions: string[];
  editFlags: {
    canUndo: boolean;
    canRedo: boolean;
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

// On Windows "&" in a label marks a keyboard mnemonic, so page text must double it.
function escapeLabel(text: string): string {
  return text.replaceAll('&', '&&');
}

function item(label: string, action: MenuAction, enabled = true): MenuEntry {
  return { label, enabled, action };
}

function searchLabel(selection: string): string {
  const characters = Array.from(selection.replace(BIDI_CONTROLS, '').replace(/\s+/g, ' ').trim()); // by code point
  const shown =
    characters.length > MAX_SEARCH_LABEL_LENGTH
      ? `${characters.slice(0, MAX_SEARCH_LABEL_LENGTH).join('')}...`
      : characters.join('');
  return escapeLabel(`Search Google for "${shown}"`);
}

function linkItems({ linkURL }: MenuParams): MenuEntry[] {
  if (linkURL === '') return [];
  return [
    ...(isWebUrl(linkURL)
      ? [
          item('Open link in new tab', { type: 'open-link', url: linkURL }),
          item('Save link as…', { type: 'save-link', url: linkURL }),
        ]
      : []),
    item('Copy link address', { type: 'copy-text', text: linkURL }),
  ];
}

function imageItems({ mediaType, srcURL, hasImageContents }: MenuParams): MenuEntry[] {
  if (mediaType !== 'image' || srcURL === '') return [];
  return [
    ...(isWebUrl(srcURL)
      ? [
          item('Open image in new tab', { type: 'open-image', url: srcURL }),
          item('Save image as…', { type: 'save-image', url: srcURL }),
        ]
      : []),
    item('Copy image', { type: 'copy-image' }, hasImageContents),
    item('Copy image address', { type: 'copy-text', text: srcURL }),
  ];
}

function editItems({
  editFlags,
  misspelledWord,
  dictionarySuggestions,
}: MenuParams): MenuEntry[][] {
  const suggestions = dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
  const spelling: MenuEntry[] =
    misspelledWord === ''
      ? []
      : suggestions.length > 0
        ? suggestions.map((word) => item(escapeLabel(word), { type: 'replace-misspelling', word }))
        : [{ label: 'No suggestions', enabled: false, action: { type: 'inert' } }];
  const edit = (label: string, command: EditCommand, enabled: boolean) =>
    item(label, { type: 'edit', command }, enabled);
  return [
    spelling,
    [edit('Undo', 'undo', editFlags.canUndo), edit('Redo', 'redo', editFlags.canRedo)],
    [
      edit('Cut', 'cut', editFlags.canCut),
      edit('Copy', 'copy', editFlags.canCopy),
      edit('Paste', 'paste', editFlags.canPaste),
      edit('Paste as plain text', 'paste-plain', editFlags.canPaste),
    ],
    [edit('Select all', 'select-all', editFlags.canSelectAll)],
  ];
}

// Builds the page context menu from what was right-clicked. Only the groups that apply are
// included, separated from each other.
export function buildPageMenu(
  params: MenuParams,
  navigation: { canGoBack: boolean; canGoForward: boolean },
): MenuEntry[] {
  const selection = params.selectionText.trim();
  const groups: MenuEntry[][] = [linkItems(params), imageItems(params)];
  if (params.isEditable) {
    groups.push(...editItems(params));
  } else if (selection !== '') {
    groups.push([item('Copy', { type: 'edit', command: 'copy' }, params.editFlags.canCopy)]);
  }
  if (selection !== '') {
    groups.push([
      item(searchLabel(selection), {
        type: 'search',
        text: Array.from(selection).slice(0, MAX_SEARCH_LENGTH).join(''),
      }),
    ]);
  }
  const isPlainPage =
    params.linkURL === '' && params.mediaType !== 'image' && !params.isEditable && selection === '';
  if (isPlainPage) {
    groups.push([
      item('Back', { type: 'go', direction: 'back' }, navigation.canGoBack),
      item('Forward', { type: 'go', direction: 'forward' }, navigation.canGoForward),
      item('Reload', { type: 'go', direction: 'reload' }),
    ]);
  }
  groups.push([item('Inspect', { type: 'inspect' })]);

  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : ['separator' as const, ...group]));
}
