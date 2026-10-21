// Runs in a worker. Keep local decoding independent of publisher latency with a small in-flight window.
// One slot was too few: any slow IPC round trip dropped video until the next Xbox keyframe.
function encodedWorker() {
    let windowSize = 1, credit = 1, enabled = true, recovering = false, requestedAt = 0, skipped = 0, generation = 0
    onmessage = event => {
        const data = event.data
        if (data.type === 'ack' && data.generation === generation) credit = Math.min(windowSize, credit + 1)
        if (data.type === 'pause' && data.generation === generation) enabled = false
        if (data.type === 'resume') { generation = data.generation; enabled = true; credit = windowSize; recovering = false; requestedAt = 0; skipped = 0 }
    }
    onrtctransform = event => {
        const { readable, writable, options } = event.transformer
        windowSize = credit = options.inFlight
        readable.pipeThrough(new TransformStream({
            transform(frame, controller) {
                const video = options.kind === 'video'
                if (!enabled) {
                    controller.enqueue(frame)
                    return
                } else if (!credit) {
                    skipped++
                    if (video) recovering = true
                } else if (video && recovering && frame.type !== 'key') {
                    skipped++
                    // The Xbox can ignore a request; repeat it while still waiting.
                    if (performance.now() - requestedAt > 1000) { requestedAt = performance.now(); postMessage({ type: 'keyframe-needed', generation }) }
                } else if (!frame.data.byteLength || !Number.isInteger(frame.getMetadata().rtpTimestamp)) {
                    // The publisher rejects these and a rejection stops the share; drop them here instead.
                    skipped++
                    if (video && frame.data.byteLength) recovering = true
                } else if (frame.data.byteLength <= 4 * 1024 * 1024) {
                    const data = frame.data.slice(0)
                    credit--
                    recovering = false
                    requestedAt = 0
                    postMessage({ type: 'frame', generation, kind: options.kind, frameType: frame.type, metadata: frame.getMetadata(), timeOriginMs: performance.timeOrigin, skipped, data }, [data])
                    skipped = 0
                } else {
                    skipped++
                    if (video) recovering = true
                    postMessage({ type: 'error', message: 'Encoded frame exceeds proxy size limit' })
                }
                controller.enqueue(frame)
            },
        })).pipeTo(writable).catch(() => postMessage({ type: 'error', message: 'Encoded proxy transform stopped' }))
    }
}

const receivers = new WeakMap()

// Three per track keeps audio + video under the main process's eight pending publisher requests.
export function tapEncodedReceiver(receiver, { onFrame, onKeyframeNeeded = () => {}, onError = () => {}, inFlight = 3 }) {
    if (!Number.isInteger(inFlight) || inFlight < 1 || inFlight > 3) throw new Error('Invalid encoded export window')
    if (!receiver?.track || !['audio', 'video'].includes(receiver.track.kind)) throw new Error('A remote media receiver is required')
    if (typeof RTCRtpScriptTransform !== 'function') throw new Error('Encoded media transforms are unavailable')
    let state = receivers.get(receiver)
    if (state?.subscriber) throw new Error('Receiver is already being exported')
    if (state && receiver.transform !== state.transform) throw new Error('Receiver transform was replaced')
    if (!state) {
        if (receiver.transform) throw new Error('Receiver already has an encoded transform')
        const url = URL.createObjectURL(new Blob([`(${encodedWorker.toString()})()`], { type: 'application/javascript' }))
        const worker = new Worker(url)
        URL.revokeObjectURL(url)
        state = { worker, transform: new RTCRtpScriptTransform(worker, { kind: receiver.track.kind, inFlight }), subscriber: null, generation: 0 }
        worker.onmessage = ({ data }) => {
            const subscriber = state.subscriber
            if (!subscriber) return
            if (data.generation !== undefined && data.generation !== subscriber.generation) return
            if (data.type === 'keyframe-needed') { subscriber.onKeyframeNeeded(); return }
            if (data.type === 'error') { subscriber.onError(new Error(data.message)); return }
            if (data.type !== 'frame') return
            Promise.resolve().then(() => {
                if (state.subscriber === subscriber) return subscriber.onFrame(data)
            }).catch(error => subscriber.onError(error)).finally(() => {
                if (state.subscriber === subscriber) worker.postMessage({ type: 'ack', generation: subscriber.generation })
            })
        }
        worker.onerror = () => state.subscriber?.onError(new Error('Encoded proxy worker failed'))
        try { receiver.transform = state.transform } catch (error) { worker.terminate(); throw error }
        receivers.set(receiver, state)
        state.dispose = () => {
            if (receivers.get(receiver) !== state) return
            state.subscriber = null
            receivers.delete(receiver)
            receiver.track.removeEventListener('ended', state.dispose)
            state.worker.onmessage = null; state.worker.onerror = null; state.worker.terminate()
        }
        receiver.track.addEventListener('ended', state.dispose, { once: true })
    }
    const subscriber = { onFrame, onKeyframeNeeded, onError, generation: ++state.generation }
    state.subscriber = subscriber
    state.worker.postMessage({ type: 'resume', generation: subscriber.generation })
    return {
        close() {
            if (state.subscriber !== subscriber) return
            state.subscriber = null
            // Chromium cannot safely detach an active transform; retain pass-through until receiver teardown.
            state.worker.postMessage({ type: 'pause', generation: subscriber.generation })
        },
        // Call only after closing the owning PeerConnection, never merely to stop publication.
        dispose: state.dispose,
    }
}
