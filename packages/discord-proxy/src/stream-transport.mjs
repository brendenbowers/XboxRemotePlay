import { randomUUID } from 'node:crypto'
import { PeerConnection } from '@lng2004/node-datachannel'
import dave from '@snazzah/davey'
import { PublisherDaveSession } from './dave-session.mjs'
import { EncodedMediaSender } from './media-sender.mjs'

// Wire shapes verified against Discord-RE/Discord-video-stream, commit 40202aa6 (ISC).
const codecs = [
    { name: 'opus', type: 'audio', clockRate: 48000, priority: 1000, payload_type: 120 },
    { name: 'H264', type: 'video', clockRate: 90000, priority: 1000, payload_type: 101, rtx_payload_type: 102, encode: true, decode: true },
]
const streams = [{ type: 'screen', rid: '100', quality: 100 }]

export function mediaAnswer(sdp) {
    if (typeof sdp !== 'string' || sdp.length > 65536) throw new Error('Invalid Discord SDP')
    const lines = sdp.split(/\r?\n/).map(line => line.trim())
    const field = prefix => lines.find(line => line.startsWith(prefix))
    const connection = field('c=IN IP4 ')
    const port = /^a=rtcp:(\d+)\b/.exec(field('a=rtcp:') || '')?.[1]
    const ufrag = field('a=ice-ufrag:'), pwd = field('a=ice-pwd:'), fingerprint = field('a=fingerprint:sha-256 ')
    const candidates = lines.filter(line => line.startsWith('a=candidate:'))
    if (!connection || !/^c=IN IP4 \d{1,3}(\.\d{1,3}){3}$/.test(connection) || !port || +port < 1 || +port > 65535 || !ufrag || !pwd || !fingerprint || !candidates.length) throw new Error('Discord SDP is missing transport parameters')
    if (!/^a=fingerprint:sha-256 ([a-f\d]{2}:){31}[a-f\d]{2}$/i.test(fingerprint)) throw new Error('Invalid DTLS fingerprint')
    const transport = [connection, ufrag, pwd, fingerprint, ...candidates, 'a=setup:passive', 'a=rtcp-mux', 'a=recvonly', 'a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay'].join('\r\n')
    return ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=Discord stream', 't=0 0', 'a=group:BUNDLE 0 1', 'a=ice-lite',
        `m=audio ${port} UDP/TLS/RTP/SAVPF 120`, transport, 'a=mid:0', 'a=rtpmap:120 opus/48000/2', 'a=fmtp:120 minptime=10;useinbandfec=1',
        `m=video ${port} UDP/TLS/RTP/SAVPF 101 102`, transport, 'a=mid:1', 'a=rtpmap:101 H264/90000', 'a=rtpmap:102 rtx/90000', 'a=fmtp:102 apt=101', 'a=rtcp-fb:101 nack', 'a=rtcp-fb:101 nack pli', ''].join('\r\n')
}

export class DiscordStreamTransport {
    constructor({ userId, onReady, onStopped, onKeyframeNeeded, width, height, fps,
        createSocket = url => new WebSocket(url), createPeer = () => new PeerConnection('Xbox Discord publisher', { iceServers: [] }),
        createEncryption = options => new PublisherDaveSession(options), createSender = options => new EncodedMediaSender(options) }) {
        if (typeof userId !== 'string' || !/^\d{17,20}$/.test(userId)) throw new Error('Invalid publishing account')
        if (![width, height, fps].every(Number.isInteger) || width < 1 || width > 7680 || height < 1 || height > 4320 || fps < 1 || fps > 120) throw new Error('Invalid stream dimensions')
        Object.assign(this, { userId, onReady, onStopped, onKeyframeNeeded, width, height, fps, createSocket, createPeer, createEncryption, createSender })
        this.closed = false
        this.sequence = -1
        this.reportedReady = false
        this.phase = 'awaiting-media-credentials'
        this.closeCode = null
    }

    setSession(session) { this.session = session; this.start() }
    setTokens(endpoint, token) {
        if (!/^[a-z0-9.-]+\.(discord\.media|discord\.gg)(:\d{1,5})?$/i.test(endpoint) || typeof token !== 'string' || !token || token.length > 16384) throw new Error('Invalid media destination')
        if (this.socket) { this.fail('Discord media endpoint changed; restart publication'); return }
        this.endpoint = endpoint; this.token = token; this.start()
    }

