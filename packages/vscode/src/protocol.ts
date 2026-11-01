// Messages between the extension host and the editor webview. Positions are line/character
// (both 0-based, characters in UTF-16 units): VS Code counts "\r\n" as two characters and
// CodeMirror as one, so offsets would disagree; lines and characters do not.

export interface LineCh {
  line: number;
  ch: number;
}

/** Replace `from`–`to` (in the document before this edit) with `text`. */
export interface Edit {
  from: LineCh;
  to: LineCh;
  text: string;
}

export type HostMessage =
  /** The document, sent once the webview is ready. */
  | {
      type: 'init';
      text: string;
      eol: '\n' | '\r\n';
      /** The document's folder as a webview URL ending in "/" (null for unsaved documents). */
      baseUri: string | null;
      /** The workspace folder as a webview URL ending in "/", for paths starting with "/". */
      workspaceUri: string | null;
      readOnly: boolean;
      /** What Tab inserts: the user's editor.insertSpaces / editor.tabSize for Markdown. */
      indentUnit: string;
      tabSize: number;
    }
  /** The document changed outside this webview (undo, another editor, git). */
  | { type: 'update'; text: string }
  /** An `edit` was applied (`ok`) or refused. */
  | { type: 'ack'; ok: boolean };

/** A followed link: a web address, or a path as written in the document. */
export interface LinkTarget {
  kind: 'web' | 'file' | 'image';
  url: string;
}

export type WebviewMessage =
  | { type: 'ready' }
  /** Ctrl/Cmd+Click on a link, or a click on an image preview. */
  | { type: 'openLink'; target: LinkTarget }
  /** Changes typed in the webview, all relative to the document before them. */
  | { type: 'edit'; edits: Edit[] }
  /** Asks for an `update` with the whole document, to catch up after a conflict. */
  | { type: 'requestText' };
