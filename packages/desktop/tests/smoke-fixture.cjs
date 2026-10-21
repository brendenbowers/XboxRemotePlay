// Exercise the real desktop bundle and settings IPC without using an Xbox account.
const path = require('node:path')
const { app, shell, clipboard } = require('electron')
const { Msal } = require('xal-node')
app.setAppPath(path.resolve(__dirname, '..'))
if (process.env.TEST_SAVED_AUTH === '1') {
    const Store = require('electron-store')
    const { safeStorage } = require('electron')
    global.savedAuthRefresh = false
    global.savedAuthFallback = false
    global.clearSavedAuthTest = () => new Store().delete('user.encryptedTokens')
    Msal.prototype.getStreamingTokens = () => { global.savedAuthRefresh = true; return new Promise(() => {}) }
    app.whenReady().then(() => {
        const synthetic = { userToken: { scope: 'XboxLive.signin', access_token: 'synthetic-test-only', refresh_token: 'synthetic-test-only', expires_in: 3600, expires_on: new Date(Date.now() + 3600000).toISOString() } }
        new Store().set('user.encryptedTokens', safeStorage.encryptString(JSON.stringify(synthetic)).toString('base64'))
    })
}
if (process.env.TEST_PAIRING === '1') {
    global.pairingActions = []
    global.pairingRequestCount = 0
    shell.openExternal = async url => { global.pairingActions.push({ action: 'open', value: url }) }
    clipboard.writeText = value => { global.pairingActions.push({ action: 'copy', value }) }
    Msal.prototype.doDeviceCodeAuth = async () => {
        global.pairingRequestCount++
        return { user_code: 'TEST-1234', verification_uri: 'https://microsoft.com/link', expires_in: 900, device_code: 'test-device-credential' }
    }
    Msal.prototype.doPollForDeviceCodeAuth = () => new Promise((resolve, reject) => { global.rejectPairing = reject })
} else {
    Msal.prototype.doDeviceCodeAuth = () => { global.savedAuthFallback = true; return new Promise(() => {}) }
}
require('../app/background.js')
if (process.env.TEST_CONSOLE_INPUT === '1') {
    const { ipcMain } = require('electron')
    global.inputPackets = []
    app.whenReady().then(() => {
        ipcMain.removeHandler('headless')
        ipcMain.handle('headless', (_event, action) => action === 'active' ? true : { active: true, stage: 'connected', receiver: {}, share: { state: 'idle' } })
        ipcMain.on('headless-input', (_event, state) => { global.inputPackets.push({ type: 'pad', state }); if (global.inputPackets.length > 500) global.inputPackets.shift() })
        ipcMain.on('headless-native-input', (_event, state) => { global.inputPackets.push({ type: 'native', state }); if (global.inputPackets.length > 500) global.inputPackets.shift() })
    })
}
