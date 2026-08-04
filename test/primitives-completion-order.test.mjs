/**
 * `PLMethodCompleted` must mark the end of the whole operation, including the
 * local DOM change the write path makes itself.
 *
 * The SSE client keeps a write's echo suppressed until this event fires (see
 * sse.mjs). If the event fires while local DOM work is still outstanding, and
 * the server is one that echoes a write back to its originating connection,
 * that echo is applied as a remote mutation and the local write then applies
 * the same change again — appending the child twice.
 *
 * POST is the case that can actually interleave: it awaits `response.text()`
 * after the request resolves, which yields to the task queue, and only then
 * appends. DELETE calls `.remove()` with no await in between, so no event can
 * be delivered between completion and the DOM change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupPrimitives, createdResponse } from './helpers/primitives-env.mjs';

const URL_UNDER_TEST = 'https://example.test/page.html';

test('POST announces completion only once its child is in the DOM', async () => {
    const { document, mod } = await setupPrimitives(
        '<ul id="list"></ul>',
        () => createdResponse('<li id="added">added</li>'),
    );

    const list = document.querySelector('#list');
    const el = new mod.PLElement(URL_UNDER_TEST, list);

    let childWasPresent = null;
    document.addEventListener('PLMethodCompleted', () => {
        childWasPresent = Boolean(document.querySelector('#list > #added'));
    });

    await el.POST('<li id="added">added</li>');

    assert.equal(childWasPresent, true,
        'PLMethodCompleted fired while the appended child was still missing — ' +
        'an echo delivered in that window would be applied on top of it');
});

test('POST still appends exactly one child', async () => {
    const { document, mod } = await setupPrimitives(
        '<ul id="list"></ul>',
        () => createdResponse('<li id="added">added</li>'),
    );

    const el = new mod.PLElement(URL_UNDER_TEST, document.querySelector('#list'));
    await el.POST('<li id="added">added</li>');

    assert.equal(document.querySelectorAll('#list > li').length, 1);
});

test('POST reports started before completed', async () => {
    const { document, mod } = await setupPrimitives(
        '<ul id="list"></ul>',
        () => createdResponse('<li id="added">added</li>'),
    );

    const seen = [];
    document.addEventListener('PLMethodStarted', () => seen.push('started'));
    document.addEventListener('PLMethodCompleted', () => seen.push('completed'));

    const el = new mod.PLElement(URL_UNDER_TEST, document.querySelector('#list'));
    await el.POST('<li id="added">added</li>');

    assert.deepEqual(seen, ['started', 'completed']);
});

test('POST returns a response whose body is still readable by the caller', async () => {
    // The finalize step consumes response.text(); the caller must still get a
    // response it can read, not one whose body is already used up.
    const { document, mod } = await setupPrimitives(
        '<ul id="list"></ul>',
        () => createdResponse('<li id="added">added</li>'),
    );

    const el = new mod.PLElement(URL_UNDER_TEST, document.querySelector('#list'));
    const response = await el.POST('<li id="added">added</li>');

    assert.equal(response.ok, true);
    assert.match(await response.text(), /id="added"/);
});

test('a POST whose body cannot be read still reports completion', async () => {
    // finalize runs before the completion event, so anything it throws would
    // skip that event entirely — leaving the entry PLMethodStarted put in the
    // SSE echo-suppression queue orphaned, and eligible to discard an
    // unrelated mutation until it ages out.
    const unreadable = {
        ok: true,
        status: 201,
        headers: new Headers({ ETag: '"abc123"' }),
        text: () => Promise.reject(new Error('body stream truncated')),
    };

    const { document, mod } = await setupPrimitives('<ul id="list"></ul>', () => unreadable);

    let completed = false;
    document.addEventListener('PLMethodCompleted', () => { completed = true; });

    const el = new mod.PLElement(URL_UNDER_TEST, document.querySelector('#list'));

    await assert.rejects(
        () => el.POST('<li id="added">added</li>'),
        /body stream truncated/,
        'the failure must still reach the caller',
    );
    assert.equal(completed, true,
        'completion must be announced even when finalization throws, or the ' +
        'echo-suppression entry is orphaned');
});

test('a failed POST does not append, and still reports completion', async () => {
    const { document, mod } = await setupPrimitives(
        '<ul id="list"></ul>',
        () => new Response('nope', { status: 403 }),
    );

    let completed = false;
    document.addEventListener('PLMethodCompleted', () => { completed = true; });

    const el = new mod.PLElement(URL_UNDER_TEST, document.querySelector('#list'));
    const response = await el.POST('<li id="added">added</li>');

    assert.equal(response.status, 403);
    assert.equal(document.querySelectorAll('#list > li').length, 0);
    assert.equal(completed, true, 'a failed write must still announce completion');
});
