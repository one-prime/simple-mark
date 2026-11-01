// Height estimates for previews that are not drawn yet. CodeMirror lays out only what is on
// screen and estimates the rest; a widget without an estimate counts as one line. A document
// with many images was estimated at less than half its height, so while dragging the
// scrollbar fast CodeMirror kept correcting the height and the thumb ran away from the mouse.
//
// So: image sizes are read in the background as soon as a preview exists, formulas are
// rendered in the background, drawn previews remember their measured height, and when
// estimates improve the previews are refreshed (without redrawing those on screen).
//
// A refresh changes the document's height, and while the scrollbar thumb is dragged Chromium
// drops the mouse movement at each change (see steady-scrollbar.ts). On a first visit images
// and formulas arrive during the drag, so an editor can hold its refreshes meanwhile.

import { StateEffect } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { loadMath, loadedMath } from './math-loader';

/**
 * Preview sizes in em of the editor's font: at 15px, 4px above and 8px below a preview, images
 * at most 320px tall and 8px apart. The same numbers as @simple-mark/canvas, so a canvas and the
 * editor agree at any font size (a canvas text may be 48 units tall).
 */
export const PREVIEW_EM = { top: 4 / 15, bottom: 8 / 15, imageMaxHeight: 320 / 15, imageGap: 8 / 15, radius: 4 / 15 };

/** Vertical padding of a preview in pixels, at the editor's font size. */
export function previewPadding(): number {
  return (PREVIEW_EM.top + PREVIEW_EM.bottom) * layout.fontSize;
}
const imageMaxHeight = () => PREVIEW_EM.imageMaxHeight * layout.fontSize;
const imageGap = () => PREVIEW_EM.imageGap * layout.fontSize;

/** Editor facts the estimates depend on, measured by `previewLayout`. */
const layout = { contentWidth: 700, exPx: 8, lineHeight: 24, fontSize: 15, fontFamily: 'sans-serif' };

/** The measured editor facts (content width, line height, resolved text font). */
export function layoutFacts(): Readonly<typeof layout> {
  return layout;
}

const measured = new Map<string, number>();
const imageSizes = new Map<string, { width: number; height: number } | null>();
const probing = new Set<string>();
const mathQueue = new Set<string>();
let mathRunning = false;

const listeners = new Set<() => void>();
let notifyScheduled = false;

/** Tells every editor that estimates improved (batched). */
function estimatesImproved(): void {
  if (notifyScheduled) return;
  notifyScheduled = true;
  setTimeout(() => {
    notifyScheduled = false;
    for (const listener of listeners) listener();
  }, 30);
}

/** Refreshes the previews so their widgets carry the current estimates. */
export const refreshEstimates = StateEffect.define<null>();

/** Editors holding their refreshes, and whether one is waiting. */
const holding = new WeakMap<EditorView, boolean>();

/**
 * Holds `view`'s refreshes (`hold`), or lets them go: a refresh that came meanwhile is done
 * now, unless `refresh` is false (the editor is going away). Call outside an editor update.
 */
export function holdEstimates(view: EditorView, hold: boolean, refresh = true): void {
  if (hold) {
    if (!holding.has(view)) holding.set(view, false);
    return;
  }
  const waiting = holding.get(view);
  holding.delete(view);
  if (waiting && refresh) view.dispatch({ effects: refreshEstimates.of(null) });
}

/** Remembers the height of a drawn preview, as the estimate for when it is off screen. */
export function rememberHeight(view: EditorView, key: string, dom: HTMLElement): void {
  view.requestMeasure({
    read: () => (dom.isConnected ? dom.getBoundingClientRect().height / view.scaleY : 0),
    write: (height) => {
      if (height > 0) measured.set(key, Math.round(height));
    },
  });
}

// ---- images ------------------------------------------------------------------------------------

type ImageSize = { width: number; height: number };
const sizeWaiters = new Map<string, ((size: ImageSize | null) => void)[]>();

function sizeKnown(src: string, size: ImageSize | null): void {
  if (imageSizes.has(src)) return;
  imageSizes.set(src, size);
  for (const waiter of sizeWaiters.get(src) ?? []) waiter(size);
  sizeWaiters.delete(src);
  estimatesImproved();
}

/**
 * Watches an image until its size is known. The size is in the first bytes of the file, so it
 * is checked every frame while loading instead of waiting for the whole (possibly large) file.
 */
