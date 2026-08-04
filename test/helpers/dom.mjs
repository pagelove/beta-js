/**
 * Minimal browser environment for testing the SSE client under Node.
 *
 * `pagelove/sse.mjs` instantiates itself on import (`const _instance = new
 * PageloveSSE()` at the bottom of the module), so every global it touches —
 * document, window, CustomEvent, DOMParser, EventSource — must exist BEFORE
 * the dynamic import. That is why setup lives here rather than in the tests.
 */
import { JSDOM } from 'jsdom';

/**
 * A stand-in for the browser's EventSource.
 *
 * Records every instance created so a test can reach the one the module
 * builds for itself, and exposes `emit()` to deliver a server event.
 */
export class FakeEventSource {
    static instances = [];

    constructor(url, opts) {
        this.url = url;
        this.opts = opts;
        this.readyState = 1;
        this.closed = false;
        this.listeners = new Map();
        FakeEventSource.instances.push(this);
    }

    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
    }

    /** Deliver a server-sent event of `type` carrying `data`. */
    emit(type, data) {
        for (const fn of this.listeners.get(type) || []) fn({ data, type });
    }

    close() {
        this.closed = true;
        this.readyState = 2;
    }
}

/**
 * Install a fresh DOM + FakeEventSource, then import a freshly-evaluated copy
 * of the SSE module.
 *
 * The cache-busting query on the import specifier matters: the module has
 * import-time side effects, so without it every test after the first would
 * silently reuse the first test's subscriber and its accumulated state.
 *
 * The module must not be imported statically by a test file: that would
 * evaluate it — and run its self-instantiation — before these globals exist.
 * Anything a test needs from the module is returned here as `mod`.
 *
 * @param {string} bodyHtml — markup for the document body
 * @returns {Promise<{document: Document, source: FakeEventSource, mod: object}>}
 */
export async function setupSseClient(bodyHtml) {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`, {
        url: 'https://example.test/page.html',
    });

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.DOMParser = dom.window.DOMParser;
    globalThis.Node = dom.window.Node;
    globalThis.location = dom.window.location;

    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource;

    const mod = await import(`../../pagelove/sse.mjs?t=${Date.now()}-${Math.random()}`);

    const source = FakeEventSource.instances[0];
    if (!source) throw new Error('sse.mjs did not open an EventSource on import');
    return { document: globalThis.document, source, mod };
}

/** Build the HTML+Microdata payload the server sends for a mutation. */
export function mutationPayload({ method, selector, body, placement = 'append' }) {
    return [
        '<article itemscope itemtype="https://pagelove.org/Mutation">',
        `  <span itemprop="method">${method}</span>`,
        `  <span itemprop="selector">${selector}</span>`,
        '  <span itemprop="path">/page.html</span>',
        '  <span itemprop="host">example.test</span>',
        `  <div itemprop="body">${body}</div>`,
        `  <span itemprop="placement">${placement}</span>`,
        '</article>',
    ].join('\n');
}

/** Simulate a local write made through the Pagelove primitives. */
export function localWrite(document, { method, selector, ok = true }) {
    document.dispatchEvent(new globalThis.CustomEvent('PLMethodStarted', {
        detail: { method, selector },
        bubbles: true,
    }));
    document.dispatchEvent(new globalThis.CustomEvent('PLMethodCompleted', {
        detail: { method, selector, response: { ok } },
        bubbles: true,
    }));
}

/** Simulate a local write whose fetch rejected — Started fires, Completed never does. */
export function localWriteThatNeverCompletes(document, { method, selector }) {
    document.dispatchEvent(new globalThis.CustomEvent('PLMethodStarted', {
        detail: { method, selector },
        bubbles: true,
    }));
}
