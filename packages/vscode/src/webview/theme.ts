// Colors from the user's VS Code theme (CSS variables VS Code sets in every webview), so the
// editor follows light, dark and high-contrast themes and theme switches. Styled like VS Code's
// own Markdown preview (extensions/markdown-language-features/media/markdown.css and the
// webview's default styles): quotes with a background, rounded code, lines under h1 and h2.

import { EditorView } from '@codemirror/view';
import { defaultTheme, type Theme } from '@simple-mark/model';

const dim = 'var(--vscode-descriptionForeground)';
const codeBackground = 'var(--vscode-textCodeBlock-background)';
// The preview's borders: black or white at 18%, i.e. the text color at 18%.
const separator = 'color-mix(in srgb, var(--vscode-editor-foreground) 18%, transparent)';

export const vscodeTheme: Theme = {
  ...defaultTheme,
  fontFamily: 'var(--vscode-font-family)',
  // Kept as font names: the editor measures this font to align Korean in tables.
  monospaceFamily: defaultTheme.monospaceFamily,
  color: 'var(--vscode-editor-foreground)',
  block: {
    ...defaultTheme.block,
    quote: { color: dim, borderLeft: 'var(--vscode-textBlockQuote-border)', lineBackground: 'var(--vscode-textBlockQuote-background)', indent: 1 },
    codeblock: { monospace: true, lineBackground: codeBackground, lineRadius: 3 / 14, indent: 1 },
    mathblock: { monospace: true },
    tableRowAlt: { lineBackground: 'color-mix(in srgb, var(--vscode-editor-foreground) 5%, transparent)' },
    hr: { rule: separator },
    h1: { ...defaultTheme.block.h1, borderBottom: separator },
    h2: { ...defaultTheme.block.h2, borderBottom: separator },
    h6: { ...defaultTheme.block.h6, color: dim },
  },
  inline: {
    ...defaultTheme.inline,
    link: { color: 'var(--vscode-textLink-foreground)' },
    code: {
      monospace: true,
      color: 'var(--vscode-textPreformat-foreground)',
      background: `var(--vscode-textPreformat-background, ${codeBackground})`,
      radius: 4 / 14,
    },
    math: { monospace: true },
    // TeX as VS Code colors it: commands like keywords (--sm-* are the preview's token colors,
    // set per theme kind in html.ts), brackets in the user's bracket pair colors.
    mathCommand: { color: 'var(--sm-keyword)' },
    mathComment: { color: 'var(--sm-comment)', italic: true },
    mathBracket1: { color: 'var(--vscode-editorBracketHighlight-foreground1, #ffd700)' },
    mathBracket2: { color: 'var(--vscode-editorBracketHighlight-foreground2, #da70d6)' },
    mathBracket3: { color: 'var(--vscode-editorBracketHighlight-foreground3, #179fff)' },
    mathBracketError: { color: 'var(--vscode-editorBracketHighlight-unexpectedBracket-foreground, #ff1212cc)' },
    // Code blocks in the preview's colors (highlight.css); comments are italic there too.
    codeKeyword: { color: 'var(--sm-keyword)' },
    codeLiteral: { color: 'var(--sm-literal)' },
    codeType: { color: 'var(--sm-type)' },
    codeNumber: { color: 'var(--sm-number)' },
    codeString: { color: 'var(--sm-string)' },
    codeComment: { color: 'var(--sm-comment)', italic: true },
    codeTitle: { color: 'var(--sm-title)' },
    codeMeta: { color: 'var(--sm-meta)' },
    codeVariable: { color: 'var(--sm-variable)' },
    codeAttr: { color: 'var(--sm-attr)' },
    codeTag: { color: 'var(--sm-tag)' },
    codeSection: { color: 'var(--sm-section)' },
    codeSelector: { color: 'var(--sm-selector)' },
    codeAddition: { color: 'rgb(155, 185, 85)', background: 'var(--vscode-diffEditor-insertedTextBackground, rgba(155, 185, 85, 0.2))' },
    codeDeletion: { color: 'rgb(255, 0, 0)', background: 'var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.2))' },
    url: { color: dim, underline: true },
    mark: { ...defaultTheme.inline.mark, color: dim },
  },
};

/** Editor chrome (background, cursor, selection, tooltips) in the theme's colors. */
export const vscodeChrome = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--vscode-editor-font-size)', backgroundColor: 'var(--vscode-editor-background)' },
  '.cm-scroller': { overflow: 'auto' },
  // The preview's spacing: the full width, less 26px of padding on both html and body.
  '.cm-content': { padding: '1em 52px', caretColor: 'var(--vscode-editorCursor-foreground)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--vscode-editor-selectionBackground)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--vscode-editorHoverWidget-background)',
    color: 'var(--vscode-editorHoverWidget-foreground)',
    border: '1px solid var(--vscode-editorHoverWidget-border)',
  },
  '.sm-image-error, .sm-math-error': { color: 'var(--vscode-errorForeground)' },
});
