/**
 * Stand-in for the CDN-hosted dom-subscriber module.
 *
 * `primitives.mjs` imports it from an https: specifier, which Node cannot
 * resolve. The loader hook in ../loader.mjs redirects that specifier here.
 * Only the surface primitives.mjs actually uses is provided.
 */
export const DOMSubscriber = {
    calls: [],
    subscribe(doc, selector, callback) {
        this.calls.push({ doc, selector, callback });
    },
};
