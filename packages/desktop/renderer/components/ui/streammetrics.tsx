import React from 'react'
import { useSettings } from '../../context/userContext'
import { getStreamQuality, readStreamMetrics } from '../../../shared/stream-quality'

export default function StreamMetrics({ player, requestedHeight = undefined }) {
    const { settings } = useSettings()
    const [metrics, setMetrics] = React.useState(null)
    const [error, setError] = React.useState(false)
    const quality = React.useRef(getStreamQuality(requestedHeight ?? settings.xhome_resolution)).current

    React.useEffect(() => {
        let previous
        let cancelled = false
        let pending = false
        const interval = setInterval(async () => {
            if (!player?._webrtcClient || pending) return
            pending = true
            try {
                const stats = await player._webrtcClient.getStats()
                stats.forEach(report => {
                    if (cancelled || report.type !== 'inbound-rtp' || report.kind !== 'video') return
                    const sample = readStreamMetrics(report, previous, quality.height)
                    previous = report
                    setMetrics({ ...sample, codec: stats.get(report.codecId)?.mimeType || 'Unknown', measuredAt: new Date().toISOString() })
                    setError(false)
                })
            } catch {
                if (!cancelled) setError(true)
            } finally {
                pending = false
            }
        }, 1000)
        return () => { cancelled = true; clearInterval(interval) }
    }, [player, quality.height])

    function saveReport() {
        const url = URL.createObjectURL(new Blob([JSON.stringify({ requestedHeight: quality.height, ...metrics }, null, 2)], { type: 'application/json' }))
        const link = document.createElement('a')
        link.href = url
        link.download = `console-stream-${Date.now()}.json`
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    return <div id="console-stream-metrics">
        <div>Requested: {quality.width} × {quality.height}</div>
        <div>Receiving: {metrics?.width && metrics?.height ? `${metrics.width} × ${metrics.height}` : 'Waiting for video'}</div>
        <div>{metrics?.fps == null ? '—' : Math.round(metrics.fps)} FPS · {metrics?.mbps == null ? '—' : metrics.mbps.toFixed(1)} Mbps</div>
        <div>{error ? 'Stream measurements unavailable' : metrics?.state || 'Waiting for video'}</div>
        <button type="button" onClick={saveReport} disabled={!metrics}>Save stream report</button>
    </div>
}
