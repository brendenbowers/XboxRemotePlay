import dave from '@snazzah/davey'

const MAX_BINARY = 1024 * 1024

// Handles only the stream media session's DAVE events; never touches the user's voice session.
export class PublisherDaveSession {
    constructor({ userId, channelId, sendJson, sendBinary, onFailure = () => {}, sessionFactory = (version, user, channel) => new dave.DAVESession(version, user, channel) }) {
        for (const id of [userId, channelId]) if (typeof id !== 'string' || !/^\d{17,20}$/.test(id)) throw new Error('Invalid DAVE participant or channel')
        Object.assign(this, { userId, channelId, sendJson, sendBinary, onFailure, sessionFactory })
        this.users = new Set([userId])
        this.pending = new Map()
        this.version = 0
        this.suspended = true
        this.closed = false
        this.failed = false
        this.session = null
        this.events = []
        this.externalSenderSet = false
    }

    initialize(version) {
        if (this.closed) throw new Error('DAVE publisher is closed')
        if (!Number.isInteger(version) || version < 1 || version > dave.DAVE_PROTOCOL_VERSION) throw new Error('A supported DAVE protocol is required')
        this.suspended = true
        this.failed = false
        this.version = version
        this.pending.clear()
        if (this.session) this.session.reinit(version, this.userId, this.channelId)
        else this.session = this.sessionFactory(version, this.userId, this.channelId)
        this.sendBinary(26, this.session.getSerializedKeyPackage())
    }

    get ready() { return !this.closed && !this.failed && !this.suspended && this.version > 0 && this.session?.ready === true }

    handleJson(op, data) {
        if (this.closed) return
        if (![11, 13, 21, 22, 24].includes(op)) return
        this.events.push(op); if (this.events.length > 32) this.events.shift()
        try {
            if (!data || typeof data !== 'object') throw new Error('Invalid DAVE event')
            if (op === 11) {
                if (!Array.isArray(data.user_ids) || data.user_ids.length > 1000 || data.user_ids.some(id => typeof id !== 'string' || !/^\d{17,20}$/.test(id))) throw new Error('Invalid participant list')
                if (new Set([...this.users, ...data.user_ids]).size > 1000) throw new Error('Too many participants')
                for (const id of data.user_ids) this.users.add(id)
            } else if (op === 13) {
                if (data.user_id !== this.userId) this.users.delete(data.user_id)
            } else if (op === 21) {
                const { transition_id: id, protocol_version: version } = data
                if (!Number.isInteger(id) || id < 0 || id > 65535 || !Number.isInteger(version) || version < 0 || version > dave.DAVE_PROTOCOL_VERSION) throw new Error('Invalid DAVE transition')
                if (this.pending.has(id) && this.pending.get(id) !== version) throw new Error('Conflicting DAVE transition')
                if (this.pending.size >= 32 && !this.pending.has(id)) throw new Error('Too many DAVE transitions')
                this.suspended = true
                this.pending.set(id, version)
                if (id === 0) this.execute(id)
                else this.sendJson(23, { transition_id: id })
            } else if (op === 22) {
                this.execute(data.transition_id)
            } else if (op === 24) {
                if (data.epoch === 1) this.initialize(data.protocol_version)
            }
        } catch { this.fail('Invalid encryption-session event') }
    }

    execute(id) {
        if (this.failed) throw new Error('DAVE requires reinitialization')
        if (!Number.isInteger(id) || !this.pending.has(id)) throw new Error('Unexpected DAVE transition')
        this.version = this.pending.get(id)
        this.pending.delete(id)
        // Transport-only downgrades may be acknowledged, but our publisher never sends clear media.
        this.suspended = this.version === 0 || this.pending.size > 0
        if (this.version === 0) this.onFailure('Discord disabled end-to-end encryption; publication is suspended')
    }

    handleBinary(message) {
        if (this.closed) return
        if (this.failed) return
        let transitionId
        try {
            if (!Buffer.isBuffer(message) || message.length < 3 || message.length > MAX_BINARY) throw new Error('Invalid DAVE message size')
            const op = message[2]
            if (![25, 27, 29, 30].includes(op)) return
            this.events.push(op); if (this.events.length > 32) this.events.shift()
            if (!this.session) throw new Error('DAVE session is not initialized')
            const body = message.subarray(3)
            if (op === 25) {
                if (!body.length) throw new Error('Empty external sender')
                this.session.setExternalSender(body)
                this.externalSenderSet = true
            } else if (op === 27) {
                if (body.length < 2 || body[0] > 1) throw new Error('Invalid proposal operation')
                this.suspended = true
                const { commit, welcome } = this.session.processProposals(body[0], body.subarray(1), [...this.users])
                if (commit) {
                    if (!Buffer.isBuffer(commit) || (welcome && !Buffer.isBuffer(welcome))) throw new Error('Invalid DAVE commit')
                    const outgoing = welcome ? Buffer.concat([commit, welcome]) : commit
                    if (outgoing.length > MAX_BINARY) throw new Error('Oversized DAVE commit')
                    this.sendBinary(28, outgoing)
                }
            } else {
                if (body.length < 3) throw new Error('Invalid commit or welcome')
                transitionId = body.readUInt16BE(0)
                if (this.pending.size >= 32 && !this.pending.has(transitionId)) throw new Error('Too many DAVE transitions')
                this.suspended = true
                if (op === 29) this.session.processCommit(body.subarray(2))
                else this.session.processWelcome(body.subarray(2))
                this.pending.set(transitionId, this.version)
                if (transitionId === 0) this.execute(0)
                else this.sendJson(23, { transition_id: transitionId })
            }
        } catch {
            if (transitionId !== undefined) {
                try { this.sendJson(31, { transition_id: transitionId }) } catch { /* Still suspend publishing on a dead gateway. */ }
            }
            this.fail('Encryption key exchange failed; publication is suspended')
        }
    }

    fail(message) {
        this.failed = this.suspended = true
        this.onFailure(message)
    }

    diagnostics() {
        return { version: this.version, ready: this.ready, failed: this.failed, suspended: this.suspended,
            groupReady: this.session?.ready === true, externalSenderSet: this.externalSenderSet,
            pendingTransitions: this.pending.size, participantCount: this.users.size, events: [...this.events],
            audio: this.session?.getEncryptionStats?.(dave.MediaType.AUDIO) || null,
            video: this.session?.getEncryptionStats?.(dave.MediaType.VIDEO) || null }
    }

    encryptOpus(data) {
        if (!this.ready) throw new Error('DAVE is not ready')
        return this.session.encryptOpus(data)
    }

    encrypt(mediaType, codec, data) {
        if (!this.ready) throw new Error('DAVE is not ready')
        return this.session.encrypt(mediaType, codec, data)
    }

    close() {
        if (this.closed) return
        this.closed = this.suspended = true
        this.pending.clear(); this.users.clear()
        this.session?.reset(); this.session = null
    }
}
