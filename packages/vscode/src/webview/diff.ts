// Diff views in the editor webview, in VS Code's diff colors.
//
// Side by side: VS Code gives each side its own webview. Each side highlights its own changed
// lines and text against the other document, and pads with spacers so both line up (see
// ../diff-align.ts); the host relays heights and scroll positions between the two.
// Inline: one webview shows the modified document, with each deleted chunk of the original
// drawn above the lines that replaced it (@codemirror/merge's unified view).

import { Chunk, unifiedMergeView, updateOriginalDoc } from '@codemirror/merge';
import { ChangeSet, EditorState, StateEffect, StateField, Text, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { padding, placeSpacers, segmentBounds, segmentHeights, type SideRange, type Spacer } from '../diff-align';
import type { DiffSide } from '../protocol';
import { diffText } from '../sync';

/** The same limits as @codemirror/merge's own views: very different texts fall back to a fast diff. */
const diffConfig = { scanLimit: 500, timeout: 300 };

/** A text in CodeMirror's form, whatever its line endings. */
export const toText = (text: string) => Text.of(text.split(/\r\n|\r|\n/));

const removedLine = 'var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.2))';
const insertedLine = 'var(--vscode-diffEditor-insertedLineBackground, rgba(155, 185, 85, 0.2))';
const removedText = 'var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.2))';
const insertedText = 'var(--vscode-diffEditor-insertedTextBackground, rgba(156, 204, 44, 0.2))';
const removedBar = 'var(--vscode-editorGutter-deletedBackground, #f14c4c)';
const insertedBar = 'var(--vscode-editorGutter-addedBackground, #2ea043)';
const diagonalFill = 'var(--vscode-diffEditor-diagonalFill, rgba(204, 204, 204, 0.2))';

// Lines color their own backgrounds and borders (code blocks, quotes, headings) with style
// attributes, so the diff color is a layer of its own between the line's background and its
// text, with a bar at the left like VS Code's gutter marks.
const lineMark = (fill: string, bar: string) => ({
  position: 'relative',
  zIndex: '0',
  '&::before': {
    content: '""',
    position: 'absolute',
    inset: '0',
    zIndex: '-1',
    pointerEvents: 'none',
    backgroundColor: fill,
    boxShadow: `inset 3px 0 0 ${bar}`,
  },
});

const diffTheme = EditorView.theme({
  '&.sm-diff-original .sm-diff-line': lineMark(removedLine, removedBar),
  '&.sm-diff-modified .sm-diff-line': lineMark(insertedLine, insertedBar),
  '&.sm-diff-original .sm-diff-text': { backgroundColor: removedText },
  '&.sm-diff-modified .sm-diff-text': { backgroundColor: insertedText },
  '.sm-diff-spacer-chunk': {
    backgroundImage: `repeating-linear-gradient(-45deg, ${diagonalFill} 0 1px, transparent 1px 8px)`,
  },
  // The unified view: inserted lines and text in the inserted colors, the original's deleted
  // lines in a block above them. Its own colors are replaced by VS Code's.
  '&.cm-merge-b .cm-changedLine': { backgroundColor: 'transparent', ...lineMark(insertedLine, insertedBar) },
  '&.cm-merge-b .cm-changedText': { background: insertedText },
  '.cm-deletedChunk': { backgroundColor: removedLine, boxShadow: `inset 3px 0 0 ${removedBar}`, paddingLeft: '6px' },
  '.cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText': { background: removedText },
  '.cm-deletedLine': { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
});

// --- Side by side ----------------------------------------------------------------------------

interface SideState {
  side: DiffSide;
  /** The other side's document. */
  other: Text;
  chunks: readonly Chunk[];
  /** The other side's segment heights, once it has sent them. */
  otherHeights: readonly number[] | null;
}

/** The other side's document changed. */
const setOther = StateEffect.define<Text>();
/** The other side measured its segments. */
const setOtherHeights = StateEffect.define<readonly number[]>();

const sideConfig = StateField.define<SideState | null>({
  create: () => null,
  update(value, tr) {
    if (!value) return value;
    let { other, chunks, otherHeights } = value;
    const original = value.side === 'original';
    if (tr.docChanged) {
      chunks = original
        ? Chunk.updateA(chunks, tr.newDoc, other, tr.changes, diffConfig)
        : Chunk.updateB(chunks, other, tr.newDoc, tr.changes, diffConfig);
    }
    for (const effect of tr.effects) {
      if (effect.is(setOther)) {
        other = effect.value;
        chunks = original ? Chunk.build(tr.newDoc, other, diffConfig) : Chunk.build(other, tr.newDoc, diffConfig);
      } else if (effect.is(setOtherHeights)) otherHeights = effect.value;
    }
    if (other === value.other && chunks === value.chunks && otherHeights === value.otherHeights) return value;
    return { side: value.side, other, chunks, otherHeights };
  },
});

/** This side's part of each chunk. */
function sideRanges(state: SideState): SideRange[] {
  const original = state.side === 'original';
  return state.chunks.map((c) => (original ? { from: c.fromA, to: c.toA } : { from: c.fromB, to: c.toB }));
}

const changedLine = Decoration.line({ class: 'sm-diff-line' });
const changedText = Decoration.mark({ class: 'sm-diff-text' });

/** Changed lines, and the changed text within them. */
const highlights = EditorView.decorations.compute([sideConfig, 'doc'], (state) => {
  const config = state.field(sideConfig);
  if (!config) return Decoration.none;
  const original = config.side === 'original';
  const { doc } = state;
  const ranges: Range<Decoration>[] = [];
  for (const chunk of config.chunks) {
    const from = original ? chunk.fromA : chunk.fromB;
    const to = original ? chunk.toA : chunk.toB;
    if (from >= to) continue;
    const end = original ? chunk.endA : chunk.endB;
    for (let pos = from; pos <= end; ) {
      const line = doc.lineAt(pos);
      ranges.push(changedLine.range(line.from));
      pos = line.to + 1;
    }
    for (const change of chunk.changes) {
      const a = from + (original ? change.fromA : change.fromB);
      const b = from + (original ? change.toA : change.toB);
      if (a < b) ranges.push(changedText.range(a, Math.min(b, doc.length)));
    }
  }
  return Decoration.set(ranges, true);
});

class SpacerWidget extends WidgetType {
  constructor(
    readonly height: number,
    readonly chunk: boolean,
  ) {
    super();
  }
  eq(other: SpacerWidget) {
    return other.height === this.height && other.chunk === this.chunk;
  }
  toDOM() {
    const dom = document.createElement('div');
    dom.className = this.chunk ? 'sm-diff-spacer sm-diff-spacer-chunk' : 'sm-diff-spacer';
    dom.setAttribute('aria-hidden', 'true');
    dom.style.height = `${this.height}px`;
    return dom;
  }
  updateDOM(dom: HTMLElement) {
    dom.className = this.chunk ? 'sm-diff-spacer sm-diff-spacer-chunk' : 'sm-diff-spacer';
    dom.style.height = `${this.height}px`;
    return true;
  }
  get estimatedHeight() {
    return this.height;
  }
  ignoreEvent() {
    return false;
  }
}

/** The spacers drawn now, set after each measurement. */
const setSpacers = StateEffect.define<readonly Spacer[]>();

const spacers = StateField.define<{ list: readonly Spacer[]; decorations: DecorationSet }>({
  create: () => ({ list: [], decorations: Decoration.none }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setSpacers)) continue;
      const list = effect.value;
      const decorations = Decoration.set(
        list.map((s) => Decoration.widget({ widget: new SpacerWidget(s.height, s.chunk), block: true, side: s.side }).range(s.pos)),
        true,
      );
      return { list, decorations };
    }
    // Until the next measurement, spacers move with the text.
    if (tr.docChanged) {
      const list = value.list.map((s) => ({ ...s, pos: tr.changes.mapPos(s.pos, s.side > 0 ? 1 : -1) }));
      return { list, decorations: value.decorations.map(tr.changes) };
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

const sameList = (a: readonly number[] | null, b: readonly number[]) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);
const sameSpacers = (a: readonly Spacer[], b: readonly Spacer[]) =>
  a.length === b.length && a.every((s, i) => s.pos === b[i]!.pos && s.height === b[i]!.height && s.side === b[i]!.side && s.chunk === b[i]!.chunk);

/**
 * Measures this side's segments after each change of text, layout or the other side's
 * heights; sends them when they change, and pads this side to the other's.
 */
function aligner(onHeights: (heights: number[]) => void) {
  return ViewPlugin.fromClass(
    class {
      sent: number[] | null = null;
      frame = 0;
      constructor(readonly view: EditorView) {
        this.schedule();
      }
      update(update: ViewUpdate) {
        const config = update.state.field(sideConfig);
        if (
          update.docChanged ||
          update.geometryChanged ||
          update.heightChanged ||
          update.viewportChanged ||
          config !== update.startState.field(sideConfig)
        ) {
          this.schedule();
        }
      }
      schedule() {
        // In a frame of its own, as @codemirror/merge does: CodeMirror's measure phase may not
        // dispatch, and the height map is up to date once an update has finished.
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          this.measure();
        });
      }
      measure() {
        const { view } = this;
        const config = view.state.field(sideConfig);
        if (!config) return;
        const { doc } = view.state;
        const bounds = segmentBounds(sideRanges(config), doc.length);
        const placed = view.state.field(spacers).list;
        const heights = segmentHeights(bounds, doc.length, (pos) => view.lineBlockAt(pos).top, view.lineBlockAt(doc.length).bottom, placed);
        if (!sameList(this.sent, heights)) {
          this.sent = heights;
          onHeights(heights);
        }
        const wanted = placeSpacers(bounds, padding(heights, config.otherHeights));
        if (!sameSpacers(placed, wanted)) view.dispatch({ effects: setSpacers.of(wanted) });
      }
      destroy() {
        cancelAnimationFrame(this.frame);
      }
    },
  );
}

