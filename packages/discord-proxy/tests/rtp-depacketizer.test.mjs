import assert from 'node:assert/strict'
import { test } from 'node:test'
import { H264Depacketizer, OpusDepacketizer, parseRtp, sequenceDelta, parseSpsDimensions } from '../src/rtp-depacketizer.mjs'

function rtp(sequence, timestamp, payload, { marker = false, payloadType = 102, extension = null, padding = 0 } = {}) {
    const header = Buffer.alloc(12)
    header[0] = 0x80 | (extension ? 0x10 : 0) | (padding ? 0x20 : 0)
    header[1] = (marker ? 0x80 : 0) | payloadType
    header.writeUInt16BE(sequence & 0xffff, 2); header.writeUInt32BE(timestamp >>> 0, 4); header.writeUInt32BE(4242, 8)
    const parts = [header]
    if (extension) { const ext = Buffer.alloc(4 + extension.length); ext.writeUInt16BE(0xbede, 0); ext.writeUInt16BE(extension.length / 4, 2); extension.copy(ext, 4); parts.push(ext) }
    parts.push(payload)
    if (padding) { const pad = Buffer.alloc(padding); pad[padding - 1] = padding; parts.push(pad) }
    return Buffer.concat(parts)
}
const sps = Buffer.from([0x67, 0x64, 0, 0x1f, 0xac]), pps = Buffer.from([0x68, 0xee, 0x3c]), idrBody = Buffer.alloc(3000, 0x5a)
test('truncated and malformed SPS data cannot produce a made-up resolution or unbounded read', () => {
    for (const data of [sps, Buffer.alloc(0), Buffer.from([0x67, 0, 0, 0, 0]), Buffer.alloc(65537, 0x67)]) assert.equal(parseSpsDimensions(data), null)
})
const stap = units => Buffer.concat([Buffer.from([24]), ...units.flatMap(unit => { const size = Buffer.alloc(2); size.writeUInt16BE(unit.length); return [size, unit] })])
// FU-A split of one NAL into chunks of `size` payload bytes.
function fuA(nal, size) {
    const body = nal.subarray(1), chunks = []
    for (let offset = 0; offset < body.length; offset += size) {
        const start = offset === 0, end = offset + size >= body.length
        chunks.push(Buffer.concat([Buffer.from([(nal[0] & 0xe0) | 28, (start ? 0x80 : 0) | (end ? 0x40 : 0) | (nal[0] & 31)]), body.subarray(offset, offset + size)]))
    }
    return chunks
}
const annexB = units => Buffer.concat(units.flatMap(unit => [Buffer.from([0, 0, 0, 1]), unit]))
const idrNal = Buffer.concat([Buffer.from([0x65]), idrBody])
// One access unit: STAP-A(SPS, PPS) then the IDR as FU-A.
function keyframePackets(sequence, timestamp) {
    const payloads = [stap([sps, pps]), ...fuA(idrNal, 1000)]
    return payloads.map((payload, index) => rtp(sequence + index, timestamp, payload, { marker: index === payloads.length - 1 }))
}
const deltaPacket = (sequence, timestamp) => rtp(sequence, timestamp, Buffer.from([0x41, 1, 2, 3]), { marker: true })
function harness() {
    const frames = [], requests = { count: 0 }
    const depacketizer = new H264Depacketizer({ onFrame: frame => frames.push(frame), onKeyframeNeeded: () => requests.count++ })
    return { depacketizer, frames, requests }
}

test('RTP header parsing honours CSRC, extensions and padding; sequence math wraps', () => {
    const parsed = parseRtp(rtp(7, 9, Buffer.from([1, 2, 3]), { extension: Buffer.alloc(8, 9), padding: 4 }))
    assert.deepEqual([...parsed.payload], [1, 2, 3])
    assert.equal(sequenceDelta(0, 65535), 1)
    assert.equal(sequenceDelta(65535, 0), -1)
    assert.equal(parseRtp(Buffer.alloc(8)), null)
})

