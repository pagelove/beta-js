/**
 * Browser environment for testing `pagelove/primitives.mjs` under Node.
 *
 * Requires the resolve hook in ./register.mjs to be installed (the module
 * imports dom-subscriber from an https: specifier Node cannot resolve).
 */
import { JSDOM } from 'jsdom';

/**
 * Install DOM globals and a scripted fetch, then import primitives.
 *
 * @param {string} bodyHtml — markup for the document body
 * @param {(request: Request) => Response|Promise<Response>} fetchImpl
 * @returns {Promise<{document: Document, mod: object, calls: Request[]}>}
 */
export async function setupPrimitives(bodyHtml, fetchImpl) {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`, {
        url: 'https://example.test/page.html',
    });

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.DOMParser = dom.window.DOMParser;
    globalThis.Node = dom.window.Node;
    globalThis.CSS = dom.window.CSS;
    globalThis.location = dom.window.location;

    // #observeForETag builds one on a successful write; jsdom has no
    // implementation and the tests here do not exercise its behaviour.
    globalThis.IntersectionObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };

    const calls = [];
    globalThis.fetch = async (request) => {
        calls.push(request);
        return fetchImpl(request);
    };

    const mod = await import(`../../pagelove/primitives.mjs?t=${Date.now()}-${Math.random()}`);
    return { document: globalThis.document, mod, calls };
}

/** A 201 response carrying `html`, as the server answers a POST. */
export function createdResponse(html) {
    return new Response(html, {
        status: 201,
        headers: { 'Content-Type': 'text/html', ETag: '"abc123"' },
    });
}
