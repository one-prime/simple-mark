// The extension host side: a custom text editor for Markdown. VS Code's TextDocument stays
// the source of truth, so saving, the dirty mark, git and undo/redo work as for any text
// editor; the webview only shows it and sends the user's edits.

import * as vscode from 'vscode';
import { makeNonce, webviewHtml } from './html';
import type { DiffInit, DiffRelay, DiffSide, HostMessage, LinkTarget, WebviewMessage } from './protocol';
import { linkPath } from './sync';

const VIEW_TYPE = 'simple-mark.editor';

/** The extension's ID, as `--enable-proposed-api` and argv.json name it. */
const EXTENSION_ID = 'Simple-Mark.simple-mark';

export function activate(context: vscode.ExtensionContext): void {
  // VS Code clears the proposals an extension may not use (stable VS Code allows them only to
  // extensions named by --enable-proposed-api or in argv.json). Without customEditorDiffs, a
  // diff shows two plain Simple-Mark editors, so say once how to get the real diff.
  const diffs = (context.extension.packageJSON as { enabledApiProposals?: string[] }).enabledApiProposals?.includes('customEditorDiffs') ?? false;
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new SimpleMarkEditorProvider(context.extensionUri, diffs ? null : diffHint()), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('simple-mark.open', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) void vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('simple-mark.openAsText', (uri?: vscode.Uri) => {
      const target = uri ?? activeCustomEditorUri();
      if (target) void vscode.commands.executeCommand('vscode.openWith', target, 'default');
    }),
  );
}

export function deactivate(): void {}

/**
 * Opens a followed link: web pages in the browser (VS Code asks first), paths in VS Code's
 * own editors (images in its image viewer, Markdown in SimpleMark). Paths are relative to the
 * document's folder; a leading "/" is an absolute path, or else relative to the workspace.
 */
async function openLink(target: LinkTarget, folder: vscode.Uri | null, workspace: vscode.Uri | undefined): Promise<void> {
  if (target.kind === 'web') {
    if (/^(https?:|mailto:)/i.test(target.url)) await vscode.env.openExternal(vscode.Uri.parse(target.url, true));
    return;
  }
  const link = linkPath(target.url);
  if (!link) return;
  // Where the file may be, in order; the first that exists opens.
  const candidates: vscode.Uri[] = [];
  if (link.base === 'drive') candidates.push(vscode.Uri.file(link.path));
  else if (link.base === 'root') {
    // "/…": an absolute path on disk (as the image preview draws it), else in the workspace
    // folder (as VS Code's own Markdown preview reads it).
    candidates.push(vscode.Uri.file(link.path));
    if (workspace) candidates.push(vscode.Uri.joinPath(workspace, link.path));
  } else if (folder) candidates.push(vscode.Uri.joinPath(folder, link.path));
  else {
    void vscode.window.showWarningMessage(`Can't open ${target.url}: save the document first, so its folder is known.`);
    return;
  }
  let uri: vscode.Uri | undefined;
  for (const candidate of candidates) {
    try {
      await vscode.workspace.fs.stat(candidate);
      uri = candidate;
      break;
    } catch {
      // Not there: try the next place.
    }
  }
  if (!uri) {
    void vscode.window.showWarningMessage(`File not found: ${target.url}`);
    return;
  }
  await vscode.commands.executeCommand('vscode.open', uri);
}

/** Explains, once per session, how to see diffs with their changes marked. */
function diffHint(): () => void {
  let shown = false;
  return () => {
    if (shown) return;
    shown = true;
    const open = 'Open argv.json';
    void vscode.window
      .showInformationMessage(
        `Simple-Mark marks the changes in a diff only with VS Code's proposed customEditorDiffs API. To allow it, add "enable-proposed-api": ["${EXTENSION_ID}"] to argv.json and restart VS Code.`,
        open,
      )
      .then((choice) => {
        if (choice === open) void vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
      });
  };
}

function activeCustomEditorUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom ? input.uri : undefined;
}

/** What a webview in a diff compares its document with. */
type DiffBinding =
  | { layout: 'sideBySide'; side: DiffSide; other: vscode.TextDocument; relay: (message: DiffRelay) => void }
  | { layout: 'inline'; original: vscode.TextDocument };

const sameUri = (a: vscode.Uri, b: vscode.Uri) => a.toString() === b.toString();

class SimpleMarkEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    /** Without the diff API: called when a document that is likely a diff's side opens. */
    private readonly onPlainDiff: (() => void) | null,
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    // Git's earlier versions (git: documents) open in an editor mostly as a diff's left side.
    if (this.onPlainDiff && document.uri.scheme === 'git') this.onPlainDiff();
    this.bind(document, panel);
  }

  // VS Code's diff editor (customEditorDiffs API proposal). VS Code picks the layout from the
  // user's diffEditor.renderSideBySide and offers "Toggle Inline View", which reopens the diff
  // in the other layout.

  /** Side by side: each document in its own webview, which line up and scroll together. */
  resolveCustomTextEditorSideBySideDiff(
    documents: vscode.CustomEditorDiffDocuments<vscode.TextDocument>,
    panels: vscode.CustomEditorSideBySideDiffWebviewPanels,
  ): void {
    // Each side's messages for the other go through here; one that is gone gets none.
    const sides: { original?: (m: HostMessage) => void; modified?: (m: HostMessage) => void } = {};
    sides.original = this.bind(documents.original, panels.original, {
      layout: 'sideBySide',
      side: 'original',
      other: documents.modified,
      relay: (message) => sides.modified?.(message),
    });
    sides.modified = this.bind(documents.modified, panels.modified, {
      layout: 'sideBySide',
      side: 'modified',
      other: documents.original,
      relay: (message) => sides.original?.(message),
    });
    panels.original.onDidDispose(() => (sides.original = undefined));
    panels.modified.onDidDispose(() => (sides.modified = undefined));
  }

  /** Inline: the modified document, with the original's deleted lines drawn in it. */
  resolveCustomTextEditorInlineDiff(documents: vscode.CustomEditorDiffDocuments<vscode.TextDocument>, panel: vscode.WebviewPanel): void {
    this.bind(documents.modified, panel, { layout: 'inline', original: documents.original });
  }

  /**
   * Shows `document` in `panel` and keeps the two equal; with `diff`, also the changes against
   * the other document. Returns how to send the webview a message.
   */
  private bind(document: vscode.TextDocument, panel: vscode.WebviewPanel, diff?: DiffBinding): (message: HostMessage) => void {
    const { webview } = panel;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    // Images may come from the document's folder and the workspace; nothing else on disk. A
    // diff's original side is a git: (or other virtual) document; its images are the file's.
    const folder = document.uri.scheme === 'untitled' ? null : vscode.Uri.joinPath(fileUriOf(document.uri), '..');
    const workspace = vscode.workspace.getWorkspaceFolder(fileUriOf(document.uri))?.uri;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [dist, ...(folder ? [folder] : []), ...(workspace ? [workspace] : [])],
    };
    webview.html = webviewHtml({
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview', 'webview.js')).toString(),
      nonce: makeNonce(),
    });

    const post = (message: HostMessage) => void webview.postMessage(message);
    // Edits from this webview are applied one at a time; while one is being applied, the
    // change event it causes is not echoed back.
    let applying = 0;
    let queue = Promise.resolve();

    const apply = async (message: Extract<WebviewMessage, { type: 'edit' }>) => {
      const edit = new vscode.WorkspaceEdit();
      for (const { from, to, text } of message.edits) edit.replace(document.uri, new vscode.Range(from.line, from.ch, to.line, to.ch), text);
      applying++;
      let ok = false;
      try {
        ok = await vscode.workspace.applyEdit(edit);
      } finally {
        applying--;
      }
      post({ type: 'ack', ok });
    };

    // A save (Ctrl+S reaches VS Code without passing the webview's messages) waits for the
    // edits still on their way: the webview answers a flush after the last one it sent, then
    // the queue is applied. Otherwise the last keystrokes missed the save.
    let flushes = 0;
    const flushed = new Map<number, () => void>();
    const flush = () =>
      new Promise<void>((resolve) => {
        const id = ++flushes;
        const done = () => {
          clearTimeout(timer);
          flushed.delete(id);
          resolve();
        };
        // A webview that does not answer (still loading, gone) holds the save up no longer.
        const timer = setTimeout(done, 1000);
        flushed.set(id, done);
        post({ type: 'flush', id });
      }).then(() => queue);

    const compared = diff ? (diff.layout === 'inline' ? diff.original : diff.other) : null;
    const diffInit = (): DiffInit | undefined => {
      if (!diff) return undefined;
      return diff.layout === 'inline'
        ? { layout: 'inline', original: diff.original.getText() }
        : { layout: 'sideBySide', side: diff.side, other: diff.other.getText() };
    };

    const subscriptions = [
      webview.onDidReceiveMessage((message: WebviewMessage) => {
        switch (message.type) {
          case 'ready': {
            const editor = vscode.workspace.getConfiguration('editor', { uri: document.uri, languageId: 'markdown' });
            const tabSize = editor.get<number>('tabSize', 4);
            post({
              type: 'init',
              text: document.getText(),
              eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
              baseUri: folder ? `${webview.asWebviewUri(folder).toString()}/` : null,
              workspaceUri: workspace ? `${webview.asWebviewUri(workspace).toString()}/` : null,
              readOnly: vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) === false,
              indentUnit: editor.get<boolean>('insertSpaces', true) ? ' '.repeat(tabSize) : '\t',
              tabSize,
              diff: diffInit(),
            });
            break;
          }
          case 'edit':
            queue = queue.then(() => apply(message));
            break;
          case 'requestText':
            post({ type: 'update', text: document.getText() });
            break;
          case 'openLink':
            void openLink(message.target, folder, workspace);
            break;
          case 'flushed':
            flushed.get(message.id)?.();
            break;
          case 'diffHeights':
          case 'diffScroll':
            if (diff?.layout === 'sideBySide') diff.relay(message);
            break;
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (!event.contentChanges.length) return;
        if (sameUri(event.document.uri, document.uri) && applying === 0) post({ type: 'update', text: document.getText() });
        // The document compared with changed: typed on the other side, staged, or saved.
        if (compared && sameUri(event.document.uri, compared.uri)) post({ type: 'diffOther', text: compared.getText() });
      }),
      vscode.workspace.onWillSaveTextDocument((event) => {
        if (sameUri(event.document.uri, document.uri)) event.waitUntil(flush());
      }),
    ];
    panel.onDidDispose(() => {
      subscriptions.forEach((s) => s.dispose());
      for (const done of flushed.values()) done();
    });
    return post;
  }
}

/**
 * The file a document is a version of: itself, or for Git's git: documents (the original side
 * of a diff), the file in the working tree, which its query names.
 */
function fileUriOf(uri: vscode.Uri): vscode.Uri {
  if (uri.scheme !== 'git' || !uri.query) return uri;
  try {
    const { path } = JSON.parse(uri.query) as { path?: unknown };
    if (typeof path === 'string' && path) return uri.with({ scheme: 'file', path, query: '' });
  } catch {
    // Not Git's JSON query: use the path as it is.
  }
  return uri.with({ scheme: 'file', query: '' });
}
