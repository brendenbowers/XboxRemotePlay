import React from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import xCloudPlayer from 'xbox-xcloud-player'

import { useSettings } from '../../context/userContext'
import StreamComponent from '../../components/ui/streamcomponent'
import StreamPreload from '../../components/ui/streampreload'
import Ipc from '../../lib/ipc'
import { useTranslation } from 'react-i18next'
import { requestStreamQuality } from '../../../shared/stream-quality'
import { releaseKeyboardInput } from '../../../shared/background-input'
import { ConsoleInputDriver } from '../../../shared/console-input-driver'

function Stream() {
    const router = useRouter()
    const { settings } = useSettings()
    const { t } = useTranslation()

    let streamStateInterval
    let keepaliveInterval

    const [xPlayer, setxPlayer] = React.useState(undefined)
    const [sessionId, setSessionId] = React.useState('')
    const [queueTime, setQueueTime] = React.useState(0)
    // 'discord' only after Start game share restarted this stream; local play keeps the normal settings.
    const [profile, setProfile] = React.useState<'local' | 'discord'>('local')
    const restarting = React.useRef(false)
    const resolution = profile === 'discord' ? settings.discord_resolution : settings.xhome_resolution
    const homeBitrate = profile === 'discord' ? settings.discord_bitrate : settings.xhome_bitrate

    React.useEffect(() => {
        if (!xPlayer) return
        const release = () => releaseKeyboardInput(xPlayer)
        window.addEventListener('blur', release)
        return () => window.removeEventListener('blur', release)
    }, [xPlayer])

    React.useEffect(() => {
        // Detect stream type and title / server id
        let streamType = 'home'
        let serverId = router.query.serverid
        if((router.query.serverid as string).substr(0, 6) === 'xcloud'){
            streamType = 'cloud'
            serverId = (router.query.serverid as string).substr(7)
        }

        if(xPlayer !== undefined){
            document.getElementById('streamComponentHolder').innerHTML = '<div id="streamComponent" class="size_'+settings.video_size+'"></div>'
            xPlayer.bind()
            if (streamType === 'home') {
                xPlayer.getEventBus().on('message', event => {
                    if (event.type === 'HandshakeAck') requestStreamQuality(xPlayer, resolution)
                })
            }

            // Set bitrates & video codec profiles
            if(((streamType === 'cloud') ? settings.xcloud_bitrate : homeBitrate) > 0){
                xPlayer.setVideoBitrate((streamType === 'cloud') ? settings.xcloud_bitrate : homeBitrate)
            }

            if(settings.video_profiles.length > 0){
                xPlayer.setCodecPreferences('video/H264', { profiles: settings.video_profiles || [] }) // 4d = high, 42e = mid, 420 = low
            }

            // Stream is ready so we start the player
            xPlayer.setControllerRumble(settings.controller_vibration)
            xPlayer.setSdpHandler((client, offer) => {
                Ipc.send('streaming', 'sendChatSdp', {
                    sessionId: sessionId,
                    sdp: offer.sdp,
                }).then((sdpResponse) => {
                    xPlayer.setRemoteOffer(sdpResponse.sdp)

                }).catch((error) => {
                    console.log('ChatSDP Exchange error:', error)
                    alert(t('errors.chatSDPExchangeError') + ' ' + JSON.stringify(error))
                })
            })

            xPlayer.createOffer().then((offer:any) => {
                Ipc.send('streaming', 'sendSdp', {
                    sessionId: sessionId,
                    sdp: offer.sdp,
                }).then((sdpResult:any) => {
                    xPlayer.setRemoteOffer(sdpResult.sdp)

                    // Gather candidates
                    const iceCandidates = xPlayer.getIceCandidates()
                    const candidates = []
                    for(const candidate in iceCandidates){
                        candidates.push({
                            candidate: iceCandidates[candidate].candidate,
                            sdpMLineIndex: iceCandidates[candidate].sdpMLineIndex,
                            sdpMid: iceCandidates[candidate].sdpMid,
                        })
                    }

                    Ipc.send('streaming', 'sendIce', {
                        sessionId: sessionId,
                        ice: candidates,
                    }).then((iceResult:any) => {
                        console.log(iceResult)
                        xPlayer.setIceCandidates(iceResult)

                        // All done. Waiting for the event 'connectionstate' to be triggered

                    }).catch((error) => {
                        console.log('ICE Exchange error:', error)
                        alert(t('errors.ICEExchangeError') + ' ' + JSON.stringify(error))
                    })

                }).catch((error) => {
                    console.log('SDP Exchange error:', error)
                    alert(t('errors.SDPExchangeError') + ' ' + JSON.stringify(error))
                })
            })

            xPlayer.getEventBus().on('connectionstate', (event) => {
                console.log('connectionstate changed:', event)

                const connStatus = document.getElementById('component_streamcomponent_connectionstatus')
                if(connStatus !== null){
                    if(event.state === 'connected'){
                        restarting.current = false
                        connStatus.innerText = t('streamWindow.clientHasBeenDisconnected')
                        document.getElementById('component_streamcomponent_loader').className = 'hidden'

                        // Set audio / Video settings
                        // @TODO: Implement api's in xbox-xcloud-player
                        if(settings.audio_enabled === false){
                            xPlayer._audioComponent._audioRender.muted = true
                        }

                        if(settings.video_enabled === false){
                            xPlayer._videoComponent._videoRender.style.opacity = 0
                        }

                        // Start keepalive loop
                        keepaliveInterval = setInterval(() => {
                            Ipc.send('streaming', 'sendKeepalive', {
                                sessionId: sessionId,
                            }).then((result) => {
                                console.log('StartStream keepalive:', result)
                            }).catch((error) => {
                                console.error('Failed to send keepalive. Error details:\n'+JSON.stringify(error))
                            })
                        }, 30000) // Send every 30 seconds

                    } else if(event.state === 'new'){
                        connStatus.innerText = t('streamWindow.startingConnection')

                    } else if(event.state === 'connecting'){
                        connStatus.innerText = t('streamWindow.connectingToConsole')

                    } else if(event.state === 'closed') {
                        if (restarting.current) return
                        // Client has been disconnected. Lets return to home.
                        // xPlayer.close()
                        console.log('Client has been disconnected. Returning to prev page.')
                        window.history.back()
                    }
                }
            })
        } else if(sessionId === '') {
            // Stream is not ready yet, lets start it...

            Ipc.send('streaming', 'startStream', {
                type: streamType,
                target: serverId,
                ...(profile === 'discord' && streamType === 'home' ? { resolution } : {}),
            }).then((result:string) => {
                console.log('StartStream session:', result)
                setSessionId(result)

            }).catch((error) => {
                alert(t('errors.failedToStartStream') + '\n' + JSON.stringify(error))
            })
        } else {

            streamStateInterval = setInterval(() => {
                Ipc.send('streaming', 'getPlayerState', {
                    sessionId: sessionId,
                }).then((session:any) => {
                    console.log('Player state:', session)

                    switch(session.playerState){
                        case 'pending':
                            // Waiting for console to start
                            break

                        case 'started':
                            // Console is ready
                            clearInterval(streamStateInterval)

                            // Start xPlayer interface
                            setxPlayer(new xCloudPlayer('streamComponent', {
                                ui_systemui: [],
                                input_touch: settings.input_touch || false,
                                input_driver: new ConsoleInputDriver(settings),
                                input_mousekeyboard: false,
                                input_legacykeyboard: true,
                                input_mousekeyboard_config: { _keymapping: {} } as any,
                            }))
                            break

                        case 'failed':
                            // Error
                            clearInterval(streamStateInterval)

                            if(session.errorDetails.code === 'WNSError' && session.errorDetails.message.includes('WaitingForServerToRegister')){
                                // Detected the "WaitingForServerToRegister" error. This means the console is not connected to the xbox servers
                                alert(t('errors.unableToStartStreamSession') + '\n\n' + t('errors.streamErrorResult') + ' ' + session.state + '\n' + t('errors.details') + ' [' + session.errorDetails.code + '] ' + session.errorDetails.message)
                            } else {
                                alert(t('errors.streamErrorResult') + ' ' + session.state + '\n' + t('errors.details') + ' [' + session.errorDetails.code + '] ' + session.errorDetails.message)
                            }
                            console.log('Full stream error:', session.errorDetails)
                            onDisconnect()
                            xPlayer?.close()
                            break

                        case 'queued':
                            // Waiting in queue
                            // @TODO: Show queue position
                            if(queueTime === 0){
                                setQueueTime(session.waitingTimes.estimatedTotalWaitTimeInSeconds)
                                console.log('Setting queue to:', session.waitingTimes.estimatedTotalWaitTimeInSeconds)


                            }
                            break
                    }

                }).catch((error) => {
                    alert(t('errors.failedToGetPlayerState') + '\n' + JSON.stringify(error))
                })
            }, 1000)
        }

        // Modal window
        return () => {
            if(xPlayer !== undefined){
                xPlayer.close()
            }

            if(keepaliveInterval){
                clearInterval(keepaliveInterval)
            }

            if(streamStateInterval){
                clearInterval(streamStateInterval)
            }
        }
    }, [xPlayer, sessionId, router.query.serverid])

    function gamepadSend(button){
        console.log('Pressed button:', button)
        xPlayer.getChannelProcessor('input').pressButton(0, 'Nexus')
    }

    // Bitrate is fixed in the offer and resolution in the handshake, so matching Discord needs a new console session.
    function restartForDiscord(){
        if (restarting.current) return
        restarting.current = true
        const previous = sessionId
        if (streamStateInterval) clearInterval(streamStateInterval)
        if (keepaliveInterval) clearInterval(keepaliveInterval)
        xPlayer?.close()
        Ipc.send('streaming', 'stopStream', { sessionId: previous }).catch(() => {}).finally(() => {
            setProfile('discord'); setQueueTime(0); setxPlayer(undefined); setSessionId('')
        })
    }

    const discordProfile = {
        active: profile === 'discord',
        restart: (router.query.serverid as string).startsWith('xcloud') ? undefined : restartForDiscord,
    }

    function onDisconnect(){
        Ipc.send('streaming', 'stopStream', {
            sessionId: sessionId,
        }).then((result) => {
            console.log('Stream stopped:', result)
        })

        if(streamStateInterval){
            clearInterval(streamStateInterval)
        }
    }

    return (
        <React.Fragment>
            <Head>
                <title>Console Stream - {t('streamWindow.pageTitle')} {router.query.serverid}</title>
            </Head>

            { (xPlayer !== undefined) ? <StreamComponent onDisconnect={ () => {
                onDisconnect()
            }} onMenu={ () => {
                gamepadSend('nexus')
            } } xPlayer={ xPlayer } discordProfile={ discordProfile } requestedHeight={ resolution }></StreamComponent> : (queueTime > 0) ?<StreamPreload onDisconnect={ () => {
                onDisconnect()
            }} waitingTime={ queueTime }></StreamPreload> : <StreamPreload onDisconnect={ () => {
                onDisconnect()
            }}></StreamPreload> }
        </React.Fragment>
    )
}

export default Stream
