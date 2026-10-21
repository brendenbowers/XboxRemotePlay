export function releaseKeyboardInput(player) {
    // Alt-Tab can swallow key-up events; release keyboard buttons without stopping gamepad polling.
    const state = player._keyboardDriver?.requestState()
    if (state) {
        for (const key of Object.keys(state)) {
            if (key !== 'GamepadIndex') state[key] = 0
        }
    }
    if (player._inputDriver) player._inputDriver._nexusOverrideN = false
}