    start() {
        if (this.closed || this.socket || !this.session || !this.token) return
        if (!/^\d{17,20}$/.test(this.serverId) || typeof this.session !== 'string' || this.session.length > 256) throw new Error('Invalid stream session')
        this.encryption = this.createEncryption({ userId: this.userId, channelId: (BigInt(this.serverId) - 1n).toString(),
            sendJson: (op, data) => this.send(op, data), sendBinary: (op, data) => this.sendBinary(op, data), onFailure: () => this.fail('Discord encryption negotiation failed') })
        const socket = this.socket = this.createSocket(`wss://${this.endpoint}/?v=8`)
        this.phase = 'connecting-media-socket'
        socket.binaryType = 'arraybuffer'
        socket.addEventListener('open', () => {
            if (this.closed) return
            try { this.send(0, { server_id: this.serverId, user_id: this.userId, session_id: this.session, token: this.token,
                video: true, streams, max_dave_protocol_version: dave.DAVE_PROTOCOL_VERSION }); this.phase = 'media-identified' }
            catch { this.fail('Discord media identification failed') }
        })
        socket.addEventListener('message', event => {
            if (this.closed) return
            try { this.handle(event.data) } catch { this.fail('Discord media negotiation failed') }
        })
        socket.addEventListener('error', () => this.fail('Discord media connection failed'))
        socket.addEventListener('close', event => {
            if (this.closed) return
            this.closeCode = Number.isInteger(event.code) && event.code >= 1000 && event.code <= 4999 ? event.code : null
            this.fail(`Discord media connection ended (${this.closeCode ?? 'unknown'}); restart publication`)
        })
    }

    send(op, d) {
        if (this.closed || this.socket?.readyState !== 1) throw new Error('Media socket is closed')
        this.socket.send(JSON.stringify({ op, d }))
    }
    sendBinary(op, data) {
        if (this.closed || this.socket?.readyState !== 1 || !Buffer.isBuffer(data) || data.length > 1024 * 1024) throw new Error('Invalid encryption message')
        this.socket.send(Buffer.concat([Buffer.from([op]), data]))
    }

    handle(message) {
        if (message instanceof ArrayBuffer) {
            if (message.byteLength < 3 || message.byteLength > 1024 * 1024) throw new Error('Invalid binary response')
            const bytes = Buffer.from(message)
            this.sequence = bytes.readUInt16BE(0)
            this.encryption.handleBinary(bytes)
        } else {
            if (typeof message !== 'string' || message.length > 128 * 1024) throw new Error('Oversized media response')
            const { op, d, seq } = JSON.parse(message)
            if (Number.isInteger(seq) && seq >= 0) this.sequence = seq
            if (op === 8) this.heartbeat(d?.heartbeat_interval)
            else if (op === 6) this.heartbeatPending = false
            else if (op === 2) this.setupPeer(d)
            else if (op === 4) {
                if (!this.peer || this.protocolAccepted || d?.video_codec !== 'H264' || (d.audio_codec && d.audio_codec !== 'opus')) throw new Error('Discord did not negotiate H.264/Opus')
                const answer = mediaAnswer(d.sdp)
                this.encryption.initialize(d.dave_protocol_version)
                this.peer.setRemoteDescription(answer, 'answer')
                this.protocolAccepted = true
                this.phase = 'waiting-for-encryption-and-dtls'
            } else if (op >= 4000) throw new Error('Media server rejected publication')
            else this.encryption.handleJson(op, d)
        }
        this.checkReady()
    }

    heartbeat(interval) {
        if (!Number.isFinite(interval) || interval < 100 || interval > 120000) throw new Error('Invalid heartbeat interval')
        clearInterval(this.heartbeatTimer)
        this.heartbeatPending = false
        this.heartbeatTimer = setInterval(() => {
            if (this.heartbeatPending) { this.fail('Discord media heartbeat timed out'); return }
            try {
                this.send(3, { t: Date.now(), seq_ack: this.sequence })
                this.heartbeatPending = true
            } catch { this.fail('Discord media heartbeat failed') }
        }, interval)
    }

