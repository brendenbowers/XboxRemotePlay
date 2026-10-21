import { app, ipcMain, utilityProcess, BrowserWindow, UtilityProcess } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export function registerDiscordProxy(getWindow: () => BrowserWindow, getReconnectAttempts: () => number = () => 0) {
    let worker: UtilityProcess
    let boot: Promise<void>
    const pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
    const reset = () => {
        worker = undefined; boot = undefined
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Discord publisher stopped')) }
        pending.clear()
    }
    const ensureWorker = () => {
        if (boot) return boot
        boot = new Promise<void>((resolve, reject) => {
            const location = app.isPackaged ? path.join(process.resourcesPath, 'discord-proxy', 'src', 'utility-worker.mjs') :
                path.join(app.getAppPath(), '..', 'discord-proxy', 'src', 'utility-worker.mjs')
            const child = worker = utilityProcess.fork(location, [], { stdio: 'ignore', serviceName: 'Console Stream Discord output' })
            const timer = setTimeout(() => { child.kill(); reject(new Error('Discord publisher did not start')) }, 10000)
            child.on('message', message => {
                if (message?.event === 'boot') { clearTimeout(timer); resolve(); return }
                if (message?.event === 'status' || message?.event === 'keyframe') {
                    const window = getWindow()
                    if (window && !window.isDestroyed()) window.webContents.send('discord-proxy-event', message)
                }
                const request = pending.get(message?.id)
                if (!request) return
                pending.delete(message.id); clearTimeout(request.timer)
                if (message.error) request.reject(new Error(message.error))
                else request.resolve(message.result)
            })
            child.on('exit', () => {
                clearTimeout(timer); reject(new Error('Discord publisher exited')); reset()
                const window = getWindow()
                if (window && !window.isDestroyed()) window.webContents.send('discord-proxy-event', { event: 'status', data: { account: 'disconnected', state: 'idle', reason: 'Discord publisher stopped' } })
            })
        })
        return boot
    }
    const request = async (action: string, data: any = {}): Promise<any> => {
        if (pending.size >= 8) throw new Error('Discord publisher is busy')
        await ensureWorker()
        if (pending.size >= 8) throw new Error('Discord publisher is busy')
        return new Promise((resolve, reject) => {
            const id = randomUUID()
            const timer = setTimeout(() => { pending.delete(id); reject(new Error('Discord publisher timed out')) }, action === 'login' || action === 'connect-canary' ? 35000 : action === 'start' || action === 'xbox-offer' ? 20000 : 5000)
            pending.set(id, { resolve, reject, timer })
            worker.postMessage({ id, action, data })
        })
    }
    ipcMain.handle('discord-proxy', async (event, action, data) => {
        if (event.sender !== getWindow()?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid publisher caller')
        if (!['status', 'login', 'connect-canary', 'disconnect', 'start', 'stop', 'frame', 'preview'].includes(action)) throw new Error('Unknown publisher action')
        if (action === 'preview' && (typeof data?.image !== 'string' || !data.image.startsWith('data:image/jpeg;base64,') || data.image.length > 400000)) throw new Error('Invalid preview image')
        if (action === 'frame' && (!(data?.data instanceof ArrayBuffer) || data.data.byteLength > 4 * 1024 * 1024)) throw new Error('Invalid encoded frame')
        // The retry budget comes from saved settings, not from the renderer.
        if (action === 'start') return request(action, { ...data, reconnectAttempts: getReconnectAttempts() })
        return request(action, data)
    })
    app.on('before-quit', () => worker?.kill())
    // No reply and no pending slot: for high-rate controller state while the worker is running.
    const notify = (action: string, data: any) => { if (worker) worker.postMessage({ action, data }) }
    // Main-process callers (headless mode) may use the xbox-* actions the renderer cannot reach.
    return { request, notify }
}
