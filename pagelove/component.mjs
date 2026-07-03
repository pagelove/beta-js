/**
 * PageloveComponent — canonical Web Component base for Pagelove view types.
 *
 * A PageloveComponent is the visible counterpart of a schema <article>. The
 * schema article is the resource (POSTed/PUT/DELETEd, observed by pagelove.mjs);
 * the component is its rendered light-DOM view, bound by `data-bind` /
 * `data-bind-attr` and kept in sync via a per-instance MutationObserver on the
 * schema.
 *
 * Components are auto-defined by pagelove.mjs from <template> roots whose tag
 * name contains a hyphen. Apps that need custom subclasses register them
 * explicitly with customElements.define before pagelove.mjs runs.
 */
import { Pagelove as Debug } from './debug.mjs';

/**
 * A binder describes one binding type:
 *   collect(root) → iterable of { element, propNames: [...] }
 *   apply(element, propName, value) — MUST be idempotent (compare-before-write)
 *   listen?(element, propName, set) — optional view→schema callback
 *
 * The base class ships with two: `data-bind` and `data-bind-attr`.
 */
const dataBindBinder = {
  collect(root) {
    return [...root.querySelectorAll('[data-bind]')].map(el => ({
      element: el,
      propNames: [el.dataset.bind],
    }));
  },
  apply(element, propName, value) {
    if ('value' in element && element.tagName !== 'BUTTON') {
      if (element.value !== value) element.value = value;
    } else {
      if (element.textContent !== value) element.textContent = value;
    }
  },
  // No listen() — pagelove.mjs's delegated change/focusout/input handlers
  // already drive view→schema commits for [data-bind] elements.
};

const dataBindAttrBinder = {
  collect(root) {
    if (!root.dataset.bindAttr) return [];
    return [{
      element: root,
      propNames: root.dataset.bindAttr.split(/\s+/).filter(Boolean),
    }];
  },
  apply(element, propName, value) {
    const str = String(value);
    if (element.dataset[propName] !== str) element.dataset[propName] = str;
  },
  // No listen() — pagelove.mjs's view-attr MutationObserver picks up
  // dataset changes and writes them through to the schema.
};

export class PageloveComponent extends HTMLElement {
  static itemtype = null;
  static binders = [dataBindBinder, dataBindAttrBinder];

  #schemaArticle = null;
  #observer = null;
  #propIndex = new Map(); // propName → [{ element, binder }]
  #renderTargets = []; // [{ propName, mode: 'stamp'|'contains', target, stamp? }]
  #internals = null;

