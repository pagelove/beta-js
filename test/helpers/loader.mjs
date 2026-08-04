/**
 * Module resolve hook: redirect the CDN-hosted dom-subscriber import to a
 * local stub so `primitives.mjs` can be imported under Node.
 *
 * Node does not resolve https: import specifiers, so without this the module
 * cannot be loaded at all — and therefore cannot be tested.
 */
const REMOTE_PREFIX = 'https://cdn.pagelove.net/js/dom-subscriber/';

export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(REMOTE_PREFIX)) {
        return {
            url: new URL('./stubs/dom-subscriber.mjs', import.meta.url).href,
            shortCircuit: true,
        };
    }
    return nextResolve(specifier, context);
}
