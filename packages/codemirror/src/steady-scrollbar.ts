// Scrollbar drags that keep up with the mouse.
//
// While the scrollbar thumb is dragged, Chromium (so VS Code too) drops the mouse movement each
// time the scroll height changes, even by 1px, and the thumb never catches up: every drop stays
// as a gap between thumb and mouse. A fast drag draws many new lines and previews, each measured
// a fraction of a pixel off its estimate, so the height changed every few steps and the thumb
// fell behind the mouse by a hundred pixels and more. Estimates cannot be exact to the pixel.
//
// So while the pointer is on the scrollbar the scroll height is held: an invisible element in
// the scroller reaches a little below the content. It grows only in steps, when the content
// passes it, and shrinks only when its blank space below the content comes into view (at the
// end of the document, where the thumb is at the bottom anyway). It is set when the pointer
// arrives, not at the press: Chromium starts a drag with the height it has, and a change at the
// press lost the first move. When the pointer leaves or the drag ends, the held height goes.
//
// On a first visit the big changes come from estimates improving in the background (images
// sized, formulas rendered: over a thousand pixels in the first second), so those refreshes
// wait too (preview-heights.ts): the document keeps one layout during the drag. They come when
// the hold ends, and CodeMirror keeps the text in view where it is.

import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { holdEstimates } from './preview-heights';

/** Room for the content to grow before the held height has to change. */
const HEADROOM_PX = 100;

export const steadyScrollbar = ViewPlugin.fromClass(
  class {
    private readonly reserve: HTMLElement;
    /** The pointer is on the scrollbar. */
    private over = false;
    /** The thumb is being dragged (the pointer may have left the scrollbar). */
    private dragging = false;
    /** The scroll height held, from the top of the content; 0 for none. */
    private held = 0;
    private readonly holdKey = {};
    /** Every listener, added in the constructor and removed in destroy. */
    private readonly listeners: [EventTarget, string, (event: never) => void, AddEventListenerOptions?][];

    constructor(readonly view: EditorView) {
      this.reserve = document.createElement('div');
      this.reserve.className = 'sm-scroll-reserve';
      this.reserve.setAttribute('aria-hidden', 'true');
      this.reserve.style.cssText = 'position: absolute; top: 0; left: 0; width: 1px; height: 0; visibility: hidden; pointer-events: none';
      view.scrollDOM.appendChild(this.reserve);
      const { scrollDOM } = view;
      this.listeners = [
        [scrollDOM, 'pointermove', (event: PointerEvent) => this.setPointer(this.onScrollbar(event), this.dragging)],
        [scrollDOM, 'pointerleave', () => this.setPointer(false, this.dragging)],
        [scrollDOM, 'pointerdown', (event: PointerEvent) => event.button === 0 && this.onScrollbar(event) && this.setPointer(true, true)],
        [scrollDOM, 'scroll', () => this.holding && this.hold(), { passive: true }],
        // Chromium sends no pointer moves during a scrollbar drag, but the pointerup at its end.
        // The pointer may still be on the scrollbar then; its next move there holds again.
        [window, 'pointerup', this.endDrag, { capture: true }],
        [window, 'pointercancel', this.endDrag, { capture: true }],
        [window, 'blur', this.endDrag],
      ];
      for (const [target, type, listener, options] of this.listeners) target.addEventListener(type, listener as EventListener, options);
    }

    private get holding(): boolean {
      return this.over || this.dragging;
    }

    update(update: ViewUpdate): void {
      if (this.holding && (update.heightChanged || update.geometryChanged)) this.hold();
    }

    destroy(): void {
      if (this.holding) holdEstimates(this.view, false, false);
      this.reserve.remove();
      for (const [target, type, listener, options] of this.listeners) target.removeEventListener(type, listener as EventListener, options);
    }

    /** Whether a pointer event is on the vertical scrollbar: right of the client area. */
    private onScrollbar(event: PointerEvent): boolean {
      return event.target === this.view.scrollDOM && event.offsetX >= this.view.scrollDOM.clientWidth;
    }

    private readonly endDrag = (): void => {
      if (this.dragging) this.setPointer(false, false);
    };

    /** Sets where the pointer is and whether it drags; holding starts or ends with them. */
    private setPointer(over: boolean, dragging: boolean): void {
      const was = this.holding;
      this.over = over;
      this.dragging = dragging;
      if (this.holding === was) return;
      if (this.holding) {
        holdEstimates(this.view, true);
        this.hold();
      } else {
        // At the end of the document the view settles on its true end.
        this.setHeld(0);
        holdEstimates(this.view, false);
      }
    }

    /** The bottom of the content, from its top (the scroller is its offset parent). */
    private contentBottom(): number {
      const content = this.view.contentDOM;
      return content.offsetTop + content.offsetHeight;
    }

    private setHeld(height: number): void {
      this.held = height;
      this.reserve.style.height = `${height}px`;
    }

    /**
     * Holds the scroll height: raised in steps when the content passes it, lowered to the content
     * when the blank space below it comes into view.
     */
    private hold(): void {
      this.view.requestMeasure({
        key: this.holdKey,
        read: () => ({ bottom: Math.ceil(this.contentBottom()), viewBottom: this.view.scrollDOM.scrollTop + this.view.scrollDOM.clientHeight }),
        write: ({ bottom, viewBottom }) => {
          if (!this.holding) return;
          if (bottom > this.held) this.setHeld(bottom + HEADROOM_PX);
          else if (viewBottom > bottom + 1 && this.held > bottom) this.setHeld(bottom);
        },
      });
    }
  },
);
