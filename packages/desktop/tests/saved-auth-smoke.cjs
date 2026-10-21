const assert = require('node:assert/strict')
const path = require('node:path')
const { _electron } = require('playwright')
;(async () => {
    const app = await _electron.launch({ args: [path.join(__dirname, 'smoke-fixture.cjs')], cwd: path.resolve(__dirname, '..'), env: { ...process.env, TEST_SAVED_AUTH: '1' } })
    try {
        await app.firstWindow()
        const state = await app.evaluate(() => ({ refresh: global.savedAuthRefresh, fallback: global.savedAuthFallback }))
        assert.equal(state.refresh, true, 'Saved encrypted Xbox tokens must be loaded after Windows encryption becomes available')
        assert.equal(state.fallback, false, 'A saved session must try refresh before opening pairing')
        console.log('PASS: saved encrypted Xbox session is loaded after app ready and uses silent refresh without pairing or account network calls')
    } finally {
        try { await app.evaluate(() => global.clearSavedAuthTest()) } finally { await app.close() }
    }
})().catch(error => { console.error(error); process.exitCode = 1 })
