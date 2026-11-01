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
