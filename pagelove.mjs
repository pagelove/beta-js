/**
 * Pagelove — Declarative template-driven two-way binding.
 *
 * Unifies schema→view rendering and view→schema binding. The developer writes
 * <template> elements with itemtype and data-bind attributes. The library
 * handles rendering, property sync in both directions, list repetition,
 * persistence, and real-time sync.
 *
 * Usage:
 *   <template itemscope itemtype="https://pagelove.org/MoodNote">
 *     <div class="mood-note">
 *       <div contenteditable data-bind="title"></div>
 *       <select data-bind="color">
 *         <option value="#fef3c7">Yellow</option>
 *       </select>
 *     </div>
 *   </template>
 *
 *   import { ReactiveTemplate } from './reactive-template.mjs';
 *   const app = new ReactiveTemplate({
 *     schema: document.getElementById('data'),
 *     view: document.getElementById('view'),
 *   });
 *   app.start();
 */

import { PLDocument } from "./pagelove/primitives.mjs";
import { Pagelove as Debug } from "./pagelove/debug.mjs";
import {
  PageloveComponent,
  Draggable,
  registerComponentMixin,
  getMatchingMixins,
  attachSortableBehavior,
} from "./pagelove/component.mjs";

export { PageloveComponent, Draggable, registerComponentMixin };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/;

// Discover HTTP capabilities immediately on module load
const _doc = new PLDocument();
export const ready = _doc.OPTIONS();

let _instanceCount = 0;

export { Pagelove as ReactiveTemplate }; // backward compat
export class Pagelove {
  #schema;  // optional explicit root element (legacy)
  #filter;  // optional CSS selector to filter discovered instances
  #view;
  #config;
  #templates = new Map(); // itemType URL → <template> element
  #schemas = new Map();  // itemType URL → [{ name, type, cardinality }]
  #typeParents = new Map(); // itemType URL → parentUrl | null (from Schema microdata)
  #observers = []; // one MutationObserver per schema root
  #pendingPatches = new Set(); // article IDs deferred due to focus
  #started = false;

  /**
   * @param {object} config
   * @param {Element} config.view — visible view root
   * @param {string} [config.filter] — CSS selector to filter which schema instances to manage
   * @param {Element} [config.schema] — explicit schema root (legacy — prefer filter)
   * @param {function} [config.beforeCommit] — (schemaEl, prop, value) → boolean
   * @param {function} [config.afterCommit] — (schemaEl, prop, value) → void
   * @param {function} [config.onRender] — (viewEl, schemaEl) → void — called after template populate
   * @param {function} [config.onPatch] — ({ articleId, prop }) → void
   * @param {function} [config.ensureSchemaEl] — custom schema element creation
   */
  constructor(config) {
    _instanceCount++;
    this.#schema = config.schema || null;
    this.#filter = config.filter || null;
    this.#view = config.view;
    this.#config = config;
    // Expose the most-recently-constructed instance for PageloveComponent.create
    // to delegate into. Apps that need multiple instances can still call .create()
    // on a specific instance directly.
    if (typeof window !== 'undefined') window.pagelove = this;
  }

