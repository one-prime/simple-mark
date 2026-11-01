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

/** Which document of a side-by-side diff a webview shows. */
export type DiffSide = 'original' | 'modified';

/** How the webview shows a diff (the document it edits is the modified one when inline). */
export type DiffInit =
  /** One side of VS Code's side-by-side diff; the other side is in another webview. */
  | { layout: 'sideBySide'; side: DiffSide; other: string }
  /** VS Code's inline diff: the modified document, with the original's deleted lines in it. */
  | { layout: 'inline'; original: string };

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
      /** Set when the webview is part of a diff. */
      diff?: DiffInit;
    }
  /** The document changed outside this webview (undo, another editor, git). */
  | { type: 'update'; text: string }
  /** An `edit` was applied (`ok`) or refused. */
  | { type: 'ack'; ok: boolean }
  /** Before a save: answer `flushed` once every typed change has been sent. */
  | { type: 'flush'; id: number }
  /** In a diff: the document compared with changed (the other side, or the original). */
  | { type: 'diffOther'; text: string }
  /** Side by side: relayed from the other side's webview. */
  | DiffRelay;

/** Between the two webviews of a side-by-side diff, through the host. */
export type DiffRelay =
  /** The drawn height of each segment (gap, chunk, gap, …), to line the sides up. */
  | { type: 'diffHeights'; heights: number[] }
  /** The scroll position, so both sides scroll together. */
  | { type: 'diffScroll'; top: number };

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
  | { type: 'requestText' }
  /** The answer to `flush`: the edits sent before it are all the webview has. */
  | { type: 'flushed'; id: number }
  /** Side by side: for the other side's webview. */
  | DiffRelay;
