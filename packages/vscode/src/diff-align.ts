// Lines up the two sides of a side-by-side diff, which VS Code shows in two separate webviews.
// No VS Code or DOM: the webview measures, these functions decide.
//
// Each side cuts its document into the same segments: unchanged gap, changed chunk, gap, chunk,
// …, gap. The sides exchange the drawn height of each segment, and where one side's segment is
// shorter, a spacer below it makes up the difference. Then both sides are equally tall at every
// segment boundary, so equal scroll positions show the same place, as in VS Code's diff editor.

/** A changed chunk on one side: from the start of its first line to past its last line. */
export interface SideRange {
  from: number;
  to: number;
}

/**
 * The segment boundaries on one side: 0, then the start and end of each chunk, then the end
 * (`docLength + 1`, past the last line). Segment `k` is `bounds[k]`–`bounds[k + 1]`; even
 * segments are unchanged gaps and odd segments are chunks. Chunk ends may point past the
 * document (as @codemirror/merge's do), so all are clamped.
 */
export function segmentBounds(chunks: readonly SideRange[], docLength: number): number[] {
  const end = docLength + 1;
  const bounds = [0];
  for (const chunk of chunks) bounds.push(Math.min(chunk.from, end), Math.min(chunk.to, end));
  bounds.push(end);
  return bounds;
}

/** A spacer to draw: a block widget at `pos`, below the line (side 2) or above the first (-2). */
export interface Spacer {
  pos: number;
  side: 2 | -2;
  height: number;
  /** Fills in for lines that only the other side has (drawn hatched). */
  chunk: boolean;
}

/** The non-empty segment holding `pos` (a position inside a line or at its end). */
function segmentAt(bounds: readonly number[], pos: number): number {
  for (let k = bounds.length - 2; k >= 0; k--) if (bounds[k]! <= pos && bounds[k + 1]! > pos) return k;
  return 0;
}

/**
 * Where the padding of each segment goes: below the segment's last line, or for a segment empty
 * on this side, below the line before it (above the first line at the document start).
 */
export function placeSpacers(bounds: readonly number[], pads: readonly number[]): Spacer[] {
  const spacers: Spacer[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const height = pads[k] ?? 0;
    if (height <= 0) continue;
    const end = bounds[k + 1]!;
    // The line break ending the segment's last line (or the line before an empty segment); at
    // the document start there is none, so the spacer goes above the first line.
    const pos = end - 1;
    spacers.push(pos < 0 ? { pos: 0, side: -2, height, chunk: k % 2 === 1 } : { pos, side: 2, height, chunk: k % 2 === 1 });
  }
  return spacers;
}

/**
 * The drawn height of each segment without this side's spacers. `top(pos)` is the top of the
 * line block at `pos` (block widgets above or below a line belong to its block); `bottom` is
 * the bottom of the document. A spacer is in the segment of the line it is drawn with.
 */
export function segmentHeights(
  bounds: readonly number[],
  docLength: number,
  top: (pos: number) => number,
  bottom: number,
  spacers: readonly Pick<Spacer, 'pos' | 'height'>[],
): number[] {
  const at = (pos: number) => (pos > docLength ? bottom : top(pos));
  const heights: number[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const from = bounds[k]!;
    const to = bounds[k + 1]!;
    heights.push(from >= to ? 0 : at(to) - at(from));
  }
  for (const spacer of spacers) heights[segmentAt(bounds, Math.min(spacer.pos, docLength))]! -= spacer.height;
  return heights.map((h) => Math.max(0, Math.round(h)));
}

/** How much to pad each segment so it is as tall as the other side's. */
export function padding(mine: readonly number[], other: readonly number[] | null): number[] {
  if (!other || other.length !== mine.length) return mine.map(() => 0);
  return mine.map((h, k) => Math.max(0, other[k]! - h));
}
