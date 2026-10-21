import React from 'react'
import { tapEncodedReceiver } from '../../../../discord-proxy/src/encoded-tap.mjs'

// Survives the panel remount caused by restarting the console stream for the Discord profile.
const AUTOSTART_KEY = 'console-stream-discord-autostart'
const AUTOSTART_WINDOW_MS = 3 * 60 * 1000

function pendingAutostart() {
    try { return Date.now() - Number(sessionStorage.getItem(AUTOSTART_KEY) || 0) < AUTOSTART_WINDOW_MS } catch { return false }
}
function setAutostart(pending: boolean) {
    try { if (pending) sessionStorage.setItem(AUTOSTART_KEY, String(Date.now())); else sessionStorage.removeItem(AUTOSTART_KEY) } catch { /* Manual start still works. */ }
}

export default function DiscordOutput({ player, profile = undefined }: { player: any; profile?: { active: boolean; restart?: () => void } }) {
    const [open, setOpen] = React.useState(false)
    const [token, setToken] = React.useState('')
    const [status, setStatus] = React.useState<any>({ account: 'disconnected', state: 'idle' })
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    const publishing = React.useRef(false)
    const taps = React.useRef(new Map<RTCRtpReceiver, any>())
    const keyframe = () => {
        try { player.getChannelProcessor('control')?.requestKeyframeRequest() } catch { /* Retry after the Xbox control channel opens. */ }
    }
    const subscribe = (receiver: RTCRtpReceiver) => tapEncodedReceiver(receiver, {
        onFrame: frame => window.Greenlight.discord('frame', { kind: frame.kind, data: frame.data, rtpTimestamp: frame.metadata.rtpTimestamp }),
        onKeyframeNeeded: keyframe,
        onError: () => { setError('Encoded media export failed. Stop Discord output and retry.'); window.Greenlight.discord('stop').catch(() => {}) },
    })
    React.useEffect(() => {
        if (!window.Greenlight?.discord) return
        let peer: RTCPeerConnection
        let mounted = true
        const update = data => {
            if (!mounted) return
            setStatus(data)
            const active = data.state === 'publishing'
            if (active === publishing.current) return
            publishing.current = active
            for (const [receiver, tap] of taps.current) {
                tap.close()
                if (active) taps.current.set(receiver, subscribe(receiver))
            }
            if (active) keyframe()
        }
        const attach = (receiver: RTCRtpReceiver) => {
            if (!receiver.track || taps.current.has(receiver) || !['audio', 'video'].includes(receiver.track.kind)) return
            try {
                const tap = subscribe(receiver)
                taps.current.set(receiver, tap)
                if (!publishing.current) tap.close()
            } catch { setError('This receiver cannot export encoded media; Discord output is unavailable.') }
        }
        const onTrack = (event: RTCTrackEvent) => attach(event.receiver)
        const disposeClosed = () => {
            if (peer.connectionState !== 'closed') return
            publishing.current = false
            for (const tap of taps.current.values()) tap.dispose()
            taps.current.clear()
            window.Greenlight.discord('stop').catch(() => {})
        }
        const bind = () => {
            const next = player._webrtcClient as RTCPeerConnection
            if (!next || peer === next) return
            peer = next
            peer.addEventListener('track', onTrack)
            peer.addEventListener('connectionstatechange', disposeClosed)
            peer.getReceivers().forEach(attach)
        }
        // The player's 'new' event fires after bind(), before SDP and the first received frames.
        const onConnection = event => { if (event.state === 'new') bind(); if (event.state === 'closed') disposeClosed() }
        player.getEventBus().on('connectionstate', onConnection)
        bind()
        const remove = window.Greenlight.onDiscord(message => {
            if (message.event === 'status') update(message.data)
            if (message.event === 'keyframe') keyframe()
        })
        window.Greenlight.discord('status').then(update).catch(() => { if (mounted) setError('Discord publisher could not start.') })
        const statsTimer = setInterval(() => {
            if (publishing.current) window.Greenlight.discord('status').then(update).catch(() => {})
        }, 2000)
        return () => {
            mounted = false; publishing.current = false
            clearInterval(statsTimer); remove(); peer?.removeEventListener('track', onTrack)
            peer?.removeEventListener('connectionstatechange', disposeClosed)
            player.getEventBus().off('connectionstate', onConnection)
            const detached = [...taps.current.values()]
            for (const tap of detached) tap.close()
            // Parent cleanup closes the player; terminating a transform earlier would stop local decoding.
            queueMicrotask(() => { if (peer?.connectionState === 'closed') detached.forEach(tap => tap.dispose()) })
            taps.current.clear()
            window.Greenlight.discord('disconnect').catch(() => {})
        }
    }, [player])

    async function command(action, data = {}) {
        setBusy(true); setError('')
        try { setStatus(await window.Greenlight.discord(action, data)); return true }
        catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method 'discord-proxy': Error: /, '') : 'Discord output failed'); return false }
        finally { setBusy(false) }
    }
    // Returns the picture size when the Xbox stream can be published, otherwise the reason it cannot.
    async function readiness(): Promise<{ width: number; height: number } | string> {
        const peer = player._webrtcClient as RTCPeerConnection
        if (!peer) return 'Wait for the Xbox stream before publishing.'
        const found = { audio: false, video: false }
        const reports = await peer.getStats()
        for (const report of reports.values()) {
            if (report.type !== 'inbound-rtp' || !report.codecId) continue
            const codec = reports.get(report.codecId)?.mimeType?.toLowerCase()
            if (report.kind === 'video' && codec === 'video/h264') found.video = true
            if (report.kind === 'audio' && codec === 'audio/opus') found.audio = true
        }
        if (!found.video || !found.audio || taps.current.size < 2) return 'Wait for the Xbox H.264 video and Opus audio stream before publishing.'
        const video = document.querySelector('#streamComponentHolder video') as HTMLVideoElement
        if (!video?.videoWidth || !video.videoHeight) return 'Wait for the Xbox picture before publishing.'
        return { width: video.videoWidth, height: video.videoHeight }
    }
    async function start() {
        if (profile?.restart && !profile.active) {
            setAutostart(true)
            profile.restart()
            return
        }
        const ready = await readiness()
        if (typeof ready === 'string') { setError(ready); return }
        await command('start', { ...ready, fps: 60 })
    }

    const [autostarting, setAutostarting] = React.useState(() => pendingAutostart())
    React.useEffect(() => {
        if (!autostarting) return
        let cancelled = false, running = false, connectTried = false
        const finish = (message = '') => { cancelled = true; setAutostart(false); setAutostarting(false); if (message) setError(message) }
        const timer = setInterval(async () => {
            if (cancelled || running) return
            running = true
            try {
                if (!pendingAutostart()) { finish('The console restarted for Discord, but the share did not start in time. Press Start game share.'); return }
                const current = await window.Greenlight.discord('status')
                if (current.account !== 'connected') {
                    if (connectTried) return
                    connectTried = true
                    if (!await command('connect-canary')) finish()
                    return
                }
                if (current.state !== 'idle') { finish(); return }
                const ready = await readiness()
                if (typeof ready === 'string') return
                finish()
                await command('start', { ...ready, fps: 60 })
            } catch { finish('Discord share could not start after the restart. Press Start game share.') }
            finally { running = false }
        }, 1000)
        return () => { cancelled = true; clearInterval(timer) }
    }, [autostarting, player])
    return <div style={{ position: 'fixed', top: 96, right: 16, zIndex: 110, color: '#fff', background: '#202124', padding: 16, maxWidth: 410, borderRadius: 8, fontSize: 14, lineHeight: 1.5 }}>
        <button className="btn btn-small" type="button" onClick={() => setOpen(!open)} aria-expanded={open}>Discord output {status.state === 'publishing' ? status.diagnostic?.media?.encryptionReady ? '● Live' : '· Waiting for viewer' : status.state === 'reconnecting' ? '· Reconnecting' : ''}</button>
        {open && <div>
            <p>Experimental direct game video and audio. Keep Discord open for voice chat.</p>
            <p role="status">{status.account} · {status.state}{status.channelId ? ` · channel ${status.channelId}` : ''}</p>
            {autostarting && <p>Console stream restarted with the Discord output profile. The share starts once the picture is back.</p>}
            {profile?.restart && !profile.active && status.state === 'idle' && <p>Start game share first restarts the console stream with the Discord output profile (Settings → Streaming).</p>}
            {status.state === 'publishing' && !status.diagnostic?.media?.encryptionReady && <p>Waiting for a viewer to join and complete encryption. Game video and audio will begin once keys are ready.</p>}
            {status.account !== 'connected' ? <div>
                <button className="btn btn-small" disabled={busy} onClick={() => command('connect-canary')}>Connect to Discord Canary</button>
                <p>Uses your open Canary voice session. Start Canary with loopback debugging on port 9223 first (see CONSOLE-STREAM.md).</p>
                <details><summary>Legacy token connector</summary>
                <form onSubmit={event => { event.preventDefault(); const value = token; setToken(''); command('login', { token: value }) }}>
                <label htmlFor="discord-local-credential">Discord credential (kept in memory for this session)</label>
                <input id="discord-local-credential" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} style={{ width: '100%', boxSizing: 'border-box', margin: '8px 0', padding: 8, border: '1px solid #777', borderRadius: 4, color: '#fff', background: '#171717', fontSize: 16 }} />
                <button className="btn btn-small" disabled={busy || !token} type="submit">Connect Discord</button>
                </form></details>
            </div> : <div>
                <button className="btn btn-small" disabled={busy || status.state !== 'idle'} onClick={() => start().catch(() => setError('Unable to inspect the Xbox stream.'))}>Start game share</button>{' '}
                <button className="btn btn-small" disabled={status.state === 'idle'} onClick={() => command('stop')}>Stop share</button>{' '}
                <button className="btn btn-small" disabled={busy} onClick={() => command('disconnect')}>Disconnect account</button>
            </div>}
            {status.stats && <p>Sent video: {status.stats.sentVideo} · audio: {status.stats.sentAudio}</p>}
            {status.diagnostic?.media?.video && <p>Discord video sent: {status.diagnostic.media.video.sent ? `${status.diagnostic.media.video.sent.width}×${status.diagnostic.media.video.sent.height}` : 'waiting for encoded video'} · advertised maximum: {status.diagnostic.media.video.advertised.width}×{status.diagnostic.media.video.advertised.height}. Source passthrough; viewer resolution is not measured.</p>}
            {status.diagnostic?.media?.feedback && <p>Video {status.diagnostic.media.feedback.videoKbps} kbps · Discord bandwidth estimate {status.diagnostic.media.feedback.rembKbps ?? '–'} kbps</p>}
            {(error || status.reason) && <p role="alert">{error || status.reason}</p>}
        </div>}
    </div>
}
