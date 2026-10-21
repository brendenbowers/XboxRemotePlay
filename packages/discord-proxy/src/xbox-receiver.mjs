import { performance } from 'node:perf_hooks'
import { Audio, Video, PeerConnection, RtcpReceivingSession } from '@lng2004/node-datachannel'
import { H264Depacketizer, OpusDepacketizer } from './rtp-depacketizer.mjs'

// Headless Xbox Remote Play receiver.
// Mirrors xbox-xcloud-player 0.2.11 bind()/createOffer() without Chromium; the main process owns signalling.

const AUDIO_PAYLOAD = 111
const VIDEO_PAYLOADS = [[102, '42e01f'], [104, '4d001f'], [106, '64001f']]
const CHANNELS = { input: '1.0', chat: 'chatV1', control: 'controlV1', message: 'messageV1' }
// Fixed client identifiers sent by the upstream player; not account data.
const MESSAGE_ID = '41f93d5a-900f-4d33-b7a1-2d4ca6747072'
const REPORT = { metadata: 1, gamepad: 2, clientMetadata: 8, mouse: 32, keyboard: 64 }
const QUALITIES = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] }

// A neutral pad: sent when the controller disconnects so no button stays held on the console.
export const NEUTRAL_GAMEPAD = Object.freeze({ buttons: 0, axes: [0, 0, 0, 0], triggers: [0, 0] })

// Upstream InputPacket header: uint16 report type, uint32 sequence, float64 client time (all little endian).
// Sections follow in upstream order: frame metadata (28 bytes each), then gamepads (23 bytes each).
export function inputPacket(sequence, { clientMetadata = false, frames = [], gamepads = [], mice = [], keys = [] } = {}) {
    const size = 14 + (clientMetadata ? 1 : 0) + (frames.length ? 1 + 28 * frames.length : 0) + (gamepads.length ? 1 + 23 * gamepads.length : 0) + (mice.length ? 1 + 18 * mice.length : 0) + (keys.length ? 1 + 3 * keys.length : 0)
    const packet = Buffer.alloc(size)
    packet.writeUInt16LE(clientMetadata ? REPORT.clientMetadata : (frames.length ? REPORT.metadata : 0) | (gamepads.length ? REPORT.gamepad : 0) | (mice.length ? REPORT.mouse : 0) | (keys.length ? REPORT.keyboard : 0), 0)
    packet.writeUInt32LE(sequence >>> 0, 2)
    packet.writeDoubleLE(performance.now(), 6)
    let offset = 14
    if (frames.length) {
        packet.writeUInt8(frames.length, offset++)
        const now = performance.now() >>> 0
        for (const frame of frames) {
            // serverDataKey, first packet arrival, submitted, decoded, rendered, packet time, now.
            for (const value of [frame.rtpTimestamp, frame.arrival, frame.arrival, frame.complete, frame.complete, now, now]) {
                packet.writeUInt32LE(value >>> 0, offset); offset += 4
            }
        }
    }
    if (gamepads.length) {
        packet.writeUInt8(gamepads.length, offset++)
        for (const pad of gamepads) {
            const axis = value => Math.max(-32767, Math.min(32767, Math.round(value * 32767)))
            const trigger = value => Math.max(0, Math.min(65535, Math.round(value * 65535)))
            packet.writeUInt8(0, offset) // gamepad index; the session announces only pad 0
            packet.writeUInt16LE(pad.buttons & 0xffff, offset + 1)
            // Upstream inverts both Y axes (browser +Y is down).
            packet.writeInt16LE(axis(pad.axes[0]), offset + 3); packet.writeInt16LE(axis(-pad.axes[1]), offset + 5)
            packet.writeInt16LE(axis(pad.axes[2]), offset + 7); packet.writeInt16LE(axis(-pad.axes[3]), offset + 9)
            packet.writeUInt16LE(trigger(pad.triggers[0]), offset + 11); packet.writeUInt16LE(trigger(pad.triggers[1]), offset + 13)
            offset += 23 // remaining 8 bytes: physicality fields, zero as upstream
        }
    }
    if (mice.length) {
        packet.writeUInt8(mice.length, offset++)
        for (const mouse of mice) {
            for (const value of [mouse.x, mouse.y, mouse.wheelX, mouse.wheelY]) { packet.writeInt32LE(value, offset); offset += 4 }
            packet.writeUInt8(mouse.buttons, offset++); packet.writeUInt8(0, offset++)
        }
    }
    if (keys.length) {
        packet.writeUInt8(keys.length, offset++)
        for (const key of keys) { packet.writeUInt8(2, offset++); packet.writeUInt8(key.pressed ? 1 : 0, offset++); packet.writeUInt8(key.code, offset++) }
    }
    if (clientMetadata) packet.writeUInt8(2, offset)
    return packet
}

