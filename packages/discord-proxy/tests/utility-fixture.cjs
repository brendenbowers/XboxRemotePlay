const { app, utilityProcess } = require('electron')
const path = require('node:path')
const assert = require('node:assert/strict')
app.whenReady().then(() => {
    const child = utilityProcess.fork(path.resolve(__dirname, '../src/utility-worker.mjs'), [], { stdio: 'pipe' })
    let done = false, step = 0
    const timer = setTimeout(() => { child.kill(); app.exit(1) }, 15000)
    child.on('message', message => {
        try {
            if (message.event === 'boot') child.postMessage({ id: 'status-test', action: 'status' })
            if (message.id === 'status-test') {
                assert.equal(message.result.account, 'disconnected')
                assert.equal(message.result.state, 'idle')
                child.postMessage({ id: 'login-test', action: 'login', data: { token: 'x' } })
                step++
            }
            if (message.id === 'login-test') {
                assert.match(message.error, /Discord connection failed/)
                assert.equal(step, 1)
                done = true; clearTimeout(timer); child.kill(); app.exit(0)
            }
        } catch (error) { console.error(error.message); clearTimeout(timer); child.kill(); app.exit(1) }
    })
    child.stderr.on('data', chunk => process.stderr.write(chunk))
    child.on('exit', () => { if (!done) { clearTimeout(timer); app.exit(1) } })
})
