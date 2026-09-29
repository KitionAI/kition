/**
 * The runtime HTTP client. A thin fetch wrapper that waits for the desktop
 * backend, prefixes the API base, sends the locale, unwraps the runtime's
 * `{ code, data }` envelope, and turns failures into errors with a message
 * the UI can show. Errors keep a `response` with the status and body so
 * callers can branch on them.
 */
import { getApiBaseURL, normalizeApiPath, waitForDesktopBackendReady } from '@/services/desktop'
import { getCurrentLocale } from '@/i18n'
import {
    pinConsoleCreditsExhausted,
    tryReportConsoleCreditsExhausted,
} from '@/services/consoleCredits'

const DEFAULT_TIMEOUT_MS = 300000

function reportRequestError(message: string) {
    console.error(message)
}

function extractNestedErrorMessage(payload: unknown): string {
    if (!payload) {
        return ''
    }

    if (typeof payload === 'string') {
        const trimmed = payload.trim()
        if (!trimmed) {
            return ''
        }

        try {
            const parsed = JSON.parse(trimmed) as Record<string, any>
            return extractNestedErrorMessage(parsed)
        } catch {
            return trimmed
        }
    }

    if (typeof payload !== 'object') {
        return String(payload)
    }

    const record = payload as Record<string, any>
    return String(
        record.error?.message
        || (typeof record.error === 'string' ? record.error : '')
        || record.message
        || record.detail
        || '',
    ).trim()
}

function normalizeErrorMessage(raw: unknown, fallback: string): string {
    const direct = extractNestedErrorMessage(raw)
    if (!direct) {
        return fallback
    }

    const jsonStart = direct.indexOf('{')
    if (jsonStart < 0) {
        return direct
    }

    const prefix = direct.slice(0, jsonStart).trim().replace(/:$/, '').trim()
    const nested = extractNestedErrorMessage(direct.slice(jsonStart))
    if (!nested) {
        return prefix || direct
    }

    return prefix ? `${prefix}: ${nested}` : nested
}

export interface RequestConfig {
    /** Query parameters; `undefined` and `null` values are skipped. */
    params?: Record<string, string | number | boolean | null | undefined>
    headers?: Record<string, string>
    signal?: AbortSignal
    /** Milliseconds before the request aborts; defaults to five minutes. */
    timeout?: number
    /** Skip the console report for the failure; the caller shows its own message. */
    suppressErrorMessage?: boolean
    /** Request body for methods without a data argument (DELETE). */
    data?: unknown
}

/** What a failed request rejects with: an Error carrying the HTTP details. */
export interface RequestError extends Error {
    config: RequestConfig & { method: string; url: string }
    response?: { status: number; data: unknown }
    /** Set when no response arrived at all (network failure or timeout). */
    request?: true
}

function buildURL(path: string, params?: RequestConfig['params']) {
    const url = `${getApiBaseURL()}${normalizeApiPath(path)}`
    if (!params) return url
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue
        search.append(key, String(value))
    }
    const query = search.toString()
    return query ? `${url}${url.includes('?') ? '&' : '?'}${query}` : url
}

function combineSignals(signal: AbortSignal | undefined, timeout: number) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeout)
    const forward = () => controller.abort(signal?.reason)
    if (signal) {
        if (signal.aborted) forward()
        else signal.addEventListener('abort', forward, { once: true })
    }
    return {
        signal: controller.signal,
        release: () => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', forward)
        },
    }
}

async function parseBody(response: Response): Promise<unknown> {
    const text = await response.text()
    if (!text) return undefined
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('json')) {
        try {
            return JSON.parse(text)
        } catch {
            return text
        }
    }
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

