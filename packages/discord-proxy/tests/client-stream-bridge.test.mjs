import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installClientStreamBridge } from '../src/client-stream-bridge.mjs'
const voice = { userId: '100000000000000001', guildId: '100000000000000002', channelId: '100000000000000003', voiceSessionId: 'synthetic-desktop-session' }
const key = `guild:${voice.guildId}:${voice.channelId}:${voice.userId}`
function fixture() {
    const calls = [], packets = [], dispatched = [], stopped = []
    const dispatcher = { dispatch(action) { dispatched.push(action); return 'original-result' } }, original = dispatcher.dispatch
    let existing = null
    const bridge = installClientStreamBridge({ dispatcher, gateway: {
        streamCreate: (...args) => calls.push(['create', ...args]), streamDelete: (...args) => calls.push(['delete', ...args]), streamSetPaused: (...args) => calls.push(['pause', ...args]),
    }, readVoice: () => voice, readActiveStreamKey: () => existing, onPacket: packet => packets.push(packet), onStopped: reason => stopped.push(reason) })
    return { bridge, dispatcher, original, calls, packets, dispatched, stopped, set existing(value) { existing = value } }
}
test('uses the existing gateway for stream creation and isolates only its own stream media events', async () => {
    const f = fixture()
    assert.deepEqual(f.calls, [])
    f.bridge.start(voice)
    assert.deepEqual(f.calls, [['create', 'guild', voice.guildId, voice.channelId, null]])
    for (const type of ['RTC_CONNECTION_STATE', 'VOICE_STATE_UPDATES', 'MESSAGE_CREATE']) assert.equal(f.dispatcher.dispatch({ type }), 'original-result')
    await f.dispatcher.dispatch({ type: 'STREAM_CREATE', streamKey: key, rtcServerId: '100000000000000004' }).catch(() => assert.fail('Gateway must not reset'))
    await f.dispatcher.dispatch({ type: 'STREAM_SERVER_UPDATE', streamKey: key, endpoint: 'example.discord.media', token: 'synthetic-media-credential' }).catch(() => assert.fail('Gateway must not reset'))
    assert.deepEqual(f.packets.map(packet => packet.t), ['STREAM_CREATE', 'STREAM_SERVER_UPDATE'])
    assert.equal(f.dispatched.length, 3)
    f.dispatcher.dispatch({ type: 'STREAM_CREATE', streamKey: 'unrelated' })
    assert.equal(f.dispatched.length, 4)
    f.bridge.control(22, { stream_key: key, paused: false })
    assert.throws(() => f.bridge.control(4, {}), /Only owned/)
    assert.throws(() => f.bridge.control(19, { stream_key: 'unrelated' }), /Only owned/)
    assert(!JSON.stringify(f.bridge.status()).includes('credential'))
    f.bridge.dispose(); f.bridge.dispose()
    assert.equal(f.dispatcher.dispatch, f.original)
    assert.equal(f.calls.filter(call => call[0] === 'delete').length, 1)
})
test('voice session changes dispatch normally and release only the bridge-owned stream', () => {
    const f = fixture()
    f.bridge.start(voice)
    const action = { type: 'VOICE_STATE_UPDATES', voiceStates: [{ userId: voice.userId, channelId: null, sessionId: voice.voiceSessionId }] }
    assert.equal(f.dispatcher.dispatch(action), 'original-result')
    assert.equal(f.dispatched[0], action)
    assert.equal(f.bridge.status().ownsStream, false)
    assert.deepEqual(f.calls.at(-1), ['delete', key])
    f.bridge.dispose()
})
test('unknown/existing stream ownership is refused; malformed media events do not escape into the client dispatcher', () => {
    const f = fixture()
    for (const value of [undefined, key]) { f.existing = value; assert.throws(() => f.bridge.start(voice), /ownership/) }
    f.existing = null
    f.bridge.start(voice)
    f.dispatcher.dispatch({ type: 'STREAM_SERVER_UPDATE', streamKey: key, endpoint: 'attacker.invalid', token: 'synthetic-private-token' })
    assert.equal(f.packets.length, 0)
    assert(!JSON.stringify(f.stopped).includes('synthetic-private-token'))
    assert.equal(f.bridge.status().ownsStream, false)
    f.bridge.dispose()
})

test('preview: owned stream only, shown locally, posted through the client REST helper', async () => {
    const posts = []
    const dispatched = [], dispatcher = { dispatch(action) { dispatched.push(action) } }
    const bridge = installClientStreamBridge({ dispatcher, rest: { post: request => { posts.push(request); return Promise.resolve({ status: 204 }) } }, gateway: {
        streamCreate() {}, streamDelete() {}, streamSetPaused() {},
    }, readVoice: () => voice, readActiveStreamKey: () => null, onPacket() {} })
    const image = 'data:image/jpeg;base64,AAAA'
    assert.throws(() => bridge.preview(image), /owned stream/)
    bridge.start(voice)
    assert.throws(() => bridge.preview('data:image/png;base64,AAAA'), /Invalid preview/)
    assert.equal(bridge.preview(image), true)
    assert.deepEqual(dispatched.at(-1), { type: 'STREAM_PREVIEW_FETCH_SUCCESS', streamKey: key, previewURL: image })
    assert.deepEqual(posts, [{ url: `/streams/${key}/preview`, body: { thumbnail: image }, oldFormErrors: true, rejectWithError: false }])
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(bridge.status().previews, { sent: 1, ok: 1, failed: 0, lastStatus: 204, available: true })
    bridge.dispose()
})
