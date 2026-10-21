import React from 'react'
import Button from './button'
import { useSettings } from '../../context/userContext'

// Headless Discord share: the console stream is received by the publisher process, with no stream page or local picture.
export default function HeadlessShare({ consoleId }: { consoleId: string }) {
    const { settings, setSettings } = useSettings()
    const [status, setStatus] = React.useState<any>(null)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    const available = typeof window !== 'undefined' && !!window.Greenlight?.headless

    const refresh = React.useCallback(() => window.Greenlight.headless('status').then(setStatus).catch(() => {}), [])
    React.useEffect(() => {
        if (!available) return
        refresh()
        const timer = setInterval(refresh, 2000)
        return () => clearInterval(timer)
    }, [available, refresh])

    async function run(action: string, data = {}) {
        setBusy(true); setError('')
        try { setStatus(await window.Greenlight.headless(action, data)) }
        catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method 'headless': Error: /, '') : 'Headless share failed') }
        finally { setBusy(false) }
    }

    if (!available) return null
    const active = status?.active
    const share = status?.share
    const video = status?.receiver?.depacketizer?.video
    return <div style={{ marginTop: 12 }}>
        {!active ? <Button label={busy ? 'Starting headless share…' : 'Headless Discord share'} disabled={busy}
            onClick={() => run('start', { target: consoleId, resolution: settings.discord_resolution, share: true })} /> : <div>
            <p role="status">Headless: {status.stage} · Discord: {share?.state === 'publishing' ? share.encryptionReady ? 'live' : 'waiting for viewer' : share?.state || 'idle'}</p>
            {status.receiver && <p>Xbox {status.receiver.depacketizer?.video?.sps?.height ? `${status.receiver.depacketizer.video.sps.width}×${status.receiver.depacketizer.video.sps.height} · ` : ''}{status.receiver.currentVideoKbps} kbps (target {status.receiver.bitrate?.targetKbps ?? status.receiver.requestedKbps ?? '–'}, Discord estimate {share?.feedback?.rembKbps ?? '–'}) · frames {video?.frames ?? 0} · lost packets {video?.lost ?? 0} · sent to Discord {share?.stats?.sentVideo ?? 0}</p>}
            {share?.video && <p>Discord video sent: {share.video.sent ? `${share.video.sent.width}×${share.video.sent.height}` : 'waiting for encoded video'} · advertised maximum: {share.video.advertised.width}×{share.video.advertised.height}. Source passthrough; viewer resolution is not measured.</p>}
            {status.receiver?.bitrate?.startupProbe === 'probing' && <p>Testing a higher quality bitrate for up to 20 seconds; packet loss ends the test early.</p>}
            {status.receiver?.bitrate?.startupProbe === 'holding' && <p>Keeping the cleanly probed quality rate. Loss, a falling bandwidth estimate or missing delivery reports restores normal adaptation.</p>}
            {status.receiver?.bitrate?.mode === 'override' && <p>Bitrate override: fixed Xbox request; automatic bandwidth and loss adjustments are off.</p>}
            <div style={{ display: 'flex', gap: 12 }}>
                {share?.state === 'idle' && <Button label='Start Discord share' disabled={busy} onClick={() => run('share')} />}
                <Button label='Stop headless' disabled={busy} onClick={() => run('stop')} />
            </div>
        </div>}
        <p><label htmlFor={`headless-bitrate-override-${consoleId}`}><input id={`headless-bitrate-override-${consoleId}`} type="checkbox" disabled={busy}
            checked={active && status.receiver?.bitrate ? status.receiver.bitrate.mode === 'override' : settings.discord_bitrate_override}
            onChange={event => {
                const override = event.target.checked
                setSettings({ ...settings, discord_bitrate_override: override })
                if (active) run('bitrate', { kbps: settings.discord_bitrate, override })
            }} /> Override Discord's estimate</label></p>
        <p className='grey' style={{ fontSize: 12 }}>Switching modes applies the saved {(settings.discord_bitrate / 1000).toFixed(1)} Mbps bitrate. Choose it and the requested resolution in Settings → Streaming.</p>
        {(error || status?.error || share?.reason) && <p role="alert">{error || status?.error || share?.reason}</p>}
        {!active && <p className='grey' style={{ fontSize: 12 }}>Requests up to {settings.discord_resolution}p game video and audio for your Canary voice channel without opening the stream window. Join voice in Canary first.</p>}
    </div>
}
