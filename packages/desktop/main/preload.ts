import { contextBridge, ipcRenderer, shell } from 'electron'
import pkg from '../package.json'

export const Preload = {
    discord(action: 'status' | 'login' | 'disconnect' | 'start' | 'stop' | 'frame' | 'preview', data = {}) {
        return ipcRenderer.invoke('discord-proxy', action, data)
    },
    headless(action: 'start' | 'stop' | 'status' | 'keyframe' | 'share' | 'unshare' | 'bitrate' | 'resolution' | 'active' | 'keyframe-data', data = {}) {
        return ipcRenderer.invoke('headless', action, data)
    },
    // One-way: controller state for a headless session (null = disconnected).
    headlessInput(state: { buttons: number; axes: number[]; triggers: number[] } | null) {
        ipcRenderer.send('headless-input', state)
    },
    headlessNativeInput(batch: import('../shared/console-input').NativeInput) {
        ipcRenderer.send('headless-native-input', batch)
    },
    onConsoleInputReset(listener: () => void) {
        const handler = () => listener()
        ipcRenderer.on('console-input-reset', handler)
        return () => ipcRenderer.removeListener('console-input-reset', handler)
    },
    onDiscord(listener) {
        const handler = (_event, message) => listener(message)
        ipcRenderer.on('discord-proxy-event', handler)
        return () => ipcRenderer.removeListener('discord-proxy-event', handler)
    },

    send(channel:string, action:string, data = {}){
        return new Promise((resolve, reject) => {
            const requestId = Math.round(Math.random()*1000)

            ipcRenderer.send(channel, {
                id: requestId,
                action: action,
                data: data,
            })

            // Wait for event back..
            const callbackFunction = (event, args) => {
                if(args.action === action && args.id === requestId){
                    ipcRenderer.removeListener(channel, callbackFunction)
                    
                    if(args.error === undefined)
                        resolve(args.data)
                    else {
                        // if(args.error.status){
                        //     alert('HTTP Status: ' + args.error.status + '\nPath:' + args.error.url + '\n' + args.error.body)
                        // } else {
                        //     alert(args.error)
                        // }
                        reject(args.error)
                    }
                }
            }

            ipcRenderer.on(channel, callbackFunction)

        })
    },

    on(channel:string, listener){

        const wrapEvent = (event, args) => {
            listener(event, args.action, args.data)
        }

        ipcRenderer.on(channel, wrapEvent)

        return wrapEvent
    }, 

    onAction(channel:string, action:string, listener){

        const wrapEvent = (event, args) => {
            if(args.action === action){
                listener(event, args.data)
            }
        }

        ipcRenderer.on(channel, wrapEvent)

        return wrapEvent
    },

    removeListener(channel:string, listener){
        ipcRenderer.removeListener(channel, listener)
    },

    openExternal(url:string){
        shell.openExternal(url)
    },

    getVersion(){
        return pkg.version
    },

    isWebUI(){
        return false
    },
}

contextBridge.exposeInMainWorld('Greenlight', Preload)