  /** Discover templates, render initial view, begin observing. */
  async start() {
    if (this.#started) return;
    this.#started = true;
    Debug.log(Debug.SCHEMA, '[Pagelove] starting');
    this.#discoverTemplates();
    await this.#discoverSchemas();
    this.#discoverComponents();
    // Attach sortable behavior to non-component [data-sortable] elements
    // (e.g. <main data-sortable data-sort-axis="x"> for lane reordering).
    document.querySelectorAll('[data-sortable]').forEach(el => {
      if (el instanceof PageloveComponent) return;
      if (el.tagName.includes('-') && customElements.get(el.tagName.toLowerCase())) return;
      attachSortableBehavior(el);
    });
    await ready;
    this.renderAll();
    this.#startObserver();
    this.#startEventListeners();
    this.#startViewAttrObserver();
    this.#startCommandListeners();
  }

  /** Stop observing and remove event listeners. */
  stop() {
    this.#started = false;
    this.#observers.forEach(o => o.disconnect());
    this.#observers = [];
    document.body.removeEventListener('change', this.#onChangeHandler);
    document.body.removeEventListener('focusout', this.#onFocusoutHandler);
    document.body.removeEventListener('input', this.#onInputHandler);
  }

  /**
   * Populate a view element's data-bind children from a schema article.
   * Use for dialogs, panels, or any element outside the main view.
   * Sets data-for on the element so commits route back to the schema.
   * @param {Element} viewEl — the element containing data-bind children
   * @param {string} schemaId — the schema article's ID
   */
  static #populateTemplates = new WeakMap();

  populate(viewEl, schemaId) {
    const schemaArticle = document.getElementById(schemaId);
    if (!schemaArticle) return;
    // Save original content as template on first use; restore on subsequent calls
    if (!Pagelove.#populateTemplates.has(viewEl)) {
      Pagelove.#populateTemplates.set(viewEl, viewEl.innerHTML);
    } else {
      viewEl.innerHTML = Pagelove.#populateTemplates.get(viewEl);
    }
    viewEl.dataset.for = schemaId;
    this.#populateBindings(viewEl, schemaArticle);
  }

  /** Force full re-render from schema. */
  renderAll() {
    // Remove only rendered view elements, preserving schema articles that may coexist
    this.#view.querySelectorAll(':scope > [data-for]').forEach(el => el.remove());
    for (const article of this.#discoverInstances()) {
      const viewEl = this.#renderArticle(article);
      if (viewEl) this.#view.appendChild(viewEl);
    }
    // Browser evaluates `:target` at HTML-parse time. When clones with
    // id-matching the URL fragment are inserted after parse, the selector
    // doesn't re-fire on its own (same quirk we hit in #patchArticle).
    // Nudge history so the fragment re-applies against the freshly
    // rendered clone, allowing e.g. /console/#hid to auto-open a card on
    // reload.
    if (location.hash && location.hash.length > 1) {
      const hash = location.hash;
      if (this.#view.querySelector(`:scope [id="${CSS.escape(hash.slice(1))}"]`)) {
        history.replaceState(history.state, '', location.pathname + location.search);
        history.replaceState(history.state, '', location.pathname + location.search + hash);
      }
    }
  }

  /** Find all schema instances that have matching templates. */
  #discoverInstances() {
    if (this.#schema) {
      // Explicit schema root — scan its direct children
      return this.#schema.querySelectorAll(':scope > [itemscope][itemtype][id]');
    }
    // Auto-discover: all itemscope elements that aren't templates, nested
    // (itemprop) children, or rendered view elements ([data-for]).
    const all = document.querySelectorAll('[itemscope][itemtype]:not(template):not([itemprop]):not([data-for])');
    return [...all].filter(el => {
      if (!this.#templates.has(el.getAttribute('itemtype'))) return false;
      if (this.#filter && !el.matches(this.#filter)) return false;
      return true;
    });
  }

  /** Whether there are deferred patches due to focused elements. */
  get hasPendingPatches() { return this.#pendingPatches.size > 0; }

  /** Apply all deferred patches. */
  flushPendingPatches() {
    const ids = [...this.#pendingPatches];
    this.#pendingPatches.clear();
    for (const id of ids) this.#patchArticle(id);
  }

  // ── Template Discovery ──

  #discoverTemplates() {
    document.querySelectorAll('template[itemtype]').forEach(t => {
      this.#templates.set(t.getAttribute('itemtype'), t);
    });
  }

  /**
   * Auto-define a custom element for any <template> root whose tag name is
   * hyphenated and not yet registered. Mixins are stacked by selector match
   * against the template root via the componentMixins registry.
   */
  #discoverComponents() {
    const seenTags = new Map(); // tagName → itemtype (for conflict detection)
    for (const [itemtype, template] of this.#templates) {
      const root = template.content.firstElementChild;
      if (!root) continue;
      const tagName = root.tagName.toLowerCase();
      if (!tagName.includes('-')) continue;

      if (seenTags.has(tagName) && seenTags.get(tagName) !== itemtype) {
        throw new Error(
          `Custom element <${tagName}> is declared as the root of two templates ` +
          `with different itemtypes:\n  ${seenTags.get(tagName)}\n  ${itemtype}\n` +
          `A custom element can only represent one schema type.`
        );
      }
      seenTags.set(tagName, itemtype);

      if (customElements.get(tagName)) continue;

      const mixins = getMatchingMixins(root);
      const Base = mixins.reduceRight((B, M) => M(B), PageloveComponent);
      customElements.define(tagName, class extends Base {
        static itemtype = itemtype;
      });
    }
  }

  async #discoverSchemas() {
    const MODULE_TYPE = 'https://pagelove.org/JavaScript/Module';
    const pending = [];

    // Load a JS module from a wrapper:
    //   <div itemprop="<itempropName>" itemscope itemtype="…/JavaScript/Module">
    //     <script itemprop="source" type="module">…</script>
    //   </div>
    // Returns a Promise resolving to the module's default export, or null if no wrapper.
    const loadModule = (prop, itempropName) => {
      const wrapper = prop.querySelector(
        `:scope > [itemprop="${itempropName}"][itemtype="${MODULE_TYPE}"]`
      );
      if (!wrapper) return null;
      const script = wrapper.querySelector(':scope > script[itemprop="source"]');
      if (!script) return null;
      const blob = new Blob([script.textContent], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      return import(url).then(mod => {
        URL.revokeObjectURL(url);
        return mod.default;
      });
    };

    // Pass 0 — build a type → parent map across all declared schemas so
    // we can check whether a given itemtype is-a pagelove.org/Property
    // via its parent chain (child types declared as having Property in
    // their ancestors are valid property definitions too).
    this.#typeParents.clear();
    document.querySelectorAll('[itemtype="https://pagelove.org/Schema"]').forEach(schema => {
      const typeUrl = schema.querySelector(':scope > [itemprop="type"]')?.getAttribute('content');
      if (!typeUrl) return;
      const parentUrl = schema.querySelector(':scope > [itemprop="parent"]')?.getAttribute('content') || null;
      this.#typeParents.set(typeUrl, parentUrl);
    });
    const isPropertyType = (typeUrl) => this.isTypeOrSubtype(typeUrl, 'https://pagelove.org/Property');

    // Pass 1 — collect raw schemas (own props + parent ref).
    const raw = new Map(); // typeUrl → { parentUrl, ownProps }
    document.querySelectorAll('[itemtype="https://pagelove.org/Schema"]').forEach(schema => {
      const typeUrl = schema.querySelector(':scope > [itemprop="type"]')?.getAttribute('content');
      if (!typeUrl) return;
      const parentUrl = schema.querySelector(':scope > [itemprop="parent"]')?.getAttribute('content') || null;
      const ownProps = [];
      schema.querySelectorAll('[itemprop="property"]').forEach(prop => {
        const propItemtype = prop.getAttribute('itemtype');
        if (!isPropertyType(propItemtype)) {
          Debug.warn(Debug.SCHEMA,
            `[Pagelove] Ignoring [itemprop="property"] element with itemtype "${propItemtype || '(none)'}" ` +
            `— expected https://pagelove.org/Property or a descendant type.`, prop);
          return;
        }
        const name = prop.querySelector('[itemprop="name"]')?.getAttribute('content');
        const type = prop.querySelector('[itemprop="type"]')?.getAttribute('content') || '';
        const cardinality = prop.querySelector('[itemprop="cardinality"]')?.getAttribute('content') || '0..1';
        const entry = { name, type, cardinality, default: undefined, read: undefined };

        // Static default via <meta itemprop="default" content="...">
        const metaDefault = prop.querySelector(':scope > meta[itemprop="default"]');
        if (metaDefault) {
          entry.default = metaDefault.getAttribute('content');
        }

        // Computed default via JavaScript/Module wrapper.
        const defaultPromise = loadModule(prop, 'default');
        if (defaultPromise) {
          pending.push(defaultPromise.then(val => { entry.default = val; }));
        }

        // Read transform via JavaScript/Module wrapper.
        const readPromise = loadModule(prop, '@read');
        if (readPromise) {
          pending.push(readPromise.then(val => { entry.read = val; }));
        }

        if (name) ownProps.push(entry);
      });
      raw.set(typeUrl, { parentUrl, ownProps });
    });

    await Promise.all(pending);

    // Pass 2 — resolve inheritance.
    const resolving = new Set();
    const resolve = (typeUrl) => {
      if (this.#schemas.has(typeUrl)) return this.#schemas.get(typeUrl);
      const r = raw.get(typeUrl);
      if (!r) throw new Error(`Schema "${typeUrl}" is not defined`);
      if (resolving.has(typeUrl)) {
        throw new Error(`Schema inheritance cycle detected at "${typeUrl}"`);
      }
      resolving.add(typeUrl);
      let merged;
      if (r.parentUrl) {
        if (!raw.has(r.parentUrl)) {
          throw new Error(`Schema "${typeUrl}" declares unknown parent "${r.parentUrl}"`);
        }
        const parentProps = resolve(r.parentUrl);
        const ownNames = new Set(r.ownProps.map(p => p.name));
        merged = [...parentProps.filter(p => !ownNames.has(p.name)), ...r.ownProps];
      } else {
        merged = r.ownProps;
      }
      resolving.delete(typeUrl);
      this.#schemas.set(typeUrl, merged);
      return merged;
    };
    for (const typeUrl of raw.keys()) resolve(typeUrl);
  }

  /**
   * Create a new schema instance from a schema.host type definition.
   * Reads the property definitions from the document's Schema microdata
   * and builds a properly structured microdata element.
   *
   * @param {string} typeUrl — the schema type URL (e.g. "https://pagelove.org/MoodNote")
   * @param {object} [values={}] — property name → value map
   * @param {object} [options]
   * @param {string} [options.tag='article'] — wrapper element tag name
   * @returns {HTMLElement} — a new microdata element ready for POST
   */
  create(typeUrl, values = {}, { tag = 'article' } = {}) {
    const props = this.#schemas.get(typeUrl);
    if (!props) throw new Error(`No schema definition found for ${typeUrl}`);

    const article = document.createElement(tag);
    article.setAttribute('itemscope', '');
    article.setAttribute('itemtype', typeUrl);
    article.id = 'item-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    for (const prop of props) {
      const { name, type, cardinality } = prop;
      const def = typeof prop.default === 'function' ? prop.default() : prop.default;
      const value = values[name] ?? def;

      // Skip 0..n properties with no value — they're added later
      if (cardinality === '0..n' && value == null) continue;

      if (type === 'https://pagelove.org/DateTime' || type === 'https://pagelove.org/Date') {
        const el = document.createElement('time');
        el.setAttribute('itemprop', name);
        el.setAttribute('datetime', value ?? new Date().toISOString());
        article.appendChild(el);
      } else if (type.startsWith('https://pagelove.org/') &&
                 type !== 'https://pagelove.org/Text' &&
                 type !== 'https://pagelove.org/Integer' &&
                 type !== 'https://pagelove.org/Number' &&
                 type !== 'https://pagelove.org/Boolean') {
        // Nested schema type — skip unless value provided as element
        if (value instanceof HTMLElement) article.appendChild(value);
      } else {
        const el = document.createElement('meta');
        el.setAttribute('itemprop', name);
        el.setAttribute('content', String(value ?? ''));
        article.appendChild(el);
      }
    }

    return article;
  }

  // ── Public helpers exposed for mixins and app code ──

  /** Resolved property list for an itemtype, or null if not discovered. */
  getSchema(itemtype) {
    return this.#schemas.get(itemtype) || null;
  }

  /**
   * True if `candidate` is either `expected` itself or has it somewhere
   * in its parent chain declared via `<meta itemprop="parent">` on a
   * schema definition. Used by Droppable, by property validation, etc.
   */
  isTypeOrSubtype(candidate, expected) {
    if (!candidate) return false;
    const seen = new Set();
    let cur = candidate;
    while (cur && !seen.has(cur)) {
      if (cur === expected) return true;
      seen.add(cur);
      cur = this.#typeParents.get(cur) || null;
    }
    return false;
  }

  /** Render a view element for a schema article (public wrapper of #renderArticle). */
  renderArticle(schemaArticle) {
    return this.#renderArticle(schemaArticle);
  }

  /** The template registered for an itemtype, or undefined. */
  getTemplate(itemtype) {
    return this.#templates.get(itemtype);
  }

  // ── Rendering ──

  #renderArticle(schemaArticle) {
    const type = schemaArticle.getAttribute('itemtype');
    const template = this.#templates.get(type);
    if (!template) return null;

    const clone = template.content.firstElementChild.cloneNode(true);
    clone.dataset.for = schemaArticle.id;

    // Upgrade the clone in place if its tag is a registered custom element.
    // Without this, a freshly-cloned element from a <template> isn't yet an
    // instance of its custom-element class, and the instanceof check below
    // would always be false.
    customElements.upgrade(clone);

    // PageloveComponents bind themselves in connectedCallback. The clone may
    // be an instance already (autonomous custom element matching a defined
    // tag), in which case we skip the legacy binding pass entirely.
    if (!(clone instanceof PageloveComponent)) {
      this.#populateBindings(clone, schemaArticle);
    }

    if (this.#config.onRender) {
      this.#config.onRender(clone, schemaArticle);
    }

    return clone;
  }

  #populateBindings(viewRoot, schemaScope) {
    // data-bind-attr: forward schema properties as data-* attributes on the view root
    const bindAttr = viewRoot.dataset.bindAttr;
    if (bindAttr) {
      for (const prop of bindAttr.split(/\s+/)) {
        const schemaEl = schemaScope.querySelector(`:scope > [itemprop="${prop}"]`);
        if (schemaEl) viewRoot.dataset[prop] = this.#readSchemaValue(schemaEl);
      }
    }

    const scopeType = schemaScope.getAttribute('itemtype');
    const scopeProps = scopeType ? this.#schemas.get(scopeType) : null;

    viewRoot.querySelectorAll('[data-bind]').forEach(el => {
      // Skip nested data-bind elements that are inside a deeper data-for scope
      if (el.closest('[data-for]') !== viewRoot && viewRoot.dataset.for) return;

      const prop = el.dataset.bind;
      const schemaEls = schemaScope.querySelectorAll(`:scope > [itemprop="${prop}"]`);
      const propDef = scopeProps?.find(p => p.name === prop);
      const isListProp = propDef?.cardinality?.endsWith('..n');

      // Repeat the stamp when the property is list-valued — by schema
      // cardinality, by nested itemscope, or by observed multiplicity.
      if (el.hasAttribute('itemscope') || schemaEls.length > 1 || isListProp) {
        // List-valued binding: repeat the stamp per matching source
        // element (zero clones when the source has no values — the stamp
        // is replaced with a marker comment, leaving nothing visible).
        this.#repeatElement(el, schemaEls);
      } else {
        // Singular property — populate if present, otherwise leave the
        // element in place empty (keeps editable scalar fields like
        // `name` visible and interactive even when the source has no
        // value yet).
        const schemaEl = schemaEls[0];
        if (schemaEl) {
          const value = this.#readSchemaValue(schemaEl);
          const transform = this.#getReadTransform(schemaScope, prop);
          this.#writeToView(el, value, transform);
        }
      }
    });

    // data-bind-{htmlattr}="prop" — bind HTML attributes (href, src, datetime, etc.)
    // Includes viewRoot itself so root-level attrs like `data-bind-id="hid"` work.
    [viewRoot, ...viewRoot.querySelectorAll('*')].forEach(el => {
      if (el !== viewRoot && el.closest('[data-for]') !== viewRoot && viewRoot.dataset.for) return;
      for (const attr of [...el.attributes]) {
        if (attr.name === 'data-bind' || attr.name === 'data-bind-attr') continue;
        if (!attr.name.startsWith('data-bind-')) continue;
        const htmlAttr = attr.name.slice(10); // "data-bind-href" → "href"
        const prop = attr.value;
        const schemaEl = schemaScope.querySelector(`:scope > [itemprop="${prop}"]`);
        if (schemaEl) {
          const value = this.#readSchemaValue(schemaEl);
          if (el.getAttribute(htmlAttr) !== value) el.setAttribute(htmlAttr, value);
        }
      }
    });
  }

  #repeatElement(stampEl, schemaEls) {
    const parent = stampEl.parentElement;
    const marker = document.createComment(`data-bind:${stampEl.dataset.bind}`);
    parent.insertBefore(marker, stampEl);
    stampEl.remove();

    for (const schemaEl of schemaEls) {
      const clone = stampEl.cloneNode(true);

      // If the schema element has a simple text value, write it
      if (!schemaEl.hasAttribute('itemscope')) {
        this.#writeToView(clone, this.#readSchemaValue(schemaEl));
      } else {
        // Nested itemscope — link view to schema and populate inner bindings
        if (schemaEl.id) clone.dataset.for = schemaEl.id;
        this.#populateBindings(clone, schemaEl);
      }

      parent.insertBefore(clone, marker.nextSibling);
    }
  }

  // ── Schema → View (MutationObserver) ──

  #startObserver() {
    const observerOpts = {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['content', 'datetime'],
    };

    if (this.#schema) {
      // Explicit schema root — observe it
      const obs = new MutationObserver((m) => this.#handleMutations(m));
      obs.observe(this.#schema, observerOpts);
      this.#observers.push(obs);
    } else {
      // Auto-discover / filter mode — observe each instance's parent, deduplicated
      // Always include the view element so new articles are detected even if none exist yet
      const parents = new Set([this.#view]);
      for (const el of this.#discoverInstances()) {
        if (el.parentElement) parents.add(el.parentElement);
      }
      for (const parent of parents) {
        const obs = new MutationObserver((m) => this.#handleMutations(m));
        obs.observe(parent, observerOpts);
        this.#observers.push(obs);
      }
    }
  }

  #handleMutations(mutations) {
    if (!this.#started) return;

    const dirtyArticles = new Set(); // for structural changes
    const dirtyProps = []; // for property changes
    let structuralChange = false;

    for (const m of mutations) {
      if (m.type === 'childList') {
        // Mutations inside a rendered view (anything under a [data-for]
        // ancestor) are view-side bookkeeping — never schema-root structural
        // changes. The previous heuristic only checked whether the *added*
        // /*removed* nodes carried `data-for`, which misses view-internal
        // itemscope elements (e.g. <li data-bind="alias" itemprop="alias"
        // itemscope>) and falsely triggers renderAll() when they're moved
        // around.
        const insideView = m.target.nodeType === 1 && m.target.closest?.('[data-for]');
        if (insideView) continue;

        // Check if an article was added/removed (not a child of an article)
        const isSchemaRoot = this.#schema ? m.target === this.#schema : !this.#findArticle(m.target);
        if (isSchemaRoot) {
          // Only count as structural if schema articles changed, not view elements
          const hasSchemaNode = [...m.addedNodes, ...m.removedNodes].some(n =>
            n.nodeType === 1
              && n.hasAttribute?.('itemscope')
              && !n.hasAttribute?.('data-for')
              && !n.closest?.('[data-for]')
          );
          if (hasSchemaNode) structuralChange = true;
        } else {
          // Child changed inside an article (e.g., comment added)
          const article = this.#findArticle(m.target);
          if (article) dirtyArticles.add(article.id);
        }
      }

      if (m.type === 'attributes' || m.type === 'characterData') {
        const node = m.type === 'characterData' ? m.target.parentElement : m.target;
        if (!node) continue;

        // Check if this is an itemprop element
        const itemprop = node.getAttribute?.('itemprop');
        if (itemprop) {
          const article = this.#findArticle(node);
          if (article) {
            dirtyProps.push({ articleId: article.id, prop: itemprop, value: this.#readSchemaValue(node) });
          }
        }
      }
    }

    if (structuralChange) {
      this.renderAll();
      return;
    }

    // Surgical property updates
    for (const { articleId, prop, value } of dirtyProps) {
      if (dirtyArticles.has(articleId)) continue; // will be re-rendered anyway
      this.#patchProperty(articleId, prop, value);
    }

    // Structural changes within articles (e.g., comment added)
    for (const articleId of dirtyArticles) {
      this.#patchArticle(articleId);
    }
  }

  #patchProperty(articleId, prop, value) {
    const container = this.#view.querySelector(`[data-for="${articleId}"]`);
    if (!container) return;

    // PageloveComponents own their schema→view sync via their per-instance
    // MutationObserver. The legacy patcher doesn't need to touch them.
    if (container instanceof PageloveComponent) return;

    // data-bind-attr: update data-* attribute on the view root (compare first to prevent cycles)
    const bindAttr = container.dataset.bindAttr;
    if (bindAttr?.split(/\s+/).includes(prop)) {
      if (container.dataset[prop] !== value) container.dataset[prop] = value;
    }

    // data-bind-{htmlattr}: update HTML attributes on matching elements
    let boundAttr = false;
    container.querySelectorAll(`[data-bind-${CSS.escape(prop)}]`).forEach(el => {
      // data-bind-href="url" wouldn't match — need to check by value
    });
    // Scan for any data-bind-* that references this prop
    container.querySelectorAll('*').forEach(el => {
      for (const attr of el.attributes) {
        if (attr.name === 'data-bind' || attr.name === 'data-bind-attr') continue;
        if (!attr.name.startsWith('data-bind-')) continue;
        if (attr.value !== prop) continue;
        const htmlAttr = attr.name.slice(10);
        if (el.getAttribute(htmlAttr) !== value) el.setAttribute(htmlAttr, value);
        boundAttr = true;
      }
    });

    const viewEl = container.querySelector(`[data-bind="${prop}"]`);
    if (!viewEl) {
      if (bindAttr?.split(/\s+/).includes(prop) || boundAttr) {
        this.#config.onPatch?.({ articleId, prop });
      }
      return;
    }

    // Focus protection
    if (viewEl === document.activeElement || viewEl.contains(document.activeElement)) {
      this.#pendingPatches.add(articleId);
      return;
    }

    const schemaArticle = document.getElementById(articleId);
    const transform = schemaArticle ? this.#getReadTransform(schemaArticle, prop) : null;
    this.#writeToView(viewEl, value, transform);
    this.#config.onPatch?.({ articleId, prop });
  }

  #patchArticle(articleId) {
    const schemaArticle = document.getElementById(articleId);
    const viewEl = this.#view.querySelector(`[data-for="${articleId}"]`);

    if (!schemaArticle) {
      if (viewEl) viewEl.remove();
      return;
    }

    // Focus protection
    if (viewEl?.contains(document.activeElement)) {
      this.#pendingPatches.add(articleId);
      return;
    }

    // PageloveComponents own their schema→view sync (same rationale as the
    // guard in #patchProperty). #renderArticle returns an *unconnected* clone,
    // so a component clone's connectedCallback (and therefore #renderChildren)
    // never runs — its child containers are empty. Overwriting the live view's
    // children with those would wipe the component's nested collections on any
    // child-level change (add / remove / drag-drop move). Let the live
    // component re-render itself instead. (#66)
    if (viewEl instanceof PageloveComponent) {
      viewEl.renderChildren();
      return;
    }

    const newViewEl = this.#renderArticle(schemaArticle);
    if (viewEl && newViewEl) {
      // Repopulate in place rather than replaceWith — preserves the
      // element's identity so `:target` state survives a re-render and
      // any external capability methods attached to the existing view
      // root remain valid.
      for (const attr of [...newViewEl.attributes]) {
        if (viewEl.getAttribute(attr.name) !== attr.value) {
          viewEl.setAttribute(attr.name, attr.value);
        }
      }
      for (const attr of [...viewEl.attributes]) {
        if (!newViewEl.hasAttribute(attr.name)) viewEl.removeAttribute(attr.name);
      }
      viewEl.replaceChildren(...newViewEl.childNodes);
    } else if (newViewEl) {
      this.#view.appendChild(newViewEl);
    }
  }

  // ── View → Schema (Event Listeners) ──

  #onChangeHandler = (e) => {
    const el = e.target.closest('[data-bind]');
    if (!el) return;
    const binding = this.#inferBinding(el);
    if (binding.commit === 'immediate') {
      this.#commitElement(el);
    }
  };

  #onFocusoutHandler = (e) => {
    const el = e.target.closest('[contenteditable][data-bind], input[data-bind], select[data-bind], textarea[data-bind]');
    if (!el) return;
    const binding = this.#inferBinding(el);
    if (binding.commit === 'blur') {
      this.#commitElement(el);
      // Flush any deferred patches
      if (this.#pendingPatches.size > 0) {
        setTimeout(() => this.flushPendingPatches(), 0);
      }
    }
  };

  #onInputHandler = (e) => {
    const el = e.target.closest('[data-bind]');
    if (!el) return;
    const binding = this.#inferBinding(el);
    if (binding.commit.startsWith('idle:')) {
      const ms = parseInt(binding.commit.split(':')[1], 10) || 500;
      this.#debounce(el, ms);
    }
  };

  #debounceTimers = new Map();

  #debounce(el, ms) {
    const key = (el.closest('[data-for]')?.dataset.for || '') + ':' + el.dataset.bind;
    if (this.#debounceTimers.has(key)) clearTimeout(this.#debounceTimers.get(key));
    this.#debounceTimers.set(key, setTimeout(() => {
      this.#debounceTimers.delete(key);
      this.#commitElement(el);
    }, ms));
  }

