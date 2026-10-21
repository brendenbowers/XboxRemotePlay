import { TokenStore } from 'xal-node'
import Store from 'electron-store'
import { safeStorage } from 'electron'

export default class AuthTokenStore extends TokenStore {

    private _store = new Store()

    load() {
        const encrypted = this._store.get('user.encryptedTokens')
        if (typeof encrypted !== 'string' || !safeStorage.isEncryptionAvailable()) return false
        try {
            this.loadJson(safeStorage.decryptString(Buffer.from(encrypted, 'base64')))
        } catch {
            this.clear()
            return false
        }

        return true
    }

    save() {
        const data = JSON.stringify({
            userToken: this._userToken?.data,
            sisuToken: this._sisuToken?.data,
            jwtKeys: this._jwtKeys,
        })

        if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows account token encryption is unavailable')
        this._store.set('user.encryptedTokens', safeStorage.encryptString(data).toString('base64'))
    }

    clear() {
        this._store.delete('user.encryptedTokens')
        this._store.delete('user.tokenstore')
        this._userToken = undefined
        this._sisuToken = undefined
        this._jwtKeys = undefined
    }

    removeAll() {
        this._store.delete('user.encryptedTokens')
        this._userToken = undefined
        this._sisuToken = undefined

        this._store.delete('user.tokenstore')
    }
}
