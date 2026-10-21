import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { CanaryConnector } from '../src/canary-connector.mjs'
import { DiscordPublisher } from '../src/publisher.mjs'

const voice = { userId: '100000000000000001', guildId: '100000000000000002', channelId: '100000000000000003', voiceSessionId: 'session', existingStreamKey: null }

test('a brief Canary gateway resume keeps the voice state; a long outage fails the poll', () => {
    const connector = new CanaryConnector({ gatewayGraceMs: 1000 })
    const left = []
    connector.on('raw', packet => left.push(packet))
    connector.acceptSnapshot({ voice, packets: [] })
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
        connector.acceptSnapshot({ gatewayReady: false, voice: null, packets: [] })
        mock.timers.tick(900)
        connector.acceptSnapshot({ gatewayReady: false, voice: null, packets: [] })
        assert.deepEqual(left, [], 'No synthetic voice leave during a resume')
        assert.equal(connector.voice.channelId, voice.channelId)
        mock.timers.tick(200)
        assert.throws(() => connector.acceptSnapshot({ gatewayReady: false, voice: null, packets: [] }), /stayed disconnected/)
    } finally { mock.timers.reset() }
})

test('reconnect backs off, counts attempts, gives up at the limit, and Stop cancels it', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const publisher = new DiscordPublisher()
        const account = new CanaryConnector()
        account.status = () => ({ state: 'connected', voice })
        publisher.setAccount(account)
        let starts = 0
        publisher.startSession = async () => { starts++; throw new Error('Discord gateway disconnected') }
        publisher.desired = { attributes: {}, attempts: 2 }; publisher.retry = 0
        publisher.scheduleReconnect('Discord gateway disconnected')
        assert.equal(publisher.state, 'reconnecting')
        assert.match(publisher.reason, /attempt 1 of 2/)
        mock.timers.tick(2400) // first wait: 2 s + up to 20% jitter
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(starts, 1)
        assert.match(publisher.reason, /attempt 2 of 2/)
        mock.timers.tick(4800)
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(starts, 2)
        assert.equal(publisher.state, 'idle')
        assert.match(publisher.reason, /gave up after 2 attempts/)

        publisher.desired = { attributes: {}, attempts: -1 }; publisher.retry = 0
        publisher.scheduleReconnect('Canary bridge disconnected')
        assert.match(publisher.reason, /attempt 1\)/, 'Unlimited shows no total')
        publisher.stop()
        mock.timers.tick(60000)
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(starts, 2, 'Stop cancels the pending retry')
        assert.equal(publisher.state, 'idle')
    } finally { mock.timers.reset() }
})
