import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { cleanup, PeerConnection } from '@lng2004/node-datachannel'
import dave from '@snazzah/davey'
import { EncodedMediaSender } from '../src/media-sender.mjs'

after(() => cleanup())
const keyframe = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0, 0, 0, 1, 0x68, 1, 2, 0, 0, 0, 1, 0x65, 4, 5])
const deltaFrame = Buffer.from([0, 0, 1, 0x41, 7, 8])
function sizedKeyframe(width, height) {
    const ue = value => { const bits = (value + 1).toString(2); return '0'.repeat(bits.length - 1) + bits }
    const codedHeight = Math.ceil(height / 16) * 16
    const bits = '010011010000000000110011' + ue(0) + ue(0) + ue(0) + ue(0) + ue(1) + '0' + ue(width / 16 - 1) + ue(codedHeight / 16 - 1) + '11' +
        (height === codedHeight ? '0' : '1' + ue(0) + ue(0) + ue(0) + ue((codedHeight - height) / 2)) + '1'
    const bytes = Buffer.from(bits.padEnd(Math.ceil(bits.length / 8) * 8, '0').match(/.{8}/g).map(byte => parseInt(byte, 2)))
    return Buffer.concat([Buffer.from([0, 0, 0, 1, 0x67]), bytes, Buffer.from([0, 0, 0, 1, 0x68, 1, 0, 0, 0, 1, 0x65, 4])])
}
function fixture() {
    const sent = []
    let open = true, canSend = true, state = 'connected', keys = 0
    const tracks = []
    const peer = {
        state: () => state,
        addTrack: () => {
            const track = { setMediaHandler: () => {}, isOpen: () => open, sendMessageBinary: bytes => { if (canSend) sent.push(bytes); return canSend }, close: () => { open = false } }
            tracks.push(track)
            return track
        },
    }
    const encryption = { ready: true, encryptOpus: data => Buffer.concat([data, Buffer.from('encrypted')]), encrypt: (media, codec, data) => Buffer.concat([data, Buffer.from('encrypted')]) }
    const sender = new EncodedMediaSender({ peer, encryption, audioSsrc: 101, videoSsrc: 102, onKeyframeNeeded: () => keys++ })
    return { sender, sent, encryption, tracks, get keys() { return keys }, set canSend(value) { canSend = value }, set state(value) { state = value } }
}

test('never sends plaintext or frames before native DAVE is ready', () => {
    const f = fixture()
    f.encryption.ready = false
    assert.equal(f.sender.publish({ kind: 'video', data: keyframe, rtpTimestamp: 1 }), false)
    assert.equal(f.sender.publish({ kind: 'audio', data: Buffer.from([0xf8, 0xff, 0xfe]), rtpTimestamp: 1 }), false)
    assert.equal(f.sent.length, 0)
    assert.equal(f.keys, 0, 'Do not request a keyframe before the publisher can use it')
    f.encryption.ready = true
    assert.equal(f.sender.publish({ kind: 'audio', data: Buffer.from([0xf8, 0xff, 0xfe]), rtpTimestamp: 1 }), true)
    assert.equal(f.keys, 1, 'Request a fresh keyframe when encryption becomes ready')
    const session = new dave.DAVESession(dave.DAVE_PROTOCOL_VERSION, '100000000000000001', '100000000000000002')
    assert.equal(session.ready, false)
    assert(session.getSerializedKeyPackage().length > 0)
    assert.throws(() => session.encryptOpus(Buffer.from([0xf8, 0xff, 0xfe])), /NotReady/)
    session.reset()
    f.sender.close()
})

test('reports the SPS resolution of accepted video only, including source quality changes', () => {
    const f = fixture()
    assert.equal(f.sender.videoResolution, null)
    let timestamp = 1
    for (const [width, height] of [[1920, 1080], [2560, 1440], [3840, 2160], [1280, 720]]) {
        assert(f.sender.publish({ kind: 'video', data: sizedKeyframe(width, height), rtpTimestamp: timestamp++ }))
        assert.deepEqual(f.sender.videoResolution, { width, height })
    }
    f.canSend = false
    assert.equal(f.sender.publish({ kind: 'video', data: sizedKeyframe(2560, 1440), rtpTimestamp: timestamp++ }), false)
    assert.deepEqual(f.sender.videoResolution, { width: 1280, height: 720 })
    f.sender.resetSource()
    assert.equal(f.sender.videoResolution, null)
    f.sender.close()
})

