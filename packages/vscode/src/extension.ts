// The extension host side: a custom text editor for Markdown. VS Code's TextDocument stays
// the source of truth, so saving, the dirty mark, git and undo/redo work as for any text
// editor; the webview only shows it and sends the user's edits.

import * as vscode from 'vscode';
import { makeNonce, webviewHtml } from './html';
import type { DiffPart, DiffRelay, Edit, HostMessage, LinkTarget, WebviewMessage } from './protocol';
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

/** A webview in VS Code's diff editor: what it shows, and the document it compares with. */
interface DiffBinding {
  part: DiffPart;
  other: vscode.TextDocument;
  /** Side by side: sends a message to the other side's webview. */
  relay?: (message: DiffRelay) => void;
}

type Post = (message: HostMessage) => void;

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
    { original, modified }: vscode.CustomEditorDiffDocuments<vscode.TextDocument>,
    panels: vscode.CustomEditorSideBySideDiffWebviewPanels,
  ): void {
    // Each side's messages for the other go through here. Webviews send none before both are
    // bound, as they start after this returns.
    let toModified: Post = () => {};
    const toOriginal = this.bind(original, panels.original, { part: 'original', other: modified, relay: (message) => toModified(message) });
    toModified = this.bind(modified, panels.modified, { part: 'modified', other: original, relay: toOriginal });
  }

  /** Inline: the modified document, with the original's deleted lines drawn in it. */
  resolveCustomTextEditorInlineDiff({ original, modified }: vscode.CustomEditorDiffDocuments<vscode.TextDocument>, panel: vscode.WebviewPanel): void {
    this.bind(modified, panel, { part: 'inline', other: original });
  }

  /**
   * Shows `document` in `panel` and keeps the two equal; with `diff`, also the changes against
   * the other document. Returns how to send the webview a message (nothing once it is closed).
   */
  private bind(document: vscode.TextDocument, panel: vscode.WebviewPanel, diff?: DiffBinding): Post {
    const { webview } = panel;
    const { folder, workspace } = documentFolders(document);
    this.setUpWebview(webview, folder, workspace);
    let closed = false;
    const post: Post = (message) => {
      if (!closed) void webview.postMessage(message);
    };
    const edits = new WebviewEdits(document, post);

    const subscriptions = [
      webview.onDidReceiveMessage((message: WebviewMessage) => {
        switch (message.type) {
          case 'ready':
            post(initMessage(document, webview, folder, workspace, diff));
            break;
          case 'edit':
            edits.add(message.edits);
            break;
          case 'flushed':
            edits.flushed(message.id);
            break;
          case 'requestText':
            post({ type: 'update', text: document.getText() });
            break;
          case 'openLink':
            void openLink(message.target, folder, workspace);
            break;
          case 'diffHeights':
          case 'diffScroll':
            diff?.relay?.(message);
            break;
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (!event.contentChanges.length) return;
        // The webview's own edits are not echoed back.
        if (sameUri(event.document.uri, document.uri) && !edits.applying) post({ type: 'update', text: document.getText() });
        if (diff && sameUri(event.document.uri, diff.other.uri)) post({ type: 'diffOther', text: diff.other.getText() });
      }),
      vscode.workspace.onWillSaveTextDocument((event) => {
        if (sameUri(event.document.uri, document.uri)) event.waitUntil(edits.flush());
      }),
    ];
    panel.onDidDispose(() => {
      closed = true;
      subscriptions.forEach((s) => s.dispose());
      edits.dispose();
    });
    return post;
  }

  /** The editor page, allowed to load the extension's files and the document's images. */
  private setUpWebview(webview: vscode.Webview, folder: vscode.Uri | null, workspace: vscode.Uri | undefined): void {
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    webview.options = {
      enableScripts: true,
      localResourceRoots: [dist, ...(folder ? [folder] : []), ...(workspace ? [workspace] : [])],
    };
    webview.html = webviewHtml({
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview', 'webview.js')).toString(),
      nonce: makeNonce(),
    });
  }
}

/**
 * Applies a webview's edits to its document, one at a time and in order. While one is being
 * applied, `applying` is true, so the change it causes is not sent back.
 */
class WebviewEdits {
  private pending = 0;
  private queue = Promise.resolve();
  private flushes = 0;
  /** Flushes waiting for the webview's answer, by ID. */
  private readonly waiting = new Map<number, () => void>();

  constructor(
    private readonly document: vscode.TextDocument,
    private readonly post: Post,
  ) {}

  get applying(): boolean {
    return this.pending > 0;
  }

  add(edits: Edit[]): void {
    this.queue = this.queue.then(() => this.apply(edits));
  }

  /** Applies `edits` and tells the webview whether they were (if not, it asks for the text). */
  private async apply(edits: Edit[]): Promise<void> {
    this.pending++;
    let ok = false;
    try {
      const edit = new vscode.WorkspaceEdit();
      for (const { from, to, text } of edits) edit.replace(this.document.uri, new vscode.Range(from.line, from.ch, to.line, to.ch), text);
      ok = await vscode.workspace.applyEdit(edit);
    } catch {
      // Refused (a range outside the document, say): the queue goes on with the next edit.
    } finally {
      this.pending--;
    }
    this.post({ type: 'ack', ok });
  }

  /**
   * Waits for the edits still on their way, before a save: Ctrl+S reaches VS Code without
   * passing the webview's messages, so the save missed the last keystrokes. The webview answers
   * a flush after the last edit it sent; then the queue is applied.
   */
  flush(): Promise<void> {
    return new Promise<void>((resolve) => {
      const id = ++this.flushes;
      const done = () => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve();
      };
      // A webview that does not answer (still loading, gone) holds the save up no longer.
      const timer = setTimeout(done, 1000);
      this.waiting.set(id, done);
      this.post({ type: 'flush', id });
    }).then(() => this.queue);
  }

  /** The webview's answer to flush `id`. */
  flushed(id: number): void {
    this.waiting.get(id)?.();
  }

  dispose(): void {
    for (const done of this.waiting.values()) done();
  }
}

/**
 * Where the document's images and linked files are: its folder (none while untitled) and its
 * workspace folder. For a git: document (an earlier version in a diff), the working file's.
 */
function documentFolders(document: vscode.TextDocument): { folder: vscode.Uri | null; workspace: vscode.Uri | undefined } {
  const file = fileUriOf(document.uri);
  return {
    folder: document.uri.scheme === 'untitled' ? null : vscode.Uri.joinPath(file, '..'),
    workspace: vscode.workspace.getWorkspaceFolder(file)?.uri,
  };
}

/** The document and the settings the editor starts with. */
function initMessage(
  document: vscode.TextDocument,
  webview: vscode.Webview,
  folder: vscode.Uri | null,
  workspace: vscode.Uri | undefined,
  diff: DiffBinding | undefined,
): HostMessage {
  const editor = vscode.workspace.getConfiguration('editor', { uri: document.uri, languageId: 'markdown' });
  const tabSize = editor.get<number>('tabSize', 4);
  return {
    type: 'init',
    text: document.getText(),
    eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
    baseUri: folder ? `${webview.asWebviewUri(folder).toString()}/` : null,
    workspaceUri: workspace ? `${webview.asWebviewUri(workspace).toString()}/` : null,
    readOnly: vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) === false,
    indentUnit: editor.get<boolean>('insertSpaces', true) ? ' '.repeat(tabSize) : '\t',
    tabSize,
    ...(diff ? { diff: { part: diff.part, other: diff.other.getText() } } : {}),
  };
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
