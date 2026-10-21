import { EventEmitter } from 'node:events'

const isId = value => typeof value === 'string' && /^\d{17,20}$/.test(value)

// Account credentials and gateway payloads stay in this process; callers receive only a small status.
export class ExperimentalAccountConnector extends EventEmitter {
    constructor({ createClient = async () => {
        const { Client, Options } = await import('@lng2004/discord.js-selfbot-v13')
        const client = new Client({ presence: {}, DMChannelVoiceStatusSync: 0,
            makeCache: Options.cacheWithLimits({ MessageManager: 0, PresenceManager: 0 }) })
        // The constructor needs an object, but login must not publish a new account presence.
        client.options.presence = undefined
        return client
    }, timeoutMs = 30000 } = {}) {
        super()
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Invalid login timeout')
        Object.assign(this, { createClient, timeoutMs })
        this.state = 'disconnected'
        this.voice = null
        this.userId = null
        this.client = null
    }

    status() {
        return { state: this.state, userId: this.userId, voice: this.voice ? { ...this.voice } : null }
    }

    async connect(token) {
        if (this.state !== 'disconnected') throw new Error('Discord connector is already connected or connecting')
        if (typeof token !== 'string' || token.length < 20 || token.length > 4096 || /\s/.test(token)) throw new Error('Enter a valid Discord credential locally')
        this.state = 'connecting'
        const attempt = this.attempt = {}
        let timer
        try {
            const client = await this.createClient()
            if (this.attempt !== attempt) { client.destroy(); throw new Error('Cancelled') }
            this.client = client
            this.rawListener = packet => this.onPacket(packet)
            client.on('raw', this.rawListener)
            // The dependency's debug events include credentials. Never forward debug/error payloads.
            this.failureListener = () => this.disconnect('Discord gateway disconnected')
            client.on('error', this.failureListener)
            client.on('invalidated', this.failureListener)
            client.on('shardDisconnect', this.failureListener)
            const failed = new Promise((_, reject) => {
                this.rejectLogin = reject
                timer = setTimeout(() => reject(new Error('Timeout')), this.timeoutMs)
            })
            await Promise.race([client.login(token).then(() => undefined), failed])
            if (this.attempt !== attempt || !isId(client.user?.id)) throw new Error('Login did not establish an account')
            this.userId = client.user.id
            this.state = 'connected'
            this.emit('status', this.status())
            return this.status()
        } catch {
            if (this.attempt === attempt) this.disconnect()
            throw new Error('Discord connection failed or was cancelled; check the local credential and try again')
        } finally {
            token = undefined
            clearTimeout(timer)
            if (this.attempt === attempt) this.rejectLogin = null
        }
    }

    onPacket(packet) {
        if (!packet?.d || !this.client) return
        const data = packet.d
        if (packet.t === 'READY') {
            if (!isId(data.user?.id)) return
            this.userId = data.user.id
            this.voice = null
            for (const guild of Array.isArray(data.guilds) ? data.guilds : []) {
                if (!isId(guild.id)) continue
                for (const voice of Array.isArray(guild.voice_states) ? guild.voice_states : []) {
                    if (voice.user_id === this.userId) this.observeVoice({ ...voice, guild_id: guild.id })
                }
            }
        } else if (packet.t === 'VOICE_STATE_UPDATE' && data.user_id === this.userId) {
            this.observeVoice(data)
        }
        // Stream controllers receive only the few events they use, never READY/messages/account data.
        if (['VOICE_STATE_UPDATE', 'STREAM_CREATE', 'STREAM_SERVER_UPDATE', 'STREAM_DELETE'].includes(packet.t)) this.emit('raw', packet)
    }

    observeVoice(data) {
        if (data.channel_id === null) this.voice = null
        else if (isId(data.guild_id) && isId(data.channel_id) && typeof data.session_id === 'string' && data.session_id.length > 0 && data.session_id.length <= 256) {
            // Discord omits self_stream when false; self_video distinguishes a full state from a partial update.
            const stream = data.self_stream ?? (typeof data.self_video === 'boolean' ? false : undefined)
            this.voice = { guildId: data.guild_id, channelId: data.channel_id, voiceSessionId: data.session_id,
                existingStreamKey: stream === false ? null : stream === true ? `guild:${data.guild_id}:${data.channel_id}:${this.userId}` : undefined }
        } else this.voice = null
        this.emit('status', this.status())
    }

    existingVoice() {
        if (this.state !== 'connected' || !this.voice) throw new Error('Join a server voice channel in Discord first; wait for its voice state to be detected')
        if (this.voice.existingStreamKey !== null) throw new Error('Stop any existing Discord stream and wait for confirmation before publishing')
        return { userId: this.userId, ...this.voice }
    }

    sendStream(op, data) {
        if (this.state !== 'connected' || ![18, 19, 22].includes(op)) throw new Error('Only stream controls are allowed')
        const voice = this.voice
        if (!voice) throw new Error('The existing Discord voice session ended')
        const key = `guild:${voice.guildId}:${voice.channelId}:${this.userId}`
        if (op === 18) {
            if (data?.type !== 'guild' || data.guild_id !== voice.guildId || data.channel_id !== voice.channelId || data.preferred_region !== null) throw new Error('Stream destination does not match the existing voice session')
            this.client.ws.broadcast({ op, d: { type: 'guild', guild_id: voice.guildId, channel_id: voice.channelId, preferred_region: null } })
        } else {
            if (data?.stream_key !== key || (op === 22 && typeof data.paused !== 'boolean')) throw new Error('Invalid owned stream control')
            this.client.ws.broadcast({ op, d: op === 19 ? { stream_key: key } : { stream_key: key, paused: data.paused } })
        }
    }

    disconnect(reason = 'Disconnected') {
        const client = this.client
        this.attempt = null
        this.rejectLogin?.(new Error('Cancelled')); this.rejectLogin = null
        this.client = null
        this.voice = null
        this.userId = null
        this.state = 'disconnected'
        if (client) {
            client.removeListener('raw', this.rawListener)
            client.removeListener('error', this.failureListener)
            client.removeListener('invalidated', this.failureListener)
            client.removeListener('shardDisconnect', this.failureListener)
            // destroy closes only this gateway socket; logout would invalidate a real account session.
            client.destroy()
        }
        this.emit('disconnected', reason)
        this.emit('status', this.status())
    }
}
