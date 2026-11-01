// Runs the built webview (dist/webview) in Chromium — VS Code webviews are Chromium — with the
// extension's own page and content security policy, and a fake VS Code host. Checks loading,
// math and images under the CSP, edits sent as line/character, and updates from the host.
// Run `npm run build` first. Uses Playwright's cached Chromium (or CHROMIUM_PATH).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';
import { webviewHtml } from '../src/html.ts';

const root = new URL('..', import.meta.url).pathname;
const images = join(root, '../codemirror/demo/images');
const TYPES = { '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = join(homedir(), '.cache/ms-playwright');
  for (const dir of existsSync(cache) ? readdirSync(cache).sort().reverse() : []) {
    const path = join(cache, dir, 'chrome-linux64/chrome');
    if (dir.startsWith('chromium-') && existsSync(path)) return path;
  }
  return undefined;
}

const nonce = 'testnonce123';
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const origin = `http://${req.headers.host}`;
  // Browsers ask for a favicon; VS Code webviews don't.
  if (url.pathname === '/favicon.ico') return res.writeHead(204).end();
  // VS Code's webview host in miniature: this page in an iframe, and something else to focus.
  if (url.pathname === '/frame') {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<button id="outside">outside</button><iframe id="webview" src="/"></iframe>');
    return;
  }
  // VS Code's side-by-side diff in miniature: two webviews next to each other.
  if (url.pathname === '/pair') {
    const frame = 'style="width: 480px; height: 900px; border: 0"';
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<body style="margin: 0; display: flex"><iframe id="original" src="/" ${frame}></iframe><iframe id="modified" src="/" ${frame}></iframe></body>`);
    return;
  }
  if (url.pathname === '/') {
    const page = webviewHtml({ cspSource: origin, scriptUri: '/webview/webview.js', nonce });
    // The fake VS Code API, allowed by the page's nonce like VS Code's own preload script.
    const fake = `<script nonce="${nonce}">
      window.toHost = []; window.cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => cspViolations.push(e.violatedDirective + ' ' + e.blockedURI));
      window.acquireVsCodeApi = () => ({ postMessage: (m) => toHost.push(m) });
    </script>`;
    res.writeHead(200, { 'content-type': 'text/html' }).end(page.replace('<div id="editor">', `${fake}<div id="editor">`));
    return;
  }
  const base = url.pathname.startsWith('/webview/') ? join(root, 'dist') : url.pathname.startsWith('/docs/') ? images : null;
  const file = base && normalize(join(base, url.pathname.replace(/^\/(docs|webview)\//, url.pathname.startsWith('/webview/') ? 'webview/' : '')));
  if (!file || !file.startsWith(base) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const eventually = async (read, ok, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() > end) return ok(value);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failures.push(message);
};

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
// Requests that are expected to fail: an image's first place to try (see the "/" fallback check).
const expectedMissing = new Set(['/sunset.png']);
let expected404s = 0;
page.on('response', (r) => r.status() === 404 && expectedMissing.has(new URL(r.url()).pathname) && expected404s++);

const toHost = () => page.evaluate(() => window.toHost.splice(0));
const fromHost = (message) => page.evaluate((m) => window.postMessage(m, '*'), message);

try {
  await page.goto(origin);
  await page.waitForFunction(() => window.toHost.some((m) => m.type === 'ready'));
  check(true, 'webview loads under the CSP and says ready');
  await toHost();

  const text = '# Title\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n\r\n![sunset](sunset.png)\r\n\r\n$$\r\n\\mathbb{R}^n\r\n$$\r\n\r\nSee [the docs](https://example.com/docs) and [notes](notes/b.md).\r\n\r\n![from the workspace](/sunset.png)\r\n';
  // The document's folder and the workspace folder (here both /docs/).
  await fromHost({ type: 'init', text, eol: '\r\n', baseUri: `${origin}/docs/`, workspaceUri: `${origin}/docs/`, readOnly: false, indentUnit: '  ', tabSize: 4 });
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => document.querySelector('.sm-math-preview svg'), null, { timeout: 15000 });
  check(true, 'math renders under the CSP (lazy MathJax chunk and font part)');
  await page.waitForFunction(() => document.querySelector('.sm-image-preview img')?.naturalWidth > 0, null, { timeout: 5000 });
  check(true, 'relative image loads from the document folder');

  // Type at the end of "# Title", then Enter + text: edits must arrive as line/character with CRLF.
  await page.click('.cm-line >> text=Title');
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('Enter');
  await page.keyboard.type('x');
  // The last word typed is sent after a pause (or before VS Code needs the document).
  await page.waitForTimeout(600);
  const sent = await toHost();
  const edits = sent.filter((m) => m.type === 'edit').flatMap((m) => m.edits);
  check(
    JSON.stringify(edits[0]) === JSON.stringify({ from: { line: 0, ch: 7 }, to: { line: 0, ch: 7 }, text: '!' }),
    `typed "!" sent as line 0, ch 7 (got ${JSON.stringify(edits[0])})`,
  );
  check(edits.some((e) => e.text === '\r\n'), 'Enter sent as "\\r\\n" (the document\'s line ending)');
  for (let i = 0; i < sent.filter((m) => m.type === 'edit').length; i++) await fromHost({ type: 'ack', ok: true });

  // An outside change (e.g. VS Code undo or git) arrives as the whole text.
  const outside = 'Intro\r\n' + text.replace('# Title', '# Title!\r\nx');
  await fromHost({ type: 'update', text: outside });
  await page.waitForTimeout(50);
  const shown = await page.evaluate(() => [...document.querySelectorAll('.cm-line')].slice(0, 3).map((l) => l.textContent));
  check(JSON.stringify(shown) === JSON.stringify(['Intro', '# Title!', 'x']), `outside change merged (${JSON.stringify(shown)})`);
  check((await toHost()).length === 0, 'an update from the host is not sent back');

  // An update that misses edits still on their way must not undo them.
  await page.keyboard.type('y');
  await fromHost({ type: 'update', text: outside });
  await page.waitForTimeout(50);
  const line = await page.evaluate(() => [...document.querySelectorAll('.cm-line')][2].textContent);
  check(line === 'xy', `stale update ignored while an edit is pending (line is ${JSON.stringify(line)})`);
  await toHost();
  await fromHost({ type: 'ack', ok: true });
  await page.waitForTimeout(50);
  check((await toHost()).some((m) => m.type === 'requestText'), 'after the ack it asks for the text again');

  // "/sunset.png" is not an absolute path on disk here, so it loads from the workspace folder.
  check(
    await eventually(() => page.evaluate(() => [...document.querySelectorAll('.sm-image-preview img')].find((i) => i.alt === 'from the workspace')?.naturalWidth ?? 0), (w) => w > 0),
    'an image path starting with "/" falls back to the workspace folder',
  );

  // Links go to the host, which opens them the VS Code way.
  await toHost();
  await page.locator('.sm-link', { hasText: 'the docs' }).click({ modifiers: ['Control'] });
  await page.locator('.sm-link', { hasText: 'notes' }).first().click({ modifiers: ['Control'] });
  await page.locator('.sm-image-preview img').first().click();
  await page.locator('.sm-link', { hasText: 'the docs' }).click(); // a plain click only places the cursor
  const opened = (await toHost()).filter((m) => m.type === 'openLink').map((m) => m.target);
  const expected = [
    { kind: 'web', url: 'https://example.com/docs' },
    { kind: 'file', url: 'notes/b.md' },
    { kind: 'image', url: 'sunset.png' },
  ];
  check(JSON.stringify(opened) === JSON.stringify(expected), `Ctrl+Click on links and a click on an image preview ask the host to open them (${JSON.stringify(opened)})`);

  // Tab indents like a text editor (by the host's setting, here two spaces) and keeps the focus;
  // in a table it still moves to the next cell.
  await toHost();
  await page.locator('.cm-line', { hasText: 'Intro' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  const lineText = (n) => page.evaluate((i) => document.querySelectorAll('.cm-line')[i].textContent, n);
  const focused = () => page.evaluate(() => document.activeElement?.classList.contains('cm-content'));
  check((await lineText(0)) === '  Intro' && (await focused()), `Tab inserts the indent unit and keeps the focus (${JSON.stringify(await lineText(0))})`);
  await page.keyboard.press('Shift+Tab');
  check((await lineText(0)) === 'Intro', `Shift+Tab outdents (${JSON.stringify(await lineText(0))})`);
  await page.locator('.cm-line', { hasText: '| a | b |' }).click();
  await page.keyboard.press('Tab');
  const header = await page.evaluate(() => [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes('| a'))?.textContent);
  check(header === '| a   | b   |' && (await focused()), `Tab in a table still moves to the next cell, re-aligned (${JSON.stringify(header)})`);
  for (let i = 0; i < (await toHost()).filter((m) => m.type === 'edit').length; i++) await fromHost({ type: 'ack', ok: true });

  // Tab while a Korean syllable is being composed: taken from the browser (which would move the
  // focus), then run once the IME commits. Chromium's IME emulation.
  const ime = await page.context().newCDPSession(page);
  await page.locator('.cm-line', { hasText: 'Intro' }).click();
  await page.keyboard.press('End');
  await ime.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
  await page.keyboard.press('Tab');
  await ime.send('Input.insertText', { text: '한' });
  await page.waitForTimeout(150);
  check((await lineText(0)) === 'Intro한 ' && (await focused()), `Tab while composing Korean indents after the syllable (${JSON.stringify(await lineText(0))})`);
  for (let i = 0; i < (await toHost()).filter((m) => m.type === 'edit').length; i++) await fromHost({ type: 'ack', ok: true });

  // Typing is sent in VS Code's undo steps: a word at a time, a run of deletions at once.
  await toHost();
  await page.locator('.cm-line', { hasText: 'Intro' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' hello world');
  await page.waitForTimeout(600);
  const words = (await toHost()).filter((m) => m.type === 'edit').map((m) => m.edits.map((e) => e.text).join(''));
  check(JSON.stringify(words) === JSON.stringify([' hello', ' world']), `typing is sent a word at a time (${JSON.stringify(words)})`);
  for (let i = 0; i < words.length; i++) await fromHost({ type: 'ack', ok: true });
  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('k');
  await page.keyboard.press('Control+z');
  const groups = (await toHost()).filter((m) => m.type === 'edit').map((m) => m.edits);
  check(
    groups.length === 2 && groups[0][0].text === '' && groups[0][0].to.ch - groups[0][0].from.ch === 3 && groups[1][0].text === 'k',
    `three Backspaces are one edit, and a shortcut (Ctrl+Z) sends what was typed first (${JSON.stringify(groups)})`,
  );
  for (let i = 0; i < groups.length; i++) await fromHost({ type: 'ack', ok: true });

  // Before a save the host asks for a flush: what was typed goes out before the answer.
  await page.keyboard.type('Z');
  await fromHost({ type: 'flush', id: 7 });
  await eventually(() => page.evaluate(() => window.toHost.some((m) => m.type === 'flushed')), (answered) => answered);
  const beforeSave = await toHost();
  check(
    beforeSave.length === 2 && beforeSave[0].type === 'edit' && beforeSave[0].edits[0].text === 'Z' && beforeSave[1].type === 'flushed' && beforeSave[1].id === 7,
    `a flush sends the typing, then answers (${JSON.stringify(beforeSave.map((m) => m.type))})`,
  );
  await fromHost({ type: 'ack', ok: true });

  // VS Code gives the focus back (Ctrl+1, switching tabs) by focusing the webview's window only;
  // the editor must take it, with the cursor where it was. A click from outside still places
  // the cursor where clicked.
  const host = await browser.newPage();
  await host.goto(`${origin}/frame`);
  const webview = await (await host.waitForSelector('#webview')).contentFrame();
  await webview.waitForFunction(() => window.toHost?.some((m) => m.type === 'ready'));
  await webview.evaluate((m) => window.postMessage(m, '*'), { type: 'init', text: 'first line\nsecond line\n', eol: '\n', baseUri: null, workspaceUri: null, readOnly: false, indentUnit: '    ', tabSize: 4 });
  await webview.locator('.cm-line', { hasText: 'second' }).click();
  await host.keyboard.press('End');
  await host.keyboard.type('X');
  await host.click('#outside');
  await host.evaluate(() => document.getElementById('webview').contentWindow.focus());
  await host.keyboard.type('Y');
  const webviewLines = () => webview.evaluate(() => [...document.querySelectorAll('.cm-line')].map((l) => l.textContent));
  check((await webviewLines())[1] === 'second lineXY', `focus given back to the webview returns to the cursor (${JSON.stringify(await webviewLines())})`);
  await host.click('#outside');
  const first = await webview.locator('.cm-line', { hasText: 'first' }).boundingBox();
  await host.mouse.click(first.x + 1, first.y + first.height / 2);
  await host.keyboard.type('Z');
  check((await webviewLines())[0] === 'Zfirst line', `a click from outside places the cursor where clicked (${JSON.stringify(await webviewLines())})`);
  await host.close();

  // VS Code's diff editor, side by side: each side in its own webview, the host relaying the
  // heights and scroll positions between them.
  const originalText = '# Notes\n\nFirst paragraph.\n\nAn old paragraph to change.\n\n![sunset](sunset.png)\n\n$$\nE = mc^2\n$$\n\nLast line.\n';
  const modifiedText = '# Notes\n\nFirst paragraph.\n\nA new paragraph, changed.\n\n## An added heading\n\nAnd more text\nover two lines.\n\n![sunset](sunset.png)\n\n$$\nE = mc^2\n$$\n\nLast line.\n';
  // Enough lines below to scroll.
  const filler = Array.from({ length: 60 }, (_, i) => `Filler line ${i + 1}.\n`).join('');
  const pair = await browser.newPage();
  pair.on('pageerror', (e) => errors.push(String(e)));
  pair.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await pair.goto(`${origin}/pair`);
  const sides = {};
  for (const side of ['original', 'modified']) {
    sides[side] = await (await pair.waitForSelector(`#${side}`)).contentFrame();
    await sides[side].waitForFunction(() => window.toHost?.some((m) => m.type === 'ready'));
  }
  // The host: forwards each side's diffHeights / diffScroll to the other side.
  let relaying = true;
  const relay = (async () => {
    while (relaying) {
      for (const [from, to] of [['original', 'modified'], ['modified', 'original']]) {
        const sent = await sides[from].evaluate(() => window.toHost.splice(0)).catch(() => []);
        for (const m of sent) if (m.type === 'diffHeights' || m.type === 'diffScroll') await sides[to].evaluate((msg) => window.postMessage(msg, '*'), m).catch(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  const init = (text, diff) => ({ type: 'init', text, eol: '\n', baseUri: `${origin}/docs/`, workspaceUri: null, readOnly: diff.part === 'original', indentUnit: '    ', tabSize: 4, diff });
  await sides.original.evaluate((m) => window.postMessage(m, '*'), init(originalText + filler, { part: 'original', other: modifiedText + filler }));
  await sides.modified.evaluate((m) => window.postMessage(m, '*'), init(modifiedText + filler, { part: 'modified', other: originalText + filler }));
  for (const frame of Object.values(sides)) {
    await frame.waitForFunction(() => document.querySelector('.sm-image-preview img')?.naturalWidth > 0 && document.querySelector('.sm-math-preview svg'), null, { timeout: 15000 });
  }
  const changed = (frame) => frame.evaluate(() => [...document.querySelectorAll('.sm-diff-line')].map((l) => l.textContent));
  const changedText = (frame) => frame.evaluate(() => [...document.querySelectorAll('.sm-diff-text')].map((l) => l.textContent).join('|'));
  check(JSON.stringify(await changed(sides.original)) === JSON.stringify(['An old paragraph to change.']), `the original side marks its removed line (${JSON.stringify(await changed(sides.original))})`);
  const added = await changed(sides.modified);
  check(added.length === 6 && added[0] === 'A new paragraph, changed.' && added.includes('## An added heading'), `the modified side marks its added lines (${JSON.stringify(added)})`);
  check((await changedText(sides.original)).includes('old') && (await changedText(sides.modified)).includes('new'), `changed words are marked within the lines (${await changedText(sides.original)} / ${await changedText(sides.modified)})`);
  const lineTop = (frame, text) => frame.evaluate((t) => [...document.querySelectorAll('.cm-line')].find((l) => l.textContent === t)?.getBoundingClientRect().top ?? NaN, text);
  const aligned = async (text) => {
    const [a, b] = [await lineTop(sides.original, text), await lineTop(sides.modified, text)];
    return { ok: Math.abs(a - b) <= 1, a, b };
  };
  const afterChunk = await eventually(() => aligned('Last line.'), (r) => r.ok, 5000);
  const tail = await aligned('Last line.');
  check(afterChunk, `the sides line up after the change (original at ${tail.a}px, modified at ${tail.b}px)`);
  check(await sides.original.evaluate(() => !!document.querySelector('.sm-diff-spacer-chunk')), 'the shorter side shows a hatched spacer for the lines it lacks');
  check(!(await sides.original.evaluate(() => document.activeElement?.classList.contains('cm-content'))), 'the original side does not take the focus');
  // SMOKE_SHOTS=<folder> saves screenshots of both diff layouts, to look at.
  if (process.env.SMOKE_SHOTS) await pair.screenshot({ path: join(process.env.SMOKE_SHOTS, 'diff-side-by-side.png') });

  // Scrolling one side scrolls the other to the same place.
  await sides.modified.evaluate(() => (document.querySelector('.cm-scroller').scrollTop = 120));
  const scrolled = await eventually(() => sides.original.evaluate(() => document.querySelector('.cm-scroller').scrollTop), (top) => Math.abs(top - 120) <= 1);
  check(scrolled, `scrolling the modified side scrolls the original (${await sides.original.evaluate(() => document.querySelector('.cm-scroller').scrollTop)})`);
  await sides.original.evaluate(() => (document.querySelector('.cm-scroller').scrollTop = 40));
  check(await eventually(() => sides.modified.evaluate(() => document.querySelector('.cm-scroller').scrollTop), (top) => Math.abs(top - 40) <= 1), 'and the other way round');
  await sides.original.evaluate(() => (document.querySelector('.cm-scroller').scrollTop = 0));
  await eventually(() => sides.modified.evaluate(() => document.querySelector('.cm-scroller').scrollTop), (top) => top === 0);

  // The modified document changes (typed, or by VS Code): the original side hears it from the
  // host, and both line up again.
  const edited = (modifiedText + filler).replace('over two lines.\n', 'over two lines.\nAnd a third.\nAnd a fourth.\n');
  await sides.modified.evaluate((m) => window.postMessage(m, '*'), { type: 'update', text: edited });
  await sides.original.evaluate((m) => window.postMessage(m, '*'), { type: 'diffOther', text: edited });
  const realigned = await eventually(() => aligned('Last line.'), (r) => r.ok, 5000);
  const now = await aligned('Last line.');
  check(realigned && (await changed(sides.modified)).includes('And a fourth.'), `after a change the sides line up again (original at ${now.a}px, modified at ${now.b}px)`);
  relaying = false;
  await relay;
  await pair.close();

  // VS Code's inline diff: one webview, the original's deleted lines above their replacement.
  const inline = await browser.newPage();
  inline.on('pageerror', (e) => errors.push(String(e)));
  await inline.goto(origin);
  await inline.waitForFunction(() => window.toHost.some((m) => m.type === 'ready'));
  await inline.evaluate((m) => window.postMessage(m, '*'), init(modifiedText, { part: 'inline', other: originalText }));
  await inline.waitForSelector('.cm-deletedChunk');
  const deleted = await inline.evaluate(() => [...document.querySelectorAll('.cm-deletedChunk .cm-deletedLine')].map((l) => l.textContent));
  check(JSON.stringify(deleted) === JSON.stringify(['An old paragraph to change.']), `inline: the deleted line is shown (${JSON.stringify(deleted)})`);
  const order = await inline.evaluate(() => {
    const chunk = document.querySelector('.cm-deletedChunk').getBoundingClientRect();
    const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent === 'A new paragraph, changed.').getBoundingClientRect();
    return chunk.bottom <= line.top + 1;
  });
  check(order, 'inline: the deleted line is drawn above the line that replaced it');
  if (process.env.SMOKE_SHOTS) await inline.screenshot({ path: join(process.env.SMOKE_SHOTS, 'diff-inline.png') });
  const inlineAdded = await inline.evaluate(() => [...document.querySelectorAll('.cm-changedLine')].map((l) => l.textContent));
  check(inlineAdded.includes('A new paragraph, changed.') && inlineAdded.includes('## An added heading'), `inline: the added lines are marked (${JSON.stringify(inlineAdded)})`);
  // The original changes (e.g. the change is staged and the index is compared): shown again.
  await inline.evaluate((m) => window.postMessage(m, '*'), { type: 'diffOther', text: modifiedText.replace('A new paragraph, changed.', 'A newer paragraph.') });
  const redrawn = await eventually(
    () => inline.evaluate(() => [...document.querySelectorAll('.cm-deletedChunk .cm-deletedLine')].map((l) => l.textContent).join('|')),
    (t) => t === 'A newer paragraph.',
  );
  check(redrawn, 'inline: a change of the original redraws the deleted lines');
  await inline.close();

  const violations = await page.evaluate(() => window.cspViolations);
  check(violations.length === 0, `no CSP violations ${violations.length ? JSON.stringify(violations) : ''}`);
  // The browser logs each failed request; the expected ones (first places to try) don't count.
  let allowed = expected404s;
  const unexpected = errors.filter((e) => !(e.startsWith('Failed to load resource') && e.includes('404') && allowed-- > 0));
  check(unexpected.length === 0, `no console errors ${unexpected.length ? JSON.stringify(unexpected) : ''}`);
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nwebview smoke test passed');