  #startEventListeners() {
    document.body.addEventListener('change', this.#onChangeHandler);
    document.body.addEventListener('focusout', this.#onFocusoutHandler);
    document.body.addEventListener('input', this.#onInputHandler);
  }

  // ── View → Schema for data-bind-attr (two-way) ──

  #startViewAttrObserver() {
    // Collect all data-* attribute names declared in templates' data-bind-attr
    const attrNames = new Set();
    for (const template of this.#templates.values()) {
      const root = template.content.firstElementChild;
      const bindAttr = root?.dataset.bindAttr;
      if (bindAttr) {
        for (const prop of bindAttr.split(/\s+/)) attrNames.add('data-' + prop);
      }
    }
    if (attrNames.size === 0) return;

    const obs = new MutationObserver((mutations) => {
      if (!this.#started) return;
      const dirtyArticles = new Map(); // articleId → schemaArticle (for batched PUT)

      for (const m of mutations) {
        const el = m.target;
        const bindAttr = el.dataset?.bindAttr;
        if (!bindAttr) continue;

        const attr = m.attributeName;
        const prop = attr.replace(/^data-/, '');
        if (!bindAttr.split(/\s+/).includes(prop)) continue;

        const articleId = el.dataset.for;
        if (!articleId) continue;
        const value = el.dataset[prop];

        // Commit to schema (compare first to prevent cycles)
        const schemaArticle = document.getElementById(articleId);
        if (!schemaArticle) continue;
        const schemaEl = schemaArticle.querySelector(`:scope > [itemprop="${prop}"]`);
        if (schemaEl && this.#readSchemaValue(schemaEl) === value) continue;

        const ensure = this.#config.ensureSchemaEl || this.#defaultEnsureSchemaEl;
        ensure(schemaArticle, prop, value);
        dirtyArticles.set(articleId, schemaArticle);

        this.#config.afterCommit?.(schemaArticle, prop, value);
      }

      // Batched PUT — one per dirty article, regardless of how many attributes changed
      for (const [, schemaArticle] of dirtyArticles) {
        this.#persist(schemaArticle);
      }
    });

    obs.observe(this.#view, {
      subtree: true,
      attributes: true,
      attributeFilter: [...attrNames],
    });
    this.#observers.push(obs);
  }

  // ── Declarative commands (--create-instance, --remove-instance) ──

  #commandHandler = (e) => {
    // Blur the button so focus protection doesn't defer the re-render
    e.source?.blur?.();
    if (e.command === '--create-instance') {
      this.#handleAddInstance(e);
    } else if (e.command === '--remove-instance') {
      this.#handleDelete(e);
    }
  };

  async #handleAddInstance(e) {
    const typeUrl = e.source.dataset.schema;
    if (!typeUrl) return;
    // If inside a [data-for] view element, POST to the linked schema element
    const viewParent = e.source.closest('[data-for]');
    const target = viewParent
      ? document.getElementById(viewParent.dataset.for)
      : e.target;
    if (!target) return;
    const tag = e.source.dataset.element || 'article';
    const article = this.create(typeUrl, {}, { tag });
    // Infer itemprop from target's schema (e.g., KanbanCard → "card" inside KanbanColumn)
    const targetType = target.getAttribute('itemtype');
    if (targetType) {
      const targetProps = this.#schemas.get(targetType);
      const prop = targetProps?.find(p => p.type === typeUrl);
      if (prop) article.setAttribute('itemprop', prop.name);
    }
    // Optimistic: append to DOM immediately, then persist in background
    target.appendChild(article);
    article._pendingPost = target.POST ? target.POST(article) : Promise.resolve();
  }