export function messageEnvelope(target, content) {
    return JSON.stringify({ type: 'Message', content: JSON.stringify(content), id: MESSAGE_ID, target, cv: '' })
}

export class XboxReceiver {
    constructor({ resolution = 1080, createPeer = config => new PeerConnection('Xbox headless receiver', config), onFrame = () => {}, onStatus = () => {} } = {}) {
        Object.assign(this, { createPeer, onFrame, onStatus })
        this.quality = QUALITIES[resolution] || QUALITIES[1080]
        this.closed = false
        this.handshake = false
        this.sequence = 0
        this.pendingFrames = []
        this.pendingKeys = []
        this.pendingMice = []
        this.nativeHeld = new Set()
        this.mouseButtons = 0
        this.inputAt = 0
        this.channels = {}
        this.media = {}
        this.stats = { audio: { packets: 0, bytes: 0, ssrc: null, payloadTypes: [] }, video: { packets: 0, bytes: 0, frames: 0, ssrc: null, payloadTypes: [] },
            channelsOpen: [], controlMessages: 0, messageTypes: [], startedAt: Date.now() }
        const emit = frame => { try { this.onFrame(frame) } catch { /* A consumer failure must not stop reception. */ } }
        this.depacketizers = {
            video: new H264Depacketizer({ onFrame: frame => { if (frame.keyframe) this.rememberKeyframe(frame); emit(frame) }, onKeyframeNeeded: () => this.requestKeyframe() }),
            audio: new OpusDepacketizer({ onFrame: emit }),
        }
        this.tickTimer = setInterval(() => { this.depacketizers.video.tick(); this.depacketizers.audio.tick() }, 10)
    }

