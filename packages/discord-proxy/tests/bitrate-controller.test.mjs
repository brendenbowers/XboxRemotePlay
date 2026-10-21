import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BitrateController } from '../src/bitrate-controller.mjs'

test('holds the initial rate until Discord media is flowing', () => {
    const controller = new BitrateController({ initialKbps: 4096 })
    assert.equal(controller.update({ rembKbps: 20000, sending: false }, 0), null)
    assert.equal(controller.targetKbps, 4096)
})

test('ramps gently toward 90% of Discord REMB and never above it', () => {
    const controller = new BitrateController({ initialKbps: 2000 })
    const targets = []
    for (let second = 0; second < 30; second++) {
        const next = controller.update({ rembKbps: 4200, fractionLost: 0, reports: second + 1, sending: true }, second * 1000)
        if (next) targets.push(next)
    }
    assert.equal(targets[0], 2160, 'First step is +8%')
    assert.equal(controller.targetKbps, 3780)
    assert(targets.every(value => value <= 3780))
})

test('follows a falling REMB immediately', () => {
    const controller = new BitrateController({ initialKbps: 8000 })
    assert.equal(controller.update({ rembKbps: 3000, fractionLost: 0, reports: 1, sending: true }, 0), 2700)
})

test('higher quality rates can exceed the former 20 Mbps ceiling but still respect Discord feedback', () => {
    const controller = new BitrateController({ initialKbps: 30000 })
    controller.update({ rembKbps: 50000, reports: 1, sending: true }, 0)
    assert(controller.targetKbps > 20000)
    for (let tick = 1; tick < 20; tick++) controller.update({ rembKbps: 50000, reports: tick + 1, sending: true }, tick * 1000)
    assert.equal(controller.targetKbps, 40000)
    controller.update({ rembKbps: 9000, sending: true }, 21000)
    assert.equal(controller.targetKbps, 8100)
})

test('startup probe waits for delivery feedback, exceeds an app-limited estimate once, then adapts normally', () => {
    const controller = new BitrateController({ probeKbps: 15000 })
    assert.equal(controller.update({ rembKbps: 9000, reports: 1, fractionLost: 0, sending: false }, 0), null)
    controller.update({ rembKbps: 9000, reports: 0, sending: true }, 1000)
    assert.equal(controller.diagnostics().startupProbe, 'waiting')
    assert.equal(controller.update({ rembKbps: 9000, reports: 1, fractionLost: 0, sending: true }, 2000), 15000)
    assert.equal(controller.diagnostics().startupProbe, 'probing')
    assert.equal(controller.update({ rembKbps: 9000, reports: 2, fractionLost: 0, sending: true }, 9000), null)
    assert.equal(controller.update({ rembKbps: 9000, reports: 3, fractionLost: 0, sending: true }, 22000), 8100)
    assert.equal(controller.diagnostics().startupProbe, 'completed')
    controller.update({ rembKbps: 9000, reports: 4, fractionLost: 0, sending: true }, 23000)
    assert.equal(controller.targetKbps, 8100, 'Probe cannot repeat')
})

test('startup probe backs down on fresh loss and keeps capacity discovered by a clean probe', () => {
    const controller = new BitrateController({ probeKbps: 15000 })
    controller.update({ rembKbps: 9000, reports: 1, fractionLost: 0, sending: true }, 0)
    assert.equal(controller.update({ rembKbps: 9000, reports: 2, fractionLost: 2, sending: true }, 1000), 8100)
    assert.equal(controller.diagnostics().startupProbe, 'aborted')
    const clean = new BitrateController({ probeKbps: 15000 })
    clean.update({ rembKbps: 9000, reports: 1, fractionLost: 0, sending: true }, 0)
    clean.update({ rembKbps: 20000, reports: 2, fractionLost: 0, sending: true }, 20000)
    assert(clean.targetKbps >= 15000 && clean.targetKbps <= 18000)
    const lossy = new BitrateController({ probeKbps: 15000 })
    lossy.update({ rembKbps: 9000, reports: 1, fractionLost: 10, sending: true }, 0)
    assert.equal(lossy.diagnostics().startupProbe, 'aborted')
    assert(lossy.targetKbps < 4096)
})

test('heavy loss backs off 15% once per fresh report and pauses increases for 3 s', () => {
    const controller = new BitrateController({ initialKbps: 4000 })
    assert.equal(controller.update({ rembKbps: 10000, fractionLost: 30, reports: 1, sending: true }, 0), 3400)
    // Same report seen again on the next tick: no second penalty, and still in the hold window.
    assert.equal(controller.update({ rembKbps: 10000, fractionLost: 30, reports: 1, sending: true }, 1000), null)
    assert.equal(controller.update({ rembKbps: 10000, fractionLost: 0, reports: 2, sending: true }, 2000), null)
    assert.equal(controller.update({ rembKbps: 10000, fractionLost: 0, reports: 3, sending: true }, 3500), 3672)
    assert.equal(controller.diagnostics().lossBackoffs, 1)
})

