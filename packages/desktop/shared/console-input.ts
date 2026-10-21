export type InputMode = 'controller' | 'native' | 'emulated'
export type PadState = { buttons: number; axes: number[]; triggers: number[] }
export type NativeInput = { reset?: boolean; keys: { code: number; pressed: boolean }[]; mice?: { x: number; y: number; wheelX: number; wheelY: number; buttons: number }[] }
export const BUTTONS = { A: 16, B: 32, X: 64, Y: 128, LeftShoulder: 4096, RightShoulder: 8192, LeftThumb: 16384, RightThumb: 32768, DPadUp: 256, DPadDown: 512, DPadLeft: 1024, DPadRight: 2048, View: 8, Menu: 4, Nexus: 2 }
export const DEFAULT_BINDINGS: Record<string, string> = { Space: 'A', ControlLeft: 'B', KeyR: 'X', KeyF: 'Y', KeyQ: 'LeftShoulder', KeyE: 'RightShoulder', ShiftLeft: 'LeftThumb', ArrowUp: 'DPadUp', ArrowDown: 'DPadDown', ArrowLeft: 'DPadLeft', ArrowRight: 'DPadRight', Tab: 'View', Enter: 'Menu', KeyN: 'Nexus' }
export const neutralPad = (): PadState => ({ buttons: 0, axes: [0, 0, 0, 0], triggers: [0, 0] })
export const inputMode = (value: any): InputMode => ['controller', 'native', 'emulated'].includes(value) ? value : 'controller'
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
export function inputOptions(settings: any) {
    const number = (value: any, min: number, max: number, fallback: number) => Number.isFinite(value) ? clamp(value, min, max) : fallback
    const bindings: Record<string, string> = {}
    for (const [code, button] of Object.entries(settings.input_bindings || DEFAULT_BINDINGS)) {
        if (/^[A-Za-z][A-Za-z0-9]{0,30}$/.test(code) && Object.hasOwn(BUTTONS, String(button)) && !['Escape', 'F9'].includes(code)) bindings[code] = String(button)
    }
    return { mode: inputMode(settings.input_mode), sensitivity: number(settings.input_sensitivity, 0.1, 5, 1), deadzone: number(settings.input_deadzone, 0, 0.4, 0.12), invertY: settings.input_invert_y === true, bindings }
}

// Physical key locations → Windows virtual keys used by the existing player protocol. IME/text injection is separate.
export function virtualKey(code: string): number | undefined {
    if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3)
    if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5)
    if (/^Numpad[0-9]$/.test(code)) return 96 + Number(code.slice(6))
    const f = /^F([1-9]|1[0-2])$/.exec(code)
    if (f) return 111 + Number(f[1])
    return ({ Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 160, ShiftRight: 161, ControlLeft: 162, ControlRight: 163, AltLeft: 164, AltRight: 165, CapsLock: 20, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46, Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222, NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111 })[code]
}

