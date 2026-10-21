const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { _electron } = require('playwright')

;(async () => {
    const app = await _electron.launch({ args: [path.join(__dirname, 'smoke-fixture.cjs')], cwd: path.resolve(__dirname, '..') })
    try {
        const page = await app.firstWindow()
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        const native = await app.evaluate(({ app, ipcMain, BrowserWindow, safeStorage }) => {
            // Mock account identity only; keep the production settings IPC and persistence.
            const user = { signedIn: true, gamertag: 'UI test', gamerpic: '', gamerscore: '', level: 1 }
            ipcMain.removeAllListeners('app')
            ipcMain.on('app', (event, args) => {
                const data = args.action === 'getAuthState' ? { isAuthenticated: true, isAuthenticating: false, user }
                    : args.action === 'loadCachedUser' ? user
                        : args.action === 'getOnlineFriends' ? [] : { autoStream: '' }
                event.sender.send('app', { id: args.id, action: args.action, data })
            })
            const encrypted = safeStorage.encryptString('test value, not a credential')
            return {
                backgroundThrottling: BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling(),
                timerThrottlingDisabled: app.commandLine.hasSwitch('disable-background-timer-throttling'),
                encryptionWorks: safeStorage.decryptString(encrypted) === 'test value, not a credential',
            }
        })
        assert.equal(native.backgroundThrottling, false)
        assert.equal(native.timerThrottlingDisabled, true)
        assert.equal(native.encryptionWorks, true)
        await page.goto('app://./settings/streaming.html')
        const quality = page.getByLabel('Requested stream resolution')
        await quality.waitFor()
        await quality.selectOption('2160')
        await page.waitForFunction(async () => (await window.Greenlight.send('settings', 'getSettings')).xhome_resolution === 2160)
        await page.reload()
        await quality.waitFor()
        await page.waitForFunction(() => document.querySelector('#remote-play-resolution')?.value === '2160')
        assert.equal(await quality.inputValue(), '2160')
        assert.match(await page.locator('body').innerText(), /3840 × 2160 request/)
        const discordQuality = page.getByLabel('Resolution for Discord shares')
        await discordQuality.selectOption('2160')
        await page.waitForFunction(async () => (await window.Greenlight.send('settings', 'getSettings')).discord_resolution === 2160)
        await page.reload()
        await page.waitForFunction(() => document.querySelector('#discord-resolution')?.value === '2160')
        assert.equal(await discordQuality.inputValue(), '2160')
        const bitrateOverride = page.getByLabel("Override Discord's bitrate estimate (headless)")
        await bitrateOverride.check()
        await page.waitForFunction(async () => (await window.Greenlight.send('settings', 'getSettings')).discord_bitrate_override === true)
        await page.reload()
        await bitrateOverride.waitFor()
        assert.equal(await bitrateOverride.isChecked(), true)
        await page.evaluate(() => {
            window.smokeTicks = 0
            window.smokeTimer = setInterval(() => window.smokeTicks++, 50)
        })
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
        await new Promise(resolve => setTimeout(resolve, 1500))
        assert((await page.evaluate(() => window.smokeTicks)) >= 10, 'Renderer timers should continue in the background')
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())
        const screenshots = path.resolve(__dirname, '../../..', '.cache', 'screenshots')
        fs.mkdirSync(screenshots, { recursive: true })
        await page.screenshot({ path: path.join(screenshots, 'settings-4k.png') })
        await quality.selectOption('1080')
        await page.waitForFunction(async () => (await window.Greenlight.send('settings', 'getSettings')).xhome_resolution === 1080)
        // Discord profile: main-process clamping of bad values keeps local play settings separate.
        await discordQuality.selectOption('720')
        await page.waitForFunction(async () => (await window.Greenlight.send('settings', 'getSettings')).discord_resolution === 720)
        const clamped = await page.evaluate(async () => {
            const current = await window.Greenlight.send('settings', 'getSettings')
            return window.Greenlight.send('settings', 'setSettings', { ...current, discord_resolution: 999, discord_bitrate: 999999, discord_bitrate_override: 'true' })
        })
        assert.equal(clamped.discord_resolution, 1080)
        assert.equal(clamped.discord_bitrate, 4096)
        assert.equal(clamped.discord_bitrate_override, false)
        assert.equal(clamped.xhome_resolution, 1080, 'Discord profile must not change local play settings')
        await page.goto('app://./settings/video.html')
        const aspect = page.locator('#aspect-size')
        await aspect.waitFor()
        await aspect.click()
        await page.waitForFunction(() => document.querySelector('#aspect-size').matches(':open'))
        await page.screenshot({ path: path.join(screenshots, 'aspect-dropdown.png') })
        await aspect.getByRole('option', { name: 'Zoom', exact: true }).click()
        assert.equal(await aspect.inputValue(), 'zoom')
        await page.waitForFunction(async () => (await window.Greenlight.send('settings', 'getSettings')).video_size === 'zoom')
        await page.reload()
        await page.waitForFunction(() => document.querySelector('#aspect-size')?.value === 'zoom')
        await aspect.focus()
        await page.keyboard.press('Space')
        await page.waitForFunction(() => document.querySelector('#aspect-size').matches(':open'))
        await page.keyboard.press('Home')
        await page.keyboard.press('Enter')
        assert.equal(await aspect.inputValue(), 'default')
        const fits = await page.evaluate(() => {
            const holder = document.createElement('div')
            holder.id = 'streamComponent'
            const video = document.createElement('video')
            holder.append(video)
            document.body.append(holder)
            const fits = ['default', 'stretch', 'zoom'].map(size => {
                holder.className = `size_${size}`
                return getComputedStyle(video).objectFit
            })
            holder.remove()
            return fits
        })
        assert.deepEqual(fits, ['contain', 'fill', 'cover'])
        const output = page.getByLabel('Audio output device')
        await page.waitForFunction(() => document.querySelectorAll('#audio-output option').length > 1)
        await output.click()
        await page.waitForFunction(() => document.querySelector('#audio-output').matches(':open'))
        const currentOutput = await output.inputValue()
        const options = await output.locator('option').all()
        let device
        for (const option of options) {
            const id = await option.getAttribute('value')
            if (id && id !== currentOutput) { device = option; break }
        }
        assert(device, 'Test requires an alternate Windows audio output')
        const deviceId = await device.getAttribute('value')
        // Verify the native popup opens, then use Playwright's supported selection operation before reload.
        await page.keyboard.press('Escape')
        await output.selectOption(deviceId)
        await page.waitForFunction(async id => (await window.Greenlight.send('settings', 'getSettings')).audio_output_device === id, deviceId)
        await page.reload()
        try {
            await page.waitForFunction(id => document.querySelector('#audio-output')?.value === id, deviceId)
        } catch (error) {
            console.log(await page.evaluate(async () => ({ url: location.href, authVisible: !!document.querySelector('#component_auth'), selected: document.querySelector('#audio-output')?.value, saved: (await window.Greenlight.send('settings', 'getSettings')).audio_output_device, options: Array.from(document.querySelectorAll('#audio-output option')).map(option => option.value) })))
            throw error
        }
        await page.screenshot({ path: path.join(screenshots, 'audio-output.png') })
        await output.selectOption('')
        await page.waitForFunction(async () => (await window.Greenlight.send('settings', 'getSettings')).audio_output_device === '')
        assert.deepEqual(errors, [])
        console.log('PASS: desktop launch, settings persistence, 4K UI, mouse/keyboard dropdowns, aspect modes, audio device selection, background timers and encryption')
    } finally {
        await app.close()
    }
})().catch(error => { console.error(error); process.exitCode = 1 })