  async #handleDelete(e) {
    const viewEl = e.source.closest('[data-for]');
    if (!viewEl) return;
    const schemaEl = document.getElementById(viewEl.dataset.for);
    if (!schemaEl) return;
    if (schemaEl.etag !== undefined) schemaEl.etag = undefined;
    // Optimistic: remove from DOM immediately, then persist
    const deleteFn = schemaEl.DELETE;
    schemaEl.remove();
    if (deleteFn) deleteFn.call(schemaEl);
  }

  #startCommandListeners() {
    // Listen for command events on commandfor targets (buttons outside templates)
    const targets = new Set();
    document.querySelectorAll('[command="--create-instance"], [command="--remove-instance"]').forEach(btn => {
      const id = btn.getAttribute('commandfor');
      if (id) targets.add(id);
    });
    for (const id of targets) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('command', this.#commandHandler);
    }
    // Delegated click listener on view for command buttons inside templates
    this.#view.addEventListener('click', (e) => {
      const btn = e.target.closest('[command]');
      if (!btn || btn.hasAttribute('commandfor')) return;
      e.source = btn; // match the command event shape
      e.command = btn.getAttribute('command');
      this.#commandHandler(e);
    });
  }

  async #commitElement(el) {
    const prop = el.dataset.bind;
    if (!prop) return;

    const value = this.#readViewValue(el);
    const schemaArticle = this.#findSchemaFromView(el);
    if (!schemaArticle) return;

    if (this.#config.beforeCommit) {
      if (this.#config.beforeCommit(schemaArticle, prop, value) === false) return;
    }

    // Update schema
    const ensure = this.#config.ensureSchemaEl || this.#defaultEnsureSchemaEl;
    ensure(schemaArticle, prop, value);

    // Find PUT target and persist
    await this.#persist(schemaArticle);

    this.#config.afterCommit?.(schemaArticle, prop, value);
  }

  async #persist(schemaArticle) {
    // Wait for any pending POST to complete first (from --create-instance)
    if (schemaArticle._pendingPost) {
      await schemaArticle._pendingPost;
      delete schemaArticle._pendingPost;
    }
    // Walk up to find an element with .PUT()
    let target = schemaArticle;
    while (target) {
      if (target.PUT) { await target.PUT(); return; }
      target = target.parentElement;
    }
    // Fallback for elements created after OPTIONS (no .PUT() discovered)
    if (schemaArticle.id) {
      await fetch(window.location.href.split('#')[0], {
        method: 'PUT',
        headers: {
          'Range': `selector=#${CSS.escape(schemaArticle.id)}`,
          'Content-Type': 'text/html',
        },
        body: schemaArticle.outerHTML,
      });
    }
  }

  // ── Helpers ──

  #findArticle(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el !== document.body) {
      if (el.id && el.hasAttribute('itemscope')) {
        // Nested repeated item with a matching view element (e.g., card inside column)
        if (this.#view.querySelector(`[data-for="${el.id}"]`)) return el;
        // Top-level template-registered type. Skip rendered view elements
        // (they carry data-for back to a real source).
        const type = el.getAttribute('itemtype');
        if (type && this.#templates.has(type)
            && !el.hasAttribute('itemprop')
            && !el.hasAttribute('data-for')) {
          if (!this.#filter || el.matches(this.#filter)) return el;
        }
      }
      el = el.parentElement;
    }
    return null;
  }

  #findSchemaFromView(viewEl) {
    let node = viewEl;
    while (node && node !== document.body) {
      if (node.dataset?.for) {
        return document.getElementById(node.dataset.for);
      }
      node = node.parentElement;
    }
    return null;
  }

  #readSchemaValue(el) {
    if (el.tagName === 'META') return el.getAttribute('content') || '';
    if (el.tagName === 'TIME') return el.getAttribute('datetime') || '';
    return el.textContent.trim();
  }

  #readViewValue(el) {
    const commit = el.dataset.commit;
    if (el.contentEditable === 'true') return el.innerText.trim();
    if (el.tagName === 'SELECT') return el.value;
    if (el.tagName === 'INPUT') {
      if (el.type === 'checkbox') return el.checked ? 'true' : 'false';
      return el.value;
    }
    if (el.tagName === 'TEXTAREA') return el.value;
    return el.textContent.trim();
  }

  #writeToView(el, value, transform) {
    if (el.contentEditable === 'true') {
      if (el.innerText.trim() !== value) {
        el.innerHTML = '';
        (value || '').split('\n').forEach((line, i) => {
          if (i > 0) el.appendChild(document.createElement('br'));
          el.appendChild(document.createTextNode(line));
        });
      }
    } else if (el.tagName === 'SELECT') {
      if (el.value !== value) el.value = value;
    } else if (el.tagName === 'INPUT') {
      if (el.type === 'checkbox') {
        el.checked = value === 'true';
      } else if (el.type === 'color') {
        if (el.value !== value) el.value = value;
      } else {
        if (el.value !== value) el.value = value;
      }
    } else if (el.tagName === 'TEXTAREA') {
      if (el.value !== value) el.value = value;
    } else if (el.tagName === 'TIME') {
      el.setAttribute('datetime', value);
      if (transform && typeof transform === 'function') {
        const result = transform(value);
        el.textContent = Array.isArray(result) ? result.join('') : result;
      } else if (!el.textContent) {
        el.textContent = value;
      }
    } else {
      // Apply @read transform for display elements (not editable/form)
      if (transform && typeof transform === 'function') {
        const result = transform(value);
        const html = Array.isArray(result) ? result.join('') : result;
        if (el.innerHTML !== html) el.innerHTML = html;
      } else if (el.textContent.trim() !== value) {
        if (value) el.textContent = value;
        else el.innerHTML = ''; // truly empty for CSS :empty
      }
    }
  }

  #getReadTransform(schemaScope, prop) {
    const type = schemaScope.getAttribute('itemtype');
    if (!type) return null;
    const schemaDef = this.#schemas.get(type);
    if (!schemaDef) return null;
    const propDef = schemaDef.find(p => p.name === prop);
    // Property-level @read takes precedence
    if (propDef?.read) return propDef.read;
    // Fall back to the property's type schema — find a @read property there
    if (propDef?.type) {
      const typeSchemaDef = this.#schemas.get(propDef.type);
      if (typeSchemaDef) {
        const readProp = typeSchemaDef.find(p => p.read);
        if (readProp) return readProp.read;
      }
    }
    return null;
  }

  #inferBinding(el) {
    const commit = el.dataset.commit;
    if (el.contentEditable === 'true') return { commit: commit || 'blur' };
    if (el.tagName === 'SELECT') return { commit: commit || 'immediate' };
    if (el.tagName === 'INPUT') {
      if (el.type === 'checkbox' || el.type === 'date' || el.type === 'color')
        return { commit: commit || 'immediate' };
      return { commit: commit || 'blur' };
    }
    if (el.tagName === 'TEXTAREA') return { commit: commit || 'blur' };
    return { commit: commit || 'blur' };
  }

  #defaultEnsureSchemaEl(article, prop, value) {
    let el = article.querySelector(`:scope > [itemprop="${prop}"]`);
    if (el) {
      // Compare before writing to prevent observer cycles
      if (el.tagName === 'META') {
        if (el.getAttribute('content') !== value) el.setAttribute('content', value);
      } else if (el.tagName === 'TIME') {
        if (el.getAttribute('datetime') !== value) el.setAttribute('datetime', value);
      } else {
        if (el.textContent !== value) el.textContent = value;
      }
    } else {
      if (ISO_DATE_RE.test(value)) {
        el = document.createElement('time');
        el.setAttribute('itemprop', prop);
        el.setAttribute('datetime', value);
      } else {
        el = document.createElement('meta');
        el.setAttribute('itemprop', prop);
        el.setAttribute('content', value);
      }
      article.appendChild(el);
    }
  }
}

// Auto-start: if the document has a <main> and no instances were manually
// created by other modules. Wait for BOTH `ready` and DOMContentLoaded so
// sibling module scripts (which run before DCL) have had a chance to
// instantiate their own Pagelove — otherwise a fast OPTIONS response can
// fire this callback between module evaluations and we race, producing
// duplicate renders.
// DOMContentLoaded fires AFTER all parser-inserted module scripts have
// evaluated, so waiting for it gives sibling modules a chance to construct
// their own Pagelove and bump _instanceCount. readyState is 'interactive'
// (not 'loading') during module evaluation, so we wait for DCL unless the
// document is already fully loaded.
const _domReady = document.readyState === 'complete'
  ? Promise.resolve()
  : new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));

Promise.all([ready, _domReady]).then(async () => {
  const main = document.querySelector('main');
  if (main && _instanceCount === 0) {
    document.pagelove = new Pagelove({ view: main });
    await document.pagelove.start();
  }
});
