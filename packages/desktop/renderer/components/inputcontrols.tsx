import React from 'react'
import { useSettings } from '../context/userContext'
import { BUTTONS, ConsoleInputState, selectedPad } from '../../shared/console-input'

export function InputModeSettings({ compact = false }: { compact?: boolean }) {
    const { settings, setSettings } = useSettings()
    const update = (key: string, value: any) => setSettings({ ...settings, [key]: value })
    return <div>
        <label>Input mode <select aria-label="Input mode" value={settings.input_mode} onChange={e => update('input_mode', e.target.value)}>
            <option value="controller">Connected controller</option>
            <option value="native">Native keyboard &amp; mouse (experimental)</option>
            <option value="emulated">Keyboard &amp; mouse as controller</option>
        </select></label>
        {settings.input_mode === 'emulated' && <div>
            <label>Mouse sensitivity <input aria-label="Mouse sensitivity" type="range" min="0.1" max="5" step="0.1" value={settings.input_sensitivity} onChange={e => update('input_sensitivity', Number(e.target.value))} /> {settings.input_sensitivity.toFixed(1)}</label>
            <label><input type="checkbox" checked={settings.input_invert_y} onChange={e => update('input_invert_y', e.target.checked)} /> Invert mouse Y</label>
            {!compact && <>
                <p>WASD moves, mouse aims, left click fires (RT), right click aims (LT), middle click presses the right stick. Escape/F9 releases capture. Aim is limited by the game's controller turn speed.</p>
                <label>Stick deadzone compensation <input aria-label="Stick deadzone compensation" type="range" min="0" max="0.4" step="0.01" value={settings.input_deadzone} onChange={e => update('input_deadzone', Number(e.target.value))} /> {Math.round(settings.input_deadzone * 100)}%</label>
                <p>Start with the game's right-stick deadzone low; adjust this if small mouse movements do not move the camera.</p>
                {Object.keys(BUTTONS).map(button => <p key={button}><label>{button} <input aria-label={`Bind ${button}`} readOnly value={Object.keys(settings.input_bindings).find(key => settings.input_bindings[key] === button) || 'Unbound'}
                    onKeyDown={e => {
                        e.preventDefault(); e.stopPropagation()
                        if (e.repeat || ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'F9'].includes(e.code)) return
                        const bindings = { ...settings.input_bindings }
                        for (const key of Object.keys(bindings)) if (bindings[key] === button) delete bindings[key]
                        if (e.code !== 'Escape') bindings[e.code] = button
                        update('input_bindings', bindings)
                    }} /></label></p>)}
                <p>Select a binding field and press a key; Escape clears it. WASD and F9 are reserved.</p>
            </>}
        </div>}
        {settings.input_mode === 'native' && !compact && <p>Requires keyboard/mouse support in the console game. Starfield on Xbox does not support native input; use controller emulation. Native Remote Play acceptance is experimental. Unicode/IME text entry is not provided.</p>}
    </div>
}