  constructor() {
    super();
    // ElementInternals gives us CSS `:state(name)` support so mixins can
    // toggle declarative states (e.g. :state(drag-over)) without touching
    // classes or attributes.
    try { this.#internals = this.attachInternals(); } catch (_) {}
  }

  /**
   * Toggle a custom state on this element. Matches via CSS `:state(name)`.
   * Requires ElementInternals; a no-op in environments without it.
   */
  setState(name, active) {
    const states = this.#internals?.states;
    if (!states) return;
    if (active) states.add(name);
    else states.delete(name);
  }

  /** Build a new schema article via pagelove.mjs's create() factory. */
  static create(values = {}) {
    if (!window.pagelove) throw new Error('pagelove.mjs has not initialized yet');
    if (!this.itemtype) throw new Error(`${this.name} has no static itemtype`);
    return window.pagelove.create(this.itemtype, values);
  }

  connectedCallback() {
    const id = this.dataset.for;
    if (!id) return;
    this.#schemaArticle = document.getElementById(id);
    if (!this.#schemaArticle) {
      Debug.warn(Debug.SCHEMA, '[PLComponent] no schema article for', id);
      return;
    }

    this.#buildIndex();
    this.#initialBind();
    this.#collectRenderTargets();
    this.#renderChildren();
    this.#startObserver();
  }

  disconnectedCallback() {
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
    this.#propIndex.clear();
    this.#renderTargets = [];
    this.#schemaArticle = null;
  }

  /**
   * Re-render this component's nested child collections from the current
   * schema article. Called by the host Pagelove patcher (#patchArticle) when a
   * child-level schema change (add / remove / move) lands inside this
   * component's article — so the component rebuilds its own children in place
   * instead of being overwritten by an unconnected clone's (empty) child
   * containers, which would wipe the nested collection until a full reload.
   *
   * Re-runs only #renderChildren, NOT #collectRenderTargets: target collection
   * is one-time (a data-render-stamp element is removed from the DOM when first
   * collected, so re-collecting would lose it). #renderChildren is idempotent —
   * it clears previously-rendered child views before re-rendering. No-op until
   * the component has connected (no schema article / render targets yet).
   */
  renderChildren() {
    this.#renderChildren();
  }

  /** Write a property value to the schema article. Used by mixins/subclasses. */
  _set(propName, value) {
    if (!this.#schemaArticle) return;
    let el = this.#schemaArticle.querySelector(`:scope > [itemprop="${propName}"]`);
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute('itemprop', propName);
      this.#schemaArticle.appendChild(el);
    }
    if (el.tagName === 'META') {
      if (el.getAttribute('content') !== String(value)) {
        el.setAttribute('content', String(value));
      }
    } else if (el.tagName === 'TIME') {
      if (el.getAttribute('datetime') !== String(value)) {
        el.setAttribute('datetime', String(value));
      }
    } else {
      if (el.textContent !== String(value)) el.textContent = String(value);
    }
  }

  /** Read a schema property value. */
  _get(propName) {
    if (!this.#schemaArticle) return undefined;
    const el = this.#schemaArticle.querySelector(`:scope > [itemprop="${propName}"]`);
    if (!el) return undefined;
    if (el.tagName === 'META') return el.getAttribute('content') || '';
    if (el.tagName === 'TIME') return el.getAttribute('datetime') || '';
    return el.textContent.trim();
  }

  /** Walk the static binders to build a propName → [{element, binder}] index. */
  #buildIndex() {
    this.#propIndex.clear();
    for (const binder of this.constructor.binders) {
      for (const { element, propNames } of binder.collect(this)) {
        for (const propName of propNames) {
          if (!propName) continue;
          if (!this.#propIndex.has(propName)) this.#propIndex.set(propName, []);
          this.#propIndex.get(propName).push({ element, binder });
        }
      }
    }
  }

  /**
   * Scan this component's subtree for `data-render-stamp="prop"` and
   * `data-render-contains="prop"` markers. If any are found, they determine
   * where children of the schema article get rendered (and, for stamps,
   * how each child is wrapped). If none are found, an implicit
   * "contains" target is created on the component root — children render
   * as direct children of `this`.
   */
  #collectRenderTargets() {
    this.#renderTargets = [];
    // Stamps: the marked element is a per-child wrapper template. Its parent
    // becomes the insertion point. The stamp is removed from the initial
    // rendered output and cloned per child.
    for (const stamp of this.querySelectorAll('[data-render-stamp]')) {
      const propName = stamp.dataset.renderStamp;
      if (!propName) continue;
      const parent = stamp.parentElement;
      if (!parent) continue;
      // Clone the stamp as a template so subsequent re-renders work,
      // then remove the original from the rendered DOM.
      const stampTemplate = stamp.cloneNode(true);
      stampTemplate.removeAttribute('data-render-stamp');
      stamp.remove();
      this.#renderTargets.push({
        propName, mode: 'stamp', target: parent, stamp: stampTemplate,
      });
    }
    // Contains: children of the named property render as direct children
    // of the marked element.
    for (const contains of this.querySelectorAll('[data-render-contains]')) {
      const propName = contains.dataset.renderContains;
      if (!propName) continue;
      this.#renderTargets.push({
        propName, mode: 'contains', target: contains, stamp: null,
      });
    }
    // Implicit default: if no markers were found, treat `this` itself as
    // a contains target for any child property.
    if (this.#renderTargets.length === 0) {
      this.#renderTargets.push({
        propName: null, mode: 'contains', target: this, stamp: null,
      });
    }
  }

  /**
   * Render all child schema articles into their render targets. Each
   * target renders the children whose itemprop matches its propName
   * (or, for the implicit default, every child that has an itemprop and
   * a registered template). Existing rendered children are replaced.
   */
  #renderChildren() {
    if (!this.#schemaArticle) return;
    const pagelove = window.pagelove;
    if (!pagelove) return;

    for (const rt of this.#renderTargets) {
      // Remove any previously-rendered child views in this target.
      for (const existing of [...rt.target.children]) {
        if (existing.dataset?.for) existing.remove();
        else if (rt.mode === 'stamp' && existing.querySelector?.('[data-for]')) existing.remove();
      }

      // Figure out which schema children to render here.
      const children = rt.propName
        ? [...this.#schemaArticle.querySelectorAll(`:scope > [itemprop="${rt.propName}"]`)]
        : [...this.#schemaArticle.children].filter(el =>
            el.hasAttribute('itemprop') && el.hasAttribute('itemscope')
          );

      for (const childSchema of children) {
        if (!childSchema.id) continue;
        const childView = pagelove.renderArticle(childSchema);
        if (!childView) continue;
        if (rt.mode === 'stamp') {
          const wrapper = rt.stamp.cloneNode(true);
          wrapper.appendChild(childView);
          rt.target.appendChild(wrapper);
        } else {
          rt.target.appendChild(childView);
        }
      }
    }
  }

  #initialBind() {
    for (const [propName, entries] of this.#propIndex) {
      const value = this._get(propName);
      if (value === undefined) continue;
      for (const { element, binder } of entries) {
        binder.apply(element, propName, value);
      }
    }
  }

  #startObserver() {
    this.#observer = new MutationObserver((mutations) => {
      const dirtyProps = new Set();
      for (const m of mutations) {
        let node;
        if (m.type === 'characterData') node = m.target.parentElement;
        else if (m.type === 'attributes') node = m.target;
        else if (m.type === 'childList') {
          // A new itemprop element was added under the schema article.
          for (const n of m.addedNodes) {
            if (n.nodeType === 1) {
              const ip = n.getAttribute?.('itemprop');
              if (ip) dirtyProps.add(ip);
            }
          }
          continue;
        }
        if (!node) continue;
        const ip = node.getAttribute?.('itemprop');
        if (ip) dirtyProps.add(ip);
      }
      for (const propName of dirtyProps) {
        const value = this._get(propName);
        if (value === undefined) continue;
        const entries = this.#propIndex.get(propName);
        if (!entries) continue;
        for (const { element, binder } of entries) {
          binder.apply(element, propName, value);
        }
      }
    });
    this.#observer.observe(this.#schemaArticle, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['content', 'datetime'],
    });
  }
}

