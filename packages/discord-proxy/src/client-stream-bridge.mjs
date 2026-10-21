// Own only the requested stream; keep voice and unrelated dispatcher actions on their original path.
export function installClientStreamBridge({ dispatcher, gateway, rest = null, readVoice, readActiveStreamKey, onPacket, onStopped = () => {} }) {
    const isId = value => typeof value === 'string' && /^\d{17,20}$/.test(value)
    if (typeof dispatcher?.dispatch !== 'function' || !['streamCreate', 'streamDelete', 'streamSetPaused'].every(key => typeof gateway?.[key] === 'function')) throw new Error('Required client interfaces are unavailable')
    if (![readVoice, readActiveStreamKey, onPacket, onStopped].every(value => typeof value === 'function')) throw new Error('Invalid bridge callbacks')
    const original = dispatcher.dispatch, descriptor = Object.getOwnPropertyDescriptor(dispatcher, 'dispatch')
    let active = null, disposed = false
    const previews = { sent: 0, ok: 0, failed: 0, lastStatus: null }
    const stop = (reason = 'Bridge stopped', deleteStream = true) => {
        const owned = active
        active = null
        if (!owned) return
        if (deleteStream) { try { gateway.streamDelete(owned.key) } catch { /* Still release the local adapter. */ } }
        onStopped(reason)
    }
    function intercept(action, ...rest) {
        const owned = active
        if (!owned || !action || typeof action !== 'object') return original.call(this, action, ...rest)
        if (action.streamKey === owned.key && ['STREAM_CREATE', 'STREAM_SERVER_UPDATE', 'STREAM_DELETE'].includes(action.type)) {
            try {
                if (action.type === 'STREAM_CREATE') {
                    if (!isId(action.rtcServerId)) throw new Error('Invalid server')
                    onPacket({ t: 'STREAM_CREATE', d: { stream_key: owned.key, rtc_server_id: action.rtcServerId } })
                } else if (action.type === 'STREAM_SERVER_UPDATE') {
                    if (typeof action.endpoint !== 'string' || !/^[a-z0-9.-]+\.(discord\.media|discord\.gg)(:\d{1,5})?$/i.test(action.endpoint) || typeof action.token !== 'string' || !action.token || action.token.length > 16384) throw new Error('Invalid media credentials')
                    onPacket({ t: 'STREAM_SERVER_UPDATE', d: { stream_key: owned.key, endpoint: action.endpoint, token: action.token } })
                } else {
                    const reason = ['user_requested', 'stream_full', 'unauthorized', 'safety_guild_rate_limited'].includes(action.reason) ? action.reason : 'unspecified'
                    onPacket({ t: 'STREAM_DELETE', d: { stream_key: owned.key, reason } })
                    stop('Discord ended the bridged stream', false)
                }
            } catch { stop('Client bridge could not forward a stream event') }
            // Prevent a competing native stream connection; all voice and unrelated actions still dispatch.
            // The gateway calls dispatch(...).catch(...); preserve its Promise contract for consumed events.
            return Promise.resolve()
        }
        if (action.type === 'VOICE_STATE_UPDATES' && Array.isArray(action.voiceStates)) {
            for (const state of action.voiceStates) {
                if (state.userId === owned.userId && (state.channelId !== owned.channelId || state.sessionId !== owned.voiceSessionId)) {
                    stop('The desktop voice session changed')
                    break
                }
            }
        }
        return original.call(this, action, ...rest)
    }
    dispatcher.dispatch = intercept
    return {
        start({ guildId, channelId }) {
            if (disposed || active) throw new Error('Bridge is unavailable or already owns a stream')
            const voice = readVoice()
            if (!voice || ![voice.userId, voice.guildId, voice.channelId].every(isId) || voice.guildId !== guildId || voice.channelId !== channelId || typeof voice.voiceSessionId !== 'string' || !voice.voiceSessionId || voice.voiceSessionId.length > 256) throw new Error('An existing matching desktop voice session is required')
            if (readActiveStreamKey() !== null) throw new Error('Existing stream ownership must be known and empty')
            const key = `guild:${guildId}:${channelId}:${voice.userId}`
            active = { userId: voice.userId, guildId, channelId, voiceSessionId: voice.voiceSessionId, key }
            try { gateway.streamCreate('guild', guildId, channelId, null) }
            catch { stop('Client stream request failed'); throw new Error('Client stream request failed') }
            return { ...voice, existingStreamKey: null }
        },
        control(op, data) {
            if (disposed || !active || ![19, 22].includes(op) || data?.stream_key !== active.key) throw new Error('Only owned stream controls are allowed')
            if (op === 19) stop('Output stopped')
            else {
                if (typeof data.paused !== 'boolean') throw new Error('Invalid pause state')
                gateway.streamSetPaused(active.key, data.paused)
            }
        },
        // Mirrors Canary's preview manager: show it locally, then POST /streams/{key}/preview. Owned stream only;
        // Canary's REST client supplies authentication itself, so no account credential is read here.
        preview(image) {
            if (disposed || !active) throw new Error('Only the owned stream can have a preview')
            if (typeof image !== 'string' || !image.startsWith('data:image/jpeg;base64,') || image.length > 400000) throw new Error('Invalid preview image')
            dispatcher.dispatch({ type: 'STREAM_PREVIEW_FETCH_SUCCESS', streamKey: active.key, previewURL: image })
            if (!rest) return false
            previews.sent++
            Promise.resolve(rest.post({ url: `/streams/${active.key}/preview`, body: { thumbnail: image }, oldFormErrors: true, rejectWithError: false }))
                .then(response => { const status = Number(response?.status) || 0; previews.lastStatus = status; if (status >= 200 && status < 300) previews.ok++; else previews.failed++ })
                .catch(() => { previews.failed++; previews.lastStatus = -1 })
            return true
        },
        status() { return { installed: !disposed, ownsStream: !!active, previews: { ...previews, available: !!rest } } },
        dispose() {
            if (disposed) return
            disposed = true
            try { stop() } finally {
                if (dispatcher.dispatch === intercept) {
                    if (descriptor) Object.defineProperty(dispatcher, 'dispatch', descriptor)
                    else delete dispatcher.dispatch
                }
            }
        },
    }
}
