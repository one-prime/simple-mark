# @simple-mark/codemirror

A CodeMirror 6 Markdown editor that never hides syntax — part of
[SimpleMark](https://github.com/one-prime/simple-mark). `# Heading` stays `# Heading`: the
`#` is dimmed and the heading is large. The text is exactly what the user typed.

```ts
import { createEditor } from '@simple-mark/codemirror';

const view = createEditor(document.getElementById('editor')!, {
  doc: '# Hello **world**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
  onChange: (text) => save(text),        // in the document's own line endings
  resolveImage: (src) => new URL(src, base).href,
  openLink: (target) => open(target),     // { kind: 'web' | 'file' | 'image', url }
});
```

- **Tab** indents as in VS Code's text editor (spaces to the next tab stop, or the selected
  lines; `indentUnit` and `tabSize` options); Shift-Tab outdents; Ctrl-M lets Tab move the
  focus instead.
- **Tables**: Tab / Shift-Tab move between cells, Enter adds a row; each re-aligns the
  table. Korean, Chinese and Japanese line up (drawn exactly two columns wide), and typing
  them with an IME is safe.
- **Images** and `$$` math preview below their source; `$inline$` math in a tooltip. Math
  (`@simple-mark/math`) loads only when a document has math; when bundling, alias MathJax's
  `#default-font/*` as its README shows, so MathJax's default font isn't bundled.
- **Colors** in fenced code blocks, as VS Code's Markdown preview colors them
  (`@simple-mark/highlight`, highlight.js; each language loads when a block needs it), and
  in TeX: commands, brackets by nesting depth, an unmatched brace in red.
- **Links**: Ctrl+Click (⌘+Click on macOS) follows a link — a plain click keeps placing the
  cursor, since links are editable text. `#heading` links jump within the document; other
  schemes than http(s)/mailto are refused; web pages and paths go to `openLink` (default: a
  new browser tab). A click on an image preview opens the image.
- **Line endings** are kept (`\r\n`, `\r`), so an unedited file saves back byte for byte.
- Accurate scroll heights for documents with many images and formulas.
- `simpleMark(theme)` gives the extensions for your own `EditorState`.

MIT. Values copied from other projects are credited in `THIRD_PARTY_NOTICES.txt`.
