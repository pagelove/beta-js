/**
 * PageloveSSE — live mutation streaming client for Pagelove.
 *
 * Opens an SSE connection to a dombase-http document, parses HTML Microdata
 * mutation events, applies them to the live DOM, and dispatches custom events
 * for observability.
 *
 * Usage:
 *   import { PageloveSSE } from './index.mjs';
 *   const sse = new PageloveSSE();            // subscribe to current page
 *   const sse = new PageloveSSE('/foo.html'); // subscribe to specific path
 *   sse.close();                              // disconnect
 */

import { Pagelove } from './debug.mjs';

class PageloveSSE {
    #source;
    #url;
    #pendingEchoes = [];

    /**
     * @param {string} [url=window.location.href] — document URL to subscribe to
     */
    constructor(url) {
        this.#url = url || window.location.href.split('#')[0];
        this.#connect();
    }

    #connect() {
        this.#source = new EventSource(this.#url, { withCredentials: true });
        Pagelove.log(Pagelove.SSE, '[PLSSE] connecting to', this.#url);

        this.#source.addEventListener('open', () => {
            Pagelove.log(Pagelove.SSE, '[PLSSE] open');
        });

        this.#source.addEventListener('mutation', (event) => {
            const mutation = PageloveSSE.parse(event.data);
            if (!mutation) {
                Pagelove.warn(Pagelove.SSE, '[PLSSE] mutation: failed to parse', event.data);
                return;
            }
            Pagelove.log(Pagelove.SSE, '[PLSSE] mutation', mutation.method, mutation.selector, mutation);
            this.#apply(mutation);
        });

        this.#source.addEventListener('reset', (event) => {
            const reason = PageloveSSE.parseReset(event.data);
            Pagelove.log(Pagelove.SSE, '[PLSSE] reset', reason);

            const resetEvent = new CustomEvent('PLStreamReset', {
                detail: { reason },
                bubbles: true,
                composed: true,
                cancelable: true
            });

            if (document.dispatchEvent(resetEvent)) {
                // Default action: reload
                location.reload();
            }
        });

        this.#source.onerror = (e) => {
            Pagelove.warn(Pagelove.SSE, '[PLSSE] error (readyState=' + this.#source?.readyState + ')', e);
            // EventSource reconnects automatically; nothing to do here
        };

        document.addEventListener('PLMethodStarted', (event) => {
            this.#pendingEchoes.push({
                method: event.detail.method.toUpperCase(),
                selector: event.detail.selector
            });
        });

        document.addEventListener('PLMethodCompleted', (event) => {
            if (!event.detail.response.ok) {
                const method = event.detail.method.toUpperCase();
                const selector = event.detail.selector;
                const idx = this.#pendingEchoes.findIndex(e =>
                    e.method === method && e.selector === selector
                );
                if (idx !== -1) this.#pendingEchoes.splice(idx, 1);
            }
        });
    }

    /**
     * Parse an HTML Microdata mutation event payload.
     *
     * @param {string} data — the SSE event data (HTML with Microdata)
     * @returns {{ method: string, selector: string, path: string, host: string, body: string } | null}
     */
    static parse(data) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(data, 'text/html');
        const item = doc.querySelector('[itemtype="https://pagelove.org/Mutation"]');
        if (!item) return null;

        const prop = (name) => {
            const el = item.querySelector(`[itemprop="${name}"]`);
            if (!el) return '';
            return name === 'body' ? el.innerHTML : el.textContent;
        };

        return {
            method: prop('method'),
            selector: prop('selector'),
            path: prop('path'),
            host: prop('host'),
            body: prop('body'),
            etag: prop('etag'),
            destination: prop('destination'),
            placement: prop('placement'),
        };
    }

    /**
     * Parse a StreamReset event payload.
     *
     * @param {string} data — the SSE event data
     * @returns {string} the reset reason
     */
    static parseReset(data) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(data, 'text/html');
        const el = doc.querySelector('[itemprop="reason"]');
        return el ? el.textContent : 'unknown';
    }

    /**
     * Apply a parsed mutation to the live DOM.
     *
     * Dispatches PLMutation (cancelable, before) and PLMutationApplied (after).
     */
    #apply(mutation) {
        const { method, selector, body } = mutation;

        // Check if this mutation is an echo of a local operation (before querySelector,
        // because local DELETEs remove the element before the echo arrives)
        const echoIdx = this.#pendingEchoes.findIndex(e =>
            e.method === method.toUpperCase() && e.selector === selector
        );
        const isEcho = echoIdx !== -1;
        if (isEcho) this.#pendingEchoes.splice(echoIdx, 1);

        const element = document.querySelector(selector);
        if (!element) return;

        // Dispatch pre-mutation event (cancelable)
        const preEvent = new CustomEvent('PLMutation', {
            detail: { ...mutation, element },
            bubbles: true,
            composed: true,
            cancelable: true
        });

        if (!document.dispatchEvent(preEvent)) {
            // Consumer called preventDefault — skip DOM change
            // Echo entry already cleaned above
            return;
        }

        let resultElement = null;

        if (!isEcho) {
            switch (method.toUpperCase()) {
                case 'POST': {
                    const template = document.createElement('template');
                    template.innerHTML = body.trim();
                    const fragment = template.content;
                    const firstChild = fragment.firstElementChild || fragment.firstChild;
                    element.appendChild(fragment);
                    resultElement = firstChild;
                    break;
                }

                case 'PUT': {
                    const template = document.createElement('template');
                    template.innerHTML = body.trim();
                    const newElement = template.content.firstElementChild || template.content.firstChild;
                    if (newElement) {
                        element.replaceWith(newElement);
                        resultElement = newElement;
                    }
                    break;
                }

                case 'DELETE': {
                    element.remove();
                    resultElement = null;
                    break;
                }

                case 'MOVE': {
                    const dest = document.querySelector(mutation.destination);
                    if (!dest) break;
                    switch ((mutation.placement || 'append').toLowerCase()) {
                        case 'before':
                            dest.parentElement?.insertBefore(element, dest);
                            break;
                        case 'after':
                            dest.parentElement?.insertBefore(element, dest.nextSibling);
                            break;
                        case 'prepend':
                            dest.insertBefore(element, dest.firstChild);
                            break;
                        case 'append':
                        default:
                            dest.appendChild(element);
                            break;
                    }
                    resultElement = element;
                    break;
                }

                default:
                    return;
            }
        }

        if (mutation.etag && resultElement) {
            resultElement.etag = mutation.etag;
        }

        // Dispatch post-mutation event
        document.dispatchEvent(new CustomEvent('PLMutationApplied', {
            detail: { ...mutation, element: resultElement },
            bubbles: true,
            composed: true,
            cancelable: false
        }));
    }

    /**
     * Close the SSE connection.
     */
    close() {
        if (this.#source) {
            this.#source.close();
            this.#source = null;
        }
    }

    /**
     * The underlying EventSource, if connected.
     * @returns {EventSource|null}
     */
    get source() {
        return this.#source;
    }

    /**
     * The URL this client is subscribed to.
     * @returns {string}
     */
    get url() {
        return this.#url;
    }
}

export { PageloveSSE };

const _instance = new PageloveSSE();
