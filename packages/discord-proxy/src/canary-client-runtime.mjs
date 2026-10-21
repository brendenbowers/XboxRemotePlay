import { resolveClientContext } from './client-context.mjs'
import { installClientStreamBridge } from './client-stream-bridge.mjs'

export function installCanaryClientBridge(root, key) {
    if (Object.getOwnPropertyDescriptor(root, key)) throw new Error('Bridge already installed')
    const context = resolveClientContext(root)
    if (!context.gateway.isSessionEstablished()) throw new Error('Canary gateway is disconnected')
    const packets = []
    let lastPoll = Date.now(), disposed = false
    const enqueue = packet => {
        if (packets.length >= 16) { dispose(); return }
        packets.push(packet)
    }
    const bridge = installClientStreamBridge({ ...context, onPacket: enqueue,
        onStopped: () => enqueue({ t: 'BRIDGE_STOPPED', d: {} }) })
    const dispose = () => {
        if (disposed) return
        disposed = true
        clearInterval(watchdog)
        try { bridge.dispose() } finally { packets.length = 0; delete root[key] }
    }
    // A killed publisher cannot run cleanup; release its stream and hook when polling stops.
    const watchdog = setInterval(() => { if (Date.now() - lastPoll > 5000) dispose() }, 1000)
    const api = {
        poll() {
            if (disposed) throw new Error('Bridge disconnected')
            lastPoll = Date.now()
            // Canary's gateway resumes routinely (e.g. after idle); report it instead of failing so the publisher can wait.
            if (!context.gateway.isSessionEstablished()) return { gatewayReady: false, voice: null, packets: [], ownsStream: bridge.status().ownsStream }
            const voice = context.readVoice()
            const status = bridge.status()
            return { voice: voice ? { ...voice, existingStreamKey: context.readActiveStreamKey() } : null,
                packets: packets.splice(0), ownsStream: status.ownsStream, previews: status.previews }
        },
        preview(image) {
            if (disposed) throw new Error('Bridge disconnected')
            return bridge.preview(image)
        },
        control(op, data) {
            if (disposed) throw new Error('Bridge disconnected')
            if (op === 18) {
                if (data?.type !== 'guild' || data.preferred_region !== null) throw new Error('Invalid stream destination')
                bridge.start({ guildId: data.guild_id, channelId: data.channel_id })
            } else bridge.control(op, data)
            return true
        },
        dispose,
    }
    Object.defineProperty(root, key, { value: api, configurable: true })
    return api.poll()
}

export function clientBridgeExpression(key) {
    return `(() => { const resolveClientContext = ${resolveClientContext.toString()}; const installClientStreamBridge = ${installClientStreamBridge.toString()}; const installCanaryClientBridge = ${installCanaryClientBridge.toString()}; return installCanaryClientBridge(globalThis, ${JSON.stringify(key)}); })()`
}
