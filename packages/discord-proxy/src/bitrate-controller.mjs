// Steers the Xbox encoder (via REMB from the headless receiver) from Discord's feedback.
// Live: the Xbox follows REMB within ~4 s at ~75-95% of the rate, and picks its own resolution from it
// (1440p from ~12.5-15 Mbps, 1080p ~5-12 Mbps, 720p ≤ ~4 Mbps, with hysteresis) up to the session's starting size.
// So bitrate is the only control; resolution follows natively.

export class BitrateController {
    constructor({ initialKbps = 4096, minKbps = 1000, maxKbps = 40000, headroom = 0.9, probeKbps = 0, probeHeight = 0, override = false } = {}) {
        Object.assign(this, { minKbps, maxKbps, headroom, probeHeight })
        this.override = override === true
        this.probeKbps = probeKbps ? clamp(probeKbps, minKbps, maxKbps) : 0
        this.probeState = probeKbps && !this.override ? 'waiting' : 'off'
        this.targetKbps = clamp(initialKbps, this.override ? 500 : minKbps, maxKbps)
        this.holdUntil = 0
        this.lastReports = 0
        this.decisions = { increases: 0, decreases: 0, lossBackoffs: 0 }
    }

    // Call about once a second. Returns the new target, or null when the Xbox does not need a new REMB.
    update({ rembKbps = null, fractionLost = null, reports = 0, sending = false, videoKbps = 0, sourceHeight = 0 }, now = Date.now()) {
        if (this.override || !sending) return null
        const previous = this.targetKbps
        // Leave room for audio and RTP/DAVE overhead inside Discord's estimate.
        const estimate = rembKbps || this.probeEstimateKbps
        const ceiling = estimate ? clamp(estimate * this.headroom, this.minKbps, this.maxKbps) : this.maxKbps
        // Each receiver report counts once; the same report is visible on several ticks. A new share restarts the count.
        if (reports < this.lastReports) this.lastReports = 0
        const freshReport = reports > this.lastReports
        this.lastReports = reports
        if (freshReport) this.lastReportAt = now
        // The live SFU estimate stayed at 9 Mbps while 1440p delivered cleanly above it.
        if (this.probeState === 'waiting' && freshReport && fractionLost !== null && rembKbps > 0) {
            this.probeState = fractionLost >= 2 ? 'aborted' : 'probing'
            this.probeEstimateKbps = rembKbps
            this.probeUntil = now + 20000
        }
        if (['probing', 'holding'].includes(this.probeState)) {
            if (freshReport && fractionLost >= 2 || now - this.lastReportAt >= 3000 || rembKbps > 0 && rembKbps < this.probeEstimateKbps * 0.9) this.probeState = 'aborted'
            else if (this.probeState === 'probing' && now >= this.probeUntil) {
                this.probeState = sourceHeight >= this.probeHeight && videoKbps > rembKbps && rembKbps > 0 ? 'holding' : 'completed'
            }
        }
        const keepQualityRate = ['probing', 'holding'].includes(this.probeState)
        if (keepQualityRate) {
            this.targetKbps = this.probeKbps
        } else if (freshReport && fractionLost >= 10) {
            this.targetKbps = Math.max(this.minKbps, this.targetKbps * 0.85)
            this.holdUntil = now + 3000
            this.decisions.lossBackoffs++
        } else if (freshReport && fractionLost >= 2) {
            this.holdUntil = Math.max(this.holdUntil, now + 1000)
        } else if (freshReport && now >= this.holdUntil) {
            this.targetKbps = Math.min(ceiling, this.targetKbps * 1.08)
        }
        this.targetKbps = Math.round(keepQualityRate ? this.targetKbps : Math.min(this.targetKbps, ceiling))
        if (this.targetKbps > previous) this.decisions.increases++
        if (this.targetKbps < previous) this.decisions.decreases++
        // Skip sends under 3% (the Xbox's own rate varies more), except the final step onto the ceiling.
        const sent = this.sentKbps ?? previous
        if (this.targetKbps === sent || (Math.abs(this.targetKbps - sent) < sent * 0.03 && this.targetKbps !== ceiling)) return null
        this.sentKbps = this.targetKbps
        return this.targetKbps
    }

    diagnostics() { return { targetKbps: this.targetKbps, mode: this.override ? 'override' : 'automatic', startupProbe: this.probeState, ...this.decisions } }
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, Math.round(value))) }
