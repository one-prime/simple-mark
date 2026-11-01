// The extension host side: a custom text editor for Markdown. VS Code's TextDocument stays
// the source of truth, so saving, the dirty mark, git and undo/redo work as for any text
// editor; the webview only shows it and sends the user's edits.

import * as vscode from 'vscode';
import { makeNonce, webviewHtml } from './html';
import type { HostMessage, LinkTarget, WebviewMessage } from './protocol';
import { linkPath } from './sync';

const VIEW_TYPE = 'simple-mark.editor';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new SimpleMarkEditorProvider(context.extensionUri), {
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

function activeCustomEditorUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom ? input.uri : undefined;
}

class SimpleMarkEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    // Images may come from the document's folder and the workspace; nothing else on disk.
    const folder = document.uri.scheme === 'untitled' ? null : vscode.Uri.joinPath(document.uri, '..');
    const workspace = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
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
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() !== document.uri.toString() || !event.contentChanges.length || applying > 0) return;
        post({ type: 'update', text: document.getText() });
      }),
    ];
    panel.onDidDispose(() => subscriptions.forEach((s) => s.dispose()));
  }
}
