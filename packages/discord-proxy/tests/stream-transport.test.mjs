import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DiscordStreamTransport, mediaAnswer } from '../src/stream-transport.mjs'

const sdp = ['c=IN IP4 192.0.2.1', 'a=rtcp:5000 IN IP4 192.0.2.1', 'a=ice-ufrag:test', 'a=ice-pwd:synthetic-password',
    'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'), 'a=candidate:1 1 UDP 1 192.0.2.1 5000 typ host'].join('\n')
function fixture() {
    const sent = [], calls = [], listeners = {}
    const socket = { readyState: 1, addEventListener: (name, fn) => { listeners[name] = fn }, send: data => sent.push(typeof data === 'string' ? JSON.parse(data) : data), close: () => calls.push('socket-close') }
    let peerState = 'new', onState, onDescription
    const peer = { state: () => peerState, onStateChange: fn => { onState = fn }, onLocalDescription: fn => { onDescription = fn },
        setLocalDescription: () => onDescription('synthetic-offer'), setRemoteDescription: (answer, type) => calls.push([type, answer]), close: () => calls.push('peer-close') }
    const encryption = { ready: false, initialize: version => { assert.equal(version, 1); calls.push('encryption-initialized') },
        handleJson: op => { if (op === 22) encryption.ready = true }, handleBinary: () => {}, close: () => calls.push('encryption-close') }
    const sender = { publish: frame => { calls.push(frame); return true }, close: () => calls.push('sender-close') }
    const transport = new DiscordStreamTransport({ userId: '100000000000000001', width: 1920, height: 1080, fps: 60,
        createSocket: url => { assert.equal(url, 'wss://test.discord.media/?v=8'); return socket }, createPeer: () => peer,
        createEncryption: () => encryption, createSender: () => sender,
        onReady: () => calls.push('ready'), onStopped: reason => calls.push(['stopped', reason]) })
    transport.serverId = '100000000000000004'
    transport.setSession('existing-voice-session')
    transport.setTokens('test.discord.media', 'synthetic-media-token')
    const message = (op, d) => listeners.message({ data: JSON.stringify({ op, d }) })
    const ready = () => message(2, { ssrc: 1, streams: [{ ssrc: 2, rtx_ssrc: 3 }] })
    const connected = () => { peerState = 'connected'; onState('connected') }
    return { transport, listeners, sent, calls, message, ready, connected }
}

test('connected share is announced while awaiting viewer keys, but media requires DAVE encryption', () => {
    const f = fixture()
    f.listeners.open()
    assert.equal(f.sent[0].op, 0)
    assert.equal(f.sent[0].d.session_id, 'existing-voice-session')
    f.ready()
    assert.equal(f.transport.publish({}), false)
    f.message(4, { sdp, video_codec: 'H264', audio_codec: 'opus', dave_protocol_version: 1 })
    f.connected()
    assert.equal(f.transport.publish({}), false)
    assert.equal(f.calls.filter(call => call === 'ready').length, 1)
    assert.equal(f.transport.diagnostics().phase, 'waiting-for-viewer-keys')
    assert.equal(f.sent.find(packet => packet.op === 12 && packet.d.video_ssrc === 2).d.streams[0].active, true)
    assert.equal(f.sent.find(packet => packet.op === 12 && packet.d.video_ssrc === 2).d.rtx_ssrc, 3)
    assert.equal(f.sent.find(packet => packet.op === 1).d.codecs.find(codec => codec.name === 'H264').rtx_payload_type, 102)
    f.message(22, { transition_id: 1 })
    assert.equal(f.calls.filter(call => call === 'ready').length, 1)
    assert.equal(f.sent.find(packet => packet.op === 5).d.speaking, 2)
    assert.equal(f.transport.publish({ synthetic: true }), true)
    f.message(22, { transition_id: 1 })
    assert.equal(f.calls.filter(call => call === 'ready').length, 1)
    f.transport.stop(); f.transport.stop()
    for (const resource of ['sender', 'peer', 'socket', 'encryption']) assert.equal(f.calls.filter(call => call === resource + '-close').length, 1)
    assert.equal(f.transport.token, null)
})

test('bad media responses and socket failures stop only the owned media transport', () => {
    for (const fail of [f => f.message(4, { sdp }), f => f.message(2, { streams: [] }), f => f.listeners.message({ data: '{' }), f => f.listeners.error({ message: 'synthetic-sensitive-payload' })]) {
        const f = fixture()
        fail(f)
        assert.equal(f.transport.closed, true)
        assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'stopped').length, 1)
        assert(!JSON.stringify(f.calls).includes('synthetic-sensitive-payload'))
        assert.equal(f.transport.publish({}), false)
    }
})

test('advertised ceiling grows with successfully sent source resolution and stays high on adaptation down', () => {
    const f = fixture()
    f.ready(); f.message(4, { sdp, video_codec: 'H264', audio_codec: 'opus', dave_protocol_version: 1 }); f.connected(); f.message(22, {})
    const announces = () => f.sent.filter(packet => packet.op === 12 && packet.d.video_ssrc === 2)
    assert.equal(f.transport.diagnostics().video.sent, null)
    f.transport.sender.videoResolution = { width: 2560, height: 1440 }
    assert(f.transport.publish({ kind: 'video' }))
    assert.deepEqual(announces().at(-1).d.streams[0].max_resolution, { type: 'fixed', width: 2560, height: 1440 })
    assert.deepEqual(f.transport.diagnostics().video.sent, { width: 2560, height: 1440 })
    f.transport.sender.videoResolution = { width: 1280, height: 720 }
    f.transport.publish({ kind: 'video' })
    assert.equal(announces().length, 2)
    assert.deepEqual(f.transport.diagnostics().video.advertised, { width: 2560, height: 1440 })
    f.transport.sender.publish = () => false
    f.transport.sender.videoResolution = { width: 3840, height: 2160 }
    f.transport.publish({ kind: 'video' })
    assert.equal(announces().length, 2)
    f.transport.stop()
})

test('SDP answer keeps DTLS fingerprint, ICE parameters, codec clocks and receiving directions', () => {
    const answer = mediaAnswer(sdp)
    assert(answer.includes('a=group:BUNDLE 0 1'))
    assert(answer.includes('a=rtpmap:120 opus/48000/2'))
    assert(answer.includes('a=rtpmap:101 H264/90000'))
    assert(answer.includes('a=rtpmap:102 rtx/90000'))
    assert(answer.includes('a=fmtp:102 apt=101'))
    assert.equal(answer.split('a=recvonly').length - 1, 2)
    assert.throws(() => mediaAnswer(sdp.replace('sha-256', 'sha-1')), /parameters/)
    assert.throws(() => mediaAnswer('x'.repeat(65537)), /Invalid/)
    assert.throws(() => mediaAnswer(sdp.replace('5000', '0')), /parameters/)
})

test('media close reports only a numeric code and preserves the failure stage before cleanup', () => {
    const f = fixture()
    f.listeners.open()
    f.ready()
    f.listeners.close({ code: 4006, reason: 'synthetic-secret-token' })
    assert.equal(f.transport.diagnostics().phase, 'negotiating-webrtc')
    assert.equal(f.transport.diagnostics().closeCode, 4006)
    assert.equal(f.transport.diagnostics().protocolAccepted, false)
    assert(!JSON.stringify(f.calls).includes('synthetic-secret-token'))
    assert(!JSON.stringify(f.transport.diagnostics()).includes('synthetic-secret-token'))
})
