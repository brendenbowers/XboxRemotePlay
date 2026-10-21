import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('../src/client-context.mjs', import.meta.url), 'utf8').replace('export function', 'function')
test('context selects current client session, refuses another session/active share, and never reads account tokens', () => {
    const context = vm.createContext({})
    vm.runInContext(`
        const B = {}, te = {getSocket(){return B}}, d = {};
        const userId='100000000000000001', channelId='100000000000000002', guildId='100000000000000003';
        let session='current-session', selfStream=false, active=[];
        const ec={getId(){return userId},getSessionId(){return session},getToken(){throw Error('must not read token')}};
        const voice={channelId,sessionId:'current-session',get selfStream(){return selfStream}};
        const D={getVoiceStateForSession(user,session){return user===userId&&session===voice.sessionId?voice:null}};
        const eo={getChannel(id){return id===channelId?{guild_id:guildId}:null}}, es={getAllActiveStreamKeys(){return active}};
        const exportsFor=get=>{const o={};Object.defineProperty(o,'A',{get});return {exports:o}};
        const userExports={};Object.defineProperty(userExports,'default',{get:()=>ec});
        const dispatcherExports={};Object.defineProperty(dispatcherExports,'h',{get:()=>d});
        const loader=Object.assign(()=>{throw Error('must not load')},{m:{276602:function factory(){return 'GatewayConnectionStore'}},c:{
            276602:exportsFor(()=>te),73153:{exports:dispatcherExports},280450:{exports:userExports},
            977997:exportsFor(()=>D),734057:exportsFor(()=>eo),116956:exportsFor(()=>es)
        }});
        globalThis.webpackChunkdiscord_app=[];
        webpackChunkdiscord_app.push=marker=>{Array.prototype.push.call(webpackChunkdiscord_app,marker);marker[2](loader)};
        ${source}
        globalThis.resolved=resolveClientContext();
    `, context)
    assert.equal(vm.runInContext('resolved.readVoice().voiceSessionId', context), 'current-session')
    assert.equal(vm.runInContext('resolved.readActiveStreamKey()', context), null)
    vm.runInContext('selfStream=true', context)
    assert.match(vm.runInContext('resolved.readActiveStreamKey()', context), /^guild:/)
    vm.runInContext("session='another-session'", context)
    assert.equal(vm.runInContext('resolved.readVoice()', context), null)
    assert.equal(vm.runInContext('resolved.readActiveStreamKey()', context), undefined)
})
