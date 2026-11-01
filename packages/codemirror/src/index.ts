import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { indentUnit } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import { defaultTheme, markdownExtensions, type Theme } from '@simple-mark/model';
import { markdownDecorations, markdownTheme } from './decorations';
import { keepLineSeparator } from './line-separator';
import { linkOpener, links, type LinkOpener } from './links';
import { imageResolver, previews, type ImageResolver } from './previews';
import { tabKey } from './tab-key';
import { tableEditing } from './table-commands';

export { lookCss, markdownDecorations, markdownTheme } from './decorations';
export { keepLineSeparator } from './line-separator';
export { followLink, linkOpener, links, type LinkOpener, type LinkTarget } from './links';
export { imageResolver, previews, refreshImages, type ImageResolver } from './previews';
export { insertIndent, removeIndent, tabKey } from './tab-key';
export { insertRowBelow, nextCell, previousCell, tableEditing } from './table-commands';

/** The SimpleMark language and styling, for hosts that build their own EditorState. */
export function simpleMark(theme: Theme = defaultTheme): Extension {
  return [
    // Before markdown(): its Enter (continue list/quote markup) has the same precedence.
    tableEditing(),
    tabKey(),
    markdown({ base: commonmarkLanguage, extensions: markdownExtensions, completeHTMLTags: false }),
    markdownTheme.of(theme),
    markdownDecorations,
    previews(),
    links(),
    EditorView.theme({
      '&': { color: theme.color },
      '.cm-scroller': { fontFamily: theme.fontFamily, lineHeight: '1.6' },
    }),
  ];
}

export interface EditorOptions {
  doc?: string;
  readOnly?: boolean;
  theme?: Theme;
  /** Line ending to read and write ("\n", "\r\n"); by default the one `doc` uses. */
  lineSeparator?: string;
  /** What Tab inserts and indents by: spaces (default four, as VS Code) or "\t". */
  indentUnit?: string;
  /** Columns a tab character spans (default 4). */
  tabSize?: number;
  /**
   * Turns an image path from the document into a URL to load (default: as written). Return
   * undefined while the file is still loading, and call `refreshImages(view)` when it has.
   */
  resolveImage?: ImageResolver;
  /**
   * Opens a followed link (Ctrl/Cmd+Click) or a clicked image preview. Default: web addresses
   * and paths (resolved like images) in a new browser tab.
   */
  openLink?: LinkOpener;
  /** Off when the host owns undo (VS Code). */
  history?: boolean;
  /** Called after every change with the full text, in the original line endings. */
  onChange?: (text: string, update: ViewUpdate) => void;
  extensions?: Extension[];
}

/** A Markdown editor in `parent`. The text is kept exactly as given, line endings included. */
export function createEditor(parent: HTMLElement, options: EditorOptions = {}): EditorView {
  const { doc = '', readOnly = false, theme = defaultTheme, resolveImage, openLink, onChange, extensions = [] } = options;
  const useHistory = options.history ?? true;
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        options.lineSeparator ? EditorState.lineSeparator.of(options.lineSeparator) : keepLineSeparator(doc),
        useHistory ? history() : [],
        keymap.of([...defaultKeymap, ...(useHistory ? historyKeymap : [])]),
        EditorView.lineWrapping,
        indentUnit.of(options.indentUnit ?? '    '),
        EditorState.tabSize.of(options.tabSize ?? 4),
        simpleMark(theme),
        resolveImage ? imageResolver.of(resolveImage) : [],
        openLink ? linkOpener.of(openLink) : [],
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        onChange ? EditorView.updateListener.of((update) => update.docChanged && onChange(update.state.sliceDoc(), update)) : [],
        extensions,
      ],
    }),
  });
}
