import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { cleanup, PeerConnection, Video, RtpPacketizationConfig, H264RtpPacketizer } from '@lng2004/node-datachannel'
import { XboxReceiver, inputPacket, messageEnvelope } from '../src/xbox-receiver.mjs'

after(() => cleanup())
const until = async (check, ms = 10000) => {
    const deadline = Date.now() + ms
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    return check()
}

test('input packets match the upstream InputPacket layout', () => {
    const hello = inputPacket(0, { clientMetadata: true })
    assert.equal(hello.length, 15)
    assert.equal(hello.readUInt16LE(0), 8)
    assert.equal(hello[14], 2)
    const report = inputPacket(7, { frames: [{ rtpTimestamp: 0x12345678, arrival: 10, complete: 12 }] })
    assert.equal(report.length, 14 + 1 + 28)
    assert.equal(report.readUInt16LE(0), 1)
    assert.equal(report.readUInt32LE(2), 7)
    assert.equal(report[14], 1)
    assert.equal(report.readUInt32LE(15), 0x12345678)
    assert.equal(JSON.parse(messageEnvelope('/a', { b: 1 })).content, '{"b":1}')
    // Gamepad section after metadata: count, then index, mask, LX, -LY, RX, -RY, LT, RT, 8 zero bytes.
    const pad = inputPacket(9, { frames: [{ rtpTimestamp: 1, arrival: 1, complete: 1 }], gamepads: [{ buttons: 16 | 4096, axes: [1, 0.5, -1, 0], triggers: [1, 0.5] }] })
    assert.equal(pad.readUInt16LE(0), 1 | 2)
    assert.equal(pad.length, 14 + 1 + 28 + 1 + 23)
    const at = 14 + 1 + 28
    assert.equal(pad[at], 1)
    assert.equal(pad.readUInt16LE(at + 2), 16 | 4096)
    assert.deepEqual([4, 6, 8, 10].map(offset => pad.readInt16LE(at + offset)), [32767, -16383, -32767, 0])
    assert.deepEqual([12, 14].map(offset => pad.readUInt16LE(at + offset)), [65535, 32768])
})

test('native keyboard/mouse packet bytes match the installed player serializer', async () => {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const Packet = require('../../desktop/node_modules/xbox-xcloud-player/dist/Channel/Input/Packet').default
    const keys = [{ code: 87, pressed: true }, { code: 87, pressed: false }]
    const mice = [{ x: -7, y: 4, wheelX: -120, wheelY: 120, buttons: 3 }, { x: 0, y: 0, wheelX: 0, wheelY: 0, buttons: 0 }]
    const expected = new Packet(7)
    expected.setData([], [], [], mice.map(m => ({ X: m.x, Y: m.y, WheelX: m.wheelX, WheelY: m.wheelY, Buttons: m.buttons, Relative: 0 })), keys.map(k => ({ keyCode: k.code, pressed: k.pressed })))
    const native = inputPacket(7, { keys, mice })
    assert.equal(native.readUInt16LE(0), 32 | 64)
    assert.deepEqual(native.subarray(14), Buffer.from(expected.toBuffer().buffer).subarray(14))
})

test('native-only input sends without video metadata; reset and heartbeat expiry release keys and mouse', () => {
    const receiver = new XboxReceiver()
    const packets = [], original = global.setInterval
    let tick
    receiver.send = (name, packet) => { if (name === 'input' && Buffer.isBuffer(packet)) packets.push(packet); return true }
    try {
        global.setInterval = callback => { tick = callback; return 0 }
        receiver.startSession()
    } finally { global.setInterval = original }
    try {
        receiver.setNativeInput({ keys: [{ code: 87, pressed: true }], mice: [{ x: 1, y: 0, wheelX: 0, wheelY: 0, buttons: 1 }] })
        tick()
        assert(packets.some(packet => packet.readUInt16LE(0) === (32 | 64)))
        receiver.setNativeInput({ keys: [{ code: 87, pressed: false }], mice: [{ x: 0, y: 0, wheelX: 0, wheelY: 0, buttons: 0 }] })
        receiver.setNativeInput({ reset: true, keys: [] })
        assert.deepEqual(receiver.pendingKeys, [{ code: 87, pressed: false }])
        assert.equal(receiver.pendingMice[0].buttons, 0)
        tick()
        receiver.setNativeInput({ keys: [{ code: 65, pressed: true }], mice: [{ x: 0, y: 0, wheelX: 0, wheelY: 0, buttons: 2 }] })
        tick()
        receiver.setGamepad({ buttons: 16, axes: [1, 0, 0, 0], triggers: [0, 1] })
        receiver.inputAt = Date.now() - 2000
        tick()
        assert.equal(receiver.nativeHeld.size, 0)
        assert.equal(receiver.mouseButtons, 0)
        assert.equal(receiver.gamepad, null)
        assert(packets.at(-1).readUInt16LE(0) & 64)
    } finally { receiver.close() }
})

