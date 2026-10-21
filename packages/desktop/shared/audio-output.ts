export async function routeAudioOutput(audio: Pick<HTMLMediaElement, 'setSinkId'>, deviceId: string): Promise<string> {
    try {
        await audio.setSinkId(deviceId)
        return ''
    } catch {
        if (deviceId) {
            try {
                await audio.setSinkId('')
                return 'Selected audio output unavailable. Using Windows Default.'
            } catch { /* Report failure below if even the default output cannot be used. */ }
        }
        return 'Unable to route stream audio. Check your Windows sound devices.'
    }
}