export default function InputControls({ player, headless = false }: { player?: any; headless?: boolean }) {
    const { settings } = useSettings()
    const ownState = React.useRef(new ConsoleInputState())
    const state: ConsoleInputState = player?._inputDriver?.state || ownState.current
    const captureArea = React.useRef<HTMLDivElement>(null)
    const [active, setActive] = React.useState(!headless)
    const [captured, setCaptured] = React.useState(false)
    const [error, setError] = React.useState('')
    const activeRef = React.useRef(active)
    activeRef.current = active

    React.useEffect(() => {
        state.configure(settings)
        setCaptured(false)
        if (document.pointerLockElement) document.exitPointerLock()
    }, [state, settings.input_mode, settings.input_sensitivity, settings.input_deadzone, settings.input_invert_y, settings.input_bindings])

    React.useEffect(() => {
        if (!headless) return
        let mounted = true
        const check = () => window.Greenlight.headless('active').then(value => {
            if (!mounted) return
            const next = value === true
            if (next !== activeRef.current) { state.release(); setActive(next) }
        }).catch(() => { if (mounted) { state.release(); setActive(false) } })
        check()
        const timer = setInterval(check, 1000)
        let last = 0
        const poll = setInterval(() => {
            if (!activeRef.current) return
            const sample = state.sample(performance.now())
            const pad = selectedPad(state, sample.pad, [...navigator.getGamepads()])
            window.Greenlight.headlessInput(pad)
            const now = performance.now()
            if (sample.native.reset || sample.native.keys.length || sample.native.mice?.length || now - last >= 250) {
                window.Greenlight.headlessNativeInput(sample.native); last = now
            }
        }, 16)
        return () => {
            mounted = false; clearInterval(timer); clearInterval(poll); state.release()
            window.Greenlight.headlessInput(null)
            window.Greenlight.headlessNativeInput({ reset: true, keys: [] })
        }
    }, [headless, state])

    React.useEffect(() => {
        let disposed = false
        const target = () => headless ? captureArea.current : document.getElementById('streamComponentHolder')
        const release = () => {
            state.release(); setCaptured(false)
            if (document.pointerLockElement === target()) document.exitPointerLock()
        }
        state.onRelease = () => {
            setCaptured(false)
            if (document.pointerLockElement && document.pointerLockElement === target()) document.exitPointerLock()
        }
        const unsubscribe = headless ? window.Greenlight.onConsoleInputReset(release) : () => {}
        const capture = async () => {
            if (!activeRef.current || state.options.mode === 'controller') return
            setError('')
            try {
                const element = target()
                if (!element) return
                try { await element.requestPointerLock({ unadjustedMovement: true } as any) }
                catch (failure) { if (failure.name === 'NotSupportedError') await element.requestPointerLock(); else throw failure }
                if (disposed || !activeRef.current) { if (document.pointerLockElement === element) document.exitPointerLock(); return }
                state.captured = document.pointerLockElement === element; setCaptured(state.captured)
            } catch { if (!disposed) setError('Mouse capture failed. Click Capture input to retry.') }
        }
        const editable = (target: EventTarget) => target instanceof HTMLElement && !!target.closest('input,textarea,select,[contenteditable="true"]')
        const key = (event: KeyboardEvent) => {
            if (event.code === 'Escape' && state.captured) { event.preventDefault(); release(); return }
            if (event.code === 'F9' && !event.repeat && !editable(event.target) && activeRef.current && state.options.mode !== 'controller') {
                event.preventDefault(); if (state.captured) release(); else capture(); return
            }
            if (!state.captured) return
            event.preventDefault(); event.stopPropagation()
            state.key(event.code, event.type === 'keydown')
        }
        const mouse = (event: MouseEvent) => {
            if (!state.captured) return
            event.preventDefault(); event.stopPropagation()
            state.mouse(event.type === 'mousemove' ? Math.round(event.movementX) : 0, event.type === 'mousemove' ? Math.round(event.movementY) : 0, event.buttons)
        }
        const wheel = (event: WheelEvent) => {
            if (!state.captured) return
            event.preventDefault(); event.stopPropagation()
            const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1
            state.mouse(0, 0, event.buttons, Math.round(event.deltaX * scale), -Math.round(event.deltaY * scale))
        }
        const lock = () => { if (document.pointerLockElement !== target()) release() }
        const context = (event: Event) => { if (state.captured) event.preventDefault() }
        const start = () => capture()
        const area = captureArea.current
        area?.addEventListener('console-capture', start)
        window.addEventListener('keydown', key, true); window.addEventListener('keyup', key, true)
        for (const name of ['mousemove', 'mousedown', 'mouseup']) window.addEventListener(name, mouse, true)
        window.addEventListener('wheel', wheel, { capture: true, passive: false })
        window.addEventListener('blur', release); document.addEventListener('pointerlockchange', lock); window.addEventListener('contextmenu', context)
        return () => {
            disposed = true; release(); state.onRelease = undefined; unsubscribe(); area?.removeEventListener('console-capture', start)
            window.removeEventListener('keydown', key, true); window.removeEventListener('keyup', key, true)
            for (const name of ['mousemove', 'mousedown', 'mouseup']) window.removeEventListener(name, mouse, true)
            window.removeEventListener('wheel', wheel, true); window.removeEventListener('blur', release)
            document.removeEventListener('pointerlockchange', lock); window.removeEventListener('contextmenu', context)
        }
    }, [state, headless, active])

    if (!active) return null
    return <div ref={captureArea} data-console-input style={{ position: 'fixed', bottom: 12, right: 12, zIndex: 100, background: '#202328', padding: 12, borderRadius: 6, maxWidth: 520 }}>
        {headless && <strong>Headless console input</strong>}
        <InputModeSettings compact />
        {settings.input_mode !== 'controller' && <>
            <button type="button" onClick={() => captureArea.current?.dispatchEvent(new Event('console-capture'))}>Capture input</button>
            <span role="status"> {captured ? 'Captured — Escape or F9 releases input' : 'Released — click Capture input or press F9'}</span>
        </>}
        {error && <p role="alert">{error}</p>}
    </div>
}
