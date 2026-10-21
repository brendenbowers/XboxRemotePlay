// RTP → encoded frames for the headless receiver.
// H.264 per RFC 6184 packetization-mode 1 (single NAL, STAP-A, FU-A) into Annex-B access units; Opus is one frame per packet.

const START_CODE = Buffer.from([0, 0, 0, 1])
const SEQUENCE_SPACE = 0x10000

// Coded picture size from an H.264 SPS NAL (ITU-T H.264 7.3.2.1.1), after removing emulation-prevention bytes.
export function parseSpsDimensions(nal) {
    if (nal.length < 5 || nal.length > 65536 || (nal[0] & 31) !== 7) return null
    try {
        const bytes = []
        for (let index = 1; index < nal.length; index++) {
            if (nal[index] === 3 && index >= 3 && nal[index - 1] === 0 && nal[index - 2] === 0) continue
            bytes.push(nal[index])
        }
        let bit = 0
        const read = count => { if (bit + count > bytes.length * 8) throw new Error('Truncated SPS'); let value = 0; for (let step = 0; step < count; step++, bit++) value = value * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1); return value }
        const unsigned = () => { let zeros = 0; while (read(1) === 0) if (++zeros > 31) throw new Error('Invalid SPS'); return 2 ** zeros - 1 + read(zeros) }
        const signed = () => { const value = unsigned(); return value % 2 ? (value + 1) / 2 : -value / 2 }
        const profile = read(8); read(16); unsigned()
        let chromaFormat = 1, separateColourPlane = false
        if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
            chromaFormat = unsigned()
            if (chromaFormat > 3) return null
            if (chromaFormat === 3) separateColourPlane = !!read(1)
            unsigned(); unsigned(); read(1)
            if (read(1)) for (let list = 0; list < (chromaFormat === 3 ? 12 : 8); list++) {
                if (!read(1)) continue
                for (let index = 0, last = 8, next = 8; index < (list < 6 ? 16 : 64); index++) { if (next !== 0) next = (last + signed() + 256) % 256; last = next || last }
            }
        }
        unsigned()
        const pocType = unsigned()
        if (pocType === 0) unsigned()
        else if (pocType === 1) { read(1); signed(); signed(); for (let cycle = unsigned(); cycle > 0; cycle--) signed() }
        unsigned(); read(1)
        const widthMbs = unsigned() + 1, heightUnits = unsigned() + 1, frameMbsOnly = read(1)
        if (!frameMbsOnly) read(1)
        read(1)
        let crop = [0, 0, 0, 0]
        if (read(1)) crop = [unsigned(), unsigned(), unsigned(), unsigned()]
        if (separateColourPlane) chromaFormat = 0
        const cropX = chromaFormat === 0 || chromaFormat === 3 ? 1 : 2, cropY = (chromaFormat === 1 ? 2 : 1) * (2 - frameMbsOnly)
        const width = widthMbs * 16 - cropX * (crop[0] + crop[1]), height = (2 - frameMbsOnly) * heightUnits * 16 - cropY * (crop[2] + crop[3])
        return width > 0 && width <= 7680 && height > 0 && height <= 4320 ? { width, height } : null
    } catch { return null }
}

// Positive when sequence a is after b, allowing 16-bit wraparound.
export function sequenceDelta(a, b) {
    const delta = (a - b + SEQUENCE_SPACE) % SEQUENCE_SPACE
    return delta >= SEQUENCE_SPACE / 2 ? delta - SEQUENCE_SPACE : delta
}

export function parseRtp(packet) {
    if (packet.length < 12 || packet[0] >> 6 !== 2) return null
    let offset = 12 + 4 * (packet[0] & 15)
    if (packet[0] & 0x10) {
        if (offset + 4 > packet.length) return null
        offset += 4 + 4 * packet.readUInt16BE(offset + 2)
    }
    let end = packet.length
    if (packet[0] & 0x20) end -= packet[packet.length - 1]
    if (offset > end) return null
    return { payloadType: packet[1] & 0x7f, marker: !!(packet[1] & 0x80), sequence: packet.readUInt16BE(2),
        timestamp: packet.readUInt32BE(4), ssrc: packet.readUInt32BE(8), payload: packet.subarray(offset, end) }
}

