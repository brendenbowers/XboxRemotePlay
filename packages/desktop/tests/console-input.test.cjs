const assert = require('node:assert/strict')
const { test } = require('node:test')
const { ConsoleInputState, inputOptions, neutralPad, sanitizeNativeInput, selectedPad, virtualKey } = require('../shared/console-input.ts')
const captured = (mode = 'emulated', options = {}) => {
    const state = new ConsoleInputState()
    state.configure({ input_mode: mode, ...options }); state.captured = true
    return state
}

test('WASD normalizes diagonals, cancels opposites and releases', () => {
    const state = captured()
    state.key('KeyW', true); state.key('KeyD', true)
    let pad = state.sample(100).pad
    assert(Math.abs(Math.hypot(...pad.axes.slice(0, 2)) - 1) < 1e-9)
    assert(pad.axes[0] > 0 && pad.axes[1] < 0)
    state.key('KeyS', true); state.key('KeyA', true)
    assert.deepEqual(state.sample(116).pad.axes.slice(0, 2), [0, 0])
    state.release()
    assert.deepEqual(state.sample(132).pad, neutralPad())
})

test('mouse aim uses elapsed time, clamps magnitude, centers when idle and can invert Y', () => {
    const a = captured(), b = captured()
    a.sample(100); b.sample(100)
    a.mouse(2, 2, 0); b.mouse(4, 4, 0)
    assert.deepEqual(a.sample(116).pad.axes.slice(2), b.sample(132).pad.axes.slice(2))
    a.mouse(10000, 10000, 0)
    assert(Math.hypot(...a.sample(132).pad.axes.slice(2)) <= 1.0000001)
    assert.deepEqual(a.sample(148).pad.axes.slice(2), [0, 0])
    const inverted = captured('emulated', { input_invert_y: true })
    inverted.mouse(0, 2, 0)
    assert(inverted.sample(100).pad.axes[3] < 0)
})

test('fast key and mouse taps survive one sample; mode switch clears every synthetic input', () => {
    const state = captured()
    state.key('Space', true); state.key('Space', false)
    state.mouse(0, 0, 3); state.mouse(0, 0, 0)
    const tapped = state.sample(100).pad
    assert.equal(tapped.buttons & 16, 16)
    assert.deepEqual(tapped.triggers, [1, 1])
    assert.deepEqual(state.sample(116).pad, neutralPad())
    state.key('KeyW', true); state.mouse(20, 10, 3)
    state.configure({ input_mode: 'controller' })
    assert.equal(state.captured, false)
    assert.deepEqual(state.sample(132).pad, neutralPad())
})

test('native mode preserves key and mouse transitions, signed deltas and wheel without mapping buttons', () => {
    const state = captured('native')
    state.sample(80)
    state.key('KeyW', true); state.key('KeyW', true); state.key('KeyW', false)
    state.mouse(-3, 4, 1); state.mouse(0, 0, 0, 0, -120)
    const { native, pad } = state.sample(100)
    assert.deepEqual(native.keys, [{ code: 87, pressed: true }, { code: 87, pressed: false }])
    assert.deepEqual(native.mice.map(m => m.buttons), [1, 0])
    assert.equal(native.mice[0].x, -3); assert.equal(native.mice[1].wheelY, -120)
    assert.deepEqual(pad, neutralPad())
    state.release()
    assert.equal(state.sample(116).native.reset, true)
    assert.equal(virtualKey('ShiftRight'), 161)
})

test('only connected-controller mode polls the physical pad and does so without keyboard capture', () => {
    const state = captured('controller'), sample = neutralPad()
    state.release()
    const pad = { connected: true, mapping: 'standard', axes: [0.5, 0, 0, 0], buttons: [{ pressed: true, value: 1 }] }
    assert.equal(selectedPad(state, sample, [null, pad]).buttons, 16)
    state.configure({ input_mode: 'native' })
    assert.deepEqual(selectedPad(state, sample, [pad]), sample)
})

test('native IPC and settings reject malformed values and strip untrusted fields', () => {
    const valid = { reset: true, keys: [{ code: 87, pressed: true, extra: 'discard' }], mice: [{ x: -3, y: 0, wheelX: 0, wheelY: 120, buttons: 1 }] }
    assert.equal(sanitizeNativeInput(valid).keys[0].extra, undefined)
    for (const value of [null, {}, { keys: Array(129).fill({ code: 1, pressed: true }) }, { keys: [{ code: 256, pressed: true }] }, { keys: [{ code: 1, pressed: 1 }] }, { keys: [], mice: [{ x: NaN }] }, { keys: [], reset: 'true' }]) assert.equal(sanitizeNativeInput(value), undefined)
    const opts = inputOptions({ input_mode: 'bogus', input_sensitivity: Infinity, input_invert_y: 'true', input_bindings: { F9: 'A', Space: 'A', KeyA: 'bogus' } })
    assert.equal(opts.mode, 'controller'); assert.equal(opts.sensitivity, 1); assert.equal(opts.invertY, false)
    assert.deepEqual(opts.bindings, { Space: 'A' })
})

test('windowed custom driver feeds the installed player serializer and reset preserves pending releases', () => {
    const Module = require('node:module'), fs = require('node:fs'), ts = require('typescript')
    const previous = Module._extensions['.ts']
    let ConsoleInputDriver
    try {
        Module._extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename)
        ConsoleInputDriver = require('../shared/console-input-driver.ts').ConsoleInputDriver
    } finally { Module._extensions['.ts'] = previous }
    const oldNavigator = Object.getOwnPropertyDescriptor(global, 'navigator')
    Object.defineProperty(global, 'navigator', { configurable: true, value: { getGamepads: () => [] } })
    const driver = new ConsoleInputDriver({ input_mode: 'native' })
    const input = { _keyboardFrames: [], _mouseFrames: [] }
    driver.setApplication({ getChannelProcessor: () => input })
    try {
        driver.start(); driver.state.captured = true
        driver.state.key('KeyW', true); driver.state.mouse(-2, 3, 1)
        const pad = driver.requestStates()[0]
        const Packet = require('xbox-xcloud-player/dist/Channel/Input/Packet').default
        const packet = new Packet(1)
        packet.setData([], [pad], [], input._mouseFrames.splice(0), input._keyboardFrames.splice(0))
        const bytes = Buffer.from(packet.toBuffer().buffer)
        assert.equal(bytes.readUInt16LE(0), 2 | 32 | 64)
        driver.state.key('KeyW', false); driver.state.mouse(0, 0, 0); driver.requestStates()
        driver.state.configure({ input_mode: 'controller' }); driver.requestStates()
        assert(input._keyboardFrames.some(key => key.keyCode === 87 && !key.pressed))
        assert(input._mouseFrames.some(mouse => mouse.Buttons === 0))
    } finally { if (oldNavigator) Object.defineProperty(global, 'navigator', oldNavigator); else delete global.navigator }
})
