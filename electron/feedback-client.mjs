const FEEDBACK_MIN_LENGTH = 10
const FEEDBACK_MAX_LENGTH = 500
const CONTACT_EMAIL_MAX_LENGTH = 254
const FEEDBACK_TIMEOUT_MS = 15_000

function normalizePortalBaseURL(value) {
  const url = new URL(String(value || '').trim())
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('feedback service URL must use HTTPS')
  }
  return url.toString().replace(/\/+$/, '')
}

function normalizeRequest(request = {}) {
  const description = String(request.description || '').trim()
  const descriptionLength = Array.from(description).length
  if (descriptionLength < FEEDBACK_MIN_LENGTH || descriptionLength > FEEDBACK_MAX_LENGTH) {
    throw new Error(`feedback must be ${FEEDBACK_MIN_LENGTH}-${FEEDBACK_MAX_LENGTH} characters`)
  }

  const contactEmail = String(request.contact_email || '').trim()
  if (Array.from(contactEmail).length > CONTACT_EMAIL_MAX_LENGTH) {
    throw new Error('contact email is too long')
  }

  return {
    accessToken: String(request.access_token || '').trim(),
    payload: {
      schema_version: 1,
      requestId: '',
      taskId: '',
      runtimeMode: 'hosted',
      errorCode: '',
      errorMessage: '',
      description,
      contactEmail,
      timestamp: new Date().toISOString(),
      via: 'desktop',
    },
  }
}

async function readResponseBody(response) {
  try {
    const body = await response.json()
    return body && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
}

function feedbackError(response, body) {
  const message = typeof body?.error === 'string' && body.error.trim()
    ? body.error.trim()
    : `feedback submission failed (${response.status})`
  return new Error(message)
}

async function postFeedback(fetchImpl, baseURL, payload, accessToken, timeoutMs) {
  const path = accessToken ? '/api/issue-reports' : '/api/issue-reports/anonymous'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = { 'content-type': 'application/json' }
    if (accessToken) {
      headers.authorization = `Bearer ${accessToken}`
    }
    const response = await fetchImpl(`${baseURL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    return { response, body: await readResponseBody(response) }
  } finally {
    clearTimeout(timer)
  }
}

export async function submitFeedbackToConsole({
  fetchImpl,
  portalBaseURL,
  request,
  timeoutMs = FEEDBACK_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('feedback fetch implementation is unavailable')
  }

  const baseURL = normalizePortalBaseURL(portalBaseURL)
  const { accessToken, payload } = normalizeRequest(request)
  let result = await postFeedback(fetchImpl, baseURL, payload, accessToken, timeoutMs)

  if (accessToken && result.response.status === 401) {
    result = await postFeedback(fetchImpl, baseURL, payload, '', timeoutMs)
  }

  if (!result.response.ok) {
    throw feedbackError(result.response, result.body)
  }

  const data = result.body?.data && typeof result.body.data === 'object'
    ? result.body.data
    : result.body
  const ticketId = String(data?.ticketId || '').trim()
  if (!ticketId) {
    throw new Error('feedback service returned an invalid response')
  }

  return {
    ticket_id: ticketId,
    accepted_at: String(data?.accepted_at || ''),
  }
}
