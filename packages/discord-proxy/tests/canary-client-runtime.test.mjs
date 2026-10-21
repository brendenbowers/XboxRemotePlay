import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { clientBridgeExpression } from '../src/canary-client-runtime.mjs'

function fixture() {
    const context = vm.createContext({})
    vm.runInContext(`
        let clock=1000, tick, cleared=false;
        Date.now=()=>clock;
        globalThis.setInterval=fn=>{tick=fn;return 1};globalThis.clearInterval=()=>{cleared=true};
        const calls=[],dispatched=[];
        const B={isSessionEstablished(){return true},streamCreate(...args){calls.push(['create',...args])},streamDelete(...args){calls.push(['delete',...args])},streamSetPaused(...args){calls.push(['pause',...args])}};
        const te={getSocket(){return B}},d={dispatch(action){dispatched.push(action);return Promise.resolve()}};
        const original=d.dispatch;
        const userId='100000000000000001',channelId='100000000000000002',guildId='100000000000000003',sessionId='current-session';
        const ec={getId(){return userId},getSessionId(){return sessionId},getToken(){throw Error('must not read token')}};
        const voice={channelId,sessionId,selfStream:false};
        const D={getVoiceStateForSession(){return voice}},eo={getChannel(){return {guild_id:guildId}}},es={getAllActiveStreamKeys(){return []}};
        const exportsFor=get=>{const o={};Object.defineProperty(o,'A',{get});return {exports:o}};
        const userExports={};Object.defineProperty(userExports,'default',{get:()=>ec});
        const dispatcherExports={};Object.defineProperty(dispatcherExports,'h',{get:()=>d});
        const loader=Object.assign(()=>{throw Error('must not load')},{m:{276602:function factory(){return 'GatewayConnectionStore'}},c:{
            276602:exportsFor(()=>te),73153:{exports:dispatcherExports},280450:{exports:userExports},
            977997:exportsFor(()=>D),734057:exportsFor(()=>eo),116956:exportsFor(()=>es)
        }});
        globalThis.webpackChunkdiscord_app=[];
        webpackChunkdiscord_app.push=marker=>{Array.prototype.push.call(webpackChunkdiscord_app,marker);marker[2](loader)};
    `, context)
    vm.runInContext(clientBridgeExpression('testBridge'), context)
    return code => vm.runInContext(code, context)
}

test('runtime hands off only owned stream packets, preserves dispatch promises and removes its hook', async () => {
    const run = fixture()
    assert.equal(run('calls.length'), 0)
    assert.equal(run('testBridge.poll().voice.existingStreamKey'), null)
    run(`testBridge.control(18,{type:'guild',guild_id:guildId,channel_id:channelId,preferred_region:null})`)
    await run(`d.dispatch({type:'STREAM_CREATE',streamKey:'guild:'+guildId+':'+channelId+':'+userId,rtcServerId:'100000000000000004'}).catch(()=>{throw Error('gateway reset')})`)
    await run(`d.dispatch({type:'STREAM_SERVER_UPDATE',streamKey:'guild:'+guildId+':'+channelId+':'+userId,endpoint:'example.discord.media',token:'synthetic-media-token'})`)
    assert.equal(run('testBridge.poll().packets.length'), 2)
    assert.equal(run('testBridge.poll().packets.length'), 0)
    await run(`d.dispatch({type:'VOICE_STATE_UPDATES',voiceStates:[]})`)
    assert.equal(run('dispatched.length'), 1)
    assert.throws(() => run('testBridge.control(4,{})'), /Only owned/)
    run('testBridge.dispose()')
    assert.equal(run('d.dispatch===original'), true)
    assert.equal(run("calls.filter(c=>c[0]==='delete').length"), 1)
    assert.equal(run('cleared'), true)
    assert.equal(run('Object.hasOwn(globalThis,"testBridge")'), false)
})

test('watchdog deletes only its own share and restores the hook after publisher loss', () => {
    const run = fixture()
    run(`testBridge.control(18,{type:'guild',guild_id:guildId,channel_id:channelId,preferred_region:null});clock+=6000;tick()`)
    assert.equal(run('d.dispatch===original'), true)
    assert.equal(run("calls.filter(c=>c[0]==='delete').length"), 1)
    assert.equal(run('Object.hasOwn(globalThis,"testBridge")'), false)
})
