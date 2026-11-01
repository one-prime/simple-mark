import { describe, expect, it } from 'vitest';
import { padding, placeSpacers, segmentBounds, segmentHeights } from '../src/diff-align';

// Documents of 10px lines: "a\nb\nc\n" has lines starting at 0, 2, 4 and an empty last line at 6.
const lineTops = (text: string) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return { top: (pos: number) => 10 * (starts.filter((s) => s <= pos).length - 1), bottom: 10 * starts.length };
};

describe('segmentBounds', () => {
  it('cuts the document into gap, chunk, …, gap, clamped to past the last line', () => {
    expect(segmentBounds([{ from: 2, to: 4 }], 6)).toEqual([0, 2, 4, 7]);
    expect(segmentBounds([{ from: 4, to: 9 }], 6)).toEqual([0, 4, 7, 7]);
    expect(segmentBounds([], 0)).toEqual([0, 1]);
  });
});

describe('segmentHeights', () => {
  it('measures each segment, an empty one as 0', () => {
    const { top, bottom } = lineTops('a\nb\nc\n');
    // A chunk of line "b", and an insertion on the other side before line "c" (empty here).
    const bounds = [0, 2, 4, 4, 4, 7];
    expect(segmentHeights(bounds, 6, top, bottom, [])).toEqual([10, 10, 0, 0, 20]);
  });

  it('leaves out this side\'s own spacers, wherever they are drawn', () => {
    // Line "a" has a 25px spacer below it, so the lines after it are 25px lower.
    const top = (pos: number) => (pos < 2 ? 0 : 35 + 10 * (pos >= 4 ? 1 : 0));
    const bounds = [0, 2, 2, 2, 4, 5];
    expect(segmentHeights(bounds, 4, top, 55, [{ pos: 1, height: 25 }])).toEqual([10, 0, 0, 10, 10]);
  });
});

describe('segmentHeights at the document start', () => {
  it('counts a spacer above the first line in the first non-empty segment', () => {
    // "a\nb\n" after an insertion on the other side at the start: an empty gap and chunk here.
    const bounds = [0, 0, 0, 2, 4, 5];
    // A 30px spacer above line "a" belongs to its line block (top 0); "b" starts at 40.
    const top = (pos: number) => (pos === 0 ? 0 : pos === 2 ? 40 : 50);
    expect(segmentHeights(bounds, 4, top, 60, [{ pos: 0, height: 30 }])).toEqual([0, 0, 10, 10, 10]);
  });
});

describe('placeSpacers', () => {
  it('pads below the segment, below the line before an empty one, or above the first line', () => {
    const bounds = [0, 0, 0, 2, 4, 7];
    const spacers = placeSpacers(bounds, [0, 30, 5, 0, 12]);
    expect(spacers).toEqual([
      { pos: 0, side: -2, height: 30, chunk: true },
      { pos: 1, side: 2, height: 5, chunk: false },
      { pos: 6, side: 2, height: 12, chunk: false },
    ]);
  });
});

describe('padding', () => {
  it('pads only the shorter side, and nothing until both sides agree on the segments', () => {
    expect(padding([10, 30, 10], [10, 0, 40])).toEqual([0, 0, 30]);
    expect(padding([10, 30, 10], [10, 0])).toEqual([0, 0, 0]);
    expect(padding([10], null)).toEqual([0]);
  });

  it('makes both sides equally tall at every segment boundary', () => {
    // Original "a\nb\nc\n" against modified "a\nx\ny\nz\nc\n": line "b" became three lines.
    const original = lineTops('a\nb\nc\n');
    const modified = lineTops('a\nx\ny\nz\nc\n');
    const boundsA = [0, 2, 4, 7];
    const boundsB = [0, 2, 8, 11];
    const hA = segmentHeights(boundsA, 6, original.top, original.bottom, []);
    const hB = segmentHeights(boundsB, 10, modified.top, modified.bottom, []);
    const spacersA = placeSpacers(boundsA, padding(hA, hB));
    const spacersB = placeSpacers(boundsB, padding(hB, hA));
    expect(spacersA).toEqual([{ pos: 3, side: 2, height: 20, chunk: true }]);
    expect(spacersB).toEqual([]);
    // With its spacer drawn, the original measures the same, so nothing changes again.
    const shifted = (pos: number) => original.top(pos) + (pos >= 4 ? 20 : 0);
    expect(segmentHeights(boundsA, 6, shifted, original.bottom + 20, spacersA)).toEqual(hA);
  });
});
