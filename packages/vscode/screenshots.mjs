// Takes the README screenshots in a real VS Code (images/*.png): the editor with Markdown, math
// and an image; a Git change as a diff, side by side and inline. Run `npm run build` first.
// Starts VS Code 1.143 or newer (/usr/share/code/code, or VSCODE_PATH) with a throwaway profile
// and repository, so a window opens while it runs.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const extension = new URL('.', import.meta.url).pathname;
const out = join(extension, 'images');
const root = mkdtempSync(join(tmpdir(), 'simple-mark-shots-'));
const repo = join(root, 'repo');
const user = join(root, 'user');

// ---- the documents -------------------------------------------------------------------------

const mountains = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="340" viewBox="0 0 800 340">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#27325e"/><stop offset="0.55" stop-color="#d9707f"/><stop offset="1" stop-color="#f7c48c"/>
    </linearGradient>
    <linearGradient id="lake" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e9a782"/><stop offset="1" stop-color="#34406e"/>
    </linearGradient>
  </defs>
  <rect width="800" height="340" fill="url(#sky)"/>
  <circle cx="555" cy="205" r="46" fill="#ffe3a9"/>
  <path d="M0 240 L120 140 L205 200 L305 100 L425 220 L520 160 L640 230 L720 170 L800 220 L800 340 L0 340 Z" fill="#4b406d"/>
  <path d="M0 268 L95 210 L185 250 L285 192 L385 262 L475 222 L565 270 L665 232 L800 270 L800 340 L0 340 Z" fill="#2e2a50"/>
  <rect y="284" width="800" height="56" fill="url(#lake)" opacity="0.9"/>
  <path d="M515 298 h80 M495 312 h120 M525 326 h60" stroke="#ffe3a9" stroke-width="3" stroke-linecap="round" opacity="0.65"/>
</svg>
`;

const showcase = `# Field notes

Simple-Mark shows Markdown **formatted as you write it**. The syntax stays in place:
*emphasis*, \`inline code\` and [links](https://github.com/one-prime/simple-mark) keep their markers.

## Math

The wave speed is $v = f\\lambda$. Display formulas render below their source:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

## Images

![Mountains at dusk](mountains.svg)
`;

const before = `# Trip plan

We hike to the **north ridge** in May.

$$
t = \\frac{d}{v}
$$

- Day 1: drive to the trailhead
- Day 2: hike to the ridge
`;

const after = `# Trip plan

We hike to the **north ridge** in June, if the weather holds.

$$
t = \\frac{d}{v} + t_{\\text{rest}}
$$

![Mountains at dusk](mountains.svg)

- Day 1: drive to the trailhead
- Day 2: hike to the ridge
- Day 3: rest at the lake
`;

const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
execFileSync('git', ['init', '-q', repo]);
git('config', 'user.email', 'shots@example.com');
git('config', 'user.name', 'Shots');
writeFileSync(join(repo, 'mountains.svg'), mountains);
writeFileSync(join(repo, 'showcase.md'), showcase);
writeFileSync(join(repo, 'trip.md'), before);
git('add', '.');
git('commit', '-q', '-m', 'Plan the trip');
writeFileSync(join(repo, 'trip.md'), after);

mkdirSync(join(user, 'User'), { recursive: true });
writeFileSync(
  join(user, 'User', 'settings.json'),
  JSON.stringify({
    'diffEditor.renderSideBySide': true,
    'git.openDiffOnClick': true,
    'security.workspace.trust.enabled': false,
    'window.restoreWindows': 'none',
    'workbench.startupEditor': 'none',
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'chat.disableAIFeatures': true,
  }),
);

// ---- VS Code -------------------------------------------------------------------------------

