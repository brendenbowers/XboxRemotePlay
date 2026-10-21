import React from 'react'
import Head from 'next/head'
import SettingsSidebar from '../../components/settings/sidebar'
import Card from '../../components/ui/card'
import { useSettings } from '../../context/userContext'
import { InputModeSettings } from '../../components/inputcontrols'

export default function SettingsInput() {
    const { settings, setSettings } = useSettings()
    const [, refresh] = React.useState(0)
    React.useEffect(() => {
        const timer = setInterval(() => refresh(value => value + 1), 1000)
        return () => clearInterval(timer)
    }, [])
    return <>
        <Head><title>Console Stream - Input</title></Head>
        <SettingsSidebar>
            <Card>
                <h1>Console input</h1>
                <InputModeSettings />
                <p>Change modes here or during local/headless play. Switching releases captured keys, buttons and sticks; connected controller mode works in the background.</p>
                <p><label><input type="checkbox" checked={settings.controller_vibration} onChange={e => setSettings({ ...settings, controller_vibration: e.target.checked })} /> Controller vibration</label></p>
                <p><label><input type="checkbox" checked={settings.input_touch} onChange={e => setSettings({ ...settings, input_touch: e.target.checked })} /> Touch input</label></p>
            </Card>
            <Card>
                <h1>Connected controllers</h1>
                {[...navigator.getGamepads()].filter(pad => pad?.connected).map(pad => <p key={pad.index}>{pad.id} ({pad.mapping || 'non-standard mapping'})</p>)}
                <p>Connected controller mode uses the first controller with a standard gamepad mapping.</p>
            </Card>
        </SettingsSidebar>
    </>
}
