import React from 'react'
import Head from 'next/head'
import SettingsSidebar from '../../components/settings/sidebar'
import Card from '../../components/ui/card'
import Button from '../../components/ui/button'
import Ipc from '../../lib/ipc'
import { useSettings } from '../../context/userContext'
import { useTranslation } from 'react-i18next'


function SettingsWebUI() {
    const { settings, setSettings} = useSettings()
    const [webuiRunning, setWebuiRunning] = React.useState(false)
    const { t } = useTranslation()

    React.useEffect(() => {
        const webuiStatusInterval = setInterval(() => {
            Ipc.send('settings', 'getWebUIStatus').then((status) => {
                setWebuiRunning(status)
            })
        }, 1000)

        Ipc.send('settings', 'getWebUIStatus').then((status) => {
            setWebuiRunning(status)
        })

        return () => {
            clearInterval(webuiStatusInterval)
        }
    })

    function setWebUIEnabled(){
        Ipc.send('settings', (webuiRunning) ? 'stopWebUI' : 'startWebUI').then((status) => {
            setWebuiRunning(status)
        })
    }

    function setWebUIAutostart(){
        setSettings({
            ...settings,
            webui_autostart: (! settings.webui_autostart),
        })
    }

    function setWebUIPort(e){
        setSettings({
            ...settings,
            webui_port: e.target.value,
        })
    }

    return (
        <React.Fragment>
            <Head>
                <title>Greenlight - {t('settings.webUI.pageTitle')}</title>
            </Head>

            <SettingsSidebar>
                <Card>
                    <h1>{t('settings.webUI.title')}</h1>

                    <p>
                        <label>{t('settings.webUI.enableWebUILabel')}</label>
                        <label style={{ minWidth: 0 }}>
                            <Button onClick={ () => setWebUIEnabled() } disabled={ window.Greenlight.isWebUI() } className={ ((webuiRunning) ? 'btn-cancel' : 'btn-primary') + ' btn-small' } label={ webuiRunning ? t('settings.webUI.stopWebUIBtn') : t('settings.webUI.startWebUIBtn') }></Button> &nbsp;
                            <Button onClick={ () => window.Greenlight.openExternal('http://127.0.0.1:'+settings.webui_port) } className={ 'btn-small' } label={ t('settings.webUI.openWebUIBtn') }></Button>
                        </label>
                    </p>

                    <p>
                        <label>{t('settings.webUI.autostartLabel')}</label>
                        <label style={{ minWidth: 0 }}>
                            <input type='checkbox' onChange={ setWebUIAutostart } checked={settings.webui_autostart} />&nbsp; ({ settings.webui_autostart ? t('settings.webUI.autostartEnabled') : t('settings.webUI.autostartDisabled') })
                        </label>
                    </p>

                    <p>
                        <label>{t('settings.webUI.portLabel')}</label>
                        <label style={{ minWidth: 0 }}>
                            <input type="text" onChange={ setWebUIPort} className="text" placeholder={t('settings.webUI.portPlaceholder')} value={ settings.webui_port || 9003 } />
                        </label>
                    </p>
                </Card>
            </SettingsSidebar>


        </React.Fragment>
    )
}

export default SettingsWebUI
