const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { _electron } = require('../../desktop/node_modules/playwright')
const desktop = path.resolve(__dirname, '../../desktop')

;(async () => {
    const app = await _electron.launch({ args: [path.join(desktop, 'tests/smoke-fixture.cjs')], cwd: desktop })
    try {
        const page = await app.firstWindow()
        await page.goto('app://./settings/video.html')
        const moduleSource = fs.readFileSync(path.resolve(__dirname, '../src/encoded-tap.mjs'), 'utf8')
        const result = await page.evaluate(async source => {
            const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))
            const { tapEncodedReceiver } = await import(url)
            URL.revokeObjectURL(url)
            const NativeWorker = window.Worker
            let workersCreated = 0
            window.Worker = new Proxy(NativeWorker, { construct(target, args) { workersCreated++; return Reflect.construct(target, args) } })
            const a = new RTCPeerConnection({ iceServers: [] }), b = new RTCPeerConnection({ iceServers: [] })
            const context = new AudioContext()
            const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination()
            oscillator.connect(destination)
            const canvas = document.createElement('canvas')
            canvas.width = 320; canvas.height = 180
            const paint = canvas.getContext('2d'), video = canvas.captureStream(30)
            const taps = [], errors = [], counts = { audio: 0, video: 0 }, skipped = { audio: 0, video: 0 }
            let keys = 0, slow = true, frames = 0
            const preview = document.createElement('video')
            preview.muted = preview.autoplay = true; document.body.append(preview)
            const timer = setInterval(() => { paint.fillStyle = frames++ % 2 ? 'red' : 'blue'; paint.fillRect(0, 0, 320, 180) }, 33)
            b.ontrack = event => {
                const tap = tapEncodedReceiver(event.receiver, {
                    onFrame: async frame => {
                        counts[frame.kind]++
                        skipped[frame.kind] += frame.skipped
                        if (!frame.data.byteLength || !Number.isInteger(frame.metadata.rtpTimestamp)) throw new Error('Missing encoded bytes or RTP timing')
                        if (slow) await new Promise(resolve => setTimeout(resolve, 250))
                    },
                    onKeyframeNeeded: () => keys++,
                    onError: error => errors.push(error.message),
                })
                taps.push(tap)
                if (event.track.kind === 'video') { preview.srcObject = new MediaStream([event.track]); preview.play().catch(error => errors.push(error.message)) }
            }
            const gather = pc => pc.iceGatheringState === 'complete' ? Promise.resolve() : new Promise((resolve, reject) => {
                const id = setTimeout(() => reject(new Error('Local ICE timeout')), 8000)
                pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(id); resolve() } })
            })
            const decoded = async () => {
                for (const report of (await b.getStats()).values()) if (report.type === 'inbound-rtp' && report.kind === 'video') return report.framesDecoded || 0
                return 0
            }
            const tracks = [...video.getTracks(), ...destination.stream.getTracks()]
            try {
                await context.resume(); oscillator.start()
                tracks.forEach(track => a.addTrack(track))
                for (const t of a.getTransceivers()) {
                    const kind = t.sender.track.kind
                    t.setCodecPreferences(RTCRtpSender.getCapabilities(kind).codecs.filter(c => c.mimeType.toLowerCase() === (kind === 'video' ? 'video/h264' : 'audio/opus')))
                }
                await a.setLocalDescription(await a.createOffer()); await gather(a)
                await b.setRemoteDescription(a.localDescription)
                await b.setLocalDescription(await b.createAnswer()); await gather(b)
                await a.setRemoteDescription(b.localDescription)
                await new Promise(resolve => setTimeout(resolve, 1200))
                const duringSlowExport = await decoded()
                slow = false
                await new Promise(resolve => setTimeout(resolve, 300))
                taps.forEach(tap => tap.close())
                const beforeDetach = await decoded(), afterCloseCounts = { ...counts }
                await new Promise(resolve => setTimeout(resolve, 500))
                const afterDetach = await decoded()
                let resumedFrames = 0, duplicateRejections = 0
                for (let cycle = 0; cycle < 20; cycle++) {
                    const resumed = b.getReceivers().map(receiver => {
                        const options = { onFrame: async () => { resumedFrames++; await new Promise(resolve => setTimeout(resolve, 80)) }, onError: error => errors.push(error.message) }
                        const tap = tapEncodedReceiver(receiver, options)
                        try { tapEncodedReceiver(receiver, options); errors.push('Duplicate subscription accepted') } catch { duplicateRejections++ }
                        return tap
                    })
                    await new Promise(resolve => setTimeout(resolve, 40))
                    resumed.forEach(tap => tap.close())
                    const stoppedCount = resumedFrames
                    await new Promise(resolve => setTimeout(resolve, 40))
                    if (resumedFrames !== stoppedCount) errors.push('Stopped subscription delivered a late frame')
                }
                return { counts, afterCloseCounts, skipped, keys, duringSlowExport, beforeDetach, afterDetach, resumedFrames, duplicateRejections, workersCreated, decodedAfterCycles: await decoded(), errors }
            } finally {
                clearInterval(timer); taps.forEach(tap => tap.close()); tracks.forEach(track => track.stop())
                a.close(); b.close(); taps.forEach(tap => tap.dispose()); oscillator.stop(); await context.close(); preview.remove()
                window.Worker = NativeWorker
            }
        }, moduleSource)
        assert.deepEqual(result.errors, [])
        assert(result.counts.audio > 1 && result.counts.video > 0)
        assert(result.skipped.audio > 0, 'Slow export must skip copies instead of blocking receiver decoding')
        assert(result.duringSlowExport > 10, 'Local video must keep decoding while export is slow')
        assert(result.afterDetach > result.beforeDetach + 3, 'Closing the tap must restore ordinary video decoding')
        assert.deepEqual(result.counts, result.afterCloseCounts, 'Stopped taps must not continue delivering media')
        assert.equal(result.workersCreated, 2, 'Twenty resume cycles must reuse the original audio/video workers')
        assert.equal(result.duplicateRejections, 40)
        assert(result.resumedFrames >= 20, 'Each resumed receiver must keep exporting frames')
        assert(result.decodedAfterCycles > result.afterDetach + 20, 'Repeated output toggles must preserve local decoding')
        console.log('PASS: encoded video/audio tap, bounded slow-consumer behavior, local playback and detach cleanup', result)
    } finally { await app.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
