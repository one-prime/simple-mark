// Opens a Git change of a Markdown file in a real VS Code, from the Source Control view, and
// checks that Simple-Mark shows the diff side by side and inline (customEditorDiffs proposal).
// Runs VS Code (default: /usr/share/code/code, or VSCODE_PATH) in extension development mode,
// which allows proposed APIs, with a throwaway profile and repository. It opens a window.
// Run `npm run build` first. SMOKE_SHOTS=<folder> saves screenshots.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const extension = new URL('..', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'simple-mark-e2e-'));
const repo = join(root, 'repo');
const user = join(root, 'user');

const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
execFileSync('git', ['init', '-q', repo]);
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'Test');
const before = '# Notes\n\nFirst paragraph.\n\nAn old paragraph to change.\n\n> A quote\n\nLast line.\n';
const after = '# Notes\n\nFirst paragraph.\n\nA new paragraph, changed.\n\n## An added heading\n\nAnd more text.\n\n> A quote\n\nLast line.\n';
writeFileSync(join(repo, 'note.md'), before);
git('add', '.');
git('commit', '-q', '-m', 'first');
writeFileSync(join(repo, 'note.md'), after);
execFileSync('mkdir', ['-p', join(user, 'User')]);
writeFileSync(
  join(user, 'User', 'settings.json'),
  JSON.stringify({
    'diffEditor.renderSideBySide': true,
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
    'git.openDiffOnClick': true,
    'window.restoreWindows': 'none',
  }),
);

const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failures.push(message);
};

/** VS Code on the repository, with the extension and (`proposal`) the diff API allowed. */
const launch = (proposal) =>
  electron.launch({
    executablePath: process.env.VSCODE_PATH ?? '/usr/share/code/code',
    args: [
      repo,
      `--extensionDevelopmentPath=${extension}`,
      // Stable VS Code allows proposed APIs only to extensions named here (or in argv.json).
      ...(proposal ? ['--enable-proposed-api=Simple-Mark.simple-mark'] : []),
      `--user-data-dir=${user}`,
      `--extensions-dir=${join(root, 'extensions')}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-gpu',
    ],
  });

/** The documents shown in Simple-Mark webviews: their changed lines, and deleted-line blocks. */
async function webviews(window) {
  const found = [];
  for (const frame of window.frames()) {
    const info = await frame
      .evaluate(() => {
        if (!document.querySelector('.cm-content')) return null;
        const lines = (selector) => [...document.querySelectorAll(selector)].map((l) => l.textContent);
        const editor = document.querySelector('.cm-editor');
        return {
          side: editor.classList.contains('sm-diff-original') ? 'original' : editor.classList.contains('sm-diff-modified') ? 'modified' : editor.classList.contains('sm-diff-inline') ? 'inline' : 'editor',
          changed: lines('.sm-diff-line, .cm-changedLine'),
          deleted: lines('.cm-deletedLine'),
          spacers: document.querySelectorAll('.sm-diff-spacer-chunk').length,
          readOnly: document.querySelector('.cm-content').getAttribute('contenteditable') !== 'true',
        };
      })
      .catch(() => null);
    if (info) found.push(info);
  }
  return found;
}

async function waitFor(read, ok, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() > end) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function runCommand(window, title) {
  // Keys typed while a webview has the focus go to the document: focus the workbench first.
  await window.locator('.part.sidebar .title-label, .activitybar').first().click();
  await window.keyboard.press('F1');
  await window.waitForSelector('.quick-input-widget input', { state: 'visible' });
  await window.keyboard.type(title);
  await window.waitForTimeout(400);
  await window.keyboard.press('Enter');
}

/** Opens the change of note.md from the Source Control view. */
async function openChange(window) {
  await window.waitForSelector('.monaco-workbench', { timeout: 30000 });
  await runCommand(window, 'View: Show Source Control');
  const row = window.locator('.scm-view .monaco-list-row', { hasText: 'note.md' }).first();
  await row.waitFor({ timeout: 30000 });
  await row.click();
}

let app = await launch(true);
try {
  const window = await app.firstWindow();
  await openChange(window);

  const sideBySide = await waitFor(() => webviews(window), (v) => v.some((w) => w.side === 'original') && v.some((w) => w.side === 'modified' && w.changed.length));
  const original = sideBySide.find((w) => w.side === 'original');
  const modified = sideBySide.find((w) => w.side === 'modified');
  check(!!original && !!modified, `side by side: both sides open in Simple-Mark (${JSON.stringify(sideBySide.map((w) => w.side))})`);
  check(JSON.stringify(original?.changed) === JSON.stringify(['An old paragraph to change.']), `side by side: the removed line is marked (${JSON.stringify(original?.changed)})`);
  check(modified?.changed.includes('## An added heading') ?? false, `side by side: the added lines are marked (${JSON.stringify(modified?.changed)})`);
  check(original?.readOnly === true && modified?.readOnly === false, 'side by side: the HEAD version is read-only, the working file editable');
  const padded = await waitFor(() => webviews(window), (v) => v.some((w) => w.side === 'original' && w.spacers > 0), 5000);
  check(padded.some((w) => w.side === 'original' && w.spacers > 0), 'side by side: the original is padded to line up with the modified side');
  if (process.env.SMOKE_SHOTS) await window.screenshot({ path: join(process.env.SMOKE_SHOTS, 'vscode-side-by-side.png') });

  // VS Code's own "Toggle Inline View" reopens the diff in one webview.
  await runCommand(window, 'Toggle Inline View');
  const inline = await waitFor(() => webviews(window), (v) => v.some((w) => w.side === 'inline' && w.deleted.length));
  const view = inline.find((w) => w.side === 'inline');
  check(!!view, `inline: the diff reopens in one webview (${JSON.stringify(inline.map((w) => w.side))})`);
  check(JSON.stringify(view?.deleted) === JSON.stringify(['An old paragraph to change.']), `inline: the deleted line is shown (${JSON.stringify(view?.deleted)})`);
  check(view?.changed.includes('## An added heading') ?? false, `inline: the added lines are marked (${JSON.stringify(view?.changed)})`);
  if (process.env.SMOKE_SHOTS) await window.screenshot({ path: join(process.env.SMOKE_SHOTS, 'vscode-inline.png') });
  await runCommand(window, 'Toggle Inline View');
  await app.close();

  // Without the proposal VS Code shows two plain editors; the extension says how to allow it.
  app = await launch(false);
  const plain = await app.firstWindow();
  await openChange(plain);
  const editors = await waitFor(() => webviews(plain), (v) => v.length >= 2);
  check(editors.length === 2 && editors.every((w) => w.side === 'editor'), `without the proposal: two plain editors (${JSON.stringify(editors.map((w) => w.side))})`);
  const hint = await plain
    .locator('.notification-toast', { hasText: 'enable-proposed-api' })
    .first()
    .waitFor({ timeout: 10000 })
    .then(() => true, () => false);
  check(hint, 'without the proposal: a notification says how to allow it');
} finally {
  await app.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nVS Code diff test passed');
