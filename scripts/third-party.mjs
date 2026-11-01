// Third-party notices for everything SimpleMark distributes, built from what is actually in
// each build so they can't drift. Strict: a bundled package with a license not allowed below,
// or whose license text can't be found, stops the build instead of shipping without notice.
//
// - The VS Code extension bundles its dependencies: `noticesPlugin` (Vite) lists every package
//   in the bundle, lazy chunks included, with its full license text.
// - The npm packages bundle none (`noBundledPackages` checks); their dependencies come with
//   their own licenses. Their notices hold only the design references below.
// - Design references: values our own code copies from MIT-licensed styles (colors, sizes, a
//   few renames). Likely not copyrightable on their own, but credited with their licenses.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const text = (path) => readFileSync(join(root, path), 'utf8').trim();

/** Licenses that allow bundling into the MIT-licensed extension, given these notices. */
const ALLOWED = new Set(['MIT', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0']);

/** Packages whose own files don't hold everything the notice needs; checked by hand. */
const OVERRIDES = {
  '@mathjax/src': {
    // The LICENSE file is the bare Apache 2.0 text; the copyright is in the source headers.
    copyright: 'Copyright (c) 2017-2026 The MathJax Consortium',
  },
  '@mathjax/mathjax-modern-font': {
    copyright: 'Copyright (c) The MathJax Consortium',
    // Labeled Apache-2.0 in package.json, but the package ships no license file.
    licenseFile: 'node_modules/@mathjax/src/LICENSE',
    note: [
      'MathJax labels this package Apache-2.0 but ships no license file; the Apache License 2.0',
      'text above is the one of MathJax itself (@mathjax/src). MathJax states that the font is "a',
      'version of Latin-Modern". The Latin Modern fonts (https://www.gust.org.pl/projects/e-foundry/latin-modern)',
      'are distributed under the GUST Font License, an instance of the LaTeX Project Public',
      'License 1.3c. Their copyright notices and license texts follow.',
    ].join('\n'),
    extra: ['licenses/LatinModern-License.txt', 'licenses/GUST-FONT-LICENSE.txt', 'licenses/LPPL-1.3c.txt'],
  },
};

/** Styles our code copies values from, by key. */
const DESIGN_SOURCES = {
  githubMarkdownCss: { name: 'github-markdown-css', url: 'https://github.com/sindresorhus/github-markdown-css', license: 'MIT', file: 'licenses/github-markdown-css.txt' },
  vscode: { name: 'Visual Studio Code (Code - OSS)', url: 'https://github.com/microsoft/vscode', license: 'MIT', file: 'licenses/vscode.txt' },
  highlightjs: { name: 'highlight.js', url: 'https://github.com/highlightjs/highlight.js', license: 'BSD-3-Clause', file: 'node_modules/highlight.js/LICENSE' },
  highlightjsStyles: { name: 'highlight.js, style "VS 2015" (Nicolas LLOBERA)', url: 'https://github.com/highlightjs/highlight.js', license: 'BSD-3-Clause', file: 'node_modules/highlight.js/LICENSE' },
};

/** What each distributed package copies, by design source. */
export const DESIGN = {
  model: {
    githubMarkdownCss: 'Sizes and colors of the default theme, its syntax colors included (src/theme.ts).',
    vscode: "Default bracket pair colors of VS Code's light theme, for TeX (src/theme.ts).",
  },
  canvas: { githubMarkdownCss: 'Text, marker and error colors (src/layout.ts, src/paint.ts).' },
  codemirror: { githubMarkdownCss: 'Error and loading message colors (src/previews.ts).' },
  highlight: {
    vscode: "The Markdown preview's fence-name renames and its grouping of highlight.js scopes by color (src/index.ts).",
    highlightjs: 'Language names and aliases, generated from its language definitions (src/languages.ts).',
  },
  vscode: {
    vscode:
      "Styles of the Markdown preview (markdown-language-features/media/markdown.css and highlight.css): spacing, borders, token colors; default bracket pair colors (src/html.ts, src/webview/theme.ts).",
    highlightjsStyles: "Dark token colors, via the preview's highlight.css, which is the VS 2015 style (src/html.ts).",
  },
};

const RULE = '='.repeat(78);

/** Credits for the values our packages (`packages/<name>`) copy, merged by source. */
function designSection(names) {
  const uses = new Map();
  for (const name of names) for (const [key, what] of Object.entries(DESIGN[name] ?? {})) uses.set(key, [...(uses.get(key) ?? []), `- ${name}: ${what}`]);
  if (!uses.size) return '';
  const parts = [...uses].map(([key, lines]) => {
    const source = DESIGN_SOURCES[key];
    return `${source.name} (${source.license})\n${source.url}\nUsed for:\n${lines.join('\n')}\n\n${text(source.file)}`;
  });
  return `${RULE}\nDESIGN REFERENCES: values copied into this code\n${RULE}\n\n${parts.join(`\n\n${'-'.repeat(78)}\n\n`)}\n`;
}

function repositoryUrl(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  return (repo ?? pkg.homepage ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
}

/** The notice of one bundled package (its directory); throws when it can't be complete. */
function packageNotice(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const license = typeof pkg.license === 'string' ? pkg.license : undefined;
  if (!license || !ALLOWED.has(license)) throw new Error(`${pkg.name}@${pkg.version}: license ${JSON.stringify(pkg.license)} is not allowed for bundling`);
  const override = OVERRIDES[pkg.name] ?? {};
  const own = readdirSync(dir).find((file) => /^licen[cs]e(\.(md|txt))?$/i.test(file));
  const licenseText = override.licenseFile ? text(override.licenseFile) : own ? readFileSync(join(dir, own), 'utf8').trim() : null;
  if (!licenseText) throw new Error(`${pkg.name}@${pkg.version}: no license text found; add one to OVERRIDES in scripts/third-party.mjs`);
  // Apache-2.0 asks to pass a NOTICE file on.
  const noticeFile = readdirSync(dir).find((file) => /^notice(\.(md|txt))?$/i.test(file));
  const parts = [[`${pkg.name} ${pkg.version} (${license})`, repositoryUrl(pkg), override.copyright].filter(Boolean).join('\n'), licenseText];
  if (noticeFile) parts.push(`NOTICE:\n${readFileSync(join(dir, noticeFile), 'utf8').trim()}`);
  if (override.note) parts.push(override.note);
  for (const file of override.extra ?? []) parts.push(`${'-'.repeat(78)}\n${file.replace(/^licenses\//, '')}\n\n${text(file)}`);
  return parts.join('\n\n');
}

/**
 * The full notices of a distributed artifact: credits for the design values of our packages in
 * it (`own`: names in packages/) and the license of each bundled package (`packageDirs`).
 */
export function thirdPartyNotices({ title, intro, own, packageDirs = [] }) {
  const dirs = [...new Set(packageDirs)].sort((a, b) => a.localeCompare(b));
  const sections = [`${title}\n\n${intro}\n`, designSection([...new Set(own)].sort())];
  if (dirs.length) sections.push(`${RULE}\nBUNDLED SOFTWARE\n${RULE}\n\n${dirs.map(packageNotice).join(`\n\n${RULE}\n\n`)}\n`);
  return sections.filter(Boolean).join('\n');
}

/** The package directory of a bundled module, or null for our own (workspace) files. */
function packageDir(id) {
  const match = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(id.split('?')[0]);
  return match && existsSync(join(match[1], 'package.json')) ? match[1] : null;
}

/** Our package (name in packages/) a bundled module belongs to, if any. */
function ownPackage(id) {
  return new RegExp(`^${root}packages/([^/]+)/`).exec(id.split('?')[0])?.[1] ?? null;
}

/**
 * Vite/Rolldown plugin: writes `file` with notices for every package in the bundle, ours
 * (their design credits) and third-party ones (their licenses).
 */
export function noticesPlugin({ file, title, intro }) {
  return {
    name: 'simple-mark-third-party-notices',
    generateBundle(_options, bundle) {
      const ids = Object.values(bundle).flatMap((chunk) => chunk.moduleIds ?? []);
      const own = ids.map(ownPackage).filter(Boolean);
      writeFileSync(file, thirdPartyNotices({ title, intro, own, packageDirs: ids.map(packageDir).filter(Boolean) }));
    },
  };
}

/** Rolldown plugin: fails the build if any third-party module would be bundled. */
export function noBundledPackages() {
  return {
    name: 'simple-mark-no-bundled-packages',
    generateBundle(_options, bundle) {
      const bundled = Object.values(bundle).flatMap((chunk) => (chunk.moduleIds ?? []).filter(packageDir));
      if (bundled.length) throw new Error(`Third-party code would be bundled (declare it as a dependency): ${bundled.join(', ')}`);
    },
  };
}