export class ConsoleInputState {
    onRelease?: () => void
    options = inputOptions({})
    held = new Set<string>()
    tapped = new Set<string>()
    captured = false
    buttons = 0
    tappedButtons = 0
    dx = 0
    dy = 0
    lastSample = 0
    pending: NativeInput = { reset: true, keys: [] }
    configure(settings: any) { this.release(); this.options = inputOptions(settings) }
    release() {
        this.held.clear(); this.tapped.clear(); this.buttons = this.tappedButtons = 0; this.dx = this.dy = 0; this.captured = false; this.lastSample = 0
        this.pending = { reset: true, keys: [] }
        this.onRelease?.()
    }
    key(code: string, down: boolean) {
        if (!this.captured || this.options.mode === 'controller' || this.held.has(code) === down) return
        if (down) { this.held.add(code); this.tapped.add(code) } else this.held.delete(code)
        const vk = virtualKey(code)
        if (this.options.mode === 'native' && vk !== undefined) {
            if (this.pending.keys.length >= 128) { this.release(); return }
            this.pending.keys.push({ code: vk, pressed: down })
        }
    }
    mouse(x: number, y: number, buttons: number, wheelX = 0, wheelY = 0) {
        if (!this.captured) return
        this.buttons = buttons & 31
        this.tappedButtons |= this.buttons
        x = clamp(x, -32767, 32767); y = clamp(y, -32767, 32767)
        this.dx = clamp(this.dx + x, -32767, 32767); this.dy = clamp(this.dy + y, -32767, 32767)
        if (this.options.mode === 'native') {
            const mice = this.pending.mice ||= [], prev = mice[mice.length - 1]
            if (prev && prev.buttons === this.buttons) {
                prev.x = clamp(prev.x + x, -32767, 32767); prev.y = clamp(prev.y + y, -32767, 32767)
                prev.wheelX = clamp(prev.wheelX + wheelX, -32767, 32767); prev.wheelY = clamp(prev.wheelY + wheelY, -32767, 32767)
            } else {
                if (mice.length >= 128) { this.release(); return }
                mice.push({ x, y, wheelX: clamp(wheelX, -32767, 32767), wheelY: clamp(wheelY, -32767, 32767), buttons: this.buttons })
            }
        }
    }
    sample(now: number) {
        const pad = neutralPad(), dt = this.lastSample ? clamp(now - this.lastSample, 1, 64) : 16
        this.lastSample = now
        if (this.captured && this.options.mode === 'emulated') {
            const keys = new Set([...this.held, ...this.tapped]), buttons = this.buttons | this.tappedButtons
            let x = Number(keys.has('KeyD')) - Number(keys.has('KeyA'))
            let y = Number(keys.has('KeyS')) - Number(keys.has('KeyW'))
            const length = Math.hypot(x, y)
            if (length > 1) { x /= length; y /= length }
            pad.axes[0] = x; pad.axes[1] = y
            let rx = this.dx / dt * this.options.sensitivity / 0.8
            let ry = this.dy / dt * this.options.sensitivity / 0.8 * (this.options.invertY ? -1 : 1)
            const magnitude = Math.hypot(rx, ry)
            if (magnitude) {
                const scale = (this.options.deadzone + (1 - this.options.deadzone) * Math.min(1, magnitude)) / magnitude
                rx *= scale; ry *= scale
            }
            pad.axes[2] = rx; pad.axes[3] = ry
            for (const code of keys) pad.buttons |= BUTTONS[this.options.bindings[code]] || 0
            if (buttons & 4) pad.buttons |= BUTTONS.RightThumb
            pad.triggers = [buttons & 2 ? 1 : 0, buttons & 1 ? 1 : 0]
        }
        const native = this.pending
        this.pending = { keys: [] }; this.dx = this.dy = 0; this.tapped.clear(); this.tappedButtons = 0
        return { pad, native }
    }
}

export function gamepadState(pad: Gamepad): PadState {
    const indices = [4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 0, 1, 2, 3]
    const masks = [4096, 8192, 8, 4, 16384, 32768, 256, 512, 1024, 2048, 2, 16, 32, 64, 128]
    const result = neutralPad()
    indices.forEach((index, i) => { if (pad.buttons[index]?.pressed || pad.buttons[index]?.value > 0.5) result.buttons |= masks[i] })
    if ((result.buttons & 12) === 12) result.buttons |= 2
    result.axes = [0, 1, 2, 3].map(i => pad.axes[i] || 0)
    result.triggers = [pad.buttons[6]?.value || 0, pad.buttons[7]?.value || 0]
    return result
}

export function selectedPad(state: ConsoleInputState, sample: PadState, pads: (Gamepad | null)[]) {
    const pad = state.options.mode === 'controller' && pads.find(pad => pad?.connected && pad.mapping === 'standard')
    return pad ? gamepadState(pad) : sample
}

export function sanitizeNativeInput(data: any): NativeInput | undefined {
    if (!data || !Array.isArray(data.keys) || data.keys.length > 128 || (data.reset !== undefined && typeof data.reset !== 'boolean')) return
    if (data.keys.some(key => !key || !Number.isInteger(key.code) || key.code < 1 || key.code > 255 || typeof key.pressed !== 'boolean')) return
    if (data.mice !== undefined && (!Array.isArray(data.mice) || data.mice.length > 128)) return
    const mice = data.mice || []
    if (mice.some(mouse => !mouse || !['x', 'y', 'wheelX', 'wheelY'].every(key => Number.isInteger(mouse[key]) && Math.abs(mouse[key]) <= 32767) || !Number.isInteger(mouse.buttons) || mouse.buttons < 0 || mouse.buttons > 31)) return
    return { reset: data.reset === true, keys: data.keys.map(key => ({ code: key.code, pressed: key.pressed })), mice: mice.map(mouse => ({ x: mouse.x, y: mouse.y, wheelX: mouse.wheelX, wheelY: mouse.wheelY, buttons: mouse.buttons })) }
}