function provenQualityController() {
    const controller = new BitrateController({ probeKbps: 15000, probeHeight: 1440 })
    for (let second = 0; second <= 20; second++) controller.update({ rembKbps: 9000, fractionLost: 0, reports: second + 1,
        sending: true, videoKbps: 13000, sourceHeight: 1440 }, second * 1000)
    return controller
}

test('retains a clean, measured 1440p rate above a fixed estimate instead of forcing 1080p', () => {
    const controller = provenQualityController()
    assert.equal(controller.diagnostics().startupProbe, 'holding')
    for (let second = 21; second <= 60; second++) controller.update({ rembKbps: 9000, fractionLost: 0, reports: second + 1,
        sending: true, videoKbps: 13000, sourceHeight: 1440 }, second * 1000)
    assert.equal(controller.targetKbps, 15000)
})

test('cannot retain an unproven source resolution or bitrate after probing', () => {
    for (const [sourceHeight, videoKbps] of [[1080, 13000], [1440, 8000]]) {
        const controller = new BitrateController({ probeKbps: 15000, probeHeight: 1440 })
        for (let second = 0; second <= 20; second++) controller.update({ rembKbps: 9000, fractionLost: 0, reports: second + 1,
            sending: true, sourceHeight, videoKbps }, second * 1000)
        assert.equal(controller.diagnostics().startupProbe, 'completed')
        assert.equal(controller.targetKbps, 8100)
    }
})

test('proven quality rate yields to loss, a falling estimate, or missing delivery reports', () => {
    const lossy = provenQualityController()
    lossy.update({ rembKbps: 9000, fractionLost: 2, reports: 22, sending: true }, 21000)
    assert.equal(lossy.targetKbps, 8100)
    assert.equal(lossy.diagnostics().startupProbe, 'aborted')
    const falling = provenQualityController()
    falling.update({ rembKbps: 7000, fractionLost: 0, reports: 22, sending: true }, 21000)
    assert.equal(falling.targetKbps, 6300)
    assert.equal(falling.diagnostics().startupProbe, 'aborted')
    const stale = provenQualityController()
    for (let second = 21; second <= 24; second++) stale.update({ rembKbps: 9000, fractionLost: 0, reports: 21, sending: true }, second * 1000)
    assert.equal(stale.targetKbps, 8100)
    assert.equal(stale.diagnostics().startupProbe, 'aborted')
    const probing = new BitrateController({ probeKbps: 15000 })
    probing.update({ rembKbps: 9000, fractionLost: 0, reports: 1, sending: true }, 0)
    probing.update({ fractionLost: 0, reports: 1, sending: true }, 3000)
    assert.equal(probing.targetKbps, 8100, 'Last known estimate still limits fallback if REMB is missing')
    assert.equal(probing.diagnostics().startupProbe, 'aborted')
})

test('does not increase the ordinary rate while delivery reports have stopped', () => {
    const controller = new BitrateController()
    for (let second = 0; second < 20; second++) controller.update({ rembKbps: 9000, sending: true }, second * 1000)
    assert.equal(controller.targetKbps, 4096)
})

test('explicit override keeps the chosen rate despite estimates and loss, without automatic probing', () => {
    const fixed = new BitrateController({ initialKbps: 15000, probeKbps: 30000, override: true })
    for (let second = 0; second < 30; second++) assert.equal(fixed.update({ rembKbps: 2000, fractionLost: 50,
        reports: second + 1, sending: true, videoKbps: 12000, sourceHeight: 1440 }, second * 1000), null)
    assert.equal(fixed.targetKbps, 15000)
    assert.equal(fixed.diagnostics().mode, 'override')
    assert.equal(fixed.diagnostics().startupProbe, 'off')
    const automatic = new BitrateController({ initialKbps: 15000 })
    automatic.update({ rembKbps: 2000, fractionLost: 50, reports: 1, sending: true }, 0)
    assert.equal(automatic.targetKbps, 1800, 'Switching back to automatic restores feedback control')
    assert.equal(automatic.diagnostics().mode, 'automatic')
    assert.equal(new BitrateController({ initialKbps: 500, override: true }).targetKbps, 500)
    assert.equal(new BitrateController({ initialKbps: 90000, override: true }).targetKbps, 40000)
})

test('a new share (report count restarting) still reacts to loss', () => {
    const controller = new BitrateController({ initialKbps: 4000 })
    controller.update({ rembKbps: 10000, fractionLost: 0, reports: 500, sending: true }, 0)
    assert(controller.update({ rembKbps: 10000, fractionLost: 40, reports: 1, sending: true }, 1000) < 4000)
})

test('moderate loss holds the rate; limits are respected', () => {
    const controller = new BitrateController({ initialKbps: 1100, minKbps: 1000 })
    assert.equal(controller.update({ rembKbps: 10000, fractionLost: 5, reports: 1, sending: true }, 0), null)
    assert.equal(controller.targetKbps, 1100)
    for (let report = 2; report < 10; report++) controller.update({ rembKbps: 10000, fractionLost: 50, reports: report, sending: true }, report * 5000)
    assert.equal(controller.targetKbps, 1000)
})
