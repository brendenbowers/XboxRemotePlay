// Exact selectors are pinned to the inspected Canary build; refuse changed exports rather than loading modules.
export function resolveClientContext(root = globalThis) {
    const value = (o, k) => o && Object.getOwnPropertyDescriptor(o, k)?.value
    const loaders = [], chunks = value(root, 'webpackChunkdiscord_app')
    if (!Array.isArray(chunks)) throw new Error('Canary module runtime is unavailable')
    const marker = [['console_stream_context_' + Date.now()], {}, loader => { if (!loaders.includes(loader) && loaders.length < 8) loaders.push(loader) }]
    try { chunks.push(marker) } finally { if (chunks[chunks.length - 1] === marker) chunks.pop() }
    const matches = loaders.filter(loader => {
        const factory = value(value(loader, 'm'), '276602')
        return typeof factory === 'function' && Function.prototype.toString.call(factory).includes('GatewayConnectionStore')
    })
    if (matches.length !== 1) throw new Error('Canary app runtime is ambiguous or unavailable')
    const cache = value(matches[0], 'c')
    const resolve = (id, name, expectedSource) => {
        const exported = value(value(cache, id), 'exports')
        const getter = exported && Object.getOwnPropertyDescriptor(exported, name)?.get
        if (typeof getter !== 'function' || Function.prototype.toString.call(getter) !== expectedSource) throw new Error('Reviewed Canary export changed')
        return getter.call(exported)
    }
    const store = resolve('276602', 'A', '()=>te'), dispatcher = resolve('73153', 'h', '()=>d')
    const users = resolve('280450', 'default', '()=>ec'), voices = resolve('977997', 'A', '()=>D')
    const channels = resolve('734057', 'A', '()=>eo'), streams = resolve('116956', 'A', '()=>es')
    if (typeof store.getSocket !== 'function' || Function.prototype.toString.call(store.getSocket) !== 'getSocket(){return B}') throw new Error('Reviewed Canary socket accessor changed')
    const gateway = store.getSocket()
    // REST client used by Canary's own ApplicationStreamPreviewUploadManager (module 722278 imports it as k).
    // Optional: a changed export disables previews without blocking the stream itself.
    let rest = null
    try {
        const candidate = resolve('636537', 'Bo', '()=>L')
        if (typeof candidate?.post === 'function') rest = candidate
    } catch { /* Previews unavailable on this build. */ }
    const isId = id => typeof id === 'string' && /^\d{17,20}$/.test(id)
    const readVoice = () => {
        const userId = users.getId(), voiceSessionId = users.getSessionId()
        if (!isId(userId) || typeof voiceSessionId !== 'string' || !voiceSessionId || voiceSessionId.length > 256) return null
        const voice = voices.getVoiceStateForSession(userId, voiceSessionId)
        const channelId = voice?.channelId, guildId = channels.getChannel(channelId)?.guild_id
        if (!isId(channelId) || !isId(guildId) || voice.sessionId !== voiceSessionId) return null
        return { userId, voiceSessionId, channelId, guildId }
    }
    const readActiveStreamKey = () => {
        const voice = readVoice()
        if (!voice) return undefined
        const key = `guild:${voice.guildId}:${voice.channelId}:${voice.userId}`
        const state = voices.getVoiceStateForSession(voice.userId, voice.voiceSessionId)
        if (state?.selfStream !== false || streams.getAllActiveStreamKeys().includes(key)) return key
        return null
    }
    return { dispatcher, gateway, rest, readVoice, readActiveStreamKey }
}