    setupPeer(data) {
        if (this.peer || !data || !Array.isArray(data.streams) || data.streams.length !== 1) throw new Error('Invalid stream readiness')
        this.ssrc = { audio: data.ssrc, video: data.streams[0].ssrc, rtx: data.streams[0].rtx_ssrc }
        if (!Number.isInteger(this.ssrc.rtx) || this.ssrc.rtx <= 0 || this.ssrc.rtx > 0xffffffff || [this.ssrc.audio, this.ssrc.video].includes(this.ssrc.rtx)) throw new Error('Invalid video repair SSRC')
        this.phase = 'negotiating-webrtc'
        this.peer = this.createPeer()
        this.sender = this.createSender({ peer: this.peer, encryption: this.encryption, audioSsrc: this.ssrc.audio, videoSsrc: this.ssrc.video, rtxSsrc: this.ssrc.rtx, onKeyframeNeeded: this.onKeyframeNeeded })
        this.peer.onStateChange(state => {
            if (this.closed) return
            if (['failed', 'closed', 'disconnected'].includes(state)) this.fail('Discord media transport disconnected')
            else {
                try { this.checkReady() } catch { this.fail('Discord media announcement failed') }
            }
        })
        this.peer.onLocalDescription(sdp => {
            if (this.closed) return
            try { this.send(1, { protocol: 'webrtc', codecs, data: sdp, sdp, rtc_connection_id: randomUUID() }) }
            catch { this.fail('Discord protocol selection failed') }
        })
        this.send(12, { audio_ssrc: this.ssrc.audio, video_ssrc: 0, rtx_ssrc: 0, streams: [] })
        this.peer.setLocalDescription()
    }

    checkReady() {
        if (this.closed || !this.protocolAccepted || this.peer?.state() !== 'connected') return
        if (!this.announced) {
        this.send(5, { delay: 0, speaking: 2, ssrc: this.ssrc.audio })
        this.announceVideo()
            this.announced = true
        }
        this.phase = this.encryption.ready ? 'publishing' : 'waiting-for-viewer-keys'
        if (this.encryption.ready && !this.encryptionWasReady) this.onKeyframeNeeded?.()
        this.encryptionWasReady = this.encryption.ready
        // A sole streamer may have no MLS group until a viewer joins; media remains gated below.
        if (!this.reportedReady) { this.reportedReady = true; this.onReady() }
    }

    publish(frame) {
        if (this.closed || !this.reportedReady || !this.encryption.ready) return false
        try {
            const sent = this.sender.publish(frame)
            const size = this.sender.videoResolution
            // A windowed share can start before the Xbox ramps to the requested quality.
            if (sent && frame.kind === 'video' && size && (size.width > this.width || size.height > this.height)) {
                this.width = Math.max(this.width, size.width); this.height = Math.max(this.height, size.height)
                this.announceVideo()
            }
            return sent
        }
        catch { this.fail('Discord media encryption or publication failed'); return false }
    }

    announceVideo() {
        this.send(12, { audio_ssrc: this.ssrc.audio, video_ssrc: this.ssrc.video, rtx_ssrc: this.ssrc.rtx, streams: [{ ...streams[0], type: 'video', ssrc: this.ssrc.video, rtx_ssrc: this.ssrc.rtx,
            active: true, max_bitrate: 40000000, max_framerate: this.fps, max_resolution: { type: 'fixed', width: this.width, height: this.height } }] })
    }

    fail(reason) {
        if (this.closed) return
        this.finalDiagnostic = this.diagnostics()
        this.stop()
        this.onStopped(reason)
    }

    diagnostics() {
        if (this.finalDiagnostic) return this.finalDiagnostic
        const state = this.peer?.state()
        return { phase: this.phase, closeCode: this.closeCode, protocolAccepted: !!this.protocolAccepted,
            encryptionReady: this.encryption?.ready === true,
            encryption: this.encryption?.diagnostics?.() || null,
            transport: this.peer ? { bytesSent: this.peer.bytesSent?.() ?? null, bytesReceived: this.peer.bytesReceived?.() ?? null, rtt: this.peer.rtt?.() ?? null } : null,
            feedback: this.sender?.feedback || null,
            video: { sent: this.sender?.videoResolution || null, advertised: { width: this.width, height: this.height }, fps: this.fps },
            peerState: ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'].includes(state) ? state : 'not-created' }
    }

    stop() {
        if (this.closed) return
        this.closed = true
        clearInterval(this.heartbeatTimer)
        this.token = this.session = null
        try { this.sender?.close() } finally {
            try { this.peer?.close() } finally {
                try { this.socket?.close() } finally { this.encryption?.close() }
            }
        }
    }
}
