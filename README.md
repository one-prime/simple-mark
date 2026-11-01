# Simple-Mark

Edit Markdown with its formatting shown and its syntax still visible.

`# Heading` keeps its `#` while the heading appears larger. `**bold**` keeps its markers
while the text appears bold. Images and math render alongside their source, and tables can
be edited with the keyboard.

This repository contains the VS Code extension and the TypeScript libraries behind it.

- **Use it in VS Code:** see the [extension README](packages/vscode/README.md) for
  installation, features, and settings.
- **Embed an editor:** start with [@simple-mark/codemirror](packages/codemirror/README.md).
- **Try it locally:** run the browser demo using the instructions below.

## Features

- Markdown headings, emphasis, lists, quotes, and links styled without hiding their syntax.
- Syntax highlighting in fenced code blocks and TeX formulas.
- Inline math tooltips and block math previews, rendered with MathJax.
- Image previews below their Markdown source.
- Keyboard navigation and alignment for tables, including Korean, Chinese, and Japanese text.
- Shared parsing, themes, and rendering utilities for browser and canvas applications.

## Packages

| Package | Purpose |
| --- | --- |
| [@simple-mark/codemirror](packages/codemirror/README.md) | CodeMirror 6 editor and extensions |
| [@simple-mark/model](packages/model/README.md) | Markdown parsing, styled ranges, themes, and table utilities |
| [@simple-mark/math](packages/math/README.md) | TeX-to-SVG rendering with MathJax |
| [@simple-mark/highlight](packages/highlight/README.md) | Code highlighting with languages loaded on demand |
| [@simple-mark/canvas](packages/canvas/README.md) | Markdown layout and drawing on a canvas |
| [VS Code extension](packages/vscode/README.md) | Markdown editing integrated with VS Code |

The packages use npm workspaces, so local development links them together. The extension
has its own version and VSIX packaging command; library releases use a separate command.

## Use the editor in an application

```bash
npm install @simple-mark/codemirror
```

Given an HTML element such as `<div id="editor"></div>`:

```ts
import { createEditor } from '@simple-mark/codemirror';

const view = createEditor(document.getElementById('editor')!, {
  doc: '# Hello **world**\n',
  onChange: (text) => console.log(text),
});

// When the editor is no longer needed:
// view.destroy();
```

See the [editor options](packages/codemirror/README.md) for image and link handling.
When bundling the editor, configure the [MathJax font alias](packages/math/README.md)
so it uses the intended font.

## Develop locally

Use Node.js 24 or newer and npm. Run these commands from the repository root:

```bash
git clone https://github.com/one-prime/simple-mark.git
cd simple-mark
npm ci
npm run dev
```

Open <http://localhost:5180> to try the browser editor demo.

Run the project checks with:

```bash
npm run typecheck
npm test
```

See [DESIGN.md](DESIGN.md) for the editor's design and architecture.

## Build the VS Code extension

From the repository root, after installing dependencies:

```bash
npm run package -w packages/vscode
```

This builds the extension and produces `packages/vscode/simple-mark-<version>.vsix`.
In VS Code, run **Extensions: Install from VSIX…** from the Command Palette and select
the generated file. See the [extension README](packages/vscode/README.md) for usage and
additional development checks.

## Package the libraries

To build the reusable packages and create npm tarballs locally:

```bash
npm run release -- --pack
```

The tarballs are written to `dist/release/`. This command does not publish to npm.
The [release script](scripts/release.mjs) documents dry-run and publishing options.

## Feedback and contributions

Report bugs and feature requests in [GitHub Issues](https://github.com/one-prime/simple-mark/issues).
For extension issues, include your VS Code version and a small Markdown example that
reproduces the problem. For library issues, include the package name and version.

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses. See
[licenses/README.md](licenses/README.md) and the generated `THIRD_PARTY_NOTICES.txt`
files for license texts and credits.