export interface SideBySideOptions {
  side: DiffSide;
  other: string;
  /** Sends this side's segment heights to the other side. */
  onHeights: (heights: number[]) => void;
}

/** One side of a side-by-side diff. */
export function sideBySideDiff({ side, other, onHeights }: SideBySideOptions): Extension {
  return [
    sideConfig.init((state: EditorState) => {
      const otherDoc = toText(other);
      const chunks = side === 'original' ? Chunk.build(state.doc, otherDoc, diffConfig) : Chunk.build(otherDoc, state.doc, diffConfig);
      return { side, other: otherDoc, chunks, otherHeights: null };
    }),
    highlights,
    spacers,
    aligner(onHeights),
    EditorView.editorAttributes.of({ class: `sm-diff-${side}` }),
    diffTheme,
  ];
}

/** Shows the other side's new text (side by side) or the original's (inline). */
export function setOtherText(view: EditorView, text: string): void {
  const config = view.state.field(sideConfig, false);
  if (config) {
    view.dispatch({ effects: setOther.of(toText(text)) });
    return;
  }
  // Inline: the unified view takes the original's change as a change set.
  const original = getOriginal(view.state);
  if (!original) return;
  const next = toText(text);
  const change = diffText(original.toString(), next.toString());
  if (!change) return;
  const changes = ChangeSet.of({ from: change.from, to: change.to, insert: change.insert }, original.length);
  view.dispatch({ effects: updateOriginalDoc.of({ doc: next, changes }) });
}

/** The other side's measured heights arrived. */
export function setOtherHeightsOf(view: EditorView, heights: readonly number[]): void {
  if (view.state.field(sideConfig, false)) view.dispatch({ effects: setOtherHeights.of(heights) });
}

// --- Inline ----------------------------------------------------------------------------------

/** The original document of an inline diff, kept beside the unified view's own copy. */
const inlineOriginal = StateField.define<Text | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(updateOriginalDoc)) value = effect.value.doc;
    return value;
  },
});

function getOriginal(state: EditorState): Text | null {
  return state.field(inlineOriginal, false) ?? null;
}

/** The modified document with the original's deleted lines drawn above their replacements. */
export function inlineDiff(original: string): Extension {
  const doc = toText(original);
  return [
    inlineOriginal.init(() => doc),
    unifiedMergeView({ original: doc, mergeControls: false, gutter: false, highlightChanges: true, syntaxHighlightDeletions: true, diffConfig }),
    EditorView.editorAttributes.of({ class: 'sm-diff-inline' }),
    diffTheme,
  ];
}