// Holds out-of-order packets briefly and releases them in sequence; a gap that outlives maxWaitMs is a loss.
class ReorderBuffer {
    constructor({ maxWaitMs, maxPackets }) {
        Object.assign(this, { maxWaitMs, maxPackets })
        this.packets = new Map()
        this.expected = null
        this.stats = { received: 0, duplicate: 0, late: 0, lost: 0, reordered: 0 }
    }

    push(rtp, now, emit) {
        this.stats.received++
        if (this.expected === null) this.expected = rtp.sequence
        const ahead = sequenceDelta(rtp.sequence, this.expected)
        if (ahead < 0) { this.stats.late++; return }
        if (this.packets.has(rtp.sequence)) { this.stats.duplicate++; return }
        if (ahead > 0) this.stats.reordered++
        this.packets.set(rtp.sequence, { rtp, arrived: now })
        this.drain(now, emit)
    }

    drain(now, emit) {
        for (;;) {
            const next = this.packets.get(this.expected)
            if (next) {
                this.packets.delete(this.expected)
                this.expected = (this.expected + 1) % SEQUENCE_SPACE
                emit(next.rtp, false)
                continue
            }
            if (!this.packets.size) return
            let oldest = null
            for (const [sequence, entry] of this.packets) if (!oldest || sequenceDelta(sequence, oldest.sequence) < 0) oldest = { sequence, entry }
            if (now - oldest.entry.arrived < this.maxWaitMs && this.packets.size < this.maxPackets) return
            // Give up on the gap: count it, then resume at the oldest packet we do have.
            this.stats.lost += sequenceDelta(oldest.sequence, this.expected)
            this.expected = oldest.sequence
            const resumed = this.packets.get(oldest.sequence)
            this.packets.delete(oldest.sequence)
            this.expected = (this.expected + 1) % SEQUENCE_SPACE
            emit(resumed.rtp, true)
        }
    }
}

export class H264Depacketizer {
    constructor({ onFrame, onKeyframeNeeded = () => {}, maxWaitMs = 40, maxPackets = 512 }) {
        Object.assign(this, { onFrame, onKeyframeNeeded })
        this.buffer = new ReorderBuffer({ maxWaitMs, maxPackets })
        this.frame = null
        this.fragment = null
        this.waitingForKeyframe = true
        this.lastRequestAt = 0
        this.now = 0
        this.stats = { frames: 0, keyframes: 0, nonReferenceFrames: 0, dropped: 0, keyframeRequests: 0, resolutionChanges: 0, sps: null }
    }

    push(packet, now = performance.now()) {
        const rtp = parseRtp(packet)
        this.now = now
        if (rtp) this.buffer.push(rtp, now, (next, afterGap) => this.consume(next, afterGap))
    }

    // Call periodically so a gap at the end of a burst still resolves and an ignored keyframe request is repeated.
    tick(now = performance.now()) {
        this.now = now
        this.buffer.drain(now, (next, afterGap) => this.consume(next, afterGap))
        if (this.waitingForKeyframe && this.buffer.stats.received && now - this.lastRequestAt > 1000) this.requestKeyframe()
    }

    // Uses the clock of the push/tick being processed so retries compare like with like.
    requestKeyframe() {
        this.lastRequestAt = this.now
        this.stats.keyframeRequests++
        this.onKeyframeNeeded()
    }

    consume(rtp, afterGap) {
        if (afterGap && this.frame) this.frame.corrupt = true
        if (this.frame && this.frame.timestamp !== rtp.timestamp) this.finish(true)
        this.frame ??= { timestamp: rtp.timestamp, units: [], keyframe: false, corrupt: afterGap }
        this.parsePayload(rtp.payload)
        if (rtp.marker) this.finish(false)
    }

