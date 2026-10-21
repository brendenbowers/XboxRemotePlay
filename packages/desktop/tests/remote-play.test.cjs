const assert = require('node:assert/strict')
const { test } = require('node:test')
const { getStreamQuality, requestStreamQuality, readStreamMetrics } = require('../shared/stream-quality.ts')
const { releaseKeyboardInput } = require('../shared/background-input.ts')
const { getPairingDetails } = require('../shared/pairing.ts')
const { routeAudioOutput } = require('../shared/audio-output.ts')

test('stream audio uses the selected output and falls back when it is unavailable', async () => {
    const calls = []
    const audio = { setSinkId: async id => { calls.push(id); if (id === 'missing') throw new Error('NotFoundError') } }
    assert.equal(await routeAudioOutput(audio, 'headphones'), '')
    assert.deepEqual(calls, ['headphones'])
    calls.length = 0
    assert.match(await routeAudioOutput(audio, 'missing'), /Windows Default/)
    assert.deepEqual(calls, ['missing', ''])
    assert.match(await routeAudioOutput({ setSinkId: async () => { throw new Error('AbortError') } }, ''), /Unable to route/)
})

test('pairing exposes the copyable code and Microsoft URL without the device credential', () => {
    const data = { user_code: 'TEST-1234', verification_uri: 'https://microsoft.com/link', expires_in: 900, device_code: 'private-test-credential' }
    assert.deepEqual(getPairingDetails(data, 1000), { code: 'TEST-1234', url: 'https://microsoft.com/link', expiresAt: 901000 })
    for (const verification_uri of ['file:///C:/Windows', 'https://microsoft.com.evil.example/link', 'https://evil.example', 'http://microsoft.com/link', 'https://user:pass@microsoft.com/link']) {
        assert.throws(() => getPairingDetails({ ...data, verification_uri }))
    }
    assert.throws(() => getPairingDetails({ ...data, user_code: '' }))
    assert.throws(() => getPairingDetails({ ...data, expires_in: -1 }))
})

test('losing focus releases held keyboard buttons while preserving physical controller input', () => {
    const keyboard = { GamepadIndex: 0, A: 1, LeftTrigger: 1, LeftThumbXAxis: 0.8 }
    const physical = { A: 1, RightTrigger: 0.7 }
    const player = { _keyboardDriver: { requestState: () => keyboard }, _inputDriver: { _nexusOverrideN: true, physical } }
    releaseKeyboardInput(player)
    assert.deepEqual(keyboard, { GamepadIndex: 0, A: 0, LeftTrigger: 0, LeftThumbXAxis: 0 })
    assert.equal(player._inputDriver._nexusOverrideN, false)
    assert.deepEqual(physical, { A: 1, RightTrigger: 0.7 })
    assert.doesNotThrow(() => releaseKeyboardInput({}))
})

test('quality requests contain the requested size and control-channel alias', () => {
    for (const height of [720, 1080, 1440, 2160]) {
        const messages = []
        const player = { getChannelProcessor: channel => ({
            generateMessage: (target, content) => ({ target, content: JSON.stringify(content) }),
            send: data => messages.push({ channel, data: JSON.parse(data) }),
        }) }
        requestStreamQuality(player, height)
        assert.equal(messages[0].channel, 'message')
        assert.equal(messages[0].data.target, '/streaming/characteristics/dimensionschanged')
        const dimensions = JSON.parse(messages[0].data.content)
        assert.equal(dimensions.preferredHeight, height)
        assert.equal(dimensions.preferredWidth, getStreamQuality(height).width)
        assert.equal(dimensions.safeAreaBottom, height)
        assert.deepEqual(messages[1], { channel: 'control', data: {
            message: 'userRequestedResolutionUpdate', resolutionAlias: String(height),
        } })
    }
    assert.equal(getStreamQuality('2160').height, 1080)
    assert.equal(getStreamQuality(-1).height, 1080)
    assert.equal(getStreamQuality(undefined).height, 1080)
})

test('4K is reported only when received decoded frames actually reach 4K', () => {
    const previous = { id: 'video', timestamp: 1000, bytesReceived: 0 }
    const report = { id: 'video', timestamp: 2000, bytesReceived: 2500000, frameWidth: 1920, frameHeight: 1080, framesDecoded: 60, framesPerSecond: 60 }
    const fallback = readStreamMetrics(report, previous, 2160)
    assert.equal(fallback.mbps, 20)
    assert.equal(fallback.state, 'Receiving below requested resolution')
    assert.equal(fallback.width, 1920)
    assert.equal(readStreamMetrics({ ...report, frameWidth: 3840, frameHeight: 2160 }, previous, 2160).state, 'Requested resolution reached')
    assert.equal(readStreamMetrics({ ...report, framesDecoded: 0 }, previous, 1080).state, 'Waiting for video')
    assert.equal(readStreamMetrics(report, null, 2160).mbps, null)
    assert.equal(readStreamMetrics(report, { ...previous, id: 'other' }, 2160).mbps, null)
    assert.equal(readStreamMetrics(report, { ...previous, bytesReceived: 9000000 }, 2160).mbps, null)
})
