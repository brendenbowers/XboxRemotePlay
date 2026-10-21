import { EventEmitter } from 'node:events'
import { ExperimentalAccountConnector } from './account-connector.mjs'
import { StreamOnlySession } from './stream-only-session.mjs'
import { DiscordStreamTransport } from './stream-transport.mjs'
import { CanaryConnector } from './canary-connector.mjs'

export class DiscordPublisher extends EventEmitter {
    constructor() {
        super()
        this.accountStatus = () => this.emit('status', this.status())
        this.setAccount(new ExperimentalAccountConnector())
        this.state = 'idle'
        this.reason = ''
        this.lastDiagnostic = null
    }
    status() {
        const account = this.account.status()
        return { account: account.state, channelId: account.voice?.channelId || null, state: this.state, reason: this.reason,
            stats: this.session?.connection?.sender?.stats || null, diagnostic: this.session?.diagnostics() || this.lastDiagnostic,
            previews: this.account.previews || null }
    }
    setAccount(account) {
        this.account?.removeListener('status', this.accountStatus)
        this.account = account
        account.on('status', this.accountStatus)
    }
    async login(token) {
        await this.disconnect()
        this.setAccount(new ExperimentalAccountConnector())
        await this.account.connect(token)
        return this.status()
    }
    async connectCanary() {
        await this.disconnect()
        this.setAccount(new CanaryConnector())
        await this.account.connect()
        return this.status()
    }
    async disconnect() { this.stop(); await this.account.disconnect(); return this.status() }
    // reconnectAttempts: 0 = off, -1 = unlimited. Only a user Stop/Disconnect cancels the retries.
    async start({ reconnectAttempts = 0, ...attributes } = {}) {
        if (this.session) throw new Error('A Discord publication is already active')
        this.cancelReconnect()
        this.desired = { attributes, attempts: Number.isInteger(reconnectAttempts) && reconnectAttempts >= -1 ? reconnectAttempts : 0 }
        this.retry = 0
        try { return await this.startSession(attributes) }
        catch (error) {
            // A failed first start is reported, not retried: only drops of a running share reconnect.
            this.desired = null; this.cancelReconnect()
            this.state = 'idle'
            throw error
        }
    }
    cancelReconnect() {
        clearTimeout(this.retryTimer); clearTimeout(this.healthyTimer)
        this.retryTimer = this.healthyTimer = null
    }
    // Exponential backoff with jitter: 2 s, 4 s, 8 s … capped at 60 s.
    scheduleReconnect(reason) {
        const desired = this.desired
        if (!desired || this.retryTimer) return
        // The legacy token connector forgets its credential, so it can only resume while still connected.
        const canReconnect = this.account instanceof CanaryConnector || this.account.status().state === 'connected'
        if (!canReconnect || (desired.attempts !== -1 && this.retry >= desired.attempts)) {
            this.desired = null
            this.state = 'idle'; this.reason = desired.attempts ? `${reason} (reconnect gave up after ${this.retry} attempts)` : reason
            this.emit('status', this.status())
            return
        }
        this.retry++
        const delay = Math.min(60000, 2000 * 2 ** (this.retry - 1)) * (1 + Math.random() * 0.2)
        this.state = 'reconnecting'
        this.reason = `${reason}. Reconnecting in ${Math.round(delay / 1000)} s (attempt ${this.retry}${desired.attempts === -1 ? '' : ` of ${desired.attempts}`})`
        this.emit('status', this.status())
        this.retryTimer = setTimeout(async () => {
            this.retryTimer = null
            if (this.desired !== desired) return
            try {
                if (this.account instanceof CanaryConnector && this.account.status().state !== 'connected') await this.account.connect()
                if (this.desired !== desired) return
                await this.startSession(desired.attributes)
            } catch (error) {
                if (this.desired === desired && !this.session) this.scheduleReconnect(error instanceof Error ? error.message.replace(/^Error: /, '') : 'Reconnect failed')
            }
        }, delay)
    }
    async startSession(attributes) {
        const voice = this.account.existingVoice()
        this.state = 'starting'; this.reason = ''
        this.lastDiagnostic = null
        const session = this.session = new StreamOnlySession({ ...voice, gateway: this.account,
            createConnection: (onReady, onStopped) => new DiscordStreamTransport({ ...attributes, userId: voice.userId, onReady, onStopped,
                onKeyframeNeeded: () => this.emit('keyframe') }) })
        session.on('stopped', reason => {
            if (this.session !== session) return
            this.lastDiagnostic = session.diagnostics()
            this.session = null; this.state = 'idle'; this.reason = reason
            clearTimeout(this.healthyTimer)
            if (this.desired && (session.published || this.retry > 0)) this.scheduleReconnect(reason)
            else this.emit('status', this.status())
        })
        this.emit('status', this.status())
        await session.start()
        if (this.session !== session) throw new Error('Discord publication was cancelled')
        this.state = 'publishing'
        session.published = true
        // A minute of healthy publishing restores the full retry budget.
        clearTimeout(this.healthyTimer)
        this.healthyTimer = setTimeout(() => { if (this.session === session) this.retry = 0 }, 60000)
        this.emit('status', this.status())
        return this.status()
    }
    stop() {
        this.desired = null
        this.cancelReconnect()
        if (this.state === 'reconnecting') { this.state = 'idle'; this.reason = 'Output stopped'; this.emit('status', this.status()) }
        this.session?.stop()
        return this.status()
    }
    publish(frame) { return this.session?.connection?.publish(frame) || false }
    async preview(image) {
        if (this.state !== 'publishing' || typeof this.account.preview !== 'function') return false
        return this.account.preview(image)
    }
}
