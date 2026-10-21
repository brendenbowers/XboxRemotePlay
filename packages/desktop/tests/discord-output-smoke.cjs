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
        await app.evaluate(({ ipcMain }) => {
            const user = { signedIn: true, gamertag: 'Synthetic Xbox', gamerpic: '', gamerscore: '', level: 1 }
            ipcMain.removeAllListeners('app')
            ipcMain.on('app', (event, args) => {
                const data = args.action === 'getAuthState' ? { isAuthenticated: true, isAuthenticating: false, user }
                    : args.action === 'loadCachedUser' ? user : args.action === 'getOnlineFriends' ? [] : { autoStream: '' }
                event.sender.send('app', { id: args.id, action: args.action, data })
            })
            ipcMain.removeAllListeners('streaming')
            ipcMain.on('streaming', async (event, args) => {
                let data = {}
                if (args.action === 'startStream') data = 'synthetic-session'
                if (args.action === 'getPlayerState') data = { playerState: 'started' }
                if (args.action === 'sendSdp') data = { sdp: await event.sender.executeJavaScript(`window.syntheticAnswer(${JSON.stringify(args.data.sdp)})`) }
                if (args.action === 'sendIce') data = []
                event.sender.send('streaming', { id: args.id, action: args.action, data })
            })
        })
        await page.addInitScript(() => {
            window.syntheticTapCount = 0; window.syntheticExports = 0; window.syntheticWorkerCommands = []
            const NativeTransform = window.RTCRtpScriptTransform, NativeWorker = window.Worker
            window.RTCRtpScriptTransform = new Proxy(NativeTransform, { construct(target, args) { window.syntheticTapCount++; return Reflect.construct(target, args) } })
            window.Worker = new Proxy(NativeWorker, { construct(target, args) {
                const worker = Reflect.construct(target, args)
                const post = worker.postMessage.bind(worker)
                worker.postMessage = (...values) => { window.syntheticWorkerCommands.push(values[0]); return post(...values) }
                worker.addEventListener('message', event => { if (event.data?.type === 'frame') window.syntheticExports++ })
                return worker
            } })
            window.syntheticAnswer = async offer => {
                const peer = window.syntheticPeer = new RTCPeerConnection({ iceServers: [] })
                const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
                const paint = canvas.getContext('2d')
                let frame = 0
                window.syntheticPaint = setInterval(() => { paint.fillStyle = frame++ % 2 ? 'red' : 'blue'; paint.fillRect(0, 0, 320, 180) }, 33)
                const context = window.syntheticAudio = new AudioContext()
                const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination()
                oscillator.connect(destination); oscillator.start(); await context.resume()
                const media = window.syntheticMedia = new MediaStream([...canvas.captureStream(30).getTracks(), ...destination.stream.getTracks()])
                await peer.setRemoteDescription({ type: 'offer', sdp: offer })
                media.getTracks().forEach(track => peer.addTrack(track, media))
                for (const transceiver of peer.getTransceivers()) {
                    const kind = transceiver.sender.track?.kind
                    if (kind) transceiver.setCodecPreferences(RTCRtpSender.getCapabilities(kind).codecs.filter(codec => codec.mimeType.toLowerCase() === (kind === 'video' ? 'video/h264' : 'audio/opus')))
                }
                await peer.setLocalDescription(await peer.createAnswer())
                if (peer.iceGatheringState !== 'complete') await new Promise(resolve => peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') resolve() }))
                return peer.localDescription.sdp
            }
        })
        await page.goto('app://./stream/[serverid].html?serverid=synthetic')
        const output = page.getByRole('button', { name: 'Discord output', exact: true })
        await output.waitFor({ timeout: 20000 }); await output.click()
        await page.getByText('disconnected · idle', { exact: true }).waitFor()
        await page.getByRole('button', { name: 'Connect to Discord Canary', exact: true }).waitFor()
        await page.getByText('Legacy token connector', { exact: true }).click()
        const credential = page.getByLabel('Discord credential (kept in memory for this session)')
        await credential.fill('x')
        await page.getByRole('button', { name: 'Connect Discord', exact: true }).click()
        await page.getByRole('alert').filter({ hasText: 'Discord connection failed' }).waitFor()
        assert.equal(await credential.inputValue(), '')
        await page.waitForFunction(() => document.querySelector('#streamComponentHolder video')?.videoWidth === 320)
        const status = await page.evaluate(() => window.Greenlight.discord('status'))
        assert.equal(status.account, 'disconnected')
        assert.equal(status.state, 'idle')
        await page.waitForFunction(() => window.syntheticTapCount === 2)
        // Drive only the UI's export state; the real worker stays disconnected and refuses publication.
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('discord-proxy-event', { event: 'status', data: { account: 'disconnected', state: 'publishing' } }))
        await page.waitForFunction(() => window.syntheticExports >= 8, null, { timeout: 5000 }).catch(async error => {
            console.error('Synthetic export state:', await page.evaluate(() => ({ taps: window.syntheticTapCount, exports: window.syntheticExports, commands: window.syntheticWorkerCommands, text: document.body.innerText })), errors)
            throw error
        })
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('discord-proxy-event', { event: 'status', data: { account: 'disconnected', state: 'idle' } }))
        await page.waitForTimeout(150)
        const exported = await page.evaluate(() => window.syntheticExports)
        await page.waitForTimeout(400)
        assert.equal(await page.evaluate(() => window.syntheticExports), exported)
        fs.mkdirSync(path.resolve(__dirname, '../../../.cache/screenshots'), { recursive: true })
        await page.screenshot({ path: path.resolve(__dirname, '../../../.cache/screenshots/discord-output.png') })
        assert.deepEqual(errors, [])
        console.log('PASS: production Discord IPC/native worker, credential clearing, synthetic Xbox playback, receiver tap start/stop and real frame IPC; no account login or broadcast')
        await page.evaluate(() => { window.syntheticPeer.close(); clearInterval(window.syntheticPaint); window.syntheticMedia.getTracks().forEach(track => track.stop()); window.syntheticAudio.close() })
    } finally { await app.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
