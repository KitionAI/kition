const PATTERNS = [
  { kind: 'network',      regex: /ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH/i },
  { kind: 'verification', regex: /sha512|code signature|blockmap|signature/i },
  { kind: 'disk',         regex: /ENOSPC|disk space|no space left/i },
  { kind: 'rate-limit',   regex: /rate limit|\b403\b|forbidden/i },
]

export function classifyUpdateError(err) {
  const message = err instanceof Error ? String(err.message || '') : String(err ?? '')
  for (const pattern of PATTERNS) {
    if (pattern.regex.test(message)) {
      return { kind: pattern.kind, message }
    }
  }
  return { kind: 'other', message }
}
