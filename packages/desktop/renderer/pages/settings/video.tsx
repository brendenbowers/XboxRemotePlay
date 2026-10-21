import React from 'react'
import Head from 'next/head'
import SettingsSidebar from '../../components/settings/sidebar'
import Card from '../../components/ui/card'
import Ipc from '../../lib/ipc'
import { useSettings } from '../../context/userContext'
import { useTranslation } from 'react-i18next'


function SettingsVideo() {
    const { settings, setSettings} = useSettings()
    const { t } = useTranslation()

    const [outputs, setOutputs] = React.useState<MediaDeviceInfo[]>([])
    const [audioError, setAudioError] = React.useState('')
    React.useEffect(() => {
        let active = true
        const refresh = async () => {
            try {
                const devices = await navigator.mediaDevices.enumerateDevices()
                if (active) setOutputs(devices.filter(device => device.kind === 'audiooutput' && device.deviceId !== 'default'))
            } catch {
                if (active) setAudioError('Unable to list audio outputs. Windows Default is still available.')
            }
        }
        refresh()
        navigator.mediaDevices?.addEventListener('devicechange', refresh)
        return () => {
            active = false
            navigator.mediaDevices?.removeEventListener('devicechange', refresh)
        }
    }, [])

    async function setAudioOutput(deviceId: string) {
        try {
            await new Audio().setSinkId(deviceId)
            setSettings({ ...settings, audio_output_device: deviceId })
            setAudioError('')
        } catch {
            setAudioError('Unable to select that output. Check it is connected and try again.')
        }
    }

    function setVideoSize(e){
        setSettings({
            ...settings,
            video_size: e,
        })
    }

    function forceLowResolution(){
        Ipc.send('settings', 'setLowResolution').then(() => {
            console.log('Resizing main window...')
            setSettings({
                ...settings,
                app_lowresolution: (!settings.app_lowresolution),
            })
        })
    }

    function setAudioEnabled(){
        setSettings({
            ...settings,
            audio_enabled: (!settings.audio_enabled),
        })
    }

    function setVideoEnabled(){
        setSettings({
            ...settings,
            video_enabled: (!settings.video_enabled),
        })
    }

    return (
        <React.Fragment>
            <Head>
                <title>Greenlight - {t('settings.videoAudio.pageTitle')}</title>
            </Head>

            <SettingsSidebar>
                <Card>
                    <h1>{t('settings.videoAudio.title')}</h1>

                    <p>
                        <label>{t('settings.videoAudio.disableVideoLabel')}</label>
                        <label style={{ minWidth: 0 }}>
                            <input type='checkbox' onChange={ setVideoEnabled } checked={!settings.video_enabled} />&nbsp; ({ !settings.video_enabled ? t('settings.videoAudio.enabledLabel') : t('settings.videoAudio.disabledLabel')})
                        </label>
                    </p>

                    <p>
                        <label htmlFor="aspect-size">{t('settings.videoAudio.aspectSizeLabel')}</label>
                        <select id="aspect-size" value={ settings.video_size } onChange={(e) => {
                            setVideoSize(e.target.value)
                        }}>
                            <option value='default'>{t('settings.videoAudio.aspectSizeValueDefault')}</option>
                            <option value='stretch'>{t('settings.videoAudio.aspectSizeValueStretch')}</option>
                            <option value='zoom'>{t('settings.videoAudio.aspectSizeValueZoom')}</option>
                        </select>
                    </p>

                    <p>
                        <label>{t('settings.videoAudio.forceLowResLabel')}</label>
                        <label style={{ minWidth: 0 }}>
                            <input type='checkbox' onChange={ forceLowResolution } checked={settings.app_lowresolution} />&nbsp; ({ settings.app_lowresolution ? t('settings.videoAudio.enabledLabel') : t('settings.videoAudio.disabledLabel')})
                        </label><br />
                        <small>{t('settings.videoAudio.forceLowResDescription')}</small>
                    </p>
                </Card>

                <Card>
                    <h1>{t('settings.videoAudio.audioTitle')}</h1>

                    <p>
                        <label htmlFor="audio-output">Audio output device</label>
                        <select id="audio-output" value={settings.audio_output_device} onChange={event => setAudioOutput(event.target.value)}>
                            <option value="">Windows Default</option>
                            {settings.audio_output_device && !outputs.some(device => device.deviceId === settings.audio_output_device) &&
                                <option value={settings.audio_output_device}>Saved device (unavailable)</option>}
                            {outputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Audio output ${index + 1}`}</option>)}
                        </select><br />
                        <small>Used for stream audio. Unavailable devices fall back to Windows Default.</small>
                    </p>
                    {audioError && <p role="alert">{audioError}</p>}

                    <p>
                        <label>{t('settings.videoAudio.disableAudioLabel')}</label>
                        <label style={{ minWidth: 0 }}>
                            <input type='checkbox' onChange={ setAudioEnabled } checked={!settings.audio_enabled} />&nbsp; ({ !settings.audio_enabled ? t('settings.videoAudio.enabledLabel') : t('settings.videoAudio.disabledLabel')})
                        </label>
                    </p>
                </Card>
            </SettingsSidebar>


        </React.Fragment>
    )
}

export default SettingsVideo