export function watchImage(img: HTMLImageElement, src: string): void {
  if (imageSizes.has(src)) return;
  // SVGs without a size of their own are drawn 300 × 150, like any replaced element.
  const natural = () => (img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : { width: 300, height: 150 });
  img.addEventListener('load', () => sizeKnown(src, natural()));
  img.addEventListener('error', () => sizeKnown(src, null));
  const check = () => {
    if (imageSizes.has(src) || img.complete) return;
    if (img.naturalWidth > 0) sizeKnown(src, natural());
    else requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}

/** The size of an image if known: null if it failed, undefined while unknown. */
export function knownImageSize(src: string): ImageSize | null | undefined {
  return imageSizes.get(src);
}

/** Calls `then` once the image's size is known (someone must be watching or probing it). */
export function whenImageSized(src: string, then: (size: ImageSize | null) => void): void {
  const size = imageSizes.get(src);
  if (size !== undefined) return then(size);
  const waiters = sizeWaiters.get(src) ?? [];
  waiters.push(then);
  sizeWaiters.set(src, waiters);
}

/** Gives an <img> its final layout size before its pixels arrive (CSS caps it at the width). */
export function reserveImageBox(img: HTMLImageElement, size: ImageSize): void {
  img.style.aspectRatio = `${size.width} / ${size.height}`;
  img.style.width = `${Math.min(size.width, (imageMaxHeight() * size.width) / size.height)}px`;
}

function probeImage(src: string): void {
  if (probing.has(src) || imageSizes.has(src) || typeof Image === 'undefined') return;
  probing.add(src);
  const img = new Image();
  watchImage(img, src);
  img.src = src;
}

/** Displayed size of one image: fits the width, at most `imageMaxHeight` tall, never enlarged. */
function imageBox(src: string | null): { width: number; height: number } {
  const errorLine = { width: layout.contentWidth, height: layout.lineHeight };
  if (src === null) return errorLine;
  const size = imageSizes.get(src);
  if (size === undefined) {
    probeImage(src);
    return { width: layout.contentWidth, height: imageMaxHeight() / 2 };
  }
  if (size === null) return errorLine;
  const scale = Math.min(1, layout.contentWidth / size.width, imageMaxHeight() / size.height);
  return { width: size.width * scale, height: size.height * scale };
}

/** Estimated height of a row of images (they wrap like the CSS flex row). */
export function imagesEstimate(key: string, srcs: readonly (string | null)[]): number {
  const known = measured.get(key);
  if (known) return known;
  let total = 0;
  let rowWidth = 0;
  let rowHeight = 0;
  for (const src of srcs) {
    const box = imageBox(src);
    if (rowWidth > 0 && rowWidth + imageGap() + box.width > layout.contentWidth) {
      total += rowHeight + imageGap();
      rowWidth = 0;
      rowHeight = 0;
    }
    rowWidth += (rowWidth > 0 ? imageGap() : 0) + box.width;
    rowHeight = Math.max(rowHeight, box.height);
  }
  return Math.round(total + rowHeight + previewPadding());
}

// ---- math --------------------------------------------------------------------------------------

/** Renders queued formulas one at a time, so their heights are known before they are shown. */
function renderQueuedMath(): void {
  if (mathRunning) return;
  mathRunning = true;
  void loadMath().then(async (math) => {
    let done = 0;
    for (const tex of mathQueue) {
      await math.renderMath(tex, true);
      mathQueue.delete(tex);
      if (++done % 10 === 0) estimatesImproved();
      await new Promise((resolve) => setTimeout(resolve, 0)); // let typing and scrolling run
    }
    mathRunning = false;
    estimatesImproved();
    if (mathQueue.size) renderQueuedMath();
  });
}

/** Estimated height of a display formula: from its rendered SVG, once known. */
export function mathEstimate(key: string, tex: string): number {
  const known = measured.get(key);
  if (known) return known;
  const result = loadedMath()?.cachedMath(tex, true);
  if (result?.svg !== undefined) {
    const height = /height="([\d.]+)ex"/.exec(result.svg);
    if (height) return Math.round(parseFloat(height[1]!) * layout.exPx + previewPadding());
  } else if (result?.error !== undefined) {
    return layout.lineHeight + previewPadding();
  } else {
    mathQueue.add(tex);
    renderQueuedMath();
  }
  return 3 * layout.lineHeight + previewPadding();
}

// ---- layout ------------------------------------------------------------------------------------

/** Measures the editor (content width, x-height, line height) and refreshes previews on news. */
export const previewLayout = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      listeners.add(this.refresh);
      this.measure();
    }

    update(update: ViewUpdate): void {
      if (update.geometryChanged) this.measure();
    }

    destroy(): void {
      listeners.delete(this.refresh);
    }

    refresh = (): void => {
      if (holding.has(this.view)) holding.set(this.view, true);
      else this.view.dispatch({ effects: refreshEstimates.of(null) });
    };

    measure(): void {
      this.view.requestMeasure({
        read: (view) => {
          const style = getComputedStyle(view.contentDOM);
          const width = view.contentDOM.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          const ctx = document.createElement('canvas').getContext('2d');
          let exPx = layout.exPx;
          if (ctx) {
            ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            exPx = ctx.measureText('x').actualBoundingBoxAscent || exPx;
          }
          // The base line height from CSS: view.defaultLineHeight comes from whichever short
          // plain line CodeMirror measured, which can be a (bigger) heading.
          const lineHeight = style.lineHeight.endsWith('px') ? parseFloat(style.lineHeight) : view.defaultLineHeight;
          return { contentWidth: width, exPx, lineHeight, fontSize: parseFloat(style.fontSize), fontFamily: style.fontFamily };
        },
        write: (next) => {
          const moved =
            Math.abs(next.contentWidth - layout.contentWidth) > 1 ||
            Math.abs(next.exPx - layout.exPx) > 0.2 ||
            Math.abs(next.lineHeight - layout.lineHeight) > 0.5 ||
            next.fontSize !== layout.fontSize ||
            next.fontFamily !== layout.fontFamily;
          if (moved && next.contentWidth > 0) {
            // Images scale with the width, so heights measured at another width are stale.
            if (Math.abs(next.contentWidth - layout.contentWidth) > 1) measured.clear();
            Object.assign(layout, next);
            estimatesImproved();
          }
        },
      });
    }
  },
);
