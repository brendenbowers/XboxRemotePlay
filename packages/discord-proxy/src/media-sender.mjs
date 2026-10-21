import { randomBytes } from 'node:crypto'
import { Audio, Video, RtpPacketizationConfig, RtpPacketizer, H264RtpPacketizer, RtcpSrReporter, RtcpNackResponder } from '@lng2004/node-datachannel'
import dave from '@snazzah/davey'
import { parseSpsDimensions } from './rtp-depacketizer.mjs'

const UINT32 = 0x100000000

function nalUnits(data) {
    const starts = []
    for (let i = 0; i < data.length - 3; i++) {
        if (data[i] === 0 && data[i + 1] === 0) {
            if (data[i + 2] === 1) { starts.push({ start: i, type: data[i + 3] & 31 }); i += 2 }
            else if (data[i + 2] === 0 && data[i + 3] === 1 && i + 4 < data.length) { starts.push({ start: i, type: data[i + 4] & 31 }); i += 3 }
        }
    }
    return starts.map((unit, index) => ({ type: unit.type, data: data.subarray(unit.start, starts[index + 1]?.start ?? data.length) }))
}

// Owns publishing tracks only. The caller owns voice/session signalling and DAVE key transitions.
export class EncodedMediaSender {
    constructor({ peer, encryption, audioSsrc, videoSsrc, rtxSsrc, audioPayloadType = 120, videoPayloadType = 101, onKeyframeNeeded = () => {} }) {
        if (!encryption || typeof encryption.encrypt !== 'function' || typeof encryption.encryptOpus !== 'function') throw new Error('DAVE encryption is required')
        for (const ssrc of [audioSsrc, videoSsrc]) if (!Number.isInteger(ssrc) || ssrc <= 0 || ssrc >= UINT32) throw new Error('Invalid media SSRC')
        if (audioSsrc === videoSsrc) throw new Error('Audio and video SSRCs must differ')
        for (const payload of [audioPayloadType, videoPayloadType]) if (!Number.isInteger(payload) || payload < 96 || payload > 127) throw new Error('Invalid codec payload type')
        if (audioPayloadType === videoPayloadType) throw new Error('Codec payload types must differ')
        Object.assign(this, { peer, encryption, onKeyframeNeeded })
        this.closed = false
        this.videoStarted = false
        this.wasReady = false
        this.needKeyframe = true
        this.parameters = null
        this.parameterResolution = null
        this.videoResolution = null
        this.stats = { sentAudio: 0, sentVideo: 0, notReady: 0, waitingKeyframe: 0, stale: 0, backpressure: 0 }
        // Value-free receiver evidence: loss/jitter for our video SSRC, NACKs, REMB estimate and actual send rate.
        this.feedback = { audioReports: 0, videoReports: 0, pictureLoss: 0, nackPackets: 0, transportFeedback: 0,
            videoFractionLost: null, videoMaxFractionLost: 0, videoCumulativeLost: null, videoJitterMs: null, rembKbps: null, videoKbps: 0, videoPeakFrameKB: 0 }
        this.ssrc = { audio: audioSsrc, video: videoSsrc }
        this.rateWindow = { start: Date.now(), bytes: 0, peak: 0 }
        const cname = 'console-stream-' + randomBytes(8).toString('hex')
        const definitions = { audio: new Audio('0', 'SendOnly'), video: new Video('1', 'SendOnly') }
        definitions.audio.addOpusCodec(audioPayloadType)
        definitions.video.addH264Codec(videoPayloadType)
        if (rtxSsrc !== undefined) {
            if (!Number.isInteger(rtxSsrc) || rtxSsrc <= 0 || rtxSsrc >= UINT32 || [audioSsrc, videoSsrc].includes(rtxSsrc)) throw new Error('Invalid video repair SSRC')
            definitions.video.addRTXCodec(102, videoPayloadType, 90000)
            definitions.video.addRtxSSRC(videoSsrc, rtxSsrc)
        }
        definitions.audio.addSSRC(audioSsrc, cname, 'xbox', 'game-audio')
        definitions.video.addSSRC(videoSsrc, cname, 'xbox', 'game-video')
        this.media = {}
        for (const kind of ['audio', 'video']) {
            const config = new RtpPacketizationConfig(kind === 'audio' ? audioSsrc : videoSsrc, cname, kind === 'audio' ? audioPayloadType : videoPayloadType, kind === 'audio' ? 48000 : 90000)
            config.playoutDelayId = 5; config.playoutDelayMin = 0; config.playoutDelayMax = kind === 'audio' ? 1 : 10
            const packetizer = kind === 'audio' ? new RtpPacketizer(config) : new H264RtpPacketizer('StartSequence', config, 1200)
            packetizer.addToChain(new RtcpSrReporter(config))
            packetizer.addToChain(new RtcpNackResponder(512))
            const track = peer.addTrack(definitions[kind])
            track.setMediaHandler(packetizer)
            track.onMessage?.(message => this.handleFeedback(kind, message))
            this.media[kind] = { track, config, lastSource: undefined }
        }
    }

