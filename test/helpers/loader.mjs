/**
 * Module resolve hook: redirect the vendored dom-subscriber module to a local
 * stub, so tests exercise `primitives.mjs` on its own.
 *
 * The real module drives a MutationObserver and reads `self.customElements`,
 * neither of which the jsdom environment in ./primitives-env.mjs provides. The
 * stub records the subscriptions primitives.mjs asks for and nothing else.
 */
const VENDORED_PATH = '/pagelove/dom-subscriber.mjs';

export async function resolve(specifier, context, nextResolve) {
    const resolved = await nextResolve(specifier, context);
    if (new URL(resolved.url).pathname.endsWith(VENDORED_PATH)) {
        return {
            ...resolved,
            url: new URL('./stubs/dom-subscriber.mjs', import.meta.url).href,
            shortCircuit: true,
        };
    }
    return resolved;
}
