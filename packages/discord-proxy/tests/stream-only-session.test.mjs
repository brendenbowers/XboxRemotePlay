import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { StreamOnlySession } from '../src/stream-only-session.mjs'

function fixture(overrides = {}) {
    const gateway = new EventEmitter()
    const packets = []
    gateway.sendStream = (op, d) => packets.push({ op, d })
    const calls = []
    let connected
    const config = {
        gateway, userId: '100000000000000001', guildId: '100000000000000002', channelId: '100000000000000003',
        voiceSessionId: 'synthetic-existing-voice-session', existingStreamKey: null,
        createConnection: ready => {
            connected = ready
            return {
                setSession: session => calls.push(['session', session]),
                setTokens: (endpoint, token) => { calls.push(['server', endpoint, token]); queueMicrotask(ready) },
                stop: () => calls.push(['stop']),
            }
        }, ...overrides,
    }
    const session = new StreamOnlySession(config)
    const dispatch = (t, d = {}) => gateway.emit('raw', { t, d: { stream_key: session.key, ...d } })
    return { session, gateway, packets, calls, dispatch, config, get connected() { return connected } }
}

test('stream-only start/stop never emits a voice-state change and accepts either event order', async () => {
    for (const reverse of [false, true]) {
        const f = fixture()
        const ready = f.session.start()
        assert.deepEqual(f.packets.map(packet => packet.op), [18], 'Do not unpause an unacknowledged stream')
        const create = () => f.dispatch('STREAM_CREATE', { rtc_server_id: '100000000000000004' })
        const server = () => f.dispatch('STREAM_SERVER_UPDATE', { endpoint: 'example.discord.media:443', token: 'fake-token' })
        if (reverse) { server(); create() } else { create(); server() }
        await ready
        assert.equal(f.session.state, 'ready')
        assert.equal(f.calls[0][0], 'session')
        assert.equal(f.calls[1][0], 'server')
        f.session.stop(); f.session.stop()
        assert.deepEqual(f.packets.map(packet => packet.op), [18, 22, 19])
        assert(!f.packets.some(packet => packet.op === 4))
        assert.equal(f.gateway.listenerCount('raw'), 0)
        assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1)
    }
})

test('unrelated streams are ignored; authoritative voice session changes stop only the proxy', async () => {
    const f = fixture()
    const ready = f.session.start()
    const rejected = assert.rejects(ready, /voice session changed/)
    f.dispatch('STREAM_CREATE', { stream_key: 'guild:unrelated', rtc_server_id: '100000000000000004' })
    assert.deepEqual(f.calls, [])
    f.dispatch('VOICE_STATE_UPDATE', { user_id: f.config.userId, channel_id: null, session_id: f.config.voiceSessionId })
    await rejected
    assert.deepEqual(f.packets.map(packet => packet.op), [18, 19])
    assert.equal(f.gateway.listenerCount('raw'), 0)
})

test('invalid server destinations, timeouts and server deletion clean up without joining/leaving voice', async () => {
    for (const endpoint of ['https://example.discord.media', 'example.discord.media.evil.test', '127.0.0.1', 'user@example.discord.media']) {
        const f = fixture()
        const ready = f.session.start()
        const rejected = assert.rejects(ready, /invalid stream response/)
        f.dispatch('STREAM_SERVER_UPDATE', { endpoint, token: 'fake-token' })
        await rejected
        assert.equal(f.gateway.listenerCount('raw'), 0)
        assert(!f.packets.some(packet => packet.op === 4))
    }
    const timeout = fixture({ timeoutMs: 10 })
    await assert.rejects(timeout.session.start(), /timed out/)
    assert.equal(timeout.gateway.listenerCount('raw'), 0)
    const ended = fixture()
    const ready = ended.session.start()
    const rejected = assert.rejects(ready, /ended the stream/)
    ended.dispatch('STREAM_DELETE')
    await rejected
    assert.deepEqual(ended.packets.map(packet => packet.op), [18])
})

test('unknown stream ownership or missing existing voice state cannot start a proxy', () => {
    assert.throws(() => fixture({ existingStreamKey: undefined }), /state must be known/)
    assert.throws(() => fixture({ existingStreamKey: 'another-active-stream' }), /state must be known/)
    assert.throws(() => fixture({ voiceSessionId: '' }), /voice session/)
})

test('server deletion preserves a known reason and negotiation stage without copying arbitrary payloads', async () => {
    for (const [reason, expected] of [['unauthorized', 'unauthorized'], ['synthetic-secret-media-token', 'unspecified']]) {
        const f = fixture()
        const pending = f.session.start()
        const rejected = assert.rejects(pending, new RegExp(`ended the stream \\(${expected}; before stream creation`))
        f.dispatch('STREAM_DELETE', { reason, token: 'synthetic-secret-media-token' })
        await rejected
        assert.deepEqual(f.session.diagnostics(), { streamCreated: false, mediaServerReceived: false, deleteReason: expected, media: null })
        assert(!JSON.stringify(f.session.diagnostics()).includes('synthetic-secret'))
        assert.deepEqual(f.packets.map(packet => packet.op), [18])
    }
})

