// Text helpers for keeping the webview and the VS Code document equal. No VS Code or DOM.

import type { LineCh } from './protocol';

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Whether `index` falls inside a "\r\n" pair or a surrogate pair of `text`. */
function splitsPair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  return isLowSurrogate(text.charCodeAt(index)) || (text[index - 1] === '\r' && text[index] === '\n');
}

/**
 * The smallest single replacement turning `before` into `after`: offsets into `before`, never
 * inside a "\r\n" or a surrogate pair. Null when the texts are equal.
 */
export function diffText(before: string, after: string): { from: number; to: number; insert: string } | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  while (prefix > 0 && (splitsPair(before, prefix) || splitsPair(after, prefix))) prefix--;
  let suffix = 0;
  while (suffix < max - prefix && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
  while (suffix > 0 && (splitsPair(before, before.length - suffix) || splitsPair(after, after.length - suffix))) suffix--;
  return { from: prefix, to: before.length - suffix, insert: after.slice(prefix, after.length - suffix) };
}

/** The line and character of `offset` in `text`, whose lines end with `eol`. */
export function offsetToLineCh(text: string, offset: number, eol: string): LineCh {
  let line = 0;
  let lineStart = 0;
  for (let i = text.indexOf(eol); i !== -1 && i < offset; i = text.indexOf(eol, lineStart)) {
    line++;
    lineStart = i + eol.length;
  }
  return { line, ch: offset - lineStart };
}

/**
 * Where a followed link's path points: a Windows drive path; a path starting with "/" (an
 * absolute path on disk if that file exists, else relative to the workspace folder); or the
 * document's folder. Query and fragment are dropped, %-escapes decoded.
 */
export function linkPath(url: string): { path: string; base: 'drive' | 'root' | 'document' } | null {
  let path = url.split(/[?#]/)[0] ?? '';
  try {
    path = decodeURIComponent(path);
  } catch {
    // Not %-encoded: use as written.
  }
  if (!path) return null;
  if (/^[a-zA-Z]:[\\/]/.test(path)) return { path, base: 'drive' };
  return { path, base: path.startsWith('/') ? 'root' : 'document' };
}