test('STAP-A + FU-A reassemble into one Annex-B keyframe, then deltas follow', () => {
    const { depacketizer, frames } = harness()
    for (const packet of keyframePackets(100, 9000)) depacketizer.push(packet, 0)
    depacketizer.push(deltaPacket(104, 10500), 1)
    assert.equal(frames.length, 2)
    assert.equal(frames[0].keyframe, true)
    assert(frames[0].data.equals(annexB([sps, pps, idrNal])))
    assert.deepEqual([...frames[1].data], [0, 0, 0, 1, 0x41, 1, 2, 3])
    assert.equal(frames[1].rtpTimestamp, 10500)
    // 0x41 has nal_ref_idc 2 (reference); a 0x01 slice would be droppable.
    assert.equal(frames[1].reference, true)
    depacketizer.push(rtp(105, 12000, Buffer.from([0x01, 9]), { marker: true }), 2)
    assert.equal(frames[2].reference, false)
    assert.equal(depacketizer.diagnostics().sps.profileIdc, 0x64)
    assert.equal(depacketizer.diagnostics().nonReferenceFrames, 1)
})

test('deltas before the first keyframe are held back', () => {
    const { depacketizer, frames } = harness()
    depacketizer.push(deltaPacket(1, 100), 0)
    for (const packet of keyframePackets(2, 200)) depacketizer.push(packet, 0)
    assert.deepEqual(frames.map(frame => frame.keyframe), [true])
})

test('out-of-order packets inside the wait window still produce intact frames', () => {
    const { depacketizer, frames } = harness()
    const packets = keyframePackets(10, 500)
    for (const index of [0, 2, 1, 3]) depacketizer.push(packets[index], index)
    assert.equal(frames.length, 1)
    assert(frames[0].data.equals(annexB([sps, pps, idrNal])))
    assert(depacketizer.diagnostics().reordered > 0)
})

test('a lost fragment drops the frame, requests one keyframe and resumes on the next IDR', () => {
    const { depacketizer, frames, requests } = harness()
    for (const packet of keyframePackets(0, 0)) depacketizer.push(packet, 0)
    const broken = keyframePackets(4, 1500) // sequences 4-7
    broken.splice(2, 1) // lose a middle FU-A fragment (sequence 6)
    for (const packet of broken) depacketizer.push(packet, 10)
    depacketizer.tick(100) // wait window expired
    depacketizer.push(deltaPacket(8, 3000), 110)
    for (const packet of keyframePackets(9, 4500)) depacketizer.push(packet, 120)
    assert.deepEqual(frames.map(frame => frame.rtpTimestamp), [0, 4500])
    assert.equal(requests.count, 1)
    assert.equal(depacketizer.diagnostics().lost, 1)
    assert.equal(depacketizer.diagnostics().waitingForKeyframe, false)
})

test('an ignored keyframe request is repeated once a second while waiting', () => {
    const { depacketizer, requests } = harness()
    depacketizer.push(deltaPacket(1, 100), 0)
    depacketizer.tick(1500)
    depacketizer.tick(1800)
    depacketizer.tick(2600)
    assert.equal(requests.count, 2)
})

test('sequence numbers wrap from 65535 to 0 without loss', () => {
    const { depacketizer, frames } = harness()
    for (const packet of keyframePackets(65533, 100)) depacketizer.push(packet, 0)
    depacketizer.push(deltaPacket(1, 1600), 1)
    assert.equal(frames.length, 2)
    assert.equal(depacketizer.diagnostics().lost, 0)
})

test('Opus packets are released in order and losses are skipped', () => {
    const frames = []
    const opus = new OpusDepacketizer({ onFrame: frame => frames.push(frame) })
    opus.push(rtp(1, 960, Buffer.from([1]), { payloadType: 111 }), 0)
    opus.push(rtp(3, 2880, Buffer.from([3]), { payloadType: 111 }), 1)
    opus.push(rtp(2, 1920, Buffer.from([2]), { payloadType: 111 }), 2)
    opus.push(rtp(5, 4800, Buffer.from([5]), { payloadType: 111 }), 3)
    opus.tick(50)
    assert.deepEqual(frames.map(frame => frame.data[0]), [1, 2, 3, 5])
    assert.equal(opus.diagnostics().lost, 1)
})
