import React from 'react'
import Ipc from '../lib/ipc'
import Image from 'next/image'

import Card from '../components/ui/card'
import Button from './ui/button'
import Loader from './ui/loader'

import { useTranslation } from 'react-i18next'
import type { PairingDetails } from '../../shared/pairing'

interface AuthProps {
  signedIn: boolean;
  gamertag?: string;
  gamerpic?: string;
  gamerscore?: string;
  isLoading?: boolean;
  pairing?: PairingDetails | null;
  authError?: string;
}

function Auth({
    signedIn = false,
    gamertag,
    gamerpic,
    gamerscore,
    isLoading = false,
    pairing = null,
    authError = '',
}: AuthProps) {
    const { t } = useTranslation()
    const [pairingNotice, setPairingNotice] = React.useState('')

    React.useEffect(() => setPairingNotice(''), [pairing?.code])

    async function pairingAction(action: 'copyPairingCode' | 'openPairingPage') {
        try {
            await Ipc.send('app', action)
            setPairingNotice(action === 'copyPairingCode' ? 'Code copied.' : 'Sign-in page opened in your browser.')
        } catch {
            setPairingNotice('This code may have expired. Request a new code and try again.')
        }
    }

    function startAuthFlow(){
        Ipc.send('app', 'login')
    }

    function logout(){
        if(confirm(t('auth.logoutQuestion'))){
            Ipc.send('app', 'clearData')
        }
    }

    function clearData(){
        if(confirm(t('auth.clearDataQuestion'))){
            Ipc.send('app', 'clearData')
        }
    }

    return (
        <React.Fragment>
            <div id="component_auth">

                <div id="component_auth_modal">
                    {pairing ? <Card>
                        <div className="pairing-panel">
                            <h1>Sign in to Console Stream</h1>
                            <p>Open Microsoft’s sign-in page and enter this code.</p>
                            <label htmlFor="pairing-code">Your pairing code</label>
                            <input id="pairing-code" readOnly value={pairing.code} onFocus={event => event.target.select()} />
                            <div className="pairing-actions">
                                <button type="button" className="btn btn-primary" onClick={() => pairingAction('copyPairingCode')}>Copy code</button>
                                <button type="button" className="btn" onClick={() => pairingAction('openPairingPage')}>Open sign-in page</button>
                            </div>
                            <a href={pairing.url} onClick={event => { event.preventDefault(); pairingAction('openPairingPage') }}>{pairing.url}</a>
                            <p>Use the Microsoft account linked to your Xbox. You can open this address on another device too.</p>
                            <p>Code expires at {new Date(pairing.expiresAt).toLocaleTimeString()}. This app will continue automatically after you sign in.</p>
                            <p role="status" aria-live="polite">{pairingNotice || 'Waiting for you to finish signing in…'}</p>
                        </div>
                    </Card> : isLoading === false ?
                        <Card>
                            {authError && <p role="alert">{authError}</p>}
                            {signedIn === true ? (<div className="component_auth_profile_container">
                                <div className="component_auth_profile_gamerpic">
                                    <Image src={ gamerpic } className="component_auth_profile_gamerpic_img" alt={ gamertag } width='96' height='96'></Image>
                                </div>

                                <div className="component_auth_profile_userdetails">
                                    <h1>{ gamertag }</h1>
                                    <p>
                                        {t('auth.gamerscore')}: { gamerscore }
                                    </p>
                                    {/* <p>
                                        {t('auth.loggingIn')}
                                    </p> */}
                                    <Button label={t('auth.loginBtn')} className='btn-primary' onClick={ () => {
                                        startAuthFlow()
                                    } }></Button> &nbsp;
                                    <Button label={t('auth.logoutBtn')} className='btn' onClick={ () => {
                                        logout()
                                    } }></Button>
                                </div>

                            </div>) : (<div style={{
                                textAlign: 'center',
                                paddingBottom: '20px',
                            }}>
                                <h1>{t('auth.loginWithXbox')}</h1>
                                <p>
                                    {t('auth.pleaseAuthenticate')}
                                </p>
                                <Button label={t('auth.loginBtn')} className='btn-primary' onClick={ () => {
                                    startAuthFlow()
                                } }></Button> &nbsp;
                                <Button label={t('auth.clearDataBtn')} className='btn' onClick={ () => {
                                    clearData()
                                } }></Button>
                            </div>) }
                        </Card>:<Card><div style={{
                            textAlign: 'center',
                        }}><Loader></Loader><br /></div></Card>
                    }
                </div>
            </div>
        </React.Fragment>
    )
}

export default Auth
