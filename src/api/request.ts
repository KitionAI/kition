/**
 * Axios request wrapper
 */
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { getApiBaseURL, normalizeApiPath, waitForDesktopBackendReady } from '@/services/desktop'
import { getCurrentLocale } from '@/i18n'
import {
    pinConsoleCreditsExhausted,
    tryReportConsoleCreditsExhausted,
} from '@/services/consoleCredits'

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

export interface RequestConfig extends AxiosRequestConfig {
    suppressErrorMessage?: boolean
}

const service: AxiosInstance = axios.create({
    baseURL: getApiBaseURL(),
    timeout: 300000,
    headers: {
        'Content-Type': 'application/json',
    },
})

service.interceptors.request.use(
    async (config) => {
        const backendReady = await waitForDesktopBackendReady()
        if (!backendReady) {
            throw new Error('Desktop backend is not ready yet, please retry shortly')
        }
        config.baseURL = getApiBaseURL()
        if (config.url) {
            config.url = normalizeApiPath(config.url)
        }
        config.headers = config.headers || ({} as any)
        ;(config.headers as Record<string, string>)['X-Locale'] = getCurrentLocale()
        return config
    },
    (error) => {
        console.error('Request error:', error)
        return Promise.reject(error)
    }
)

service.interceptors.response.use(
    (response: AxiosResponse) => {
        const res = response.data

        if (res?.code !== undefined && res.code !== 200) {
            reportRequestError(res.message || 'Request failed')
            return Promise.reject(new Error(res.message || 'Request failed'))
        }

        if (res && typeof res === 'object' && 'data' in res) {
            return res.data
        }

        return res
    },
    (error) => {
        console.error('Response error:', error)

        let message = 'Request failed'

        const requestConfig = error.config as RequestConfig | undefined
        const suppressErrorMessage = Boolean(requestConfig?.suppressErrorMessage)

        if (error.response) {
            const status = error.response.status
            const responseData = error.response.data || {}

            // Detect the structured `credits_exhausted` error returned by the
            // KitionAI Console hosted LLM proxy before falling back to the
            // generic status-code handling. We do this even on non-402 paths
            // because the gin-error middleware may emit 500 for some upstream
            // failures while preserving the structured payload.
            const consoleDetail = tryReportConsoleCreditsExhausted(responseData, 'unknown')
            if (consoleDetail) {
                message = consoleDetail.message
                pinConsoleCreditsExhausted(error as unknown as Error, consoleDetail)
            }

            switch (status) {
                case 400:
                    message = consoleDetail
                        ? message
                        : normalizeErrorMessage(responseData.detail || responseData.message || responseData.error, 'Invalid request')
                    break
                case 401:
                    message = consoleDetail
                        ? message
                        : normalizeErrorMessage(responseData.detail || responseData.message || responseData.error, 'Current workspace is unavailable')
                    break
                case 402:
                    message = consoleDetail
                        ? message
                        : normalizeErrorMessage(responseData.detail || responseData.message || responseData.error, 'This action cannot continue right now')
                    break
                case 403:
                    message = 'Access denied'
                    break
                case 404:
                    message = 'The requested resource was not found'
                    break
                case 429:
                    message = 'Too many requests, please try again later'
                    break
                case 500:
                    message = consoleDetail
                        ? message
                        : normalizeErrorMessage(responseData.detail || responseData.message || responseData.error, 'Internal server error')
                    break
                case 503:
                    message = 'Service temporarily unavailable'
                    break
                default:
                    message = consoleDetail
                        ? message
                        : normalizeErrorMessage(responseData.detail || responseData.message || responseData.error, `Request failed (${status})`)
            }
        } else if (error.request) {
            message = 'Network error, please check your connection'
        }

        error.message = message
        if (!suppressErrorMessage) {
            reportRequestError(message)
        }
        return Promise.reject(error)
    }
)

export default {
    get: <T = any>(url: string, config?: RequestConfig) =>
        service.get<any, T>(url, config),
    post: <T = any>(url: string, data?: any, config?: RequestConfig) =>
        service.post<any, T>(url, data, config),
    put: <T = any>(url: string, data?: any, config?: RequestConfig) =>
        service.put<any, T>(url, data, config),
    delete: <T = any>(url: string, config?: RequestConfig) =>
        service.delete<any, T>(url, config),
    patch: <T = any>(url: string, data?: any, config?: RequestConfig) =>
        service.patch<any, T>(url, data, config),
}