    handleFeedback(kind, message) {
        const data = Buffer.from(message)
        for (let offset = 0; offset + 4 <= data.length;) {
            if (data[offset] >> 6 !== 2) return
            const length = (data.readUInt16BE(offset + 2) + 1) * 4
            if (offset + length > data.length || length < 4) return
            const type = data[offset + 1], count = data[offset] & 31
            if (type === 201 && kind === 'audio') this.feedback.audioReports++
            if (type === 200 || type === 201) {
                // Report blocks follow the header (plus 20 bytes of sender info in an SR).
                for (let block = offset + (type === 200 ? 28 : 8), index = 0; index < count && block + 24 <= offset + length; index++, block += 24) {
                    if (data.readUInt32BE(block) !== this.ssrc.video) continue
                    this.feedback.videoReports++
                    const fraction = Math.round(data[block + 4] / 2.56)
                    this.feedback.videoFractionLost = fraction
                    this.feedback.videoMaxFractionLost = Math.max(this.feedback.videoMaxFractionLost, fraction)
                    this.feedback.videoCumulativeLost = data.readIntBE(block + 5, 3)
                    this.feedback.videoJitterMs = Math.round(data.readUInt32BE(block + 12) / 90)
                }
            }
            if (type === 205 && count === 1) {
                // Each NACK item names one packet plus a 16-bit bitmask of following losses.
                for (let item = offset + 12; item + 4 <= offset + length; item += 4) {
                    let mask = data.readUInt16BE(item + 2), lost = 1
                    while (mask) { lost += mask & 1; mask >>= 1 }
                    this.feedback.nackPackets += lost
                }
            }
            if (type === 205 && count === 15) this.feedback.transportFeedback++
            if (type === 206 && count === 15 && length >= 20 && data.toString('latin1', offset + 12, offset + 16) === 'REMB') {
                const exponent = data[offset + 17] >> 2, mantissa = ((data[offset + 17] & 3) << 16) | data.readUInt16BE(offset + 18)
                this.feedback.rembKbps = Math.round(mantissa * 2 ** exponent / 1000)
            }
            if (type === 206 && count === 1) {
                this.feedback.pictureLoss++
                if (kind === 'video' && (!this.lastPliRequest || Date.now() - this.lastPliRequest > 500)) {
                    // Keep sending deltas meanwhile: gating on PLI froze every viewer until the Xbox IDR arrived.
                    this.lastPliRequest = Date.now(); this.onKeyframeNeeded()
                }
            }
            offset += length
        }
    }

    // A replacement source (new console session) starts new RTP clocks and parameter sets; without this its
    // timestamps could look older than the last frame and be dropped as stale.
    resetSource() {
        for (const media of Object.values(this.media)) media.lastSource = undefined
        this.parameters = null
        this.parameterResolution = this.videoResolution = null
        this.needKeyframe = true
        this.videoStarted = false
    }

    requestKeyframe() {
        this.videoStarted = false
        if (this.needKeyframe) {
            this.needKeyframe = false
            this.onKeyframeNeeded()
        }
    }

