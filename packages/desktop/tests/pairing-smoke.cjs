const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { _electron } = require('playwright')

;(async () => {
    const app = await _electron.launch({
        args: [path.join(__dirname, 'smoke-fixture.cjs')],
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, TEST_PAIRING: '1' },
    })
    try {
        const page = await app.firstWindow()
        const code = page.getByLabel('Your pairing code')
        await code.waitFor()
        assert.equal(await code.inputValue(), 'TEST-1234')
        await code.focus()
        assert.equal(await code.evaluate(element => element.selectionEnd - element.selectionStart), 9)
        await page.getByRole('button', { name: 'Copy code', exact: true }).click()
        await page.getByRole('status').filter({ hasText: 'Code copied.' }).waitFor()
        await page.getByRole('button', { name: 'Open sign-in page', exact: true }).click()
        await page.getByRole('status').filter({ hasText: 'Sign-in page opened' }).waitFor()
        await page.getByRole('link', { name: 'https://microsoft.com/link', exact: true }).click()
        assert.deepEqual(await app.evaluate(() => global.pairingActions), [
            { action: 'copy', value: 'TEST-1234' },
            { action: 'open', value: 'https://microsoft.com/link' },
            { action: 'open', value: 'https://microsoft.com/link' },
        ])
        await page.evaluate(() => window.Greenlight.send('app', 'login'))
        assert.equal(await app.evaluate(() => global.pairingRequestCount), 1)
        const screenshot = path.resolve(__dirname, '../../..', '.cache', 'screenshots', 'pairing.png')
        fs.mkdirSync(path.dirname(screenshot), { recursive: true })
        await page.screenshot({ path: screenshot })
        await app.evaluate(() => global.rejectPairing(new Error('Test expiration')))
        await page.getByRole('alert').filter({ hasText: 'Sign-in expired' }).waitFor()
        await page.getByRole('button', { name: 'Login', exact: true }).click()
        await code.waitFor()
        assert.equal(await app.evaluate(() => global.pairingRequestCount), 2)
        console.log('PASS: selectable pairing code, copy action, button/link opening, duplicate prevention and retry after expiration')
    } finally {
        await app.close()
    }
})().catch(error => { console.error(error); process.exitCode = 1 })
