// Typed changes grouped into one edit each, as VS Code's text editor groups them into undo
// steps. VS Code owns undo for the document, and each edit the host applies is one step; one
// edit per keystroke made Ctrl+Z take back a single character.
//
// A group is a run of typing, or a run of deleting, at the cursor. It ends when another kind
// of change comes (Enter, paste, Tab, table commands), the cursor moves away, or a space
// follows a word (so the space starts the next word's step, as in VS Code). The webview also
// sends a group after a pause and before VS Code needs the document (see main.ts).

import type { ChangeSet, Text, Transaction } from '@codemirror/state';
import type { Edit } from '../protocol';

type Kind = 'type' | 'delete';

/** Typing (IME composition included) or deleting; null for changes that stand alone. */
function kindOf(tr: Transaction): Kind | null {
  if (tr.isUserEvent('input.type')) return 'type';
  if (tr.isUserEvent('delete.backward') || tr.isUserEvent('delete.forward')) return 'delete';
  return null;
}

function insertedText(tr: Transaction): string {
  let text = '';
  tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    text += inserted.toString();
  });
  return text;
}

interface Group {
  /** The document before the group's first change. */
  start: Text;
  changes: ChangeSet;
  kind: Kind | null;
  /** The cursor after the last change. */
  head: number;
  /** The last character typed, for the word rule. */
  lastChar: string;
  lineBreak: string;
}

/** Line/character edits of `changes`, positions in `start`, line breaks as `lineBreak`. */
export function toEdits(start: Text, changes: ChangeSet, lineBreak: string): Edit[] {
  const edits: Edit[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const from = start.lineAt(fromA);
    const to = start.lineAt(toA);
    edits.push({
      from: { line: from.number - 1, ch: fromA - from.from },
      to: { line: to.number - 1, ch: toA - to.from },
      text: inserted.sliceString(0, inserted.length, lineBreak),
    });
  });
  return edits;
}

export class EditGroups {
  private group: Group | null = null;

  /** `send` gets each finished group as one edit. */
  constructor(private readonly send: (edits: Edit[]) => void) {}

  /** Whether typed changes are waiting to be sent. */
  get waiting(): boolean {
    return this.group !== null;
  }

  /** Adds a change typed in the editor (a transaction without one is ignored). */
  add(tr: Transaction): void {
    if (!tr.docChanged) return;
    const kind = kindOf(tr);
    const inserted = kind === 'type' ? insertedText(tr) : '';
    const group = this.group;
    if (group) {
      const continues =
        kind !== null &&
        kind === group.kind &&
        tr.startState.selection.main.head === group.head &&
        !(kind === 'type' && /^\s/.test(inserted) && group.lastChar !== '' && !/\s/.test(group.lastChar));
      if (continues) {
        group.changes = group.changes.compose(tr.changes);
        group.head = tr.state.selection.main.head;
        if (inserted) group.lastChar = inserted.slice(-1);
        return;
      }
      this.flush();
    }
    this.group = {
      start: tr.startState.doc,
      changes: tr.changes,
      kind,
      head: tr.state.selection.main.head,
      lastChar: inserted.slice(-1),
      lineBreak: tr.state.lineBreak,
    };
    if (kind === null) this.flush();
  }

  /** Sends the waiting group, if any. */
  flush(): void {
    const group = this.group;
    if (!group) return;
    this.group = null;
    this.send(toEdits(group.start, group.changes, group.lineBreak));
  }
}
