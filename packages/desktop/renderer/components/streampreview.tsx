import React from 'react'

// Discord stream thumbnail, mirroring Canary's ApplicationStreamPreviewUploadManager:
// fit into 512×288, skip black frames, JPEG data URL, first upload as soon as the share is live,
// then every 5 minutes (60 s after a failure).
const WIDTH = 512, HEIGHT = 288
const REPEAT_MS = 5 * 60 * 1000, RETRY_MS = 60 * 1000

function toJpeg(source: CanvasImageSource, width: number, height: number) {
    const scale = Math.min(WIDTH / width, HEIGHT / height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let lit = false
    for (let index = 0; index < pixels.length && !lit; index += 64) lit = pixels[index] > 8 || pixels[index + 1] > 8 || pixels[index + 2] > 8
    return lit ? canvas.toDataURL('image/jpeg') : null
}

// Headless has no <video>: decode the receiver's latest IDR once with WebCodecs (Annex-B, no description).
async function decodeKeyframe({ data, codec }: { data: Uint8Array; codec: string }) {
    const frame = await new Promise<VideoFrame>((resolve, reject) => {
        const decoder = new VideoDecoder({ output: output => { resolve(output); decoder.close() }, error: reject })
        decoder.configure({ codec, optimizeForLatency: true })
        decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data }))
        decoder.flush().catch(reject)
        setTimeout(() => reject(new Error('Preview decode timed out')), 3000)
    })
    try { return toJpeg(frame, frame.displayWidth, frame.displayHeight) } finally { frame.close() }
}

async function capture() {
    const video = document.querySelector('#streamComponentHolder video') as HTMLVideoElement
    if (video?.videoWidth && video.videoHeight) return toJpeg(video, video.videoWidth, video.videoHeight)
    if (await window.Greenlight.headless('active')) {
        const keyframe = await window.Greenlight.headless('keyframe-data')
        if (keyframe?.data && typeof keyframe.codec === 'string' && typeof VideoDecoder === 'function') return decodeKeyframe(keyframe)
    }
    return null
}

export default function StreamPreview() {
    React.useEffect(() => {
        if (typeof window === 'undefined' || !window.Greenlight?.discord) return
        let nextAt = 0, busy = false
        const timer = setInterval(async () => {
            if (busy) return
            busy = true
            try {
                const status = await window.Greenlight.discord('status')
                if (status?.state !== 'publishing') { nextAt = 0; return }
                if (Date.now() < nextAt) return
                const image = await capture().catch(() => null)
                // Nothing to show yet (no picture, or black): try again shortly.
                if (!image) { nextAt = Date.now() + 5000; return }
                const sent = await window.Greenlight.discord('preview', { image }).catch(() => false)
                nextAt = Date.now() + (sent ? REPEAT_MS : RETRY_MS)
            } catch { /* Status unavailable; retry on the next tick. */ } finally { busy = false }
        }, 3000)
        return () => clearInterval(timer)
    }, [])
    return null
}