test('waits for SPS/PPS/IDR, rejects stale frames and handles RTP timestamp rollover', () => {
    const f = fixture()
    assert.equal(f.sender.publish({ kind: 'video', data: deltaFrame, rtpTimestamp: 0xffffff00 }), false)
    assert.equal(f.sender.publish({ kind: 'video', data: keyframe, rtpTimestamp: 0xffffff80 }), true)
    assert.notDeepEqual(f.sent[0], keyframe)
    assert.equal(f.sender.publish({ kind: 'video', data: deltaFrame, rtpTimestamp: 900 }), true)
    assert.equal(f.sender.publish({ kind: 'video', data: deltaFrame, rtpTimestamp: 800 }), false)
    assert.equal(f.sender.publish({ kind: 'video', data: deltaFrame, rtpTimestamp: 900 }), false)
    f.canSend = false
    assert.equal(f.sender.publish({ kind: 'video', data: deltaFrame, rtpTimestamp: 1800 }), false)
    f.canSend = true
    assert.equal(f.sender.publish({ kind: 'video', data: deltaFrame, rtpTimestamp: 2700 }), false)
    assert.equal(f.sender.publish({ kind: 'video', data: keyframe, rtpTimestamp: 3600 }), true)
    f.sender.close()
})

test('encryption failure never falls back to clear media; close and input validation are safe', () => {
    const f = fixture()
    assert.throws(() => f.sender.publish({ kind: 'audio', data: Buffer.from([1]), rtpTimestamp: -1 }), /Invalid/)
    assert.throws(() => f.sender.publish({ kind: 'video', data: Buffer.from([1, 2, 3]), rtpTimestamp: 1 }), /Annex-B/)
    f.encryption.encryptOpus = () => { throw new Error('private encryption details') }
    assert.throws(() => f.sender.publish({ kind: 'audio', data: Buffer.from([1]), rtpTimestamp: 1 }), /^Error: DAVE encryption failed; frame was not sent$/)
    assert.equal(f.sent.length, 0)
    f.sender.close(); f.sender.close()
    assert.equal(f.sender.publish({ kind: 'audio', data: Buffer.from([1]), rtpTimestamp: 1 }), false)
})

test('recovery can prepend a known parameter pair to an IDR, but never reuses it after a partial config change', () => {
    const f = fixture()
    const idr = Buffer.from([0, 0, 1, 0x65, 4, 5])
    assert.equal(f.sender.publish({ kind: 'video', data: idr, rtpTimestamp: 1 }), false)
    assert.equal(f.sender.publish({ kind: 'video', data: keyframe, rtpTimestamp: 2 }), true)
    f.canSend = false
    assert.equal(f.sender.publish({ kind: 'video', data: deltaFrame, rtpTimestamp: 3 }), false)
    f.canSend = true
    assert.equal(f.sender.publish({ kind: 'video', data: idr, rtpTimestamp: 4 }), true)
    assert(f.sent.at(-1).subarray(0, 16).equals(keyframe.subarray(0, 16)))
    assert(f.sent.at(-1).includes(idr))
    const changedSps = Buffer.from([0, 0, 1, 0x67, 0x42, 0, 0x20])
    assert.equal(f.sender.publish({ kind: 'video', data: changedSps, rtpTimestamp: 5 }), false)
    assert.equal(f.sender.publish({ kind: 'video', data: idr, rtpTimestamp: 6 }), false)
    assert.equal(f.sender.publish({ kind: 'video', data: keyframe, rtpTimestamp: 7 }), true)
    f.sender.close()
    assert.equal(f.sender.parameters, null)
})

test('receiver picture loss requests a fresh keyframe without leaking feedback payloads or flooding requests', () => {
    const f = fixture()
    f.sender.publish({ kind: 'video', data: keyframe, rtpTimestamp: 1 })
    const before = f.keys
    const pli = Buffer.from([0x81, 206, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2])
    f.sender.handleFeedback('video', pli)
    f.sender.handleFeedback('video', pli)
    assert.equal(f.keys, before + 1)
    assert.equal(f.sender.feedback.pictureLoss, 2)
    assert.equal(f.sender.publish({ kind: 'video', data: deltaFrame, rtpTimestamp: 2 }), true, 'PLI must not freeze the picture while the IDR is pending')
    assert.equal(f.sender.publish({ kind: 'video', data: Buffer.from([0, 0, 1, 0x65, 4, 5]), rtpTimestamp: 3 }), true)
    f.sender.handleFeedback('audio', Buffer.from([0x80, 201, 0, 1, 0, 0, 0, 1]))
    assert.equal(f.sender.feedback.audioReports, 1)
    f.sender.handleFeedback('video', Buffer.from([0x80, 206, 255, 255]))
    f.sender.close()
})

