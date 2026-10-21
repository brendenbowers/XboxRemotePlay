import { DiscordPublisher } from './publisher.mjs'
import { XboxReceiver } from './xbox-receiver.mjs'
import { BitrateController } from './bitrate-controller.mjs'

const publisher = new DiscordPublisher()
let receiver = null, controller = null
// Discord's estimate and loss steer the Xbox encoder through REMB while a headless share is live.
setInterval(() => {
    if (!receiver || !controller) return
    const sender = publisher.session?.connection?.sender
    const feedback = sender?.feedback
    const sending = !!(sender?.encryption?.ready && sender.stats.sentVideo > 0)
    const next = controller.update({ rembKbps: feedback?.rembKbps, fractionLost: feedback?.videoFractionLost, reports: feedback?.videoReports || 0, sending,
        videoKbps: feedback?.videoKbps || 0, sourceHeight: receiver.depacketizers.video.stats.sps?.height || 0 })
    if (next) receiver.setBitrate(next)
}, 1000)
const port = process.parentPort
if (!port) throw new Error('Publisher must be launched by Console Stream')
publisher.on('status', data => port.postMessage({ event: 'status', data }))
publisher.on('keyframe', () => {
    if (receiver) receiver.requestKeyframe()
    else port.postMessage({ event: 'keyframe' })
})
port.on('message', async ({ data: message }) => {
    const { id, action, data } = message || {}
    // Fire-and-forget controller state from main (already validated there); no reply on this hot path.
    if (action === 'xbox-gamepad' && id === undefined) { receiver?.setGamepad(data); return }
    if (action === 'xbox-native-input' && id === undefined) { receiver?.setNativeInput(data); return }
    if (typeof id !== 'string' || id.length > 64) return
    try {
        let result
        if (action === 'status') result = publisher.status()
        else if (action === 'login') result = await publisher.login(data?.token)
        else if (action === 'connect-canary') result = await publisher.connectCanary()
        else if (action === 'disconnect') result = await publisher.disconnect()
        else if (action === 'start') result = await publisher.start(data)
        else if (action === 'stop') result = publisher.stop()
        else if (action === 'preview') result = await publisher.preview(data?.image)
        else if (action === 'xbox-keyframe-data') {
            // Latest IDR (Annex-B) plus its avc1 codec string, for the renderer to decode one preview frame.
            const keyframe = receiver?.lastKeyframe
            result = keyframe ? { data: new Uint8Array(keyframe.data), codec: keyframe.codec, ageMs: Date.now() - keyframe.at } : null
        }
        else if (action === 'frame') {
            if (!data || !(data.data instanceof ArrayBuffer) || data.data.byteLength > 4 * 1024 * 1024) throw new Error('Invalid media frame')
            result = publisher.publish({ kind: data.kind, rtpTimestamp: data.rtpTimestamp, data: Buffer.from(data.data) })
        } else if (action === 'xbox-offer') {
            // Main-process only (headless mode); one receiver at a time.
            receiver?.close()
            publisher.session?.connection?.sender?.resetSource()
            // In-process path: no renderer tap or IPC hop. publish() returns false until a share is live.
            receiver = new XboxReceiver({ resolution: data?.resolution, onFrame: frame => publisher.publish(frame) })
            controller = null
            result = await receiver.createOffer()
        } else if (action === 'xbox-answer') receiver.setAnswer(data?.sdp)
        else if (action === 'xbox-ice') receiver.addRemoteCandidates(Array.isArray(data?.candidates) ? data.candidates.slice(0, 64) : [])
        else if (action === 'xbox-status') result = receiver ? { ...receiver.diagnostics(), bitrate: controller?.diagnostics() || null } : null
        else if (action === 'xbox-bitrate') {
            // Initial/manual rate; the controller continues from it once Discord feedback flows.
            if (!Number.isInteger(data?.kbps) || data.kbps < 500 || data.kbps > 40000 || !receiver) result = false
            else {
                controller = new BitrateController({ initialKbps: data.kbps, override: data.override === true,
                    probeKbps: receiver.quality[1] >= 2160 ? 30000 : receiver.quality[1] >= 1440 ? 15000 : 0, probeHeight: receiver.quality[1] })
                result = receiver.setBitrate(data.kbps)
            }
        } else if (action === 'xbox-resolution') result = receiver?.requestResolution(data?.height) || false
        else if (action === 'xbox-keyframe') result = receiver?.requestKeyframe() || false
        else if (action === 'xbox-stop') { receiver?.close(); receiver = null; controller = null }
        else throw new Error('Unknown publisher action')
        port.postMessage({ id, result })
    } catch {
        // Never serialize dependency errors: they may contain media credentials or account data.
        port.postMessage({ id, error: action.startsWith('xbox-') ? 'Headless Xbox receiver failed' : action === 'connect-canary' ? 'Could not connect to Discord Canary. Start it with loopback debugging on port 9223, sign in and join voice, then retry.' : action === 'login' ? 'Discord connection failed. Check the local credential and try again.' :
            publisher.status().reason || 'Discord output failed. Join a server voice channel and stop any existing share, then retry.' })
    } finally { if (action === 'login' && data) data.token = undefined }
})
port.postMessage({ event: 'boot' })