test('offer mirrors the Chromium player layout: audio, video, then data channels', { timeout: 20000 }, async () => {
    const receiver = new XboxReceiver({ createPeer: config => new PeerConnection('offer-shape', { ...config, iceServers: [] }) })
    try {
        const { sdp, candidates } = await receiver.createOffer()
        // Ports differ (libdatachannel writes the gathered port); kinds, payloads and mids must match.
        const sections = sdp.split(/\r?\n/).filter(line => line.startsWith('m=') || line.startsWith('a=mid:')).map(line => line.replace(/^(m=\w+) \d+/, '$1'))
        assert.deepEqual(sections, ['m=audio UDP/TLS/RTP/SAVPF 111', 'a=mid:0', 'm=video UDP/TLS/RTP/SAVPF 102 104 106', 'a=mid:1', 'm=application UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:2'])
        assert.match(sdp, /a=sendrecv/)
        assert.match(sdp, /a=recvonly/)
        assert.match(sdp, /profile-level-id=64001f/)
        assert(candidates.every(entry => entry.candidate.startsWith('candidate:')))
    } finally { receiver.close() }
})

test('a local Xbox stand-in completes the experimental 4K handshake and delivers H.264 frames', { timeout: 20000 }, async () => {
    const xbox = new PeerConnection('xbox-stand-in', { iceServers: [] })
    const received = { control: [], input: [], message: [] }
    xbox.onDataChannel(channel => {
        const name = channel.getLabel()
        channel.onMessage(message => {
            received[name]?.push(message)
            if (name === 'message' && typeof message === 'string' && JSON.parse(message).type === 'Handshake') channel.sendMessage(JSON.stringify({ type: 'HandshakeAck' }))
        })
    })
    // Pre-declared mid 1 track so the answer signals the video SSRC, as a normal endpoint does.
    const xboxVideo = new Video('1', 'SendOnly')
    xboxVideo.addH264Codec(102, 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f')
    xboxVideo.addSSRC(4242, 'xbox', 'xbox', 'video')
    const config = new RtpPacketizationConfig(4242, 'xbox', 102, 90000)
    const sender = { track: xbox.addTrack(xboxVideo), config }
    sender.track.setMediaHandler(new H264RtpPacketizer('StartSequence', config, 1200))
    const frames = []
    const receiver = new XboxReceiver({ resolution: 2160, createPeer: config => new PeerConnection('headless', { ...config, iceServers: [] }), onFrame: frame => frames.push(frame) })
    try {
        const offer = await receiver.createOffer()
        xbox.setRemoteDescription(offer.sdp, 'offer')
        await until(() => xbox.localDescription()?.type === 'answer')
        receiver.setAnswer(xbox.localDescription().sdp)
        for (const candidate of offer.candidates) xbox.addRemoteCandidate(candidate.candidate, candidate.sdpMid)
        xbox.onLocalCandidate((candidate, mid) => receiver.addRemoteCandidates([{ candidate, sdpMid: mid }]))
        assert(await until(() => receiver.handshake), 'HandshakeAck must start the session')
        assert(await until(() => received.control.length >= 2 && received.input.length >= 1))
        assert.equal(JSON.parse(received.control[0]).message, 'authorizationRequest')
        assert.equal(Buffer.from(received.input[0]).readUInt16LE(0), 8, 'First input packet is client metadata')
        assert(received.message.some(text => JSON.parse(text).target === '/streaming/characteristics/dimensionschanged'))
        const dimensions = received.message.map(text => JSON.parse(text)).find(message => message.target === '/streaming/characteristics/dimensionschanged')
        assert.equal(JSON.parse(dimensions.content).horizontal, 3840)
        assert.equal(JSON.parse(dimensions.content).vertical, 2160)
        assert(received.control.some(text => JSON.parse(text).resolutionAlias === '2160'))
        assert(await until(() => sender?.track.isOpen()))
        const idr = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x1f, 0, 0, 0, 1, 0x68, 1, 0, 0, 0, 1, 0x65]), Buffer.alloc(5000, 0x11)])
        const delta = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x41]), Buffer.alloc(300, 0x22)])
        for (const [index, frame] of [idr, delta, delta].entries()) { sender.config.timestamp = 90000 + index * 1500; sender.track.sendMessageBinary(frame) }
        assert(await until(() => frames.length >= 3), 'Marker bits must complete three frames')
        assert.deepEqual(frames.map(frame => frame.keyframe), [true, false, false])
        assert(await until(() => received.input.some(packet => Buffer.from(packet).readUInt16LE(0) === 1)), 'Frame metadata is reported back to the Xbox')
        // REMB on the wire (what the Xbox sees) must carry the requested rate in bits per second.
        const remb = []
        sender.track.onMessage(message => {
            const data = Buffer.from(message)
            for (let offset = 0; offset + 4 <= data.length;) {
                const length = (data.readUInt16BE(offset + 2) + 1) * 4
                if (data[offset + 1] === 206 && (data[offset] & 31) === 15 && data.toString('latin1', offset + 12, offset + 16) === 'REMB')
                    remb.push((((data[offset + 17] & 3) << 16) | data.readUInt16BE(offset + 18)) * 2 ** (data[offset + 17] >> 2))
                offset += length
            }
        })
        for (const kbps of [2500, 15000, 8100]) {
            const before = remb.length, expected = kbps * 1000
            assert(receiver.setBitrate(kbps))
            assert(await until(() => remb.slice(before).some(rate => Math.abs(rate - expected) < expected * 0.01)),
                `Xbox stand-in must receive the ${kbps} kbps request, including probe and fallback`)
        }
        const diagnostics = receiver.diagnostics()
        assert.equal(diagnostics.requestedKbps, 8100)
        assert.deepEqual(diagnostics.video.payloadTypes, [102])
        assert.deepEqual([...diagnostics.channelsOpen].sort(), ['chat', 'control', 'input', 'message'])
    } finally { receiver.close(); xbox.close() }
})
