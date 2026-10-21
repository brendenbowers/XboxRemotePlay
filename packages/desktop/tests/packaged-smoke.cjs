const assert = require('node:assert/strict')
const path = require('node:path')
const { _electron } = require('playwright')

;(async () => {
    const app = await _electron.launch({ executablePath: path.resolve(__dirname, '../dist/win-unpacked/Console Stream.exe') })
    try {
        const page = await app.firstWindow()
        await page.locator('#component_auth').waitFor()
        const state = await app.evaluate(({ app, BrowserWindow }) => ({
            packaged: app.isPackaged,
            name: app.getName(),
            backgroundThrottling: BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling(),
        }))
        assert.equal(state.packaged, true)
        assert.equal(state.name, 'Console Stream')
        assert.equal(state.backgroundThrottling, false)
        assert.match(page.url(), /^app:/)
        const publisher = await page.evaluate(() => window.Greenlight.discord('status'))
        assert.equal(publisher.account, 'disconnected')
        assert.equal(publisher.state, 'idle')
        if (process.env.TEST_CANARY_BRIDGE === '1') {
            const canary = await page.evaluate(() => window.Greenlight.discord('connect-canary'))
            assert.equal(canary.account, 'connected')
            assert.equal(canary.state, 'idle')
            assert(canary.channelId, 'Canary must retain its existing voice destination')
            const stopped = await page.evaluate(() => window.Greenlight.discord('disconnect'))
            assert.equal(stopped.account, 'disconnected')
            console.log('PASS: packaged IPC/native utility attaches to the existing Canary voice session and detaches without starting a share')
        }
        console.log('PASS: packaged executable reaches sign-in, disables background throttling, and loads its native Discord publisher')
    } finally {
        await app.close()
    }
})().catch(error => { console.error(error); process.exitCode = 1 })
