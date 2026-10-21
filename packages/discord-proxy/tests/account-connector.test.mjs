import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ExperimentalAccountConnector } from '../src/account-connector.mjs'

const userId = '100000000000000001', guildId = '100000000000000002', channelId = '100000000000000003'
const credential = 'synthetic-local-credential-no-real-account'
test('the installed connector constructs and destroys locally without signing in', async () => {
    const connector = new ExperimentalAccountConnector()
    const client = await connector.createClient()
    try {
        assert.equal(client.options.presence, undefined)
        assert.equal(client.voice.connection, null)
        assert.equal(client.options.DMChannelVoiceStatusSync, 0)
    } finally { client.destroy() }
})
function fixture(login) {
    const client = new EventEmitter(), sent = []
    client.user = { id: userId }
    client.ws = { broadcast: packet => sent.push(packet) }
    client.destroy = () => { client.destroyed = true; client.token = null }
    client.login = login || (async token => { client.token = token; return token })
    const connector = new ExperimentalAccountConnector({ createClient: async () => client, timeoutMs: 30 })
    const voice = (extra = {}) => client.emit('raw', { t: 'VOICE_STATE_UPDATE', d: { user_id: userId, guild_id: guildId, channel_id: channelId, session_id: 'existing-desktop-session', self_stream: false, ...extra } })
    return { connector, client, sent, voice }
}

test('login discovers the existing voice session and only allows stream controls', async () => {
    const f = fixture()
    const status = await f.connector.connect(credential)
    assert.equal(status.state, 'connected')
    assert(!JSON.stringify(status).includes(credential))
    assert.throws(() => f.connector.existingVoice(), /Join a server voice/)
    f.voice()
    assert.equal(f.connector.existingVoice().voiceSessionId, 'existing-desktop-session')
    for (const op of [4, 1, 24]) assert.throws(() => f.connector.sendStream(op, {}), /Only stream/)
    const key = `guild:${guildId}:${channelId}:${userId}`
    f.connector.sendStream(18, { type: 'guild', guild_id: guildId, channel_id: channelId, preferred_region: null })
    f.connector.sendStream(22, { stream_key: key, paused: false })
    f.connector.sendStream(19, { stream_key: key })
    assert.deepEqual(f.sent.map(p => p.op), [18, 22, 19])
    assert.throws(() => f.connector.sendStream(19, { stream_key: key + 'x' }), /Invalid owned/)
    f.connector.disconnect()
    assert.equal(f.client.destroyed, true)
    assert.equal(f.client.token, null)
    assert.equal(f.client.listenerCount('raw'), 0)
    assert.equal(f.client.listenerCount('error'), 0)
})

test('unknown/existing streams, private calls and ended voice cannot be used', async () => {
    const f = fixture()
    await f.connector.connect(credential)
    f.client.emit('raw', { t: 'READY', d: { user: { id: userId }, guilds: [{ id: guildId, voice_states: [{ user_id: userId, channel_id: channelId, session_id: 'desktop', self_stream: false }] }] } })
    assert.equal(f.connector.existingVoice().channelId, channelId)
    for (const self_stream of [undefined, true]) {
        f.voice({ self_stream })
        assert.throws(() => f.connector.existingVoice(), /existing Discord stream/)
    }
    f.voice({ self_stream: undefined, self_video: false })
    assert.equal(f.connector.existingVoice().existingStreamKey, null)
    f.voice({ guild_id: null })
    assert.throws(() => f.connector.existingVoice(), /Join a server voice/)
    f.voice({ channel_id: null })
    assert.throws(() => f.connector.sendStream(18, {}), /voice session ended/)
    assert.deepEqual(f.sent, [])
    f.connector.disconnect()
})

test('failed, timed-out and cancelled login never expose credentials or leave listeners', async () => {
    for (const login of [async () => { throw new Error(credential) }, () => new Promise(() => {})]) {
        const f = fixture(login)
        await assert.rejects(f.connector.connect(credential), error => !error.message.includes(credential) && /connection failed/.test(error.message))
        assert.equal(f.connector.status().state, 'disconnected')
        assert.equal(f.client.destroyed, true)
        assert.equal(f.client.listenerCount('raw'), 0)
    }
    const f = fixture(() => new Promise(() => {}))
    const pending = f.connector.connect(credential)
    await new Promise(resolve => setImmediate(resolve))
    f.connector.disconnect()
    await assert.rejects(pending, /cancelled/)
    assert.equal(f.client.destroyed, true)
})

test('a gateway disconnect invalidates remembered voice state; unrelated account data is not forwarded', async () => {
    const f = fixture(), received = []
    f.connector.on('raw', packet => received.push(packet.t))
    await f.connector.connect(credential)
    f.voice()
    f.client.emit('raw', { t: 'MESSAGE_CREATE', d: { content: 'synthetic-private-data' } })
    assert.deepEqual(received, ['VOICE_STATE_UPDATE'])
    f.client.emit('shardDisconnect', { code: 1006 })
    assert.equal(f.connector.status().voice, null)
    assert.throws(() => f.connector.existingVoice(), /Join a server voice/)
})