    parsePayload(payload) {
        if (!payload.length) return
        const type = payload[0] & 31
        if (type >= 1 && type <= 23) { this.fragment = null; this.addUnit(payload); return }
        if (type === 24) {
            this.fragment = null
            for (let cursor = 1; cursor + 2 <= payload.length;) {
                const size = payload.readUInt16BE(cursor)
                if (!size || cursor + 2 + size > payload.length) { this.frame.corrupt = true; return }
                this.addUnit(payload.subarray(cursor + 2, cursor + 2 + size))
                cursor += 2 + size
            }
            return
        }
        if (type === 28 && payload.length > 2) {
            const header = payload[1], start = header & 0x80, end = header & 0x40
            if (start) this.fragment = [Buffer.from([(payload[0] & 0xe0) | (header & 31)]), payload.subarray(2)]
            else if (this.fragment) this.fragment.push(payload.subarray(2))
            else { this.frame.corrupt = true; return }
            if (end) { this.addUnit(Buffer.concat(this.fragment)); this.fragment = null }
            return
        }
        this.frame.corrupt = true // STAP-B, MTAP, FU-B: not used in packetization-mode 1
    }

    addUnit(unit) {
        const type = unit[0] & 31
        if (type === 5) this.frame.keyframe = true
        // nal_ref_idc 0 on a slice means no later frame depends on it, so it could be skipped for a lower-rate layer.
        if ((type === 1 || type === 5) && this.frame.reference === undefined) this.frame.reference = (unit[0] & 0x60) !== 0
        if (type === 7 && unit.length >= 4) {
            let size = null
            try { size = parseSpsDimensions(unit) } catch { /* Keep the last known size. */ }
            const previous = this.stats.sps
            this.stats.sps = { profileIdc: unit[1], constraints: unit[2], levelIdc: unit[3], ...(size || previous && { width: previous.width, height: previous.height }) }
            // The Xbox picks its resolution from the REMB bandwidth; count the switches it actually makes.
            if (previous?.height && size && size.height !== previous.height) this.stats.resolutionChanges++
        }
        this.frame.units.push(START_CODE, unit)
    }

    // A frame whose marker never arrived (timestamp changed) is incomplete.
    finish(incomplete) {
        const frame = this.frame
        this.frame = null
        if (this.fragment) { frame.corrupt = true; this.fragment = null }
        if (incomplete || frame.corrupt || !frame.units.length) { this.drop(); return }
        if (this.waitingForKeyframe && !frame.keyframe) { this.stats.dropped++; return }
        this.waitingForKeyframe = false
        this.stats.frames++
        if (frame.keyframe) this.stats.keyframes++
        if (frame.reference === false) this.stats.nonReferenceFrames++
        this.onFrame({ kind: 'video', rtpTimestamp: frame.timestamp, keyframe: frame.keyframe, reference: frame.reference !== false, data: Buffer.concat(frame.units) })
    }

    drop() {
        this.stats.dropped++
        // Later deltas reference the lost frame, so wait for an IDR rather than forwarding artefacts.
        if (!this.waitingForKeyframe) { this.waitingForKeyframe = true; this.requestKeyframe() }
    }

    diagnostics() { return { ...this.stats, ...this.buffer.stats, waitingForKeyframe: this.waitingForKeyframe } }
}

// Opus frames are independent, so a short reorder window is enough and losses are simply skipped.
export class OpusDepacketizer {
    constructor({ onFrame, maxWaitMs = 20, maxPackets = 64 }) {
        this.onFrame = onFrame
        this.buffer = new ReorderBuffer({ maxWaitMs, maxPackets })
        this.stats = { frames: 0 }
    }

    push(packet, now = performance.now()) {
        const rtp = parseRtp(packet)
        if (rtp) this.buffer.push(rtp, now, next => this.emit(next))
    }

    tick(now = performance.now()) { this.buffer.drain(now, next => this.emit(next)) }

    emit(rtp) {
        if (!rtp.payload.length) return
        this.stats.frames++
        this.onFrame({ kind: 'audio', rtpTimestamp: rtp.timestamp, data: Buffer.from(rtp.payload) })
    }

    diagnostics() { return { ...this.stats, ...this.buffer.stats } }
}
