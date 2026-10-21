import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CanaryConnector } from '../src/canary-connector.mjs'
const voice = { userId: '100000000000000001', guildId: '100000000000000002', channelId: '100000000000000003', voiceSessionId: 'synthetic-session', existingStreamKey: null }
const target = { type: 'page', url: 'https://canary.discord.com/channels/@me', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/synthetic' }
function fixture(targets = [target]) {
    const sent = [], sockets = []
    let snapshot = { voice, packets: [], ownsStream: false }, fail = false
    class Socket {
        readyState = 1
        constructor() { sockets.push(this); queueMicrotask(() => this.onopen()) }
        send(text) {
            const request = JSON.parse(text); sent.push(request)
            const expression = request.params.expression
            const value = expression.includes(']?.dispose()') || expression.includes('].control(') ? true : snapshot
            const result = fail ? { exceptionDetails: { text: 'synthetic-private-value' } } : { result: { value } }
            queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: request.id, result }) }))
        }
        close() { this.readyState = 3; this.onclose?.() }
    }
    const connector = new CanaryConnector({ fetchImpl: async () => ({ ok: true, json: async () => targets }), WebSocketImpl: Socket, pollMs: 60000 })
    return { connector, sent, sockets, set snapshot(value) { snapshot = value }, set fail(value) { fail = value } }
}
test('Canary connector uses only its scoped control API and forwards stream credentials only to internal listeners', async () => {
    const f = fixture(), packets = []
    await f.connector.connect()
    assert.deepEqual(f.connector.existingVoice(), voice)
    f.connector.on('raw', p => packets.push(p))
    f.connector.sendStream(18, { type: 'guild', guild_id: voice.guildId, channel_id: voice.channelId, preferred_region: null })
    assert.throws(() => f.connector.sendStream(4, {}), /Only owned/)
    f.snapshot = { voice, ownsStream: true, packets: [{ t: 'STREAM_SERVER_UPDATE', d: { token: 'synthetic-media-token' } }, { t: 'MESSAGE_CREATE', d: { content: 'private' } }] }
    await f.connector.poll()
    assert.equal(packets.length, 1)
    assert.equal(packets[0].t, 'STREAM_SERVER_UPDATE')
    assert(!JSON.stringify(f.connector.status()).includes('synthetic-media-token'))
    assert(f.sent.every(request => request.method === 'Runtime.evaluate'))
    assert(f.sent.some(request => request.params.expression.includes('.control(18,')))
    await f.connector.disconnect()
    assert.equal(f.sockets[0].readyState, 3)
    assert(f.sent.some(request => request.params.expression.includes('.dispose()')))
    assert.equal(f.connector.requests.size, 0)
})
test('discovery rejects non-loopback targets and errors never expose runtime exception contents', async () => {
    const bad = fixture([{ ...target, webSocketDebuggerUrl: 'ws://attacker.invalid:9223/page' }])
    await assert.rejects(bad.connector.connect(), /Could not connect/)
    assert.equal(bad.sockets.length, 0)
    const f = fixture()
    f.fail = true
    await assert.rejects(f.connector.connect(), error => !error.message.includes('synthetic-private-value'))
    assert.equal(f.connector.state, 'disconnected')
    assert.equal(f.sockets[0].readyState, 3)
})
test('current voice-session changes stop the session and invalidate stale publication destinations', async () => {
    const f = fixture(), packets = []
    await f.connector.connect()
    f.connector.on('raw', p => packets.push(p))
    f.snapshot = { voice: null, packets: [], ownsStream: false }
    await f.connector.poll()
    assert.equal(packets[0].t, 'VOICE_STATE_UPDATE')
    assert.equal(packets[0].d.channel_id, null)
    assert.throws(() => f.connector.existingVoice(), /Join a server/)
    await f.connector.disconnect()
})
