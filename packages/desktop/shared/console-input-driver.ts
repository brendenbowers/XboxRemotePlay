import { ConsoleInputState, selectedPad, BUTTONS } from './console-input'
import type { NativeInput } from './console-input'

// The supported input_driver hook owns controller polling. Native queues use the pinned 0.2.11 packet writer.
export class ConsoleInputDriver {
    state = new ConsoleInputState()
    application: any
    nativeHeld = new Set<number>()
    mouseButtons = 0
    constructor(settings: any) { this.state.configure(settings) }
    setApplication(application: any) { this.application = application }
    start() { this.state.release() }
    stop() { this.state.release(); this.queueNative(this.state.sample(performance.now()).native) }
    queueNative(batch: NativeInput) {
        const input = this.application?.getChannelProcessor('input')
        if (!input) return
        if (batch.reset) {
            input._keyboardFrames.length = 0; input._mouseFrames.length = 0
            for (const code of this.nativeHeld) input._keyboardFrames.push({ keyCode: code, pressed: false })
            this.nativeHeld.clear()
            if (this.mouseButtons) input._mouseFrames.push({ X: 0, Y: 0, WheelX: 0, WheelY: 0, Buttons: 0, Relative: 0 })
            this.mouseButtons = 0
        }
        for (const key of batch.keys) {
            // Retain released codes until reset: a queued key-up may be cleared before it is sent.
            if (key.pressed) this.nativeHeld.add(key.code)
            input._keyboardFrames.push({ keyCode: key.code, pressed: key.pressed })
        }
        for (const m of batch.mice || []) {
            input._mouseFrames.push({ X: m.x, Y: m.y, WheelX: m.wheelX, WheelY: m.wheelY, Buttons: m.buttons, Relative: 0 })
            this.mouseButtons |= m.buttons
        }
    }
    requestStates() {
        const { pad, native } = this.state.sample(performance.now())
        const input = this.application?.getChannelProcessor('input')
        // Bound queued transitions even if the transport stops draining; reset releases all tracked keys.
        if (input?._keyboardFrames.length > 128 || input?._mouseFrames.length > 128) {
            this.state.release(); this.queueNative({ reset: true, keys: [] })
        } else this.queueNative(native)
        const value = selectedPad(this.state, pad, [...navigator.getGamepads()])
        const frame: any = { GamepadIndex: 0, LeftThumbXAxis: value.axes[0], LeftThumbYAxis: value.axes[1], RightThumbXAxis: value.axes[2], RightThumbYAxis: value.axes[3], LeftTrigger: value.triggers[0], RightTrigger: value.triggers[1] }
        for (const [button, mask] of Object.entries(BUTTONS)) frame[button] = value.buttons & mask ? 1 : 0
        return [frame]
    }
}