// ── Mixin registry ──────────────────────────────────────────────────

/**
 * (selector, mixinFn) pairs. Auto-registration matches the template root
 * against each selector and stacks the matching mixins on PageloveComponent.
 *
 * Composition order: earlier-registered = inner (closer to PageloveComponent),
 * later-registered = outer (wraps the previous). Documented and stable.
 */
const componentMixins = [];

export function registerComponentMixin(selector, mixinFn) {
  componentMixins.push([selector, mixinFn]);
}

export function getMatchingMixins(rootElement) {
  return componentMixins
    .filter(([selector]) => {
      try { return rootElement.matches(selector); } catch (_) { return false; }
    })
    .map(([, mixinFn]) => mixinFn);
}

// ── Draggable mixin ─────────────────────────────────────────────────

/**
 * Draggable — pointer-events drag positioning. Writes data-x / data-y on
 * release; pagelove.mjs's view-attr observer picks the change up and
 * commits it to the schema. Mid-drag visual feedback uses style.left/top
 * so we don't PUT on every pointer move.
 */
export const Draggable = (Base) => class extends Base {
  #dragState = null;
  #savedStyles = null;        // pre-drag inline styles, restored by #clearFloating
  #currentDropTarget = null;  // whatever [data-droppable/sortable] the pointer is currently over
  #onPointerDown;
  #onPointerMove;
  #onPointerUp;

  #updateDropTarget(clientX, clientY) {
    // pointer-events is already 'none' on `this` during drag, so
    // elementFromPoint sees the layout underneath.
    const hit = document.elementFromPoint(clientX, clientY);
    const next = hit?.closest?.('[data-droppable], [data-sortable]') || null;
    if (next === this.#currentDropTarget) return next;
    if (this.#currentDropTarget?.setState) {
      this.#currentDropTarget.setState('drag-over', false);
    }
    if (next && next !== this && next.setState) {
      next.setState('drag-over', true);
    }
    this.#currentDropTarget = next;
    return next;
  }

  connectedCallback() {
    super.connectedCallback?.();
    // Explicitly disable native HTML5 drag on the host. It would otherwise
    // hijack mousedown on contenteditable descendants, breaking text editing.
    this.setAttribute('draggable', 'false');
    this.#onPointerDown = (e) => this.#startDrag(e);
    this.#onPointerMove = (e) => this.#onMove(e);
    this.#onPointerUp   = (e) => this.#endDrag(e);
    this.addEventListener('pointerdown', this.#onPointerDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback?.();
    this.removeEventListener('pointerdown', this.#onPointerDown);
    if (this.#dragState) {
      window.removeEventListener('pointermove', this.#onPointerMove);
      window.removeEventListener('pointerup',   this.#onPointerUp);
      this.#dragState = null;
    }
  }

  #startDrag(e) {
    if (e.target.closest('[contenteditable], select, input, button')) return;
    if (this.querySelector(':scope [data-drag-handle]') &&
        !e.target.closest('[data-drag-handle]')) return;
    e.preventDefault();

    // Capture the element's visual position BEFORE any class changes that
    // might remove CSS transforms (e.g. :hover translateY). This ensures
    // the fixed-position promotion matches the exact pixel the user sees.
    const rect = this.getBoundingClientRect();
    const offsetParent = this.offsetParent || document.body;

    // Raise to top of sibling z-order. Mirrors Stackable's #raise logic
    // but runs unconditionally here — Safari's capture-phase pointerdown
    // doesn't always reach the custom element before Draggable's bubble-
    // phase handler, so Stackable's raise may not have fired yet.
    const parent = this.parentElement;
    if (parent) {
      let max = 0;
      for (const sib of parent.children) {
        if (sib === this) continue;
        const n = parseInt(sib.dataset?.z, 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
      const mine = parseInt(this.dataset.z, 10) || 0;
      if (mine <= max) this.dataset.z = String(max + 1);
    }

    this.#dragState = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startRectLeft: rect.left,
      startRectTop: rect.top,
      startWidth: rect.width,
      offsetParent,
      promoted: false,
      moved: false,
    };
    this.classList.add('dragging');
    // Promote to fixed positioning immediately — in the same synchronous
    // block as classList.add('dragging') — so the browser never paints an
    // intermediate frame where the hover CSS transform is gone but the
    // element hasn't been promoted yet (which causes a visible judder in
    // Safari).
    this.#promoteToFloating();
    this.style.transform = 'translate(0px, 0px)';
    window.addEventListener('pointermove', this.#onPointerMove);
    window.addEventListener('pointerup',   this.#onPointerUp);
  }

  #promoteToFloating() {
    const s = this.#dragState;
    // Save current inline styles before overwriting. Other systems — the
    // css-attr-polyfill (left/top/width from data attrs), Stackable
    // (zIndex), Resizable (width/height) — set inline styles that we'd
    // destroy if we blanked them on drag end. Save-and-restore is the
    // generic fix.
    this.#savedStyles = {
      position: this.style.position,
      left:     this.style.left,
      top:      this.style.top,
      width:    this.style.width,
      height:   this.style.height,
      margin:   this.style.margin,
      zIndex:   this.style.zIndex,
      pointerEvents: this.style.pointerEvents,
      transform: this.style.transform,
    };
    // Promote to position: fixed so we escape any clipping ancestor (e.g.
    // a scrollable column with overflow: auto). Start at the element's
    // current viewport position; translate() will track pointer delta.
    this.style.position = 'fixed';
    this.style.left = s.startRectLeft + 'px';
    this.style.top  = s.startRectTop + 'px';
    this.style.width = s.startWidth + 'px';
    this.style.margin = '0';
    this.style.zIndex = '10000';
    this.style.pointerEvents = 'none';
    s.promoted = true;
  }

  #clearFloating() {
    // Restore pre-drag inline styles so the polyfill, Stackable, Resizable
    // etc. don't lose their inline-style-driven values.
    if (this.#savedStyles) {
      for (const [prop, val] of Object.entries(this.#savedStyles)) {
        this.style[prop] = val;
      }
      this.#savedStyles = null;
    }
  }

  #onMove(e) {
    if (!this.#dragState) return;
    this.#dragState.moved = true;
    const dx = e.clientX - this.#dragState.startClientX;
    const dy = e.clientY - this.#dragState.startClientY;
    this.style.transform = `translate(${dx}px, ${dy}px)`;
    this.#updateDropTarget(e.clientX, e.clientY);
  }

  #endDrag(e) {
    if (!this.#dragState) return;
    window.removeEventListener('pointermove', this.#onPointerMove);
    window.removeEventListener('pointerup',   this.#onPointerUp);
    const { moved, startClientX, startClientY, startRectLeft, startRectTop, offsetParent } = this.#dragState;
    const dx = e.clientX - startClientX;
    const dy = e.clientY - startClientY;
    this.#dragState = null;
    if (!moved) {
      this.classList.remove('dragging');
      this.#clearFloating();
      return;
    }

    // pointer-events is already 'none' (set by #promoteToFloating), so
    // elementFromPoint sees the layout beneath our floating preview.
    const target = this.#updateDropTarget(e.clientX, e.clientY);

    if (this.#currentDropTarget?.setState) {
      this.#currentDropTarget.setState('drag-over', false);
    }
    this.#currentDropTarget = null;

    // A deliberate drag-drop should not be blocked by pagelove.mjs's focus
    // protection on #patchArticle. If a contenteditable inside the target
    // lane still has focus from a prior edit, blur it so the schema mutation's
    // re-render isn't deferred.
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }

    // Walk up the ancestor chain of [data-droppable]/[data-sortable] targets,
    // dispatching PLDropAttempt to each until one claims it. This lets a lane's
    // Sortable/Droppable get first shot (for card drops), and if it passes, the
    // board-level handler can catch lane reorders.
    let dropTarget = target;
    while (dropTarget && dropTarget !== this) {
      const attempt = new CustomEvent('PLDropAttempt', {
        bubbles: false,
        cancelable: true,
        detail: { draggable: this, clientX: e.clientX, clientY: e.clientY },
      });
      const handled = !dropTarget.dispatchEvent(attempt);
      if (handled) {
        this.classList.remove('dragging');
        // Remove the old view from the DOM entirely. The drop handler's
        // schema mutation triggers a re-render that creates a fresh view
        // at the new position. Using display:none would leave a hidden
        // element in the DOM that could interfere with focus protection
        // and prevent the re-render from firing.
        this.remove();
        return;
      }
      dropTarget = dropTarget.parentElement?.closest?.('[data-droppable], [data-sortable]') || null;
    }

    // Fall-through: free-form x/y commit — only meaningful for elements
    // that bind x/y via data-bind-attr (moodboard items with position:
    // absolute). For everything else (kanban cards in flex flow), setting
    // inline left/top would offset the card from its natural position.
    // Just clear the floating styles and return.
    const bindsXY = this.dataset.bindAttr?.split(/\s+/).includes('x');
    if (!bindsXY) {
      this.style.transition = 'none';
      this.classList.remove('dragging');
      this.#clearFloating();
      void this.offsetHeight;
      this.style.transition = '';
      return;
    }

    // Compute the final position from the element's visual drop point
    // (viewport coords from the fixed+translate positioning) converted
    // to the offset parent's coordinate space.
    const visualLeft = startRectLeft + dx;
    const visualTop  = startRectTop  + dy;
    const op = offsetParent || document.body;
    const opRect = op.getBoundingClientRect();
    const newX = Math.round(visualLeft - opRect.left + op.scrollLeft);
    const newY = Math.round(visualTop  - opRect.top  + op.scrollTop);
    // Disable CSS transitions so the style restoration doesn't animate
    // (e.g. a `transform 0.15s` transition would ghost-slide the element
    // as `translate(dx,dy)` transitions to `none`).
    this.style.transition = 'none';
    this.classList.remove('dragging');
    this.dataset.x = String(newX);
    this.dataset.y = String(newY);
    if (this.#savedStyles) {
      this.style.position = this.#savedStyles.position;
      this.style.left   = newX + 'px';
      this.style.top    = newY + 'px';
      this.style.width  = this.#savedStyles.width;
      this.style.height = this.#savedStyles.height;
      this.style.margin = this.#savedStyles.margin;
      this.style.zIndex = this.#savedStyles.zIndex;
      this.style.pointerEvents = this.#savedStyles.pointerEvents;
      this.style.transform = this.#savedStyles.transform;
      this.#savedStyles = null;
    }
    // Force the browser to commit transition:none before re-enabling,
    // so the restored styles don't trigger any animation.
    void this.offsetHeight;
    this.style.transition = '';
  }
};

// Register Draggable as the default selector-driven mixin.
// We use `data-draggable` rather than the native `draggable` attribute so we
// don't engage the browser's HTML5 drag-and-drop, which would otherwise
// hijack mousedowns on contenteditable descendants.
registerComponentMixin('[data-draggable]', Draggable);

// ── Resizable mixin ─────────────────────────────────────────────────

/**
 * Resizable — adds a small corner handle (a child div with a known class)
 * and drives resize via pointer events. Cross-browser, identical look on
 * Chrome and Safari. Writes data-width / data-height on resize end so
 * pagelove.mjs's view-attr observer commits the new size to the schema;
 * CSS reads `attr(data-width px)` for the initial render.
 */
export const Resizable = (Base) => class extends Base {
  #handle = null;
  #resizeState = null;
  #onPointerDown;
  #onPointerMove;
  #onPointerUp;

  connectedCallback() {
    super.connectedCallback?.();
    if (!this.querySelector(':scope > .pl-resize-handle')) {
      this.#handle = document.createElement('div');
      this.#handle.className = 'pl-resize-handle';
      this.appendChild(this.#handle);
    } else {
      this.#handle = this.querySelector(':scope > .pl-resize-handle');
    }
    this.#onPointerDown = (e) => this.#startResize(e);
    this.#onPointerMove = (e) => this.#onMove(e);
    this.#onPointerUp   = (e) => this.#endResize(e);
    this.#handle.addEventListener('pointerdown', this.#onPointerDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback?.();
    if (this.#handle) {
      this.#handle.removeEventListener('pointerdown', this.#onPointerDown);
    }
    if (this.#resizeState) {
      window.removeEventListener('pointermove', this.#onPointerMove);
      window.removeEventListener('pointerup',   this.#onPointerUp);
      this.#resizeState = null;
    }
  }

  #startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    const rect = this.getBoundingClientRect();
    this.#resizeState = {
      startX: e.clientX,
      startY: e.clientY,
      startW: rect.width,
      startH: rect.height,
    };
    this.classList.add('resizing');
    window.addEventListener('pointermove', this.#onPointerMove);
    window.addEventListener('pointerup',   this.#onPointerUp);
  }

  #onMove(e) {
    if (!this.#resizeState) return;
    const w = Math.max(60, this.#resizeState.startW + (e.clientX - this.#resizeState.startX));
    const h = Math.max(40, this.#resizeState.startH + (e.clientY - this.#resizeState.startY));
    this.style.width  = w + 'px';
    this.style.height = h + 'px';
  }

  #endResize(e) {
    if (!this.#resizeState) return;
    window.removeEventListener('pointermove', this.#onPointerMove);
    window.removeEventListener('pointerup',   this.#onPointerUp);
    this.classList.remove('resizing');
    const w = Math.round(parseFloat(this.style.width)  || this.offsetWidth);
    const h = Math.round(parseFloat(this.style.height) || this.offsetHeight);
    this.style.width  = '';
    this.style.height = '';
    this.#resizeState = null;
    if (this.dataset.width  !== String(w)) this.dataset.width  = String(w);
    if (this.dataset.height !== String(h)) this.dataset.height = String(h);
  }
};

registerComponentMixin('[data-resizable]', Resizable);

// ── Stackable mixin ─────────────────────────────────────────────────

/**
 * Stackable — click-to-front z-ordering. On pointerdown, the component
 * sets its data-z to (max sibling data-z) + 1, which pagelove.mjs's
 * view-attr observer commits to the schema as a `z` property. CSS reads
 * `z-index: attr(data-z integer)` to apply the stacking. Listener is
 * capture-phase and non-intrusive: no preventDefault, no stopPropagation,
 * so Draggable/contenteditable/button clicks still proceed normally.
 */
export const Stackable = (Base) => class extends Base {
  #onPointerDown;
  #attrObserver = null;

  connectedCallback() {
    super.connectedCallback?.();
    this.#onPointerDown = () => this.#raise();
    this.addEventListener('pointerdown', this.#onPointerDown, { capture: true });

    // Mirror data-z to inline style.zIndex on any source of change (initial
    // bind from schema, our own #raise write, SSE update from another client).
    // This avoids depending on CSS `attr(data-z integer)` support, which isn't
    // in Safari yet and isn't covered by our css-attr-polyfill.
    this.#applyZ();
    this.#attrObserver = new MutationObserver(() => this.#applyZ());
    this.#attrObserver.observe(this, { attributes: true, attributeFilter: ['data-z'] });
  }

  disconnectedCallback() {
    super.disconnectedCallback?.();
    this.removeEventListener('pointerdown', this.#onPointerDown, { capture: true });
    if (this.#attrObserver) {
      this.#attrObserver.disconnect();
      this.#attrObserver = null;
    }
  }

  #applyZ() {
    const raw = this.dataset.z;
    const n = parseInt(raw, 10);
    this.style.zIndex = Number.isFinite(n) ? String(n) : '';
  }

  #raise() {
    const parent = this.parentElement;
    if (!parent) return;
    let max = 0;
    for (const sibling of parent.children) {
      if (sibling === this) continue;
      const n = parseInt(sibling.dataset?.z, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    const mine = parseInt(this.dataset.z, 10) || 0;
    if (mine > max) return;
    const next = String(max + 1);
    if (this.dataset.z !== next) this.dataset.z = next;
  }
};

registerComponentMixin('[data-stackable]', Stackable);

// ── MOVE request ────────────────────────────────────────────────────

const ID_SELECTOR_RE = /^#[\w-]+(?:\s+#[\w-]+)*$/;

/**
 * Module-level flag: flipped to false on the first 405 so we don't
 * keep trying MOVE on servers that don't support it.
 */
let moveSupported = true;

/**
 * Attempt an HTTP MOVE. Returns 'ok' on success, 'unsupported' on 405,
 * or throws on other errors. Logs the request to Debug.PRIMITIVES.
 */
async function tryMove({ url, sourceSelector, destSelector, placement, etag }) {
  if (!moveSupported) return 'unsupported';
  // Strip URL fragment — it's client-side state, not part of the resource URL
  url = url.split('#')[0];
  if (!ID_SELECTOR_RE.test(sourceSelector) || !ID_SELECTOR_RE.test(destSelector)) {
    Debug.warn(Debug.PRIMITIVES, '[MOVE] selectors must be id-based; falling back to POST+DELETE');
    return 'unsupported';
  }
  const p = placement || 'append';
  const headers = {
    'Range': `selector=${sourceSelector}`,
    'Destination': url,
    'Destination-Range': `selector=${destSelector}; placement=${p}`,
  };
  if (typeof etag === 'string' && etag.length > 0) {
    headers['If-Match'] = etag;
  }

  Debug.log(Debug.PRIMITIVES, [
    '[MOVE]',
    `MOVE ${(() => { try { const u = new URL(url); return u.pathname + u.search; } catch (_) { return url; } })()} HTTP/1.1`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ].join('\n'));

  const resp = await fetch(url, { method: 'MOVE', headers });
  if (resp.ok) {
    Debug.log(Debug.PRIMITIVES, `[MOVE] ${resp.status} OK`);
    return 'ok';
  }
  if (resp.status === 405) {
    moveSupported = false;
    Debug.log(Debug.PRIMITIVES, '[MOVE] 405 — server does not support MOVE; falling back');
    return 'unsupported';
  }
  const body = await resp.text().catch(() => '');
  throw new Error(`MOVE ${resp.status}: ${body}`);
}

// ── Droppable mixin ─────────────────────────────────────────────────

/**
 * Droppable — accept cross-container drops of articles whose itemtype
 * matches a property declared in this container's schema. Acceptance
 * is derived entirely from schema microdata — no `data-accepts`
 * attribute. Cardinality limits are respected.
 *
 * On accept, performs the standard POST-clone-to-target + DELETE-from-
 * source move pattern. If this container is also Sortable, uses Sortable's
 * `computeInsertBefore` helper to place the clone at the drop position
 * before POSTing.
 */
export const Droppable = (Base) => class extends Base {
  #onDropAttempt;

  connectedCallback() {
    super.connectedCallback?.();
    this.#onDropAttempt = (e) => this.#handleDrop(e);
    this.addEventListener('PLDropAttempt', this.#onDropAttempt);
  }

  disconnectedCallback() {
    super.disconnectedCallback?.();
    this.removeEventListener('PLDropAttempt', this.#onDropAttempt);
  }

  async #handleDrop(e) {
    const pagelove = window.pagelove;
    if (!pagelove) return;
    const { draggable } = e.detail;
    if (!draggable) return;

    // Find the target container's schema article.
    const containerSchema = document.getElementById(this.dataset.for);
    if (!containerSchema) return;
    const containerType = containerSchema.getAttribute('itemtype');
    const containerProps = pagelove.getSchema(containerType);
    if (!containerProps) return;

    // Find the draggable's schema article.
    const sourceSchema = document.getElementById(draggable.dataset.for);
    if (!sourceSchema) return;
    const draggableType = sourceSchema.getAttribute('itemtype');

    // Reject in-container drops — Sortable handles those.
    if (sourceSchema.parentElement === containerSchema) return;

    // Find a container property whose type accepts the draggable's type.
    const matchingProp = containerProps.find(p =>
      pagelove.isTypeOrSubtype(draggableType, p.type)
    );
    if (!matchingProp) return;

    // Cardinality check.
    const maxRaw = (matchingProp.cardinality || '0..n').split('..')[1] || 'n';
    if (maxRaw !== 'n') {
      const max = parseInt(maxRaw, 10);
      const existing = containerSchema.querySelectorAll(
        `:scope > [itemprop="${matchingProp.name}"]`
      ).length;
      if (Number.isFinite(max) && existing >= max) return;
    }

    // Accept.
    e.preventDefault();

    const sourceParent = sourceSchema.parentElement;
    const sourceNext = sourceSchema.nextElementSibling;
    const sourceId = sourceSchema.id;

    // Optimistic: move the source into the target. We move the original
    // element (not a clone) so MOVE's "same id" semantics are preserved.
    containerSchema.appendChild(sourceSchema);
    sourceSchema.setAttribute('itemprop', matchingProp.name);

    // Try atomic MOVE first; fall back to POST+DELETE on 405.
    try {
      const result = await tryMove({
        url: window.location.href.split('#')[0],
        sourceSelector: `#${sourceId}`,
        destSelector: `#${containerSchema.id}`,
        placement: 'append',
        etag: sourceSchema.etag,
      });

      if (result === 'ok') {
        // MOVE succeeded atomically — nothing more to do.
      } else {
        // MOVE not supported (405). Roll back the optimistic move, then
        // redo via POST+DELETE with a clone (which creates a new id on
        // the server side).
        sourceSchema.remove();
        if (sourceParent) sourceParent.insertBefore(sourceSchema, sourceNext);

        const clone = sourceSchema.cloneNode(true);
        clone.id = 'item-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        clone.setAttribute('itemprop', matchingProp.name);
        containerSchema.appendChild(clone);
        sourceSchema.remove();

        await this.#postWithRetry(containerSchema, clone);
        await this.#deleteWithRetry(sourceId);
      }
    } catch (err) {
      Debug.error(Debug.SCHEMA, '[Droppable] drop failed; rolling back', err);
      // Roll back: put source back where it was.
      sourceSchema.remove();
      if (sourceParent) sourceParent.insertBefore(sourceSchema, sourceNext);
      return;
    }

    this.dispatchEvent(new CustomEvent('PLDrop', {
      detail: { draggable, containerSchema },
      bubbles: true,
    }));
  }

  async #postWithRetry(container, body) {
    if (!container.POST) return;
    try { return await container.POST(body); }
    catch (_) { return await container.POST(body); }
  }

  async #deleteWithRetry(id) {
    const doFetch = async () => {
      const url = window.location.href.split('#')[0];
      const r = await fetch(url, {
        method: 'DELETE',
        headers: { 'Range': `selector=#${id}` },
      });
      if (!r.ok && r.status !== 416 /* already gone */) {
        throw new Error(`HTTP ${r.status}`);
      }
      return r;
    };
    try { return await doFetch(); }
    catch (_) { return await doFetch(); }
  }
};

registerComponentMixin('[data-droppable]', Droppable);

// ── Sortable mixin ──────────────────────────────────────────────────

/**
 * Sortable — in-container reorder via drop position. DOM-order-as-sort-order:
 * reordering means `insertBefore(draggable, refSibling)` on the schema layer,
 * followed by PUTting the container so the server and other clients see the
 * new order.
 *
 * Exposes `computeInsertBefore(clientY, draggable, [itemprop], [container])`
 * so Droppable can call it during cross-container moves.
 */
export const Sortable = (Base) => class extends Base {
  #onDropAttempt;

  connectedCallback() {
    super.connectedCallback?.();
    this.#onDropAttempt = (e) => this.#handleSort(e);
    this.addEventListener('PLDropAttempt', this.#onDropAttempt);
  }

  disconnectedCallback() {
    super.disconnectedCallback?.();
    this.removeEventListener('PLDropAttempt', this.#onDropAttempt);
  }

  /**
   * Compute the sibling the dropped element should be inserted *before*,
   * or null for append-to-end. Used by both our own sort handling and by
   * Droppable when doing a cross-container move into a sortable target.
   */
  computeInsertBefore(clientY, draggable, itempropName, containerSchemaOverride) {
    const containerSchema = containerSchemaOverride || document.getElementById(this.dataset.for);
    if (!containerSchema) return null;
    const draggableSchema = document.getElementById(draggable.dataset.for);
    const prop = itempropName || draggableSchema?.getAttribute('itemprop');
    if (!prop) return null;

    // Walk the siblings in DOM order, excluding the dragged element itself.
    const siblings = [...containerSchema.querySelectorAll(`:scope > [itemprop="${prop}"]`)]
      .filter(s => s !== draggableSchema);

    for (const sib of siblings) {
      // The view element for each sibling has data-for=<id>; hit-test it.
      const view = document.querySelector(`[data-for="${sib.id}"]`);
      if (!view) continue;
      const rect = view.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (clientY < midY) return sib;
    }
    return null;  // append
  }

  async #handleSort(e) {
    const pagelove = window.pagelove;
    if (!pagelove) return;
    const { draggable } = e.detail;
    if (!draggable) return;

    const containerSchema = document.getElementById(this.dataset.for);
    if (!containerSchema) return;
    const draggableSchema = document.getElementById(draggable.dataset.for);
    if (!draggableSchema) return;

    // Only handle in-container reorder. Cross-container is Droppable's job.
    if (draggableSchema.parentElement !== containerSchema) return;

    const ref = this.computeInsertBefore(e.detail.clientY, draggable);
    if (ref === draggableSchema) return;  // already in place
    if (ref === draggableSchema.nextElementSibling) return;  // already in place

    e.preventDefault();

    // Snapshot position for potential rollback.
    const originalNext = draggableSchema.nextElementSibling;
    const originalParent = draggableSchema.parentElement;

    // Optimistic: reorder immediately.
    containerSchema.insertBefore(draggableSchema, ref);

    // Try atomic MOVE first; fall back to PUT-the-container on 405.
    const destSelector = ref ? `#${ref.id}` : `#${containerSchema.id}`;
    const placement = ref ? 'before' : 'append';

    (async () => {
      try {
        const result = await tryMove({
          url: window.location.href.split('#')[0],
          sourceSelector: `#${draggableSchema.id}`,
          destSelector,
          placement,
          etag: draggableSchema.etag,
        });

        if (result === 'ok') {
          // MOVE succeeded atomically — no PUT needed.
        } else {
          // MOVE not supported. Fall back to PUT-the-container.
          let putTarget = containerSchema;
          while (putTarget && !putTarget.PUT) putTarget = putTarget.parentElement;
          if (putTarget?.PUT) {
            try { await putTarget.PUT(); }
            catch (_) { await putTarget.PUT(); }  // single retry
          }
        }
      } catch (err) {
        Debug.error(Debug.SCHEMA, '[Sortable] reorder failed; rolling back', err);
        if (originalParent) originalParent.insertBefore(draggableSchema, originalNext);
      }
    })();

    this.dispatchEvent(new CustomEvent('PLDrop', {
      detail: { draggable, containerSchema },
      bubbles: true,
    }));
  }
};

registerComponentMixin('[data-sortable]', Sortable);

// ── Standalone sortable attachment ──────────────────────────────────

/**
 * Attach sortable behavior to any element (not just PageloveComponents).
 * Used by pagelove.mjs for non-component [data-sortable] elements like
 * <main data-sortable data-sort-axis="x">.
 *
 * Supports `data-sort-axis="x"` for horizontal sort (default: "y").
 * The container IS the element itself — children are all direct
 * `article[itemscope]` descendants.
 */
export function attachSortableBehavior(element) {
  element.addEventListener('PLDropAttempt', async (e) => {
    const { draggable, clientX, clientY } = e.detail;
    const schema = document.getElementById(draggable.dataset.for);
    if (!schema || schema.parentElement !== element) return;

    const horizontal = element.dataset.sortAxis === 'x';
    const clientPos = horizontal ? clientX : clientY;

    // Compute insertion point among sibling articles.
    const siblings = [...element.querySelectorAll(':scope > article[itemscope]')]
      .filter(a => a !== schema);
    let ref = null;
    for (const sib of siblings) {
      const view = document.querySelector(`[data-for="${sib.id}"]`);
      if (!view) continue;
      const rect = view.getBoundingClientRect();
      const mid = horizontal
        ? rect.left + rect.width / 2
        : rect.top + rect.height / 2;
      if (clientPos < mid) { ref = sib; break; }
    }
    if (ref === schema.nextElementSibling) return; // already in place

    e.preventDefault();
    const originalNext = schema.nextElementSibling;
    element.insertBefore(schema, ref);

    // Try MOVE, fall back to PUT.
    const sourceSelector = `#${schema.id}`;
    const destSelector = ref ? `#${ref.id}` : `#${element.id}`;
    const placement = ref ? 'before' : 'append';

    (async () => {
      try {
        const result = await tryMove({
          url: window.location.href.split('#')[0],
          sourceSelector,
          destSelector,
          placement,
          etag: schema.etag,
        });
        if (result === 'ok') return;
        // Fall back to PUT the container.
        let target = element;
        while (target && !target.PUT) target = target.parentElement;
        if (target?.PUT) {
          try { await target.PUT(); }
          catch (_) { await target.PUT(); }
        }
      } catch (err) {
        Debug.error(Debug.SCHEMA, '[Sortable] standalone reorder failed; rolling back', err);
        element.insertBefore(schema, originalNext);
      }
    })();
  });
}
