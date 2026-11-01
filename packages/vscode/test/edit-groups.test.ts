import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import type { Edit } from '../src/protocol';
import { EditGroups } from '../src/webview/edit-groups';

/** An editor state that records what EditGroups sends. */
function setup(doc: string, cursor = doc.length, lineSeparator?: string) {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: lineSeparator ? EditorState.lineSeparator.of(lineSeparator) : [],
  });
  const sent: Edit[][] = [];
  const groups = new EditGroups((edits) => sent.push(edits));
  const apply = (spec: TransactionSpec) => {
    const tr = state.update(spec);
    state = tr.state;
    groups.add(tr);
  };
  /** Types `text` one character at a time at the cursor. */
  const type = (text: string) => {
    for (const ch of text) {
      const at = state.selection.main.head;
      apply({ changes: { from: at, insert: ch }, selection: EditorSelection.cursor(at + 1), userEvent: 'input.type' });
    }
  };
  const backspace = (times: number) => {
    for (let i = 0; i < times; i++) {
      const at = state.selection.main.head;
      apply({ changes: { from: at - 1, to: at }, selection: EditorSelection.cursor(at - 1), userEvent: 'delete.backward' });
    }
  };
  return { sent, groups, apply, type, backspace, get state() { return state; } };
}

describe('EditGroups', () => {
  it('sends a typed word as one edit, and a space starts the next', () => {
    const t = setup('');
    t.type('hello world');
    t.groups.flush();
    expect(t.sent).toEqual([
      [{ from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, text: 'hello' }],
      [{ from: { line: 0, ch: 5 }, to: { line: 0, ch: 5 }, text: ' world' }],
    ]);
  });

  it('keeps a run of deletions together, apart from typing', () => {
    const t = setup('abcdef');
    t.backspace(3);
    t.type('xy');
    t.groups.flush();
    expect(t.sent).toEqual([
      [{ from: { line: 0, ch: 3 }, to: { line: 0, ch: 6 }, text: '' }],
      [{ from: { line: 0, ch: 3 }, to: { line: 0, ch: 3 }, text: 'xy' }],
    ]);
  });

  it('sends other changes at once, each on its own, ending the group before them', () => {
    const t = setup('ab');
    t.type('c');
    t.apply({ changes: { from: 3, insert: '\n' }, selection: EditorSelection.cursor(4), userEvent: 'input' });
    expect(t.sent.length).toBe(2);
    expect(t.groups.waiting).toBe(false);
  });

  it('starts a new group where the cursor moved', () => {
    const t = setup('one two');
    t.type('X');
    t.apply({ selection: EditorSelection.cursor(0) });
    t.type('Y');
    t.groups.flush();
    expect(t.sent.map((edits) => edits.map((e) => e.text))).toEqual([['X'], ['Y']]);
  });

  it('writes line breaks as the document does, positions in lines', () => {
    const t = setup('a\r\nb', 3, '\r\n');
    t.type('c');
    t.apply({ changes: { from: 4, insert: '\r\nd' }, selection: EditorSelection.cursor(6), userEvent: 'input.paste' });
    expect(t.sent).toEqual([
      [{ from: { line: 1, ch: 1 }, to: { line: 1, ch: 1 }, text: 'c' }],
      [{ from: { line: 1, ch: 2 }, to: { line: 1, ch: 2 }, text: '\r\nd' }],
    ]);
  });
});
