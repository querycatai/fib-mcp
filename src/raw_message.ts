export interface RawResponseMatch {
    id: string | number | null;
}

export interface RawNotificationMatch {
    method: string;
}

export type RawMessageMatch =
    | { type: 'response'; id: string | number | null }
    | { type: 'notification'; method: string };

const RAW_ID_PATTERN = '(?:null|-?(?:0|[1-9]\\d*)|"(?:\\\\.|[^"\\\\])*")';
const RAW_STRING_PATTERN = '(?:"(?:\\\\.|[^"\\\\])*")';

const RAW_MESSAGE_RE = new RegExp(
    `^\\s*\\{\\s*(?:` +
    `(?:"jsonrpc"\\s*:\\s*"2\\.0"\\s*,\\s*"id"\\s*:\\s*(${RAW_ID_PATTERN})|"id"\\s*:\\s*(${RAW_ID_PATTERN})\\s*,\\s*"jsonrpc"\\s*:\\s*"2\\.0")\\s*,\\s*"(?:result|error)"\\s*:` +
    `|` +
    `(?:"jsonrpc"\\s*:\\s*"2\\.0"\\s*,\\s*"method"\\s*:\\s*(${RAW_STRING_PATTERN})|"method"\\s*:\\s*(${RAW_STRING_PATTERN})\\s*,\\s*"jsonrpc"\\s*:\\s*"2\\.0")\\s*(?:,\\s*"params"\\s*:|\\s*\\}\\s*$)` +
    `)`
);

function parseRawId(rawId: string): string | number | null {
    if (rawId === 'null') {
        return null;
    }

    if (rawId[0] === '"') {
        return JSON.parse(rawId);
    }

    return Number(rawId);
}

export function matchRawMessage(rawMessage: string): RawMessageMatch | null {
    const source = String(rawMessage || '');

    const match = source.match(RAW_MESSAGE_RE);
    if (!match) {
        return null;
    }

    if (match[1] || match[2]) {
        return { type: 'response', id: parseRawId(match[1] || match[2]) };
    }

    return { type: 'notification', method: JSON.parse(match[3] || match[4]) };
}

export function matchRawResponse(rawMessage: string): RawResponseMatch | null {
    const match = matchRawMessage(rawMessage);
    return match?.type === 'response' ? { id: match.id } : null;
}

export function matchRawNotification(rawMessage: string): RawNotificationMatch | null {
    const match = matchRawMessage(rawMessage);
    return match?.type === 'notification' ? { method: match.method } : null;
}