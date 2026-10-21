export interface PairingDetails {
    code: string;
    url: string;
    expiresAt: number;
}

export function getPairingDetails(data, now = Date.now()): PairingDetails {
    const url = new URL(data.verification_uri)
    if (url.protocol !== 'https:' || !['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com', 'login.live.com'].includes(url.hostname)
        || url.username || url.password || (url.port && url.port !== '443')) {
        throw new Error('Unexpected Microsoft sign-in URL')
    }
    if (typeof data.user_code !== 'string' || !data.user_code.trim() || data.user_code.length > 64
        || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
        throw new Error('Invalid Microsoft pairing response')
    }
    return { code: data.user_code, url: url.href, expiresAt: now + data.expires_in * 1000 }
}