const app = await electron.launch({
  executablePath: process.env.VSCODE_PATH ?? '/usr/share/code/code',
  args: [
    repo,
    `--extensionDevelopmentPath=${extension}`,
    '--enable-proposed-api=Simple-Mark.simple-mark',
    `--user-data-dir=${user}`,
    `--extensions-dir=${join(root, 'extensions')}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-gpu',
  ],
});

/** Runs a command from the Command Palette, with the workbench (not a webview) focused. */
async function runCommand(window, title) {
  await window.locator('.monaco-workbench .part.statusbar').click({ position: { x: 5, y: 5 } });
  await window.keyboard.press('F1');
  await window.waitForSelector('.quick-input-widget input', { state: 'visible' });
  await window.keyboard.type(title);
  await window.waitForTimeout(500);
  await window.keyboard.press('Enter');
  await window.waitForTimeout(300);
}

/** The frame of the Simple-Mark webview whose editor matches `selector` and shows `text`. */
async function frameShowing(window, selector, text) {
  for (let tries = 0; tries < 80; tries++) {
    for (const frame of window.frames()) {
      const found = await frame
        .evaluate(([sel, t]) => !!document.querySelector(sel) && document.querySelector('.cm-content')?.textContent.includes(t), [selector, text])
        .catch(() => false);
      if (found) return frame;
    }
    await window.waitForTimeout(250);
  }
  throw new Error(`No webview with ${selector} showing ${text}`);
}

/** Waits until a frame has drawn its formulas and images. */
async function rendered(frame) {
  await frame.waitForFunction(
    () =>
      [...document.querySelectorAll('.sm-image-preview img')].every((img) => img.naturalWidth > 0) &&
      document.querySelectorAll('.sm-math-preview svg').length > 0,
    null,
    { timeout: 20000 },
  );
}

/** Saves the editor area (tabs and editors, no side bars), down to the end of the documents. */
async function shoot(window, name, frames) {
  await window.waitForTimeout(800);
  const box = await window.locator('.part.editor').boundingBox();
  let bottom = box.y;
  for (const frame of frames) {
    const last = await frame.locator('.cm-content > :last-child').boundingBox();
    bottom = Math.max(bottom, last.y + last.height);
  }
  const height = Math.min(box.height, bottom - box.y + 16);
  await window.screenshot({ path: join(out, name), clip: { ...box, height } });
  console.log(`  saved images/${name}`);
}

mkdirSync(out, { recursive: true });
try {
  const window = await app.firstWindow();
  await window.waitForSelector('.monaco-workbench', { timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 1000));
  await window.waitForTimeout(500);

  // The editor: Markdown, math (with an inline formula's tooltip) and an image.
  await runCommand(window, 'View: Close Primary Side Bar');
  await runCommand(window, 'View: Close Secondary Side Bar');
  await window.keyboard.press('Control+P');
  await window.waitForSelector('.quick-input-widget input', { state: 'visible' });
  await window.keyboard.type('showcase.md');
  await window.waitForTimeout(500);
  await window.keyboard.press('Enter');
  const showcaseFrame = await frameShowing(window, '.cm-editor:not([class*="sm-diff"])', 'Field notes');
  await rendered(showcaseFrame);
  await showcaseFrame.locator('.cm-line', { hasText: 'wave speed' }).locator('text=lambda').first().click();
  await showcaseFrame.waitForSelector('.sm-math-tooltip svg', { timeout: 10000 });
  await shoot(window, 'editor.png', [showcaseFrame]);

  // The diff: Source Control, click the change, side by side then inline.
  await runCommand(window, 'View: Close All Editors');
  await runCommand(window, 'View: Show Source Control');
  const row = window.locator('.scm-view .monaco-list-row', { hasText: 'trip.md' }).first();
  await row.waitFor({ timeout: 30000 });
  await row.click();
  const modified = await frameShowing(window, '.sm-diff-modified', 'Trip plan');
  const original = await frameShowing(window, '.sm-diff-original', 'Trip plan');
  await rendered(modified);
  await rendered(original);
  await runCommand(window, 'View: Close Primary Side Bar');
  await original.waitForSelector('.sm-diff-spacer-chunk');
  await shoot(window, 'diff-side-by-side.png', [original, modified]);

  await runCommand(window, 'Toggle Inline View');
  const inline = await frameShowing(window, '.sm-diff-inline', 'Trip plan');
  await inline.waitForSelector('.cm-deletedChunk');
  await rendered(inline);
  await shoot(window, 'diff-inline.png', [inline]);
  await runCommand(window, 'Toggle Inline View');
} finally {
  await app.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