test('native WebRTC sends separately packetized H.264 and Opus over a real local DTLS/SRTP connection', { timeout: 15000 }, async () => {
    const outgoing = new PeerConnection('proxy-sender', { iceServers: [] })
    const incoming = new PeerConnection('proxy-local-receiver', { iceServers: [] })
    const received = []
    const errors = []
    // Transport test only: a fake ready encryptor preserves bytes for RTP assertions, not a DAVE round trip.
    const encryption = { ready: true, encryptOpus: data => data, encrypt: (type, codec, data) => data }
    const sender = new EncodedMediaSender({ peer: outgoing, encryption, audioSsrc: 777, videoSsrc: 778, rtxSsrc: 779 })
    outgoing.onLocalDescription((sdp, type) => incoming.setRemoteDescription(sdp, type))
    incoming.onLocalDescription((sdp, type) => outgoing.setRemoteDescription(sdp, type))
    outgoing.onLocalCandidate((candidate, mid) => incoming.addRemoteCandidate(candidate, mid))
    incoming.onLocalCandidate((candidate, mid) => outgoing.addRemoteCandidate(candidate, mid))
    incoming.onTrack(track => track.onMessage(packet => received.push({ mid: track.mid(), packet: Buffer.from(packet) })))
    const deadline = Date.now() + 10000
    try {
        outgoing.setLocalDescription()
        while ((outgoing.state() !== 'connected' || !sender.media.audio.track.isOpen() || !sender.media.video.track.isOpen()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
        assert.equal(outgoing.state(), 'connected')
        assert(outgoing.localDescription().sdp.includes('a=rtpmap:102 rtx/90000'))
        assert(outgoing.localDescription().sdp.includes('a=ssrc-group:FID 778 779'))
        const opus = Buffer.from([0xf8, 0xff, 0xfe])
        assert(sender.publish({ kind: 'audio', data: opus, rtpTimestamp: 48000 }))
        assert(sender.publish({ kind: 'video', data: keyframe, rtpTimestamp: 90000 }))
        while (received.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
        const mediaPackets = received.filter(({ packet }) => packet.length > 12 && (packet[1] & 0x7f) >= 96)
        assert(mediaPackets.some(({ mid, packet }) => mid === '0' && packet.readUInt32BE(8) === 777 && packet.subarray(-3).equals(opus)))
        assert(mediaPackets.some(({ mid, packet }) => mid === '1' && packet.readUInt32BE(8) === 778))
        assert.deepEqual(errors, [])
    } finally { sender.close(); outgoing.close(); incoming.close() }
})

test('receiver reports, NACKs and REMB become value-free video delivery diagnostics', () => {
    const f = fixture()
    // RR with one block for video SSRC 102: 25% lost, 1234 cumulative, jitter 9000 ticks (100 ms).
    const receiverReport = Buffer.alloc(32)
    receiverReport.writeUInt8(0x81, 0); receiverReport.writeUInt8(201, 1); receiverReport.writeUInt16BE(7, 2); receiverReport.writeUInt32BE(9, 4)
    receiverReport.writeUInt32BE(102, 8); receiverReport.writeUInt8(64, 12); receiverReport.writeIntBE(1234, 13, 3); receiverReport.writeUInt32BE(9000, 20)
    // NACK for packet 500 plus two more flagged in the bitmask.
    const nack = Buffer.from([0x81, 205, 0, 3, 0, 0, 0, 9, 0, 0, 0, 102, 1, 0xf4, 0, 5])
    // REMB: exponent 3, mantissa 250000 = 2,000 kbps.
    const remb = Buffer.from([0x8f, 206, 0, 5, 0, 0, 0, 9, 0, 0, 0, 0, 0x52, 0x45, 0x4d, 0x42, 1, (3 << 2) | (250000 >> 16), (250000 >> 8) & 255, 250000 & 255, 0, 0, 0, 102])
    f.sender.handleFeedback('video', Buffer.concat([receiverReport, nack, remb]))
    assert.equal(f.sender.feedback.videoReports, 1)
    assert.equal(f.sender.feedback.videoFractionLost, 25)
    assert.equal(f.sender.feedback.videoCumulativeLost, 1234)
    assert.equal(f.sender.feedback.videoJitterMs, 100)
    assert.equal(f.sender.feedback.nackPackets, 3)
    assert.equal(f.sender.feedback.rembKbps, 2000)
    f.sender.handleFeedback('video', Buffer.from([0x80, 201, 0, 1, 0, 0, 0, 9]))
    const unrelated = Buffer.from(receiverReport)
    unrelated.writeUInt32BE(999, 8)
    f.sender.handleFeedback('video', unrelated)
    assert.equal(f.sender.feedback.videoReports, 1, 'Empty or unrelated reports cannot refresh video delivery evidence')
    f.sender.close()
})
