import { createWindow } from './helpers'
import Application from './application'
import { Msal } from 'xal-node'
import AuthTokenStore from './helpers/tokenstore'
import i18n from 'i18next';
import { getPairingDetails, PairingDetails } from '../shared/pairing'


export default class Authentication {
    _application:Application

    _tokenStore:AuthTokenStore
    _msal:Msal

    _authWindow
    _authCallback

    _isAuthenticating:boolean = false
    _isAuthenticated:boolean = false
    _appLevel:number = 0
    _pairing:PairingDetails | null = null
    _authError = ''

    private t = i18n.t.bind(i18n);

    constructor(application:Application){
        this._application = application
        this._tokenStore = new AuthTokenStore()
        this._msal = new Msal(this._tokenStore)
    }

    checkAuthentication(){
        // Windows safeStorage is unavailable before Electron's ready event.
        this._tokenStore.load()
        this._application.log('authenticationV2', '[checkAuthentication()] Starting token check...')
        if(this._tokenStore.hasValidAuthTokens()){

            // Deprecate xal token.
            if(this._tokenStore.getUserToken() !== undefined && this._tokenStore.getUserToken().data.scope != 'XboxLive.signin'){
                this._application.log('authenticationV2', '[checkAuthentication()] Deprecating old XAL token scope. Starting auth flow to get new tokens.')
                return false
            }

            this._application.log('authenticationV2', '[checkAuthentication()] Tokens are valid')
            this.startSilentFlow()

            return true

        } else {
            if(this._tokenStore.getUserToken() !== undefined){
                // We have a user token, lets try to refresh it.
                this._application.log('authenticationV2', '[checkAuthentication()] Tokens are expired but we have a user token. Lets try to refresh the tokens.')
                this.startSilentFlow()

                return true

            } else {
                this._application.log('authenticationV2', '[checkAuthentication()] No tokens are present.')
                return false
            }
        }
    }

    startSilentFlow(){
        this._application.log('authenticationV2', '[startSilentFlow()] Starting silent flow...')
        this._isAuthenticating = true

        const forceRegionIp = this._application._store.get('force_region_ip', '')
        if (forceRegionIp && typeof forceRegionIp === 'string' && forceRegionIp.trim() !== '') {
            this._msal.setDefaultHeaders({ 'X-Forwarded-For': forceRegionIp.trim() })
            this._application.log('authenticationV2', '[startSilentFlow()] Using X-Forwarded-For:', forceRegionIp)
        } else {
            this._msal.setDefaultHeaders({})
        }

        this.getTokens()
    }

    getTokens(){
        this.getStreamingToken().then((streamingTokens) => {
            this._application.log('authenticationV2', '[getTokens()] Retrieved streaming tokens')

            if(streamingTokens.xCloudToken !== undefined){
                this._application.log('authenticationV2', '[getTokens()] Retrieved both xHome and xCloud tokens')
                this._appLevel = 2
            } else {
                this._application.log('authenticationV2', '[getTokens()] Retrieved xHome token only')
                this._appLevel = 1
            }

            this._msal.getWebToken().then((webToken) => {
                this._application.log('authenticationV2', __filename+'[getTokens()] Web token received')
                this._application.authenticationCompleted(streamingTokens, webToken)

            }).catch((error) => {
                this._application.log('authenticationV2', __filename+'[getTokens()] Failed to retrieve web tokens:', error)
                this._isAuthenticating = false
                this._authError = 'Could not finish signing in. Please try again.'
            })

        }).catch((err) => {
            this._application.log('authenticationV2', '[startSilentFlow()] Failed to retrieve streaming tokens:', err)
            // @TODO: If we fail to get streaming tokens, we should probably start the auth flow to let the user re-authenticate and get new tokens.
            this._isAuthenticating = false
            this.startAuthflow()
        })
    }

    startAuthflow(){
        if (this._isAuthenticating) return
        this._isAuthenticating = true
        this._pairing = null
        this._authError = ''
        this._application.log('authenticationV2', '[startAuthflow()] Starting authentication flow')

        const forceRegionIp = this._application._store.get('force_region_ip', '')
        if (forceRegionIp && typeof forceRegionIp === 'string' && forceRegionIp.trim() !== '') {
            this._msal.setDefaultHeaders({ 'X-Forwarded-For': forceRegionIp.trim() })
            this._application.log('authenticationV2', '[startSilentFlow()] Using X-Forwarded-For:', forceRegionIp)
        } else {
            this._msal.setDefaultHeaders({})
        }

        this._msal.doDeviceCodeAuth().then((data) => {
            this._application.log('authenticationV2', '[startAuthflow()] Starting devicecode auth')

            this._pairing = getPairingDetails(data)
            return this._msal.doPollForDeviceCodeAuth(data.device_code, data.expires_in * 1000)
        }).then(() => {
                this._application.log('authenticationV2', '[startAuthflow()] Devicecode authentication successful')
                this._pairing = null
                this.getTokens()
        }).catch((error) => {
            this._application.log('authenticationV2', '[startAuthflow()] Sign-in did not complete')
            this._isAuthenticating = false
            this._pairing = null
            this._authError = 'Sign-in expired or could not be completed. Please try again for a new code.'
        })
    }

    openAuthWindow(url){
        const authWindow = createWindow('auth', {
            width: 500,
            height: 600,
            title: this.t('auth.windowTitle'),
        })

        authWindow.loadURL(url)
        this._authWindow = authWindow

        this._authWindow.on('close', () => {
            this._application.log('authenticationV2', '[openAuthWindow()] Closed auth window')
            // @TODO: What to do?
        })
    }

    async getStreamingToken(){
        const userToken = this._tokenStore.getUserToken()
        if(userToken === undefined)
            throw new Error( this.t('errors.sisuTokenIsMissing') )

        this._application.log('authenticationV2', '[getStreamingToken()] Found local token')

        const streamingTokens = await this._msal.getStreamingTokens()
        this._application.log('authenticationV2', '[getStreamingToken()] Retrieved streaming tokens')

        return { xHomeToken: streamingTokens.xHomeToken, xCloudToken: streamingTokens.xCloudToken }
        // return { xHomeToken: streamingTokens.xHomeToken, xCloudToken: undefined }
    }


}