    publish({ kind, data, rtpTimestamp }) {
        if (this.closed) return false
        if (!['audio', 'video'].includes(kind) || !Buffer.isBuffer(data) || !data.length || data.length > 4 * 1024 * 1024 || !Number.isInteger(rtpTimestamp) || rtpTimestamp < 0 || rtpTimestamp >= UINT32) throw new Error('Invalid encoded media frame')
        const media = this.media[kind]
        if (!this.encryption.ready || this.peer.state() !== 'connected' || !media.track.isOpen()) {
            this.stats.notReady++
            this.wasReady = this.videoStarted = false
            return false
        }
        if (!this.wasReady) {
            this.wasReady = this.needKeyframe = true
            this.requestKeyframe()
        }
        if (media.lastSource !== undefined) {
            const delta = (rtpTimestamp - media.lastSource + UINT32) % UINT32
            if (delta === 0 || delta >= UINT32 / 2) { this.stats.stale++; return false }
        }
        if (kind === 'video') {
            const units = nalUnits(data), types = units.map(unit => unit.type)
            if (!types.length) throw new Error('H.264 must contain Annex-B NAL units')
            const parameters = units.filter(unit => unit.type === 7 || unit.type === 8)
            if (parameters.length) {
                const previous = this.parameters
                // Cache a complete pair together; partial encoder configuration must never reuse an old pair.
                this.parameters = parameters.length === 2 && types.includes(7) && types.includes(8) && parameters.every(unit => unit.data.length <= 65536)
                    ? Buffer.concat(parameters.sort((a, b) => a.type - b.type).map(unit => unit.data)) : null
                const sps = parameters.find(unit => unit.type === 7)?.data
                this.parameterResolution = this.parameters && sps ? parseSpsDimensions(sps.subarray(sps[2] === 1 ? 3 : 4)) : null
                if (this.videoStarted && (!this.parameters || !previous?.equals(this.parameters))) { this.needKeyframe = true; this.requestKeyframe() }
            }
            if (!this.videoStarted && !(types.includes(5) && this.parameters)) {
                this.stats.waitingKeyframe++
                this.requestKeyframe()
                return false
            }
            if (!this.videoStarted && !parameters.length) data = Buffer.concat([this.parameters, data])
        }
        // Preserve each source RTP clock, including rollover. Cross-track sync still requires verified RTCP timing.
        media.config.timestamp = rtpTimestamp
        let encrypted
        try {
            encrypted = kind === 'audio' ? this.encryption.encryptOpus(data) : this.encryption.encrypt(dave.MediaType.VIDEO, dave.Codec.H264, data)
        } catch {
            this.needKeyframe = true
            this.requestKeyframe()
            throw new Error('DAVE encryption failed; frame was not sent')
        }
        if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('DAVE returned an invalid encoded frame')
        // This native Track binding exposes send acceptance, not the bufferedAmount declared in its types.
        if (!media.track.sendMessageBinary(encrypted)) {
            this.stats.backpressure++
            if (kind === 'video') { this.needKeyframe = true; this.requestKeyframe() }
            return false
        }
        media.lastSource = rtpTimestamp
        if (kind === 'video') {
            // Dimensions describe accepted encoded video, never the requested or advertised size.
            this.videoResolution = this.parameterResolution
            this.videoStarted = true; this.needKeyframe = true; this.stats.sentVideo++
            const rate = this.rateWindow, now = Date.now()
            rate.bytes += encrypted.length; rate.peak = Math.max(rate.peak, encrypted.length)
            if (now - rate.start >= 2000) {
                this.feedback.videoKbps = Math.round(rate.bytes * 8 / (now - rate.start))
                this.feedback.videoPeakFrameKB = Math.round(rate.peak / 1024)
                this.rateWindow = { start: now, bytes: 0, peak: 0 }
            }
        }
        else this.stats.sentAudio++
        return true
    }

    close() {
        if (this.closed) return
        this.closed = true
        this.parameters = null
        for (const { track } of Object.values(this.media)) track.close()
    }
}
