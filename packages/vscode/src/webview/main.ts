// The webview side: a SimpleMark editor kept equal to the VS Code document. Typed changes go
// to the host as line/character edits, grouped into undo steps as VS Code's text editor groups
// them (./edit-groups.ts); changes from VS Code (undo, other editors, git) come back as the
// whole text and are merged in as one minimal change, keeping the cursor.
// In VS Code's diff editor, the same editor also shows the changes (see ./diff.ts).

import { Annotation } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createEditor } from '@simple-mark/codemirror';
import type { DiffInit, HostMessage, WebviewMessage } from '../protocol';
import { diffText, offsetToLineCh } from '../sync';
import { inlineDiff, setOtherHeightsOf, setOtherText, sideBySideDiff } from './diff';
import { EditGroups } from './edit-groups';
import { vscodeChrome, vscodeTheme } from './theme';

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscode = acquireVsCodeApi();
const post = (message: WebviewMessage) => vscode.postMessage(message);

/** Marks transactions that come from the host, so they are not sent back. */
const fromHost = Annotation.define<boolean>();

let view: EditorView | null = null;
/** Edits sent and not yet acknowledged. */
let pending = 0;
/** An update arrived while edits were pending; ask for the text once they are applied. */
let stale = false;

/**
 * Image paths relative to the document's folder. A path starting with "/" is an absolute path
 * on disk, or else relative to the workspace folder (as VS Code's Markdown preview reads it):
 * both are tried, like when the link is opened. Web images as they are; other schemes refused.
 */
function imageResolver(baseUri: string | null, workspaceUri: string | null) {
  return (src: string): string | string[] | null => {
    if (/^(https?:|data:image\/)/i.test(src)) return src;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || !baseUri) return null;
    try {
      const resolved = new URL(src, baseUri).toString();
      if (src.startsWith('/') && workspaceUri) return [resolved, new URL(src.slice(1), workspaceUri).toString()];
      return resolved;
    } catch {
      return null;
    }
  };
}

/** Typed changes, sent to the host one group (one undo step in VS Code) at a time, in order. */
const groups = new EditGroups((edits) => {
  pending++;
  post({ type: 'edit', edits });
});

/** A group still being typed is sent after this pause. */
const GROUP_PAUSE_MS = 500;
let groupTimer = 0;

/** Sends the typed changes not sent yet: before VS Code works with the document. */
function sendTyped(): void {
  clearTimeout(groupTimer);
  groupTimer = 0;
  groups.flush();
}

const sendEdits = EditorView.updateListener.of((update) => {
  for (const tr of update.transactions) {
    if (tr.docChanged && !tr.annotation(fromHost)) groups.add(tr);
  }
  if (update.docChanged) {
    clearTimeout(groupTimer);
    groupTimer = groups.waiting ? window.setTimeout(sendTyped, GROUP_PAUSE_MS) : 0;
  }
});

// VS Code acts on the document when a shortcut reaches it (Ctrl+Z, Ctrl+S, Ctrl+W, …) and
// when the editor loses the focus (a menu, another editor). Send what was typed first; the
// capture phase runs before VS Code's own key listener in this window.
window.addEventListener(
  'keydown',
  (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || /^F\d+$/.test(event.key)) sendTyped();
  },
  true,
);
window.addEventListener('blur', sendTyped);
window.addEventListener('pagehide', sendTyped);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && sendTyped());

/** The diff extensions, if this webview is part of VS Code's diff editor. */
function diffExtensions(diff: DiffInit | undefined) {
  if (!diff) return [];
  if (diff.layout === 'inline') return [inlineDiff(diff.original)];
  return [sideBySideDiff({ side: diff.side, other: diff.other, onHeights: (heights) => post({ type: 'diffHeights', heights }) })];
}

/** Side by side: the scroll position last set from the other side, so it is not sent back. */
let scrolledTo: number | null = null;

/** Side by side: both sides scroll together, as in VS Code's diff editor. */
function syncScroll(editor: EditorView): void {
  let frame = 0;
  editor.scrollDOM.addEventListener('scroll', () => {
    const top = editor.scrollDOM.scrollTop;
    if (scrolledTo !== null && Math.abs(top - scrolledTo) < 1) return;
    scrolledTo = null;
    // One message per frame is enough to follow.
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        post({ type: 'diffScroll', top: editor.scrollDOM.scrollTop });
      });
    }
  });
}

function start(message: Extract<HostMessage, { type: 'init' }>): void {
  view = createEditor(document.getElementById('editor')!, {
    doc: message.text,
    lineSeparator: message.eol,
    readOnly: message.readOnly,
    indentUnit: message.indentUnit,
    tabSize: message.tabSize,
    theme: vscodeTheme,
    history: false, // VS Code owns undo/redo for the document
    resolveImage: imageResolver(message.baseUri, message.workspaceUri),
    // VS Code opens links: web pages outside, files in its own editors.
    openLink: (target) => post({ type: 'openLink', target }),
    extensions: [vscodeChrome, sendEdits, diffExtensions(message.diff)],
  });
  if (message.diff?.layout === 'sideBySide') syncScroll(view);
  // In a side-by-side diff VS Code focuses the modified side, like its text diff editor.
  if (message.diff?.layout !== 'sideBySide' || message.diff.side === 'modified') view.focus();
}

// When VS Code gives the editor back the focus (Ctrl+1, switching tabs), it focuses this
// webview's window but nothing in it, so typing went nowhere until a click. Focus the editor,
// which puts the cursor back where it was, as in VS Code's text editor.
window.addEventListener('focus', () => {
  if (view && !view.hasFocus) view.focus();
});

/** Makes the editor show `text`, changing only what differs. */
function reconcile(text: string): void {
  if (!view) return;
  const { state } = view;
  const current = state.sliceDoc();
  const diff = diffText(current, text);
  if (!diff) return;
  const toPos = (offset: number) => {
    const { line, ch } = offsetToLineCh(current, offset, state.lineBreak);
    return state.doc.line(line + 1).from + ch;
  };
  view.dispatch({ changes: { from: toPos(diff.from), to: toPos(diff.to), insert: diff.insert }, annotations: fromHost.of(true) });
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      if (!view) start(message);
      break;
    case 'update':
      // Our own edits are still on their way: this text may not have them yet.
      sendTyped();
      if (pending > 0) stale = true;
      else reconcile(message.text);
      break;
    case 'flush':
      // Everything typed goes out before this answer, so the host has it all once it arrives.
      sendTyped();
      post({ type: 'flushed', id: message.id });
      break;
    case 'diffOther':
      if (view) setOtherText(view, message.text);
      break;
    case 'diffHeights':
      if (view) setOtherHeightsOf(view, message.heights);
      break;
    case 'diffScroll':
      if (view && Math.abs(view.scrollDOM.scrollTop - message.top) >= 1) {
        scrolledTo = message.top;
        view.scrollDOM.scrollTop = message.top;
      }
      break;
    case 'ack':
      pending--;
      if (!message.ok) stale = true;
      if (pending === 0 && stale) {
        stale = false;
        post({ type: 'requestText' });
      }
      break;
  }
});

post({ type: 'ready' });