    // Resolves once ICE gathering completes so the offer and candidates can be posted together, like the browser flow.
    createOffer() {
        this.peer = this.createPeer({ iceServers: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'], disableAutoNegotiation: true })
        const candidates = []
        const gathered = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('ICE gathering timed out')), 15000)
            this.peer.onLocalCandidate((candidate, mid) => candidates.push({ candidate: candidate.replace(/^a=/, ''), sdpMid: mid, sdpMLineIndex: Number(mid) }))
            this.peer.onGatheringStateChange(state => { if (state === 'complete') { clearTimeout(timer); resolve() } })
        })
        this.peer.onStateChange(state => this.onStatus({ peer: state }))
        // Chromium order: audio (mid 0), video (mid 1), then the data section (mid 2).
        const audio = new Audio('0', 'SendRecv')
        audio.addOpusCodec(AUDIO_PAYLOAD, 'minptime=10;useinbandfec=1;stereo=1')
        const video = new Video('1', 'RecvOnly')
        for (const [payload, profile] of VIDEO_PAYLOADS) video.addH264Codec(payload, `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profile}`)
        for (const [kind, description] of [['audio', audio], ['video', video]]) {
            const track = this.peer.addTrack(description)
            const session = new RtcpReceivingSession()
            track.setMediaHandler(session)
            track.onMessage(message => this.handleRtp(kind, Buffer.from(message)))
            this.media[kind] = { track, session }
        }
        for (const [name, protocol] of Object.entries(CHANNELS)) {
            const channel = this.peer.createDataChannel(name, { protocol })
            channel.onOpen(() => this.onChannelOpen(name))
            channel.onMessage(message => this.onChannelMessage(name, message))
            this.channels[name] = channel
        }
        this.peer.setLocalDescription('offer')
        return gathered.then(() => ({ sdp: this.peer.localDescription().sdp, candidates }))
    }

    setAnswer(sdp) {
        if (typeof sdp !== 'string' || !sdp.startsWith('v=0')) throw new Error('Invalid Xbox answer')
        this.peer.setRemoteDescription(sdp, 'answer')
    }

    addRemoteCandidates(candidates) {
        for (const entry of candidates || []) {
            const candidate = String(entry?.candidate || '').replace(/^a=/, '')
            if (!candidate.startsWith('candidate:')) continue
            try { this.peer.addRemoteCandidate(candidate, String(entry.sdpMid ?? '0')) } catch { /* Ignore candidates libjuice cannot parse. */ }
        }
    }

    send(name, data) {
        const channel = this.channels[name]
        if (!channel?.isOpen()) return false
        return typeof data === 'string' ? channel.sendMessage(data) : channel.sendMessageBinary(data)
    }

    onChannelOpen(name) {
        this.stats.channelsOpen.push(name)
        if (name === 'message') this.send('message', JSON.stringify({ type: 'Handshake', version: 'messageV1', id: 'f9c5f412-0e69-4ede-8e62-92c7f5358c56', cv: '' }))
    }

    onChannelMessage(name, message) {
        if (name === 'control') { this.stats.controlMessages++; return }
        if (name !== 'message' || typeof message !== 'string') return
        let parsed
        try { parsed = JSON.parse(message) } catch { return }
        // Types and targets only: message content can carry console/user details.
        const label = parsed.type === 'Message' ? `Message:${parsed.target}` : String(parsed.type)
        if (!this.stats.messageTypes.includes(label) && this.stats.messageTypes.length < 40) this.stats.messageTypes.push(label)
        if (parsed.type === 'HandshakeAck' && !this.handshake) this.startSession()
    }

    // Same sequence the upstream MessageChannel sends after HandshakeAck.
    startSession() {
        this.handshake = true
        const [width, height] = this.quality
        this.send('control', JSON.stringify({ message: 'authorizationRequest', accessKey: '4BDB3609-C1F1-4195-9B37-FEFF45DA8B8E' }))
        this.send('control', JSON.stringify({ message: 'gamepadChanged', gamepadIndex: 0, wasAdded: true }))
        this.send('input', inputPacket(this.sequence, { clientMetadata: true }))
        this.send('message', messageEnvelope('/streaming/systemUi/configuration', { version: [0, 1, 0], systemUis: [] }))
        this.send('message', messageEnvelope('/streaming/properties/clientappinstallidchanged', { clientAppInstallId: 'c11ddb2e-c7e3-4f02-a62b-fd5448e0b851' }))
        this.send('message', messageEnvelope('/streaming/characteristics/orientationchanged', { orientation: 0 }))
        this.send('message', messageEnvelope('/streaming/characteristics/touchinputenabledchanged', { touchInputEnabled: false }))
        this.send('message', messageEnvelope('/streaming/characteristics/clientdevicecapabilities', {}))
        this.requestResolution(height)
        // Upstream sends input every 16 ms; without a renderer, frame metadata comes from packet arrival.
        // The current pad state rides along every tick, as the upstream driver resends it each frame.
        this.inputTimer = setInterval(() => {
            if (this.inputAt && Date.now() - this.inputAt > 1000) { this.releaseInput(); this.inputAt = 0 }
            const gamepads = this.gamepad ? [this.gamepad] : []
            if (!this.pendingFrames.length && !gamepads.length && !this.pendingKeys.length && !this.pendingMice.length) return
            this.sequence++
            this.send('input', inputPacket(this.sequence, { frames: this.pendingFrames.splice(0, 29), gamepads, keys: this.pendingKeys.splice(0, 29), mice: this.pendingMice.splice(0, 29) }))
            if (this.gamepad === NEUTRAL_GAMEPAD) this.gamepad = null
        }, 16)
    }

    // Latest PC controller state; null after a disconnect has been sent as a neutral pad.
    setGamepad(state) {
        this.inputAt = Date.now()
        if (!state) { if (this.gamepad) this.gamepad = NEUTRAL_GAMEPAD; return }
        this.gamepad = state
        this.stats.gamepadUpdates = (this.stats.gamepadUpdates || 0) + 1
    }

    releaseInput() {
        this.gamepad = NEUTRAL_GAMEPAD
        this.pendingKeys = [...this.nativeHeld].map(code => ({ code, pressed: false }))
        this.nativeHeld.clear()
        this.pendingMice = this.mouseButtons ? [{ x: 0, y: 0, wheelX: 0, wheelY: 0, buttons: 0 }] : []
        this.mouseButtons = 0
    }

    setNativeInput(batch) {
        this.inputAt = Date.now()
        if (batch.reset) this.releaseInput()
        if (this.pendingKeys.length + batch.keys.length > 256 || this.pendingMice.length + (batch.mice?.length || 0) > 256) { this.releaseInput(); return }
        for (const key of batch.keys) {
            // Keep codes until reset so clearing an unsent release cannot leave a remote key down.
            if (key.pressed) this.nativeHeld.add(key.code)
            this.pendingKeys.push(key)
        }
        for (const mouse of batch.mice || []) { this.pendingMice.push(mouse); this.mouseButtons |= mouse.buttons }
    }

    // Same pair the windowed app sends after HandshakeAck (shared/stream-quality.ts); also tried mid-session.
    requestResolution(height) {
        const quality = QUALITIES[height]
        if (!quality || !this.handshake) return false
        this.quality = quality
        const [width] = quality
        this.send('message', messageEnvelope('/streaming/characteristics/dimensionschanged', { horizontal: width, vertical: height, preferredWidth: width, preferredHeight: height,
            safeAreaLeft: 0, safeAreaTop: 0, safeAreaRight: width, safeAreaBottom: height, supportsCustomResolution: true }))
        return this.send('control', JSON.stringify({ message: 'userRequestedResolutionUpdate', resolutionAlias: String(height) }))
    }

    handleRtp(kind, packet) {
        if (packet.length < 12 || packet[0] >> 6 !== 2) return
        const payloadType = packet[1] & 0x7f
        if (payloadType >= 72 && payloadType <= 79) return // RTCP sharing the mux
        const stats = this.stats[kind]
        stats.packets++; stats.bytes += packet.length
        if (kind === 'video') this.measureRate(packet.length)
        stats.ssrc ??= packet.readUInt32BE(8)
        if (!stats.payloadTypes.includes(payloadType) && stats.payloadTypes.length < 8) stats.payloadTypes.push(payloadType)
        const now = performance.now()
        this.depacketizers[kind].push(packet, now)
        if (kind !== 'video') return
        // Frame metadata for the input channel, standing in for the browser's render callbacks.
        const timestamp = packet.readUInt32BE(4)
        if (this.frame?.rtpTimestamp !== timestamp) this.frame = { rtpTimestamp: timestamp, arrival: now }
        if (packet[1] & 0x80) {
            stats.frames++
            this.pendingFrames.push({ ...this.frame, complete: now })
            if (this.pendingFrames.length > 60) this.pendingFrames.splice(0, this.pendingFrames.length - 60)
            this.frame = null
        }
    }

    // Latest IDR for stream preview thumbnails; decodable alone, codec string from the SPS (avc1.PPCCLL).
    rememberKeyframe(frame) {
        const sps = this.depacketizers.video.stats.sps
        if (!sps || frame.data.length > 4 * 1024 * 1024) return
        const hex = value => value.toString(16).padStart(2, '0')
        this.lastKeyframe = { data: frame.data, codec: `avc1.${hex(sps.profileIdc)}${hex(sps.constraints)}${hex(sps.levelIdc)}`, at: Date.now() }
    }

    // Two-second window of the Xbox's actual video rate, so bitrate requests can be checked against the result.
    measureRate(bytes) {
        const now = Date.now()
        this.rate ??= { start: now, bytes: 0, kbps: 0 }
        this.rate.bytes += bytes
        if (now - this.rate.start >= 2000) this.rate = { start: now, bytes: 0, kbps: Math.round(this.rate.bytes * 8 / (now - this.rate.start)) }
    }

    // REMB toward the Xbox; libdatachannel repeats it with later receiver reports.
    setBitrate(kbps) {
        if (!Number.isFinite(kbps) || kbps <= 0) return false
        this.requestedKbps = Math.round(kbps)
        return this.media.video?.track.requestBitrate(this.requestedKbps * 1000) || false
    }

    // Control message only: sending RTCP PLI as well made the Xbox emit two IDRs per request.
    requestKeyframe() {
        const now = Date.now()
        if (now - (this.lastKeyframeRequest || 0) < 300) return false
        this.lastKeyframeRequest = now
        return this.send('control', JSON.stringify({ message: 'videoKeyframeRequested', ifrRequested: true }))
    }

    diagnostics() {
        const seconds = Math.max(1, (Date.now() - this.stats.startedAt) / 1000)
        return { ...this.stats, peer: this.peer?.state?.() || 'new', handshake: this.handshake,
            videoKbps: Math.round(this.stats.video.bytes * 8 / seconds / 1000), audioKbps: Math.round(this.stats.audio.bytes * 8 / seconds / 1000),
            currentVideoKbps: this.rate?.kbps || 0, requestedKbps: this.requestedKbps || null,
            depacketizer: { video: this.depacketizers.video.diagnostics(), audio: this.depacketizers.audio.diagnostics() } }
    }

    close() {
        if (this.closed) return
        this.closed = true
        clearInterval(this.inputTimer)
        clearInterval(this.tickTimer)
        for (const channel of Object.values(this.channels)) try { channel.close() } catch { /* Already closed. */ }
        for (const { track } of Object.values(this.media)) try { track.close() } catch { /* Already closed. */ }
        try { this.peer?.close() } catch { /* Already closed. */ }
    }
}
