/**
 * Regression tests for echo-suppression bookkeeping in the SSE client.
 *
 * Background: the client records each local write as a "pending echo" so that
 * if the server streams that write back, the DOM is not changed twice — the
 * write path already applied it locally (see primitives.mjs, which appends on
 * a successful POST and removes on a successful DELETE).
 *
 * The server, however, deliberately does NOT stream a mutation back to the
 * connection that caused it. So for a successful write the echo never arrives,
 * and an entry that is only cleared by an arriving echo is never cleared at
 * all. It then matches the next mutation from ANOTHER client with the same
 * method and selector, and silently swallows it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    setupSseClient,
    mutationPayload,
    localWrite,
    localWriteThatNeverCompletes,
} from './helpers/dom.mjs';

test('a remote mutation is applied when no local write is pending', async () => {
    const { document, source } = await setupSseClient('<ul id="list"></ul>');

    source.emit('mutation', mutationPayload({
        method: 'POST', selector: '#list', body: '<li>from-someone-else</li>',
    }));

    assert.equal(document.querySelectorAll('#list > li').length, 1);
});

test('a successful local write does not swallow a later remote mutation', async () => {
    const { document, source } = await setupSseClient('<ul id="list"></ul>');

    // The user adds an item. The write path applies it locally itself, so the
    // list already contains it; the server will not echo it back.
    document.querySelector('#list').innerHTML = '<li>mine</li>';
    localWrite(document, { method: 'POST', selector: '#list', ok: true });

    // Now somebody else adds an item. This one MUST reach the DOM.
    source.emit('mutation', mutationPayload({
        method: 'POST', selector: '#list', body: '<li>from-someone-else</li>',
    }));

    const items = [...document.querySelectorAll('#list > li')].map(li => li.textContent);
    assert.deepEqual(items, ['mine', 'from-someone-else']);
});

test('repeated local writes do not swallow that many remote mutations', async () => {
    const { document, source } = await setupSseClient('<ul id="list"></ul>');

    for (let i = 0; i < 3; i++) {
        localWrite(document, { method: 'POST', selector: '#list', ok: true });
    }

    for (let i = 0; i < 3; i++) {
        source.emit('mutation', mutationPayload({
            method: 'POST', selector: '#list', body: `<li>remote-${i}</li>`,
        }));
    }

    assert.equal(document.querySelectorAll('#list > li').length, 3,
        'each remote mutation must be applied, however many local writes preceded it');
});

test('an in-flight local write still suppresses its own echo', async () => {
    // This is what the mechanism is FOR: between the request starting and it
    // completing, an echo of our own write must not be applied a second time.
    const { document, source } = await setupSseClient('<ul id="list"></ul>');

    localWriteThatNeverCompletes(document, { method: 'POST', selector: '#list' });

    source.emit('mutation', mutationPayload({
        method: 'POST', selector: '#list', body: '<li>echo-of-my-own-write</li>',
    }));

    assert.equal(document.querySelectorAll('#list > li').length, 0,
        'an echo arriving while our write is in flight must be suppressed');
});

test('a write whose request never completes cannot suppress forever', async () => {
    // If fetch rejects, PLMethodCompleted never fires. Without an expiry the
    // entry would outlive the request and swallow an unrelated mutation.
    const { document, source, mod } = await setupSseClient('<ul id="list"></ul>');
    const { ECHO_TTL_MS } = mod;

    const realNow = Date.now;
    try {
        localWriteThatNeverCompletes(document, { method: 'POST', selector: '#list' });
        Date.now = () => realNow() + ECHO_TTL_MS + 1;

        source.emit('mutation', mutationPayload({
            method: 'POST', selector: '#list', body: '<li>much-later</li>',
        }));
    } finally {
        Date.now = realNow;
    }

    assert.equal(document.querySelectorAll('#list > li').length, 1,
        'a stale pending echo must expire rather than suppress indefinitely');
});

test('a failed local write does not suppress a later remote mutation', async () => {
    const { document, source } = await setupSseClient('<ul id="list"></ul>');

    localWrite(document, { method: 'POST', selector: '#list', ok: false });

    source.emit('mutation', mutationPayload({
        method: 'POST', selector: '#list', body: '<li>from-someone-else</li>',
    }));

    assert.equal(document.querySelectorAll('#list > li').length, 1);
});
