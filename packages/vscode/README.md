# Simple-Mark for VS Code

Edit Markdown with its formatting shown — and none of its syntax hidden.

`# Heading` stays `# Heading`: the `#` is dimmed and the heading is large. `**bold**` keeps
its `**`. Markdown stays editable text, and an unedited document keeps its original line
endings. Table navigation can reformat table spacing as described below.

## Installation

Requires **VS Code 1.100.0 or newer**.

### From the Marketplace

Open Extensions in VS Code and search for `@id:Simple-Mark.simple-mark`, or visit the
[Simple-Mark Marketplace listing](https://marketplace.visualstudio.com/items?itemName=Simple-Mark.simple-mark).
Select **Install**, then open a Markdown file.

### From a VSIX file

If you have a `simple-mark-<version>.vsix` file, open the Command Palette, run
**Extensions: Install from VSIX…**, and select it. To build a VSIX yourself, see
[Building from source](#building-from-source).

## Features

- Headings, emphasis, code, quotes, lists and links styled in place, markers dimmed.
- **Tab** indents as in VS Code's text editor, by your `editor.tabSize` and
  `editor.insertSpaces` for Markdown; Shift+Tab outdents. Ctrl+M switches Tab to moving the
  focus.
- **Tables**: Tab / Shift-Tab move between cells, Enter adds a row; each re-aligns the
  table. Korean and other wide characters line up.
- **Math**: `$inline$` shows a rendered tooltip, `$$` blocks render below their source
  (MathJax). The TeX is colored: commands, brackets in your bracket pair colors, an unmatched
  brace in red.
- **Code blocks** are colored by their language, as in VS Code's Markdown preview
  (highlight.js, 190+ languages).
- **Images** preview below their line; paths are relative to the document (see Links for
  paths starting with `/`).
- **Links**: Ctrl+Click (⌘+Click on macOS) opens a link: web pages in your browser (VS Code
  asks first), `#heading` links jump within the document, and paths open in VS Code — images
  in its image viewer, Markdown files in Simple-Mark. Paths are relative to the document. A
  path starting with `/` is an absolute path on disk, or else relative to the workspace folder
  (as in VS Code's own Markdown preview); images are found the same way. Click an image
  preview to open the image.
- Follows your color theme, styled like VS Code's Markdown preview. Saving, undo/redo and git work as with any text editor.

## Usage

Simple-Mark is the default editor for `.md` and `.markdown` files: open one and it opens in
Simple-Mark.

- **Open as Text** in the editor title bar (or **Reopen Editor With… → Text Editor**)
  shows the plain text.
- **Open with Simple-Mark** in the title bar or the Explorer context menu switches back.

To keep the plain text editor as your default instead, add to your settings:

```json
{
  "workbench.editorAssociations": {
    "*.md": "default",
    "*.markdown": "default"
  }
}
```

## Korean, Chinese and Japanese text in tables

Tables are padded counting each Korean, Chinese or Japanese character as two columns
(Unicode East Asian Width, the same rule Prettier uses), so the saved text is aligned.
Simple-Mark draws these characters exactly two columns wide, so its tables line up with any
font.

VS Code's plain text editor relies on its font instead. Unless the font draws these
characters exactly twice as wide as Latin letters, pipes after such text land too far left
there. To see tables aligned in the text editor too, use such a font, for example
[D2Coding](https://github.com/naver/d2codingfont) (Ubuntu: `sudo apt install fonts-naver-d2coding`):

```json
"editor.fontFamily": "'D2Coding', monospace"
```

This setting applies to every file. Noto Sans Mono CJK KR comes close but not exactly: its
Hangul is 1.84 columns wide, so a row with about six Korean characters ends one column short.

> **Warning:** Quit and restart VS Code completely after installing a font. VS Code runs on
> Chromium, which reads the list of installed fonts when it starts; "Reload Window" may not
> be enough. Until then, VS Code silently falls back to another font and the setting seems
> to have no effect.

## Notes

- Images load from the document's folder, the workspace and `https:` URLs only.
- Math supports common TeX packages; commands that create links or HTML (`\href`,
  `\style`) are not available.

## Source and feedback

The extension is maintained in the
[Simple-Mark repository](https://github.com/one-prime/simple-mark), alongside the editor
libraries it uses. Its source is in
[`packages/vscode`](https://github.com/one-prime/simple-mark/tree/main/packages/vscode).

[Report a bug or request a feature](https://github.com/one-prime/simple-mark/issues).
For bugs, include your VS Code version, operating system, and a small Markdown example
that reproduces the issue.

## Building from source

Use Node.js 24 or newer and npm. Clone the full repository so the extension can use the
shared workspace packages and build scripts:

```bash
git clone https://github.com/one-prime/simple-mark.git
cd simple-mark
npm ci
npm run package -w packages/vscode
```

The package command builds the extension and writes
`packages/vscode/simple-mark-<version>.vsix`. Install it using **Extensions: Install from
VSIX…** in VS Code.

From the repository root, run type checks and tests with:

```bash
npm run typecheck
npm test
```

For the webview smoke check, first build the extension with
`npm run build -w packages/vscode`, then run `npm run smoke -w packages/vscode`.
The smoke check requires Chromium in Playwright's cache or a `CHROMIUM_PATH` environment
variable pointing to a Chromium executable.

## License

MIT. The extension includes CodeMirror, Lezer, MathJax (with its font) and highlight.js, each
under its own license; `THIRD_PARTY_NOTICES.txt` in the extension has their full license
texts, along with credits for the styles of VS Code's Markdown preview it follows.
