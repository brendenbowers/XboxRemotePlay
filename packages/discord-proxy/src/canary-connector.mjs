import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { clientBridgeExpression } from './canary-client-runtime.mjs'

const isId = value => typeof value === 'string' && /^\d{17,20}$/.test(value)

export class CanaryConnector extends EventEmitter {
    constructor({ fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, pollMs = 100, gatewayGraceMs = 15000 } = {}) {
        super()
        Object.assign(this, { fetchImpl, WebSocketImpl, pollMs, gatewayGraceMs })
        this.state = 'disconnected'; this.voice = null; this.userId = null
        this.requests = new Map(); this.nextId = 0
        this.key = '__consoleStream_' + randomUUID().replaceAll('-', '')
    }
    status() { return { state: this.state, userId: this.userId, voice: this.voice ? { ...this.voice } : null } }
    async connect() {
        if (this.state !== 'disconnected') throw new Error('Canary connector is already active')
        this.state = 'connecting'
        const attempt = this.attempt = {}
        try {
            const response = await this.fetchImpl('http://127.0.0.1:9223/json/list', { signal: AbortSignal.timeout(5000), redirect: 'error' })
            if (!response.ok) throw new Error('Discovery failed')
            const targets = await response.json()
            const matches = targets.filter(target => target.type === 'page' && new URL(target.url).origin === 'https://canary.discord.com')
            if (matches.length !== 1) throw new Error('Ambiguous Canary page')
            const endpoint = new URL(matches[0].webSocketDebuggerUrl)
            if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== '9223') throw new Error('Invalid endpoint')
            if (this.attempt !== attempt) throw new Error('Cancelled')
            const socket = this.socket = new this.WebSocketImpl(endpoint.href)
            socket.onmessage = event => this.onMessage(event)
            socket.onclose = () => { if (this.socket === socket) this.disconnect() }
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Connection timed out')), 5000)
                socket.onopen = () => { clearTimeout(timer); resolve() }
                socket.onerror = () => { clearTimeout(timer); reject(new Error('Connection failed')) }
            })
            if (this.attempt !== attempt) throw new Error('Cancelled')
            this.acceptSnapshot(await this.evaluate(clientBridgeExpression(this.key)))
            if (this.attempt !== attempt) throw new Error('Cancelled')
            this.state = 'connected'
            this.emit('status', this.status())
            this.pollTimer = setInterval(() => this.poll(), this.pollMs)
            return this.status()
        } catch {
            await this.disconnect()
            throw new Error('Could not connect to Discord Canary. Start it with loopback debugging on port 9223, sign in and join voice, then retry.')
        }
    }
    onMessage(event) {
        try {
            if (typeof event.data !== 'string' || event.data.length > 512 * 1024) throw new Error('Invalid response')
            const message = JSON.parse(event.data), request = this.requests.get(message.id)
            if (!request) return
            this.requests.delete(message.id); clearTimeout(request.timer)
            if (message.error || message.result?.exceptionDetails) request.reject(new Error('Canary bridge request failed'))
            else request.resolve(message.result?.result?.value)
        } catch { this.disconnect() }
    }
    evaluate(expression) {
        const socket = this.socket
        if (!socket || socket.readyState !== 1) return Promise.reject(new Error('Canary disconnected'))
        return new Promise((resolve, reject) => {
            if (this.requests.size >= 8) { reject(new Error('Canary bridge is busy')); return }
            const id = ++this.nextId
            const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('Canary request timed out')) }, 3000)
            this.requests.set(id, { resolve, reject, timer })
            try { socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
                expression: `(() => { if (location.origin !== 'https://canary.discord.com') throw new Error('Wrong page'); return (${expression}); })()`,
                returnByValue: true, timeout: 2000,
            } })) } catch { clearTimeout(timer); this.requests.delete(id); reject(new Error('Canary request failed')) }
        })
    }
    acceptSnapshot(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.packets) || snapshot.packets.length > 16) throw new Error('Invalid bridge snapshot')
        // Keep the last voice state while Canary's gateway resumes; give up only if it stays down.
        if (snapshot.gatewayReady === false) {
            this.gatewayDownSince ??= Date.now()
            if (Date.now() - this.gatewayDownSince > this.gatewayGraceMs) throw new Error('Canary gateway stayed disconnected')
            return
        }
        this.gatewayDownSince = null
        const voice = snapshot.voice
        if (voice !== null && (!voice || ![voice.userId, voice.guildId, voice.channelId].every(isId) ||
            typeof voice.voiceSessionId !== 'string' || !voice.voiceSessionId || voice.voiceSessionId.length > 256)) throw new Error('Invalid voice session')
        const before = this.voice
        this.voice = voice
        // Counts and HTTP status only (value-free).
        const previews = snapshot.previews
        if (previews && typeof previews === 'object') this.previews = { available: !!previews.available, sent: Number(previews.sent) || 0, ok: Number(previews.ok) || 0, failed: Number(previews.failed) || 0, lastStatus: Number(previews.lastStatus) || null }
        this.userId = voice?.userId || null
        if (before && (!voice || voice.channelId !== before.channelId || voice.voiceSessionId !== before.voiceSessionId)) {
            this.emit('raw', { t: 'VOICE_STATE_UPDATE', d: { user_id: before.userId, channel_id: voice?.channelId ?? null, session_id: voice?.voiceSessionId ?? null } })
        }
        for (const packet of snapshot.packets) {
            if (['STREAM_CREATE', 'STREAM_SERVER_UPDATE', 'STREAM_DELETE'].includes(packet?.t)) this.emit('raw', packet)
            else if (packet?.t === 'BRIDGE_STOPPED') this.emit('disconnected', 'Canary stream bridge stopped')
        }
        if (before?.channelId !== voice?.channelId) this.emit('status', this.status())
    }
    async poll() {
        if (this.polling || this.state !== 'connected') return
        this.polling = true
        try {
            this.acceptSnapshot(await this.evaluate(`globalThis[${JSON.stringify(this.key)}].poll()`))
            this.pollFailingSince = null
        } catch {
            // One slow evaluate is not a dead bridge; Canary's own watchdog releases the stream after 5 s without polls.
            this.pollFailingSince ??= Date.now()
            if (this.gatewayDownSince && Date.now() - this.gatewayDownSince > this.gatewayGraceMs || Date.now() - this.pollFailingSince > 4000) await this.disconnect()
        } finally { this.polling = false }
    }
    existingVoice() {
        if (this.state !== 'connected' || !this.voice) throw new Error('Join a server voice channel in Discord Canary first')
        if (this.voice.existingStreamKey !== null) throw new Error('Stop the existing Discord share before publishing')
        return { ...this.voice }
    }
    // Stream thumbnail for the owned share (JPEG data URL, ~512×288 like Canary's own uploader).
    async preview(image) {
        if (this.state !== 'connected') throw new Error('Canary is not connected')
        if (typeof image !== 'string' || !image.startsWith('data:image/jpeg;base64,') || image.length > 400000) throw new Error('Invalid preview image')
        return this.evaluate(`globalThis[${JSON.stringify(this.key)}].preview(${JSON.stringify(image)})`)
    }
    sendStream(op, data) {
        if (this.state !== 'connected' || ![18, 19, 22].includes(op)) throw new Error('Only owned stream controls are allowed')
        this.evaluate(`globalThis[${JSON.stringify(this.key)}].control(${op},${JSON.stringify(data)})`).catch(() => this.disconnect())
    }
    async disconnect() {
        if (this.closing) return this.closing
        this.attempt = null
        clearInterval(this.pollTimer)
        this.state = 'disconnected'; this.voice = null; this.userId = null
        this.gatewayDownSince = null; this.pollFailingSince = null
        this.emit('disconnected', 'Canary bridge disconnected')
        this.emit('status', this.status())
        const socket = this.socket
        if (!socket) return
        this.closing = (async () => {
            try { await this.evaluate(`globalThis[${JSON.stringify(this.key)}]?.dispose()` ) } catch { /* The renderer watchdog also restores its hook. */ }
            if (this.socket === socket) this.socket = null
            socket.close()
            for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error('Canary disconnected')) }
            this.requests.clear()
        })()
        try { await this.closing } finally { this.closing = null }
    }
}
