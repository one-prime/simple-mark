# SimpleMark — Design Notes

A WYSIWYG Markdown editor that **never hides Markdown syntax**. Formatting is a
visual layer over the raw text; the file on disk is exactly what you typed.

## Principles

1. **The Markdown text is the document.** The editor stores raw Markdown
   characters. Saving = writing the text. No Markdown→model→Markdown conversion.
2. **Nothing is ever hidden.** `#`, `**`, `` ` ``, `|`, `![](…)`, `$…$` all stay
   visible. Syntax markers are dimmed; the content they wrap is styled.
3. **Lossless round-trip.** Opening and saving an unedited file produces a
   byte-identical file (whitespace, `*` vs `_`, line endings, trailing newline).
4. **Rendered output is preview only.** Image and math renders are widgets that
   are not part of the document and never written to disk.

## Architecture

```
.md file ──load──▶ text ──Lezer (incremental)──▶ syntax tree ──model──▶ styled runs/blocks
                    ▲                                                     │
                    │ edits                                ┌──────────────┴──────────────┐
                 user input                          CM6 decorations              Canvas 2D drawing
                                                    (editor, VS Code)               (DrawLayout)
```

- **Editor engine:** CodeMirror 6.
- **Parser:** Lezer (`@lezer/markdown` with GFM) plus a small math extension.
- **Styling model:** one pure function from text to styled runs/blocks, shared
  by the CM6 editor and DrawLayout's canvas renderer so they never disagree.
- **Undo/redo:** in-memory editor history. Not written to the `.md` file.
  (Persisting history across restarts is optional, later, in app storage.)

## Markdown flavor

GFM (tables, task lists, strikethrough, autolinks) + math (`$…$`, `$$…$$`).

## Element display rules

| Element | Display |
|---|---|
| Headings, emphasis, code, quotes, lists, links | Markers dimmed, content styled |
| Tables | Raw pipe text, styled as a grid (see below) |
| Images | Source visible; rendered image widget below the line |
| Fenced code | Fences visible; code colored by its language (as VS Code's preview) |
| Block math `$$…$$` | Source visible, TeX colored; rendered math below the block |
| Inline math `$…$` | Source visible, TeX colored; rendered math in a tooltip on hover / cursor inside |

### Look

The default theme follows GitHub's Markdown styles (`github-markdown-css`, light); the VS Code
host follows VS Code's Markdown preview (`markdown-language-features/media/markdown.css` and
the webview's default styles) with the user's theme colors. Both are MIT and were read for the
values. Headings 2 / 1.5 / 1.25 / 1 / 0.875 / 0.85 em at weight 600, h1 and h2 with a line
under them; quotes with a 0.25em bar and 1em indent; code blocks with 1em indent and rounded
corners; inline code with a rounded background (the visible backticks stand in for GitHub's
padding); `---` with a bar across the line. All of it is drawn without changing any size —
inset shadows and backgrounds in the editor, rectangles on the canvas — so lines keep exactly
line height × font size, and the editor and the canvas still agree.

Corners and the line under a heading belong to the edges of a block: `resolveLineLook` takes
which blocks start and end on a line, so a setext heading gets its line under `===` and a code
block rounds only its fence lines. In the editor, inline code is one element around its spans
(backticks included) for the rounded background; on the canvas, neighbouring runs with the same
background are one box. Margins between blocks (GitHub's 16px) are not copied: they would add
height that is not in the text.

### Tables

- Monospace font inside table blocks so pipes line up.
- Header row bold, delimiter row dimmed, body rows with alternating background.
- Auto-align (Advanced Tables style) on **Tab / Enter**, not every keystroke:
  Tab → next cell + re-pad column, Enter → new row. Padding respects column
  alignment (`:--`, `--:`, `:-:`).
- Padding uses **display width**, not string length — CJK characters count as 2
  columns.

### Tab key

Tab works as in VS Code's text editor (`codemirror/src/tab-key.ts`): it inserts spaces up to
the next tab stop at the cursor, also mid-line (or a tab character when indenting with tabs),
and replaces a selection within a line; a selection across lines, or of whole lines, is
indented. Shift-Tab outdents. Tab stops count columns as VS Code does: a tab reaches the next
stop, a wide (CJK) character is two columns. Tables keep their Tab (next cell, higher
precedence). Ctrl-M (Shift-Alt-M on macOS) switches Tab to moving the focus, as in VS Code.
`createEditor` takes `indentUnit` (default four spaces) and `tabSize` (4); the VS Code host
passes the user's `editor.insertSpaces` and `editor.tabSize` for Markdown, read when the
document opens (indentation is not detected from the file, unlike VS Code's
`editor.detectIndentation`). Tab during IME composition waits for the commit, then runs the
editor's Tab binding, for tables and text alike.

### Math

- **MathJax with SVG output**: self-contained SVG (no fonts to load), so the same
  render works in the CM6 widget, on DrawLayout's canvas, and in its CLI render.
- On parse error, show the source marked with an error style instead of a broken
  widget.
- The TeX source is colored as VS Code colors it (`model/src/math-tokens.ts`, as inline
  styles, so the editor and the canvas agree): commands (`\frac`, `\{`) like keywords,
  `{}()[]` by nesting depth in three colors (bracket pair colorization), `%` comments. An
  unmatched brace is red — TeX needs braces balanced — but an unmatched `(` or `[` stays
  plain, since `[0, 1)` is valid math; `(` and `[` never pair across a brace. The VS Code host
  takes the bracket colors from the user's theme (`--vscode-editorBracketHighlight-*`) and
  the keyword/comment colors of the Markdown preview by theme kind (`--sm-*` in `html.ts`).

### Code blocks

- Colored with **highlight.js**, the highlighter of VS Code's Markdown preview
  (`markdown-language-features`: `hljs.highlight(code, { language, ignoreIllegals: true })`
  after its own renames such as `shell` → `sh`, `tsx` → `jsx`). So the same fence names find
  the same languages (193), the same text is colored, and unknown languages stay plain (no
  guessing), as in the preview. Lezer grammars were considered: incremental and already in
  the bundle for JS/CSS/HTML, but only ~20 full grammars; the rest are CodeMirror's stream
  modes, which would pull `@codemirror/language` into `model` and the canvas. Lezer still
  parses the Markdown and finds each block; highlight.js only colors its text.
- `@simple-mark/highlight` (no DOM) reads highlight.js's HTML back into ranges (the innermost
  colored scope wins; text must match the code exactly or the block stays plain) and maps its
  scopes to 15 `code*` inline styles, grouped as the preview's `highlight.css` colors them.
  `markdownStyles` takes the highlighter (`StyleSource.highlight`) and cuts the tokens around
  quote markers and list indentation, so the editor and the canvas color code alike.
- Each language is a lazy chunk (`src/languages.ts`, generated by `scripts/languages.mjs` with
  aliases and the languages it embeds: HTML loads CSS and JavaScript). A block is plain until
  its language loads; `createHighlighter(onReady)` then asks the host to draw again. Results
  are cached per language and text, so typing re-colors only the block being edited. The core
  adds 14.6 KB gzip to the VS Code webview.
- VS Code host: the preview's colors per theme kind (`--sm-*` in `html.ts`, dark = VS 2015,
  light = the preview's light rules); the default theme uses GitHub's syntax colors.

## Known pitfalls

- Context-sensitive constructs (setext headings, lazy continuation) mean an edit
  can change how neighboring blocks parse.
- Line wrapping in CM6 (browser) vs DrawLayout's canvas (`wrapText`) can differ
  slightly; keep fonts and line height identical.

## Packages and hosts

```
packages/
  model/       pure TS, no DOM: Lezer parse (GFM + math) → styled runs/blocks,
               table auto-align. Shared by every renderer.
  math/        pure TS, no DOM: TeX → self-contained SVG string (MathJax 4).
  highlight/   pure TS, no DOM: code block colors with highlight.js (lazy languages).
  codemirror/  CM6 editor + extensions, built on model
               createEditor(parent, { doc, onChange, resolveImage, theme, readOnly })
  vscode/      VS Code extension hosting the editor in a webview
(DrawLayout)   draws model output with Canvas 2D; mounts the CM6 editor to edit
```

### Publishing: `@simple-mark/*` on npm

Public on npm under the org `@simple-mark`: `@simple-mark/model`, `@simple-mark/math`,
`@simple-mark/highlight`, `@simple-mark/canvas`, `@simple-mark/codemirror`, all at the same
version (0.1.0 had no canvas; 0.2.0 adds it and moves preview detection into `model`; 0.3.7
adds highlight). The unscoped name
`simple-mark` was refused by npm as too similar to the existing `simplemark` package.

In the repo, each package exports its TypeScript source (the workspace, Vite and the tests
use it directly). `npm run release` (`scripts/release.mjs`) builds each with tsdown into
`packages/<name>/dist`, writes a publish-ready `package.json` there (exports to the built
files, `@simple-mark/*` dependencies at the current version, everything else external), copies
the package README and the license, and publishes in dependency order (model, math, highlight,
canvas, codemirror), skipping versions already on npm (a rerun after a partial release). `-- --pack` makes `.tgz` files in `dist/release`, `-- --dry-run` checks.
Side-effect imports are stripped from the `.d.ts` files: they carry no types and would pull
MathJax's own types, which fail strict checks, into users' type checking. Checked by
installing the three `.tgz` files into an empty project (TypeScript 5 strict with library
checks, Vite build, browser run with lazy math). npm publishing needs 2FA on the account.

### Licenses

Everything distributed carries the notices of what it contains, built from the build itself
(`scripts/third-party.mjs`), and the builds fail instead of shipping without them:

- **VS Code extension:** the webview bundles 22 packages (CodeMirror, Lezer and helpers: MIT;
  highlight.js: BSD-3-Clause; MathJax and its font: Apache-2.0). A Vite plugin lists every
  package in the bundle, lazy chunks included, and writes `THIRD_PARTY_NOTICES.txt` (packaged
  in the `.vsix`) with each full license text and Apache NOTICE files. A license outside MIT,
  ISC, 0BSD, BSD-2/3-Clause and Apache-2.0, or a package without license text, stops the build.
  The host build (esbuild) fails if it bundles any third-party code.
- **npm packages:** bundle no third-party code (a tsdown plugin fails the release if they
  would); dependencies install with their own licenses.
- **Design references:** values our code copies (github-markdown-css sizes and colors; VS
  Code's preview styles, bracket colors and fence-name renames; highlight.js's VS 2015 colors
  and language aliases) are credited with their licenses in each package's notices; the
  extension's notices credit those of every package of ours it bundles.
- Texts no installed package provides are kept verbatim in `licenses/`.

**Math font: Latin Modern.** MathJax's default font, `mathjax-newcm`, is labeled Apache-2.0
but ships no license file, and its source repository is not public. MathJax says it is based
on New Computer Modern, whose fonts are under the GUST Font License except, since NewCM
8.0.0, NewCM10-Regular, NewCMUncial and NewCM*Devanagari: GPL-3.0-or-later with a Font
Exception and a Distribution Exception that does not hold for a changed glyph set (which a
MathJax font is). Which NewCM version MathJax used is not stated. So math is drawn with
`mathjax-modern`, "a version of Latin-Modern": the font New Computer Modern grew from, so it
looks the same, and under the GUST Font License only (`licenses/LatinModern-License.txt`).
Also considered: KaTeX like VS Code's preview (MIT with license files, but HTML and web fonts,
no SVG for the canvas) and MathJax's TeX font, probably GitHub's (its license has been an
open MathJax issue, #1856, since 2017).

MathJax's SVG output imports its default font through the package import `#default-font/*`
whatever font it is given, so a bundle would still include New Computer Modern. Every Vite
config aliases that import to Latin Modern (`scripts/mathjax-font.mjs`); the strict notices
check is what found it. Hosts that bundle `@simple-mark/math` need the same alias.

### Links

Ctrl+Click (⌘+Click on macOS) follows a link; a plain click places the cursor, because link
text is editable (VS Code's convention). While the key is held, links show a pointer and an
underline; their title says how to open them. A click on an image preview opens the image.
`model` finds the link at a position (`linkAt`: links, images, reference links, autolinks,
bare URLs, definition URLs) and classifies its target (`linkKind`): `web` (http(s), mailto,
`www.`, e-mail), `anchor` (`#heading`, GitHub-style slugs from `headingAnchors`, Korean
kept), `file` (paths), `unsafe` (any other scheme — refused). The editor jumps to anchors
itself and hands the rest to the host's `openLink`: the browser default opens a new tab
(paths resolved like images); VS Code opens web pages with `openExternal` and paths with
`vscode.open` relative to the document, so images open in its image viewer and `.md` files in
SimpleMark. DrawLayout will choose its own behavior.

A path starting with `/` is an absolute path on disk if that file exists, else relative to the
workspace folder (VS Code's Markdown preview convention) — for drawing and for opening alike.
So an `ImageResolver` may return several URLs to try in order; a preview moves to the next one
when an image fails to load (the first failure shows up as one 404 in the console).

A host that loads files itself (DrawLayout reads them from the project folder) may not have a
URL yet when the editor asks: the resolver returns `undefined`, the preview says "Loading …",
and the host calls `refreshImages(view)` when files have loaded. Before, such an image showed
"Can't load" for the rest of the edit.

### Canvas: `@simple-mark/canvas`

`layoutMarkdown(text, options)` (no DOM; widths from the host's `measure`) turns text into
positioned runs, line decorations and image/math boxes with the editor's styling;
`paintMarkdown(ctx, layout, sources)` draws it with Canvas 2D; `createMathImages` makes
MathJax SVGs drawable in the text's color and sizes them by the font's real x-height.
Wrapping breaks between words and anywhere between CJK characters, like the browser; table
lines are laid out on a column grid (wide characters exactly two columns). Editor sizes
(preview padding, image max height, quote bar) are converted to em so a canvas text at any
font size matches the editor at 15px. What gets previewed below which line
(`previewBlocks`, `mathSource`) lives in `model` and is shared with the editor.
Side-by-side check (`npm run dev -w @simple-mark/canvas`, with New Computer Modern): formula
212.7×50.2 vs 214.3×50.5 px, total vertical drift 1.6 px over 936 px.

Every line is exactly line height × font size, and all runs on a line share the baseline of
the line's own font (`TextRun.lineFont`). The editor keeps to that: a browser grows a line
to fit inline text in another font (inline code), so such spans get `line-height: 0`, and
the 1em `cm-widgetBuffer` image CodeMirror puts after the height-hint widget is aligned to
the line's top (on the baseline it stuck out above headings at line height 1.25). Before,
DrawLayout's editing overlay drifted 3–4 px below the canvas text further down a block.

### VS Code

- `CustomTextEditorProvider` + webview running the editor.
- VS Code `TextDocument` is the source of truth; webview edits → `WorkspaceEdit`,
  external changes → pushed to webview.
- VS Code owns undo/redo (CM6 history disabled in this host).
- Focus: VS Code gives a webview the focus back (Ctrl+1, switching tabs) by focusing its
  window only (`contentWindow.focus()` in its webview host page), so the body had it and
  typing went nowhere. On the window's `focus` the editor takes it, with its cursor where it
  was, as VS Code's text editor does. Smoke test: the page in an iframe, refocused that way.
- Images resolved via `webview.asWebviewUri()`; theme from `--vscode-*` CSS vars.
- Positions travel as line/character, never offsets: CodeMirror counts `\r\n`
  as one character, VS Code as two. The host sends the document's EOL and the
  editor uses it (also for new, empty files).
- Echo and races: the host doesn't echo changes while applying the webview's
  edit; the webview ignores host updates while its own edits are unacknowledged
  and asks for the full text afterwards; host text is merged as one minimal
  change (never splitting `\r\n` or surrogate pairs).
- Layout for a later repo split: `src/extension.ts` (host, esbuild → CJS),
  `src/webview/` (Vite, lazy MathJax chunks), `src/html.ts` / `protocol.ts` /
  `sync.ts` (no VS Code or DOM, shared and testable). Its only tie to this repo
  is the `@simple-mark/codemirror` / `@simple-mark/model` dependency.

### DrawLayout (Markdown text)

DrawLayout (`../DrawLayout`) renders with **Canvas 2D**; text is edited in a
`<textarea>` overlay (`CanvasTextEditor.tsx`). `drawlayout render` (CLI) and the
PNG copy use the same renderer, so Markdown must be drawn on the canvas — a DOM
overlay layer would be missing from both and break z-order.

- **Display:** Canvas 2D draws `model` output. Because syntax is never hidden,
  this is only styled text runs (font, size, weight, color), line backgrounds
  (code blocks, tables), and image/math bitmaps — no HTML layout engine needed.
  Tables are monospace text, so they draw as plain lines.
- **Editing own text:** the CM6 editor replaces the textarea for Markdown text,
  using the same overlay transform and the same draft → commit/cancel lifecycle
  (one DrawLayout undo step per edit session; CM6 history inside the session).
- **File-backed text (`file: "notes/x.md"`) stays read-only on the canvas**, as
  all file-backed text is today. Edit the `.md` file in VS Code with SimpleMark.

- **Data model:** Markdown is the existing `TEXT` node plus an optional
  `textFormat: "plain" | "markdown"` property — not a new node type, so every
  `TEXT` feature (fonts, auto-size, `file`/`key`, overrides) keeps working and
  readers that don't know Markdown still show the text. Rule: `textFormat` set →
  use it; otherwise a `file` ending in `.md`/`.markdown` → markdown; otherwise
  plain.

## Milestones

1. ✅ `model` (parse → block ranges + flat styled spans, theme, look resolution)
   and `codemirror` (decorations, line-ending preservation) with a demo page
   (`npm run dev` → http://localhost:5180).
2. ✅ Tables: Tab / Shift-Tab between cells, Enter adds a row (on an empty last
   row: leaves the table), each re-aligning the table as one undo step; padding
   by display width; alternating rows; font-independent alignment of wide
   characters.
3. ✅ Images and math: `$…$` / `$$…$$` syntax (Pandoc rules) in `model`;
   `packages/math` renders TeX to SVG (MathJax 4, no DOM); previews of images
   and `$$` blocks below their lines, inline math in a tooltip (cursor inside or
   hover); errors shown as text; hosts resolve image paths (`resolveImage`).
4. ✅ VS Code extension (`packages/vscode`, built to move to its own repo later):
   custom text editor for `*.md` / `*.markdown`, the default editor for them
   (manifest `priority: "default"`; "Open as Text" switches back); webview
   synced with the TextDocument; VS Code theme colors; images from the
   document's folder/workspace/https. Checked: unit tests, the built webview in
   Chromium under the extension's own CSP with a fake host (`npm run smoke`), a
   packaged `.vsix`, activation against a stub `vscode`. Not yet checked inside
   real VS Code.
5. DrawLayout: `textFormat`, canvas drawing of `model` output, CM6 editing overlay.

## Findings

- CodeMirror joins lines with `\n` in `doc.toString()` even with a `\r\n`
  separator; always read text back with `state.sliceDoc()`.
- Fonts can't be trusted to draw CJK exactly two columns wide: a Latin-only
  monospace font falls back to a CJK font of another width, and even Noto Sans
  Mono CJK KR draws Hangul syllables 0.92 em (ideographs and kana 1.0 em). The
  editor measures the theme's monospace font once; if CJK doesn't fit two
  columns, runs of wide characters in table lines are drawn as inline boxes of
  exactly `2ch` per character. Checked in Chromium and Firefox with the default
  font and with DejaVu Sans Mono (Latin-only): pipes line up within 0.1 px.
  Korean IME composition inside those boxes was checked with Chromium's IME
  emulation, not yet with a real IME. The canvas renderer should do the same:
  draw each wide character centered in two columns.
- IME (Korean): while a syllable is still being composed, CodeMirror skips its
  keymaps, so Enter/Tab never reach the table commands. The browser then
  inserts a raw line break itself (sometimes before the composing syllable,
  splitting the row), and Tab moves focus out of the editor. Fixes: any typed
  line break inside a table (not paste/drop) is turned into "add a row below"
  with the typed text kept in its cell; Tab during composition is taken in the
  capture phase and runs after the IME commits (now for indentation outside tables too).
  Reproduced and verified with Chromium's IME emulation (a smoke test check).
- With a real IME (ibus, Korean), a syllable typed in a table landed on a stray
  line of its own — without any Enter. Likely cause: the wide-character boxes
  wrapped the text while it was being composed, changing the DOM under the IME.
  So the boxes are never drawn on a line holding a cursor; that row is aligned
  again as soon as the cursor leaves it (it isn't re-padded before Tab/Enter
  anyway). Rule for future decorations: never change DOM structure (wrappers,
  inline boxes) on the cursor's line; classes and styles are fine.
- GFM reads a text line directly below a table as another row, so leaving a
  table needs a blank line in between.
- Lezer puts a quoted table's `>` markers inside the Table node, between rows.
- Math syntax follows Pandoc: `$` opens only before a non-space, closes only
  after a non-space and not before a digit (`$5 and $10` stays text); `\$` never
  counts; a `$$` line ends a paragraph like a code fence. The block parser uses
  Lezer's untyped `line.depth` (as Lezer's own fenced code does) to stop at the
  end of a quote or list; tests cover it.
- MathJax 4 notes: inline formulas are split into several `<svg>`s at `=` unless
  `linebreaks: { inline: false }`; `TexError` is not an `Error` subclass; rare
  glyph ranges load font parts on demand, so `packages/math/src/fonts.ts` maps
  each of the 26 parts of the Latin Modern font to a static `import()` (bundlers make
  lazy chunks of them). The list matches font 4.1.3, so `@mathjax/src` is pinned to 4.1.3.
- Untrusted documents: the TeX packages `html`, `texhtml`, `textmacros`,
  `require` and `autoload` are left out (`\href`, `\style`, raw HTML, loading
  code). Image previews load whatever URL a document names — hosts should limit
  that (VS Code: webview CSP / `localResourceRoots`).
- Bundle (demo build): editor 516 KB (176 KB gzip) without MathJax; MathJax and
  its main font load on first math, 1.3 MB (468 KB gzip). Follow-up: the editor
  chunk includes HTML/CSS/JS parsers that `@codemirror/lang-markdown` uses for
  inline HTML; a lighter `htmlTagLanguage` could cut it.
- Block previews are recomputed from the whole syntax tree on each change; fine
  for normal documents, a candidate for incremental updates later.
- Scrollbar drift: CodeMirror draws only what is on screen and estimates the
  rest; a widget without `estimatedHeight` counts as one line. A test document
  with 40 images and formulas was estimated at 15.5k px instead of 34.9k, and a
  fast scrollbar drag left the thumb up to 34 px from the mouse (only the first
  time through; measured parts were right). `preview-heights.ts` now reads image
  sizes and renders formulas in the background, remembers measured heights, and
  refreshes estimates without redrawing visible previews (`updateDOM`): estimate
  33.7k px, worst gap 2 px. Demo: `?long`.
- Same drift on the first pass while images load (many distinct images, slow
  connection): a drawn `<img>` has no height until its pixels arrive, so
  CodeMirror measured empty previews (74 of them at 1 MB/s; gap up to 19 px).
  Now image sizes are read from the first bytes (checked every frame while
  loading, not on `load`), an `<img>` gets its final box (width + aspect-ratio)
  before its pixels arrive, and previews whose size is still unknown (and math
  not yet rendered) hold their estimated height. Result at 1 MB/s and 300 KB/s:
  0–1 empty previews, worst gap 1 px. Test: different URL per image in `?long`,
  throttled with Chromium DevTools protocol, cache off, scroll right away.
- Text lines: CodeMirror estimates a line as characters ÷ characters-per-line,
  measured on Latin text, so headings (bigger font) and Korean (twice as wide)
  came out short — a Korean paragraph drawn on 2 lines was estimated at 1.
  `line-heights.ts` puts an invisible widget with `estimatedHeight` (text width
  in the real font, wrapped at the editor width) on headings and long lines;
  CodeMirror uses the larger of that and its own guess for undrawn lines. Not on
  cursor lines, never redrawn. Result: English and Korean estimates exact.
- CodeMirror learns the normal line height from the first short plain-text line
  on screen — a setext heading's text line qualified and made every estimate
  1.4× too tall. Heading text lines now get a mark span (CodeMirror skips lines
  with spans), and our estimates read the line height from CSS instead.
- Setext heading text lines are estimated at the normal font size (the hint
  only recognises `#` headings); rare, small error.
- First fast drag in a real Chrome (user's report, `?long&debug`): scroll events
  arrived only every 30–60 ms while new images were drawn. Image previews now
  use `decoding="async"`; the next report showed 17 ms frames, no long frames,
  and heights within 0.2% (33,914 → 33,840 px).
- **Known issue:** on the very first fast drag through `?long` (80 large images)
  the user still sees the thumb and content not matching the mouse; the second
  drag is fine. Measurements in the user's Chrome (heights, frame timing) look
  right, and headless tests can't drag a real scrollbar, so the cause isn't
  pinned down — likely the browser downloading/drawing never-seen images. Left
  open; revisit if it shows in real documents (a screen recording would help).
  Debug tooling: demo `?debug` posts a report to the dev server
  (`<tmp>/simple-mark-debug-report.json`).
- Dev server: changing dependencies while `npm run dev` runs can leave two
  copies of `@codemirror/view` loaded (keymaps silently ignored). Restart it,
  deleting `packages/codemirror/node_modules/.vite`.
