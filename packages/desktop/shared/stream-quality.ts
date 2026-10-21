export const streamQualities = [
    { height: 720, width: 1280, alias: '720', label: '720p' },
    { height: 1080, width: 1920, alias: '1080', label: '1080p' },
    { height: 1440, width: 2560, alias: '1440', label: '1440p' },
    { height: 2160, width: 3840, alias: '2160', label: '4K / 2160p (experimental)' },
]

export function getStreamQuality(height: unknown) {
    return streamQualities.find(quality => quality.height === height) || streamQualities[1]
}

export function requestStreamQuality(player, height: unknown) {
    const quality = getStreamQuality(height)
    const message = player.getChannelProcessor('message')
    message.send(JSON.stringify(message.generateMessage('/streaming/characteristics/dimensionschanged', {
        horizontal: quality.width,
        vertical: quality.height,
        preferredWidth: quality.width,
        preferredHeight: quality.height,
        safeAreaLeft: 0,
        safeAreaTop: 0,
        safeAreaRight: quality.width,
        safeAreaBottom: quality.height,
        supportsCustomResolution: true,
    })))
    // shortcut: 2160 is an experimental alias; confirm support using decoded frame dimensions.
    player.getChannelProcessor('control').send(JSON.stringify({
        message: 'userRequestedResolutionUpdate',
        resolutionAlias: quality.alias,
    }))
}

export function readStreamMetrics(report, previous, requestedHeight: unknown) {
    const quality = getStreamQuality(requestedHeight)
    const width = report.frameWidth || 0
    const height = report.frameHeight || 0
    const seconds = previous && previous.id === report.id ? (report.timestamp - previous.timestamp) / 1000 : 0
    const bytes = seconds > 0 ? report.bytesReceived - previous.bytesReceived : 0
    const mbps = seconds > 0 && bytes >= 0 ? bytes * 8 / seconds / 1000000 : null
    const hasVideo = width > 0 && height > 0 && report.framesDecoded > 0
    return {
        requested: `${quality.width} × ${quality.height}`,
        width,
        height,
        fps: report.framesPerSecond ?? null,
        mbps,
        framesDecoded: report.framesDecoded || 0,
        state: !hasVideo ? 'Waiting for video' : width >= quality.width && height >= quality.height
            ? 'Requested resolution reached' : 'Receiving below requested resolution',
    }
}
