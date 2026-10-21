import { EventEmitter } from 'node:events'

// Protocol prototype: the caller must supply an authenticated gateway and an existing voice session.
// This module never logs in, joins voice, sends microphone audio, or changes voice state.
export class StreamOnlySession extends EventEmitter {
    constructor({ gateway, userId, guildId, channelId, voiceSessionId, existingStreamKey, createConnection, timeoutMs = 15000 }) {
        super()
        for (const value of [userId, guildId, channelId]) {
            if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) throw new Error('Invalid Discord identifier')
        }
        if (typeof voiceSessionId !== 'string' || !voiceSessionId || voiceSessionId.length > 256) throw new Error('An existing authenticated voice session is required')
        if (existingStreamKey !== null) throw new Error('Existing stream state must be known and no other stream may be active')
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid timeout')
        Object.assign(this, { gateway, userId, guildId, channelId, voiceSessionId, createConnection, timeoutMs })
        this.key = `guild:${guildId}:${channelId}:${userId}`
        this.state = 'idle'
        this.connection = null
        this.serverReceived = false
        this.deleteReason = null
        this.listener = packet => this.handlePacket(packet)
        this.disconnectListener = () => this.stop('Discord gateway disconnected')
    }

    send(op, d) { this.gateway.sendStream(op, d) }

    start() {
        if (this.state !== 'idle') return Promise.reject(new Error('Session has already been started'))
        this.state = 'starting'
        this.ready = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
        this.gateway.on('raw', this.listener)
        this.gateway.on('disconnected', this.disconnectListener)
        this.timeout = setTimeout(() => this.stop('Stream negotiation timed out'), this.timeoutMs)
        try {
            this.connection = this.createConnection(() => queueMicrotask(() => {
                if (this.state !== 'starting') return
                this.state = 'ready'
                clearTimeout(this.timeout)
                this.resolve(this.connection)
            }), reason => this.stop(reason))
            this.requested = true
            this.send(18, { type: 'guild', guild_id: this.guildId, channel_id: this.channelId, preferred_region: null })
        } catch {
            this.stop('Unable to request the Discord stream')
        }
        return this.ready
    }

    handlePacket(packet) {
        if (!packet || !packet.d || !['starting', 'ready'].includes(this.state)) return
        const data = packet.d
        if (packet.t === 'VOICE_STATE_UPDATE' && data.user_id === this.userId &&
            (data.channel_id !== this.channelId || data.session_id !== this.voiceSessionId)) {
            this.stop('The existing voice session changed')
            return
        }
        if (data.stream_key !== this.key) return
        try {
            if (packet.t === 'STREAM_CREATE' && this.state === 'starting') {
                if (typeof data.rtc_server_id !== 'string' || !/^\d{17,20}$/.test(data.rtc_server_id)) throw new Error('Invalid stream server')
                if (this.created) return
                this.created = true
                this.connection.serverId = data.rtc_server_id
                this.connection.streamKey = this.key
                this.connection.setSession(this.voiceSessionId)
                // Creation is asynchronous; never control a stream before its creation acknowledgement.
                this.send(22, { stream_key: this.key, paused: false })
                if (this.server) this.applyServer()
            } else if (packet.t === 'STREAM_SERVER_UPDATE') {
                if (typeof data.endpoint !== 'string' || !/^[a-z0-9.-]+\.(discord\.media|discord\.gg)(:\d{1,5})?$/i.test(data.endpoint)) throw new Error('Invalid Discord media endpoint')
                if (typeof data.token !== 'string' || !data.token || data.token.length > 16384) throw new Error('Invalid media credentials')
                this.server = { endpoint: data.endpoint, token: data.token }
                this.serverReceived = true
                if (this.created) this.applyServer()
            } else if (packet.t === 'STREAM_DELETE') {
                this.deleteReason = ['user_requested', 'stream_full', 'unauthorized', 'safety_guild_rate_limited'].includes(data.reason) ? data.reason : 'unspecified'
                this.requested = false
                this.stop(`Discord ended the stream (${this.deleteReason}; ${this.created ? 'stream created' : 'before stream creation'}; ${this.connection?.phase || 'awaiting media'})`)
            }
        } catch {
            this.stop('Discord returned an invalid stream response')
        }
    }

    applyServer() {
        this.connection.setTokens(this.server.endpoint, this.server.token)
        this.server = null
    }

    diagnostics() {
        if (this.finalDiagnostic) return this.finalDiagnostic
        return { streamCreated: !!this.created, mediaServerReceived: this.serverReceived, deleteReason: this.deleteReason,
            media: this.connection?.diagnostics?.() || null }
    }

    stop(reason = 'Output stopped') {
        if (this.state === 'stopped') return
        const wasStarting = this.state === 'starting'
        this.finalDiagnostic = this.diagnostics()
        this.state = 'stopped'
        clearTimeout(this.timeout)
        this.gateway.removeListener('raw', this.listener)
        this.gateway.removeListener('disconnected', this.disconnectListener)
        this.server = null
        try { this.connection?.stop() } catch { /* Still release the gateway stream if local transport cleanup fails. */ }
        if (this.requested) {
            this.requested = false
            try { this.send(19, { stream_key: this.key }) } catch { /* No gateway delivery is possible after disconnection. */ }
        }
        if (wasStarting) this.reject(new Error(reason))
        this.emit('stopped', reason)
    }
}



