import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPrimitives, createdResponse } from './helpers/primitives-env.mjs';
import { FakeEventSource, mutationPayload } from './helpers/dom.mjs';

async function setup({ handshake = true } = {}) {
    let finishWrite;
    const response = new Promise(resolve => { finishWrite = resolve; });
    const { document, mod } = await setupPrimitives(
        '<ul id="list"></ul><ul id="other"></ul>', () => response,
    );
    // jsdom has no CSS.escape; all IDs used by this fixture need no escaping.
    globalThis.CSS = { escape(value) {
        assert.match(value, /^[a-z][a-z0-9-]*$/);
        return value;
    } };
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource;
    await import(`../pagelove/sse.mjs?concurrent-test=${Date.now()}-${Math.random()}`);
    const source = FakeEventSource.instances[0];
    if (handshake) source.emit('pagelove-connection', 'connection-token');
    const list = new mod.PLElement('https://example.test/page.html', document.querySelector('#list'));
    let started;
    document.addEventListener('PLMethodStarted', event => { started = event.detail; });
    const startWrite = () => {
        const pending = list.POST('<li id="local">my item</li>');
        assert.deepEqual(started, { method: 'POST', selector: '#list' });
        return pending;
    };
    const completeWrite = () => finishWrite(createdResponse('<li id="local">my item</li>'));
    const remotePost = (id, selector = '#list') => source.emit('mutation', mutationPayload({
        method: 'POST', selector, body: `<li id="${id}">another client's item</li>`,
    }));
    return { document, startWrite, completeWrite, remotePost, source };
}

test('a distinct remote POST survives while the local POST to the same parent is pending', async () => {
    const { document, startWrite, completeWrite, remotePost, source } = await setup();
    const pending = startWrite();
    remotePost('remote');
    completeWrite();
    await pending;
    source.close();
    assert.deepEqual([...document.querySelectorAll('#list > li')].map(el => el.id).sort(), ['local', 'remote']);
});

test('two distinct remote POSTs both survive while the local POST is pending', async () => {
    const { document, startWrite, completeWrite, remotePost, source } = await setup();
    const pending = startWrite();
    remotePost('remote-a');
    remotePost('remote-b');
    completeWrite();
    await pending;
    source.close();
    assert.deepEqual([...document.querySelectorAll('#list > li')].map(el => el.id).sort(), ['local', 'remote-a', 'remote-b']);
});

test('control: the remote POST survives after local completion', async () => {
    const { document, startWrite, completeWrite, remotePost, source } = await setup();
    const pending = startWrite();
    completeWrite();
    await pending;
    remotePost('remote');
    source.close();
    assert.deepEqual([...document.querySelectorAll('#list > li')].map(el => el.id).sort(), ['local', 'remote']);
});

test('control: a remote POST to a different parent survives during the local write', async () => {
    const { document, startWrite, completeWrite, remotePost, source } = await setup();
    const pending = startWrite();
    remotePost('remote', '#other');
    completeWrite();
    await pending;
    source.close();
    assert.equal(document.querySelector('#list > li').id, 'local');
    assert.equal(document.querySelector('#other > li').id, 'remote');
});

test('a handshake clears fallback suppression for a write already in flight', async () => {
    const { document, startWrite, completeWrite, remotePost, source } = await setup({ handshake: false });
    const pending = startWrite();
    source.emit('pagelove-connection', 'connection-token');
    remotePost('remote');
    completeWrite();
    await pending;
    source.close();
    assert.deepEqual([...document.querySelectorAll('#list > li')].map(el => el.id).sort(), ['local', 'remote']);
});

async function assertOwnEchoSuppressed({ document, startWrite, completeWrite, source }) {
    const pending = startWrite();
    source.emit('mutation', mutationPayload({
        method: 'POST', selector: '#list', body: '<li id="local">my item</li>',
    }));
    completeWrite();
    await pending;
    source.close();
    assert.equal(document.querySelectorAll('#list > #local').length, 1);
}

test('a server without a handshake retains in-flight own-echo protection', async () => {
    await assertOwnEchoSuppressed(await setup({ handshake: false }));
});

test('an empty handshake does not disable legacy own-echo protection', async () => {
    const fixture = await setup({ handshake: false });
    fixture.source.emit('pagelove-connection', '   ');
    await assertOwnEchoSuppressed(fixture);
});

test('reopening the stream restores fallback protection until the next handshake', async () => {
    const fixture = await setup();
    fixture.source.emit('open');
    await assertOwnEchoSuppressed(fixture);
});

test('a stream error restores fallback protection during reconnection', async () => {
    const fixture = await setup();
    fixture.source.onerror({ type: 'error' });
    await assertOwnEchoSuppressed(fixture);
});

test('a fresh handshake after reconnect allows concurrent remote additions again', async () => {
    const { document, startWrite, completeWrite, remotePost, source } = await setup();
    source.emit('open');
    source.emit('pagelove-connection', 'replacement-token');
    const pending = startWrite();
    remotePost('remote');
    completeWrite();
    await pending;
    source.close();
    assert.deepEqual([...document.querySelectorAll('#list > li')].map(el => el.id).sort(), ['local', 'remote']);
});
