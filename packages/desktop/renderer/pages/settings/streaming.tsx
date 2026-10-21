import React from 'react'
import Head from 'next/head'

import SettingsSidebar from '../../components/settings/sidebar'
import Card from '../../components/ui/card'
import Ipc from '../../lib/ipc'

import { useTranslation } from 'react-i18next'

import { useSettings } from '../../context/userContext'
import { streamQualities } from '../../../shared/stream-quality'


function SettingsStreaming() {
    const { settings, setSettings} = useSettings()
    const { t } = useTranslation()

    React.useEffect(() => {
    //
    })

    function setxCloudBitrate(e){
        console.log('Set xCloud bitrate to:', e.target.value)
        setSettings({
            ...settings,
            xcloud_bitrate: parseInt(e.target.value),
        })
    }

    function setxHomeBitrate(e){
        console.log('Set xHome bitrate to:', e.target.value)
        setSettings({
            ...settings,
            xhome_bitrate: parseInt(e.target.value),
        })
    }

    function setVideoProfile(profile){
        console.log('Set video profile to:', profile)
        setSettings({
            ...settings,
            video_profiles: (profile !== '') ? [profile] : [],
        })
    }

    // video_profiles ([])

    function setPreferredGameLanguage(e){
        setSettings({
            ...settings,
            preferred_game_language: e,
        })

        Ipc.send('app', 'setPreferredGameLanguage', { language: e }).then((res) => {
            console.log('Set preferred game language:', res)
        })
    }

    function setForceRegionIp(e){
        setSettings({
            ...settings,
            force_region_ip: e,
        })

        Ipc.send('app', 'setForceRegionIp', { ip: e }).then((res) => {
            console.log('Set force region IP:', res)
        })
    }

    return (
        <React.Fragment>
            <Head>
                <title>Console Stream - {t('settings.streaming.pageTitle')}</title>
            </Head>

            <SettingsSidebar>
                <Card>
                    <h1>Console Remote Play</h1>
                    <p>
                        <label htmlFor="remote-play-resolution">Requested stream resolution</label>
                        <select id="remote-play-resolution" value={settings.xhome_resolution} onChange={event => setSettings({
                            ...settings,
                            xhome_resolution: Number(event.target.value),
                        })}>
                            {streamQualities.map(quality => <option key={quality.height} value={quality.height}>{quality.label}</option>)}
                        </select>
                    </p>
                    <p>Applies to your next console connection. Playback and controller polling continue when you switch to another window.</p>
                    <p>4K sends a 3840 × 2160 request. The console may deliver a lower resolution or reject the request. The stream overlay shows the actual received video size.</p>
                </Card>
                <Card>
                    <h1>Discord output profile</h1>
                    <p>
                        <label htmlFor="discord-resolution">Resolution for Discord shares</label>
                        <select id="discord-resolution" value={settings.discord_resolution} onChange={event => setSettings({
                            ...settings,
                            discord_resolution: Number(event.target.value),
                        })}>
                            {streamQualities.map(quality => <option key={quality.height} value={quality.height}>{quality.label}</option>)}
                        </select>
                    </p>
                    <p>
                        <label htmlFor="discord-bitrate">Bitrate for Discord shares</label>
                        <input id="discord-bitrate" type="range" min="1024" max="39936" step="512" value={settings.discord_bitrate} onChange={event => setSettings({
                            ...settings,
                            discord_bitrate: parseInt(event.target.value),
                        })} />
                        ({(settings.discord_bitrate / 1024).toFixed(1)} Mbps)
                    </p>
                    <p><label htmlFor="discord-bitrate-override"><input id="discord-bitrate-override" type="checkbox" checked={settings.discord_bitrate_override}
                        onChange={event => setSettings({ ...settings, discord_bitrate_override: event.target.checked })} /> Override Discord's bitrate estimate (headless)</label></p>
                    <p>Override keeps the bitrate above as a fixed Xbox request, without automatic probing or loss backoff. Use about 15 Mbps for a 1440p experiment; excessive rates can buffer. Resolution remains a requested maximum. This setting applies to the next headless connection; the console card can switch modes live.</p>
                    <p>Start game share restarts the console stream with this profile if it is running with other settings, then starts the share. Local play without Discord keeps the settings above. The bitrate is the starting Xbox request; headless mode then adapts it to Discord's bandwidth estimate. Raising it cannot guarantee a higher sustained resolution.</p>
                    <p>
                        <label htmlFor="reconnect-attempts">Reconnect attempts after a drop</label>
                        <select id="reconnect-attempts" value={settings.reconnect_attempts} onChange={event => setSettings({
                            ...settings,
                            reconnect_attempts: Number(event.target.value),
                        })}>
                            <option value={0}>Off</option>
                            {[3, 5, 10, 25].map(count => <option key={count} value={count}>{count}</option>)}
                            <option value={-1}>Unlimited</option>
                        </select>
                    </p>
                    <p>When the Discord share or a headless console session drops, Console Stream retries with increasing waits (2 s, 4 s, 8 s … up to 1 minute). A minute of healthy streaming resets the count; Stop cancels retrying.</p>
                    <p>The resolution is a requested maximum. Headless mode probes 15 Mbps for 1440p (30 Mbps for experimental 4K) for up to 20 seconds. It keeps that rate only if the requested source size is reached and video above Discord's estimate is delivered with clean reports. Packet loss, a substantial estimate drop or missing delivery reports restores normal adaptation. Video is forwarded without scaling; check the actual sent size. Sender measurements do not prove the viewer's decoded resolution.</p>
                </Card>
                <Card>
                    <h1>{t('settings.streaming.title')}</h1>

                    <p>{t('settings.streaming.description')}</p>
                    <p>

                        <label>{t('settings.streaming.xCloudStreamingBitrateLabel')}</label>
                        <input type="range" min="0" max="40960" step="1024" value={settings.xcloud_bitrate} onChange={ setxCloudBitrate } />
                ({ settings.xcloud_bitrate === 0 ? t('settings.streaming.unlimitedLabel') : Math.floor(settings.xcloud_bitrate / 1024) + ' ' + t('settings.streaming.mbpsLabel') })
                    </p>
                    <p>
                        <label>{t('settings.streaming.xHomeStreamingBitrateLabel')}</label>
                        <input type="range" min="0" max="40960" step="1024" value={settings.xhome_bitrate} onChange={ setxHomeBitrate } />
                ({ settings.xhome_bitrate === 0 ? t('settings.streaming.unlimitedLabel') : Math.floor(settings.xhome_bitrate / 1024) + ' ' + t('settings.streaming.mbpsLabel') })
                    </p>

                    <p>
                        <label>{t('settings.streaming.setH264ProfileLabel')}</label>
                        <select value={ (settings.video_profiles.length > 0) ? settings.video_profiles[0] : '' } onChange={ (e) => setVideoProfile(e.target.value) }>
                            <option value="">{t('settings.streaming.setH264ProfileValueAuto')}</option>
                            <option value="4d">{t('settings.streaming.setH264ProfileValueHigh')}</option>
                            <option value="42e">{t('settings.streaming.setH264ProfileValueMedium')}</option>
                            <option value="420">{t('settings.streaming.setH264ProfileValueLow')}</option>
                        </select>
                    </p>

                </Card>

                <Card>
                    <h1>{t('settings.streaming.forceRegionTitle')}</h1>
                    <p>

                        <label>{t('settings.streaming.setRegionLabel')}</label>
                        <select value={ settings.force_region_ip || '' } onChange={ (e) => setForceRegionIp(e.target.value) }>
                            <option value="">{t('settings.streaming.setRegionValueDisabled')}</option>
                            <option value="203.41.44.20">{t('settings.streaming.setRegionValueAustralia')}</option>
                            <option value="200.221.11.101">{t('settings.streaming.setRegionValueBrazil')}</option>
                            <option value="194.25.0.68">{t('settings.streaming.setRegionValueEurope')}</option>
                            <option value="122.1.0.154">{t('settings.streaming.setRegionValueJapan')}</option>
                            <option value="203.253.64.1">{t('settings.streaming.setRegionValueKorea')}</option>
                            <option value="4.2.2.2">{t('settings.streaming.setRegionValueUS')}</option>
                        </select>
                    </p>
                    <p>
                        <label>{t('settings.streaming.preferredGameLanguageLabel')}</label>
                        {(() => {
                            const languages = [
                                { code: "ar-SA", label: t('settings.streaming.preferredGameLanguageValueArabic') },
                                { code: "cs-CZ", label: t('settings.streaming.preferredGameLanguageValueCzech') },
                                { code: "da-DK", label: t('settings.streaming.preferredGameLanguageValueDanish') },
                                { code: "de-DE", label: t('settings.streaming.preferredGameLanguageValueGerman') },
                                { code: "el-GR", label: t('settings.streaming.preferredGameLanguageValueGreek') },
                                { code: "en-GB", label: t('settings.streaming.preferredGameLanguageValueEnglishUK') },
                                { code: "en-US", label: t('settings.streaming.preferredGameLanguageValueEnglishUS') },
                                { code: "es-ES", label: t('settings.streaming.preferredGameLanguageValueSpanish') },
                                { code: "es-MX", label: t('settings.streaming.preferredGameLanguageValueSpanishMX') },
                                { code: "fi-FI", label: t('settings.streaming.preferredGameLanguageValueFinnish') },
                                { code: "fr-FR", label: t('settings.streaming.preferredGameLanguageValueFrench') },
                                { code: "he-IL", label: t('settings.streaming.preferredGameLanguageValueHebrew') },
                                { code: "hu-HU", label: t('settings.streaming.preferredGameLanguageValueHungarian') },
                                { code: "it-IT", label: t('settings.streaming.preferredGameLanguageValueItalian') },
                                { code: "ja-JP", label: t('settings.streaming.preferredGameLanguageValueJapanese') },
                                { code: "ko-KR", label: t('settings.streaming.preferredGameLanguageValueKorean') },
                                { code: "nb-NO", label: t('settings.streaming.preferredGameLanguageValueNorwegian') },
                                { code: "nl-NL", label: t('settings.streaming.preferredGameLanguageValueDutch') },
                                { code: "pl-PL", label: t('settings.streaming.preferredGameLanguageValuePolish') },
                                { code: "pt-BR", label: t('settings.streaming.preferredGameLanguageValuePortugueseBR') },
                                { code: "pt-PT", label: t('settings.streaming.preferredGameLanguageValuePortuguese') },
                                { code: "ru-RU", label: t('settings.streaming.preferredGameLanguageValueRussian') },
                                { code: "sk-SK", label: t('settings.streaming.preferredGameLanguageValueSlovak') },
                                { code: "sv-SE", label: t('settings.streaming.preferredGameLanguageValueSwedish') },
                                { code: "tr-TR", label: t('settings.streaming.preferredGameLanguageValueTurkish') },
                                { code: "zh-CN", label: t('settings.streaming.preferredGameLanguageValueChineseCN') },
                                { code: "zh-TW", label: t('settings.streaming.preferredGameLanguageValueChineseTW') },
                            ];
                            // Sort languages alphabetically by label
                            const sortedLanguages = languages.sort((a, b) => a.label.localeCompare(b.label));
                            return (
                                <select value={settings.preferred_game_language || ''} onChange={(e) => setPreferredGameLanguage(e.target.value)}>
                                    {sortedLanguages.map(lang => (
                                        <option key={lang.code} value={lang.code}>{lang.label}</option>
                                    ))}
                                </select>
                            );
                        })()}
                    </p>
                </Card>
            </SettingsSidebar>


        </React.Fragment>
    )
}

export default SettingsStreaming
