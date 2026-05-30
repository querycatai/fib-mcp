export interface RawResponseMatch {
    id: string | number | null;
}

export interface RawNotificationMatch {
    method: string;
}

const RESPONSE_RE = /^\s*\{\s*"jsonrpc"\s*:\s*"2\.0"\s*,\s*"id"\s*:\s*(null|-?(?:0|[1-9]\d*)|"(?:\\.|[^"\\])*")\s*,\s*"(?:result|error)"\s*:/;
const NOTIFICATION_RE = /^\s*\{\s*"jsonrpc"\s*:\s*"2\.0"\s*,\s*"method"\s*:\s*"([^"\\\s]+)"\s*(?:,\s*"params"\s*:|\})/;

export function matchRawResponse(rawMessage: string): RawResponseMatch | null {
    const match = String(rawMessage || '').match(RESPONSE_RE);
    if (!match) return null;

    const rawId = match[1];
    if (rawId === 'null') {
        return { id: null };
    }

    if (rawId[0] === '"') {
        return { id: JSON.parse(rawId) };
    }

    return { id: Number(rawId) };
}

export function matchRawNotification(rawMessage: string): RawNotificationMatch | null {
    const match = String(rawMessage || '').match(NOTIFICATION_RE);
    if (!match) return null;

    return { method: match[1] };
}