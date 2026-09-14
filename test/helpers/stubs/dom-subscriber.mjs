/**
 * Stand-in for ../../../pagelove/dom-subscriber.mjs.
 *
 * The resolve hook in ../loader.mjs redirects the vendored module here, so a
 * test can import primitives.mjs without a live MutationObserver. Only the
 * surface primitives.mjs actually uses is provided.
 */
export const DOMSubscriber = {
    calls: [],
    subscribe(doc, selector, callback) {
        this.calls.push({ doc, selector, callback });
    },
};
