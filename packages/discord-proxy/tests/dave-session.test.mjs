import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PublisherDaveSession } from '../src/dave-session.mjs'

function fixture(real = false) {
    const json = [], binary = [], failures = [], cryptoCalls = []
    const fake = {
        ready: false, reset() { this.ready = false }, reinit() { this.ready = false; cryptoCalls.push(['reinit']) },
        getSerializedKeyPackage: () => Buffer.from('fake-key-package'),
        setExternalSender: () => {},
        processProposals: (...args) => { cryptoCalls.push(args); return { commit: Buffer.from('fake-commit') } },
        processCommit() { this.ready = true }, processWelcome() { this.ready = true },
        encryptOpus: data => Buffer.concat([data, Buffer.from('encrypted')]),
        encrypt: (media, codec, data) => Buffer.concat([data, Buffer.from('encrypted')]),
    }
    const manager = new PublisherDaveSession({ userId: '100000000000000001', channelId: '100000000000000002', sendJson: (op, data) => json.push({ op, data }), sendBinary: (op, data) => binary.push({ op, data }), onFailure: error => failures.push(error), ...(real ? {} : { sessionFactory: () => fake }) })
    const packet = (op, body) => Buffer.concat([Buffer.from([0, 1, op]), body])
    return { manager, json, binary, failures, fake, cryptoCalls, packet }
}

test('real DAVE creates a key package but refuses media before the MLS group exists', () => {
    const f = fixture(true)
    f.manager.initialize(1)
    assert.equal(f.binary[0].op, 26)
    assert(f.binary[0].data.length > 0)
    assert.equal(f.manager.diagnostics().groupReady, false)
    assert(!JSON.stringify(f.manager.diagnostics()).includes('100000000000000001'))
    assert.equal(f.manager.ready, false)
    assert.throws(() => f.manager.encryptOpus(Buffer.from([1])), /not ready/)
    f.manager.handleBinary(f.packet(30, Buffer.from([0, 1, 0xff])))
    assert.equal(f.manager.ready, false)
    assert.equal(f.json.at(-1).op, 31)
    assert(f.failures.length > 0)
    f.manager.close()
})

test('media waits for a welcome/commit AND execution of the corresponding transition', () => {
    const f = fixture()
    f.manager.initialize(1)
    f.manager.handleBinary(f.packet(30, Buffer.from([0, 7, 1])))
    assert.equal(f.manager.ready, false)
    assert.deepEqual(f.json.at(-1), { op: 23, data: { transition_id: 7 } })
    f.manager.handleJson(22, { transition_id: 7 })
    assert.equal(f.manager.ready, true)
    f.manager.handleJson(6, null)
    assert.equal(f.manager.ready, true, 'Unrelated heartbeat acknowledgments must not suspend DAVE')
    assert.notDeepEqual(f.manager.encryptOpus(Buffer.from([1])), Buffer.from([1]))
    f.manager.handleJson(21, { transition_id: 8, protocol_version: 0 })
    assert.equal(f.manager.ready, false)
    f.manager.handleJson(22, { transition_id: 8 })
    assert.equal(f.manager.ready, false)
    assert.match(f.failures.at(-1), /disabled end-to-end/)
    f.manager.close()
})

test('proposal identity checks, reinitialization and corrupt transitions fail closed', () => {
    const f = fixture()
    f.manager.initialize(1)
    f.manager.handleJson(11, { user_ids: ['100000000000000003'] })
    f.manager.handleBinary(f.packet(27, Buffer.from([0, 0])))
    assert.deepEqual(f.cryptoCalls[0][2], ['100000000000000001', '100000000000000003'])
    assert.equal(f.binary.at(-1).op, 28)
    f.manager.handleJson(22, { transition_id: 123 })
    assert.equal(f.manager.ready, false)
    assert(f.failures.length)
    f.manager.handleJson(24, { epoch: 1, protocol_version: 1 })
    assert.equal(f.binary.at(-1).op, 26)
    assert(f.cryptoCalls.some(call => call[0] === 'reinit'))
    f.manager.handleBinary(Buffer.alloc(2))
    assert.equal(f.manager.ready, false)
    f.manager.close(); f.manager.close()
    assert.throws(() => f.manager.initialize(1), /closed/)
})