function messageForFailure(status: number, responseData: any, error: RequestError): string {
    // The KitionAI Console hosted LLM proxy returns a structured
    // `credits_exhausted` error; detect it before the status fallbacks
    // because the runtime may wrap it in a 500.
    const consoleDetail = tryReportConsoleCreditsExhausted(responseData, 'unknown')
    if (consoleDetail) {
        pinConsoleCreditsExhausted(error, consoleDetail)
        return consoleDetail.message
    }
    const detail = responseData?.detail || responseData?.message || responseData?.error
    switch (status) {
        case 400:
            return normalizeErrorMessage(detail, 'Invalid request')
        case 401:
            return normalizeErrorMessage(detail, 'Current workspace is unavailable')
        case 402:
            return normalizeErrorMessage(detail, 'This action cannot continue right now')
        case 403:
            return 'Access denied'
        case 404:
            return 'The requested resource was not found'
        case 429:
            return 'Too many requests, please try again later'
        case 500:
            return normalizeErrorMessage(detail, 'Internal server error')
        case 503:
            return 'Service temporarily unavailable'
        default:
            return normalizeErrorMessage(detail, `Request failed (${status})`)
    }
}

async function send<T>(method: string, url: string, dataArgument: unknown, config: RequestConfig = {}): Promise<T> {
    const backendReady = await waitForDesktopBackendReady()
    if (!backendReady) {
        throw new Error('Desktop backend is not ready yet, please retry shortly')
    }
    if (config.signal?.aborted) {
        throw config.signal.reason ?? new DOMException('Request aborted', 'AbortError')
    }
    const data = dataArgument ?? config.data

    const headers: Record<string, string> = { 'X-Locale': getCurrentLocale(), ...(config.headers || {}) }
    const isFormData = typeof FormData !== 'undefined' && data instanceof FormData
    if (isFormData) {
        // Fetch must generate the Content-Type boundary to match its multipart body.
        for (const name of Object.keys(headers)) {
            if (name.toLowerCase() === 'content-type') delete headers[name]
        }
    }
    let body: BodyInit | undefined
    if (data !== undefined && data !== null) {
        if (isFormData || typeof data === 'string' || data instanceof Blob || data instanceof ArrayBuffer) {
            body = data as BodyInit
        } else {
            body = JSON.stringify(data)
            if (!('Content-Type' in headers)) headers['Content-Type'] = 'application/json'
        }
    }

    const error = new Error('Request failed') as RequestError
    error.config = { ...config, method, url }
    const { signal, release } = combineSignals(config.signal, config.timeout ?? DEFAULT_TIMEOUT_MS)

    let response: Response
    try {
        response = await fetch(buildURL(url, config.params), { method, headers, body, signal })
    } catch (cause) {
        release()
        if (config.signal?.aborted) throw cause
        console.error('Response error:', cause)
        error.request = true
        error.message = 'Network error, please check your connection'
        if (!config.suppressErrorMessage) reportRequestError(error.message)
        throw error
    }

    const payload = await parseBody(response).finally(release)

    if (!response.ok) {
        console.error('Response error:', response.status, payload)
        error.response = { status: response.status, data: payload }
        error.message = messageForFailure(response.status, payload || {}, error)
        if (!config.suppressErrorMessage) reportRequestError(error.message)
        throw error
    }

    const envelope = payload as { code?: unknown; message?: string; data?: unknown } | undefined
    if (envelope && typeof envelope === 'object' && envelope.code !== undefined && envelope.code !== 200) {
        const message = envelope.message || 'Request failed'
        reportRequestError(message)
        throw new Error(message)
    }
    if (envelope && typeof envelope === 'object' && 'data' in envelope) {
        return envelope.data as T
    }
    return payload as T
}

export default {
    get: <T = any>(url: string, config?: RequestConfig) => send<T>('GET', url, undefined, config),
    post: <T = any>(url: string, data?: any, config?: RequestConfig) => send<T>('POST', url, data, config),
    put: <T = any>(url: string, data?: any, config?: RequestConfig) => send<T>('PUT', url, data, config),
    delete: <T = any>(url: string, config?: RequestConfig) => send<T>('DELETE', url, undefined, config),
    patch: <T = any>(url: string, data?: any, config?: RequestConfig) => send<T>('PATCH', url, data, config),
}
