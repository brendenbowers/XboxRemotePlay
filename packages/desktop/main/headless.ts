import { ipcMain, BrowserWindow } from 'electron'
import type Application from './application'
import { sanitizeNativeInput } from '../shared/console-input'

// Renderer gamepad state → { buttons: uint16 mask, axes: 4 × [-1, 1], triggers: 2 × [0, 1] }, or null for disconnected.
function sanitizeGamepad(state: any) {
    if (state === null) return null
    const finite = (value: any, min: number, max: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : 0
    if (!state || !Number.isInteger(state.buttons) || !Array.isArray(state.axes) || !Array.isArray(state.triggers)) return undefined
    return { buttons: state.buttons & 0xffff, axes: [0, 1, 2, 3].map(index => finite(state.axes[index], -1, 1)), triggers: [0, 1].map(index => finite(state.triggers[index], 0, 1)) }
}

// Exponential backoff with jitter: 2 s, 4 s, 8 s … capped at 60 s (same schedule as the Discord publisher).
const backoffMs = (attempt: number) => Math.min(60000, 2000 * 2 ** (attempt - 1)) * (1 + Math.random() * 0.2)
const STALL_MS = 10000

type Session = {
    id: string; target: string; resolution: number; stage: string
    keepalive?: ReturnType<typeof setInterval>; monitor?: ReturnType<typeof setInterval>; healthy?: ReturnType<typeof setTimeout>
    retry: number; lastPackets: number; lastProgress: number
}

// Headless Xbox session: the main process keeps the authenticated signalling and the
// publisher utility owns the WebRTC receiver, so no stream page or Chromium decoder is involved.
export function registerHeadless(application: Application, request: (action: string, data?: any) => Promise<any>, getWindow: () => BrowserWindow,
    notify: (action: string, data: any) => void = () => {}) {
    let session: Session | null = null
    let lastError = ''
    const manager = () => application._ipc._channels.streaming._streamManager
    const settings = () => application._store.get('settings', {}) as { discord_bitrate?: number; discord_bitrate_override?: boolean; reconnect_attempts?: number }
    const reconnectAttempts = () => { const value = settings().reconnect_attempts; return Number.isInteger(value) && value >= -1 ? value : 5 }

    const waitForStarted = async (sessionId: string) => {
        const deadline = Date.now() + 120000
        while (Date.now() < deadline) {
            const state = manager().getSession(sessionId)?.playerState
            if (state === 'started') return
            if (state === 'failed') throw new Error('The console could not start a Remote Play session')
            await new Promise(resolve => setTimeout(resolve, 1000))
        }
        throw new Error('The console did not become ready in time')
    }

    // Tears down only the console side; the Discord share keeps running unless stop() asks for it.
    const releaseConsole = async (current: Session) => {
        getWindow()?.webContents.send('console-input-reset')
        clearInterval(current.keepalive); clearInterval(current.monitor); clearTimeout(current.healthy)
        await request('xbox-stop').catch(() => {})
        if (current.id) await manager().stopStream(current.id).catch(() => {})
        current.id = ''
    }

    const stop = async () => {
        const current = session
        session = null
        if (!current) return
        await request('stop').catch(() => {})
        await releaseConsole(current)
    }

    const connectConsole = async (current: Session) => {
        getWindow()?.webContents.send('console-input-reset')
        current.stage = 'starting console session'
        current.id = await manager().startStream('home', current.target, current.resolution) as string
        current.stage = 'waiting for console'
        await waitForStarted(current.id)
        current.stage = 'negotiating'
        // No b=AS ceiling: the Xbox rate is steered by REMB, starting at the Discord profile bitrate.
        const offer = await request('xbox-offer', { resolution: current.resolution })
        const answer: any = await manager().sendSdp(current.id, offer.sdp)
        if (typeof answer?.sdp !== 'string') throw new Error('The console did not return an SDP answer')
        await request('xbox-answer', { sdp: answer.sdp })
        const remote = await manager().sendIce(current.id, offer.candidates)
        await request('xbox-ice', { candidates: remote })
        current.keepalive = setInterval(() => { manager().sendKeepalive(current.id).catch(() => {}) }, 30000)
        await request('xbox-bitrate', { kbps: settings().discord_bitrate ?? 4096, override: settings().discord_bitrate_override === true }).catch(() => {})
        current.stage = 'connected'
        current.lastPackets = 0; current.lastProgress = Date.now()
        current.monitor = setInterval(() => watch(current), 2000)
        // A minute connected restores the full retry budget.
        current.healthy = setTimeout(() => { current.retry = 0 }, 60000)
    }

    // The console drops idle or broken sessions; notice it from the peer state or from video no longer arriving.
    const watch = async (current: Session) => {
        if (session !== current || current.stage !== 'connected') return
        const receiver = await request('xbox-status').catch(() => null)
        if (session !== current || current.stage !== 'connected') return
        const packets = receiver?.video?.packets ?? 0
        if (packets > current.lastPackets) { current.lastPackets = packets; current.lastProgress = Date.now() }
        const peer = receiver?.peer
        if (!receiver || ['disconnected', 'failed', 'closed'].includes(peer)) reconnectConsole(current, `Console connection ${peer || 'lost'}`)
        else if (Date.now() - current.lastProgress > STALL_MS) reconnectConsole(current, 'Console stopped sending video')
    }

    const reconnectConsole = async (current: Session, reason: string) => {
        if (session !== current || current.stage === 'reconnecting') return
        current.stage = 'reconnecting'
        await releaseConsole(current)
        const attempts = reconnectAttempts()
        while (session === current) {
            if (attempts !== -1 && current.retry >= attempts) {
                lastError = attempts ? `${reason}; reconnect gave up after ${current.retry} attempts` : reason
                await stop()
                return
            }
            current.retry++
            const delay = backoffMs(current.retry)
            lastError = `${reason}. Reconnecting in ${Math.round(delay / 1000)} s (attempt ${current.retry}${attempts === -1 ? '' : ` of ${attempts}`})`
            current.stage = 'reconnecting'
            await new Promise(resolve => setTimeout(resolve, delay))
            if (session !== current) return
            try {
                await connectConsole(current)
                lastError = ''
                return
            } catch (error) {
                reason = error instanceof Error ? error.message : 'Console reconnect failed'
                await releaseConsole(current)
            }
        }
    }

    // The publisher needs the announced size; headless has no <video>, so use the requested stream size.
    const share = async () => {
        if (session?.stage !== 'connected') throw new Error('Start the headless console session first')
        const publisher = await request('status')
        if (publisher.state !== 'idle') return publisher
        if (publisher.account !== 'connected') await request('connect-canary')
        const [width, height] = ({ 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] })[session.resolution]
        return request('start', { width, height, fps: 60, reconnectAttempts: reconnectAttempts() })
    }

    const start = async (target: string, resolution: number, withShare: boolean) => {
        if (session) throw new Error('A headless session is already running')
        lastError = ''
        const current: Session = session = { id: '', target, resolution, stage: 'starting console session', retry: 0, lastPackets: 0, lastProgress: Date.now() }
        try { await connectConsole(current) }
        catch (error) {
            lastError = error instanceof Error ? error.message : 'Headless session failed'
            if (session === current) await stop()
            throw new Error(lastError)
        }
        // A share failure (no voice channel, Canary closed) keeps the console session for a retry.
        if (withShare) await share().catch(error => { lastError = error instanceof Error ? error.message.replace(/^Error: /, '') : 'Discord share failed' })
        return status()
    }

    const status = async () => {
        const publisher = await request('status').catch(() => null)
        return {
            active: !!session, stage: session?.stage || 'idle', resolution: session?.resolution || null, error: lastError,
            receiver: session?.stage === 'connected' ? await request('xbox-status').catch(() => null) : null,
            share: publisher && { account: publisher.account, state: publisher.state, reason: publisher.reason, stats: publisher.stats,
                encryptionReady: !!publisher.diagnostic?.media?.encryptionReady, feedback: publisher.diagnostic?.media?.feedback || null,
                video: publisher.diagnostic?.media?.video || null, previews: publisher.previews || null },
        }
    }

    ipcMain.on('headless-input', (event, state) => {
        if (event.sender !== getWindow()?.webContents || event.senderFrame !== event.sender.mainFrame || session?.stage !== 'connected') return
        const gamepad = sanitizeGamepad(state)
        if (gamepad !== undefined) notify('xbox-gamepad', gamepad)
    })

    let nativeWindowStart = 0, nativeMessages = 0
    ipcMain.on('headless-native-input', (event, data) => {
        if (event.sender !== getWindow()?.webContents || event.senderFrame !== event.sender.mainFrame || session?.stage !== 'connected') return
        if (Date.now() - nativeWindowStart >= 1000) { nativeWindowStart = Date.now(); nativeMessages = 0 }
        if (++nativeMessages > 150) return
        const batch = sanitizeNativeInput(data)
        if (batch) notify('xbox-native-input', batch)
    })

    ipcMain.handle('headless', async (event, action, data) => {
        if (event.sender !== getWindow()?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid headless caller')
        if (action === 'start') {
            if (typeof data?.target !== 'string' || !/^[A-Za-z0-9]{8,32}$/.test(data.target)) throw new Error('Invalid console id')
            return start(data.target, [720, 1080, 1440, 2160].includes(data?.resolution) ? data.resolution : 1080, data?.share === true)
        }
        if (action === 'share') {
            lastError = ''
            await share().catch(error => { lastError = error instanceof Error ? error.message.replace(/^Error: /, '') : 'Discord share failed' })
            return status()
        }
        if (action === 'unshare') { await request('stop').catch(() => {}); return status() }
        if (action === 'stop') { await stop(); return status() }
        if (action === 'status') return status()
        if (action === 'active') return session?.stage === 'connected'
        if (action === 'keyframe-data') return session?.stage === 'connected' ? request('xbox-keyframe-data') : null
        if (action === 'keyframe') return request('xbox-keyframe')
        if (action === 'bitrate') {
            const applied = await request('xbox-bitrate', { kbps: data?.kbps, override: data?.override === true })
            if (!applied) throw new Error('Could not apply the Xbox bitrate; check the rate and console connection')
            return status()
        }
        if (action === 'resolution') return request('xbox-resolution', { height: data?.height })
        throw new Error('Unknown headless action')
    })
}
