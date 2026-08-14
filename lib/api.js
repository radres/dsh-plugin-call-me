/**
 * The /call-me HTTP client.
 *
 * Deliberately tiny and dependency-free: the whole service is four routes, and a
 * plugin that lives inside somebody else's agent loop should not drag a request
 * library into their process.
 *
 * Two things here are load-bearing and easy to break:
 *
 *   - `/ring` and `/text` need no token. The server derives a sender identity
 *     from (recipient, label, caller IP) and hands the derived `session_token`
 *     back, so the first send is also what opens the conversation thread. That
 *     is why nothing in this plugin has a login step.
 *   - The server's limits are enforced HERE too (600 chars for a spoken
 *     question, 2000 for a text, 30-300s for a call). A request over the line
 *     comes back 422, and a 422 in a turn-end notifier reads to the user as
 *     "the plugin is broken".
 *
 * @module dsh-plugin-call-me/api
 */

/** The hosted service. There is no self-hosted deployment. */
const DEFAULT_API = 'https://serdaroztetik.com/aiphone'

/** Spoken question ceiling (server: AIPHONE_MAX_QUESTION_CHARS). */
export const MAX_QUESTION_CHARS = 600
/** Text body ceiling (server: AIPHONE_MAX_MESSAGE_CHARS). */
export const MAX_MESSAGE_CHARS = 2000
/** Call wait bounds (server: RingIn.timeout_s). */
export const MIN_CALL_WAIT_S = 30
export const MAX_CALL_WAIT_S = 300

/** A /call-me request that did not come back 2xx, with the body kept for the log. */
export class CallMeError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'CallMeError'
    this.status = status
  }
}

/** Internal dev plumbing (e2e rigs point at a local server); not a user-facing setting. */
function apiBase() {
  return String(process.env.AIPHONE_API || DEFAULT_API).replace(/\/+$/, '')
}

/** Node 20 has AbortSignal.any; keep working without it rather than dying on an old runtime. */
function combineSignals(signals) {
  const live = signals.filter(Boolean)
  if (live.length === 1) return live[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(live)
  return live[0]
}

async function requestJson(path, { method = 'GET', body, timeoutMs = 30_000, signal } = {}) {
  const response = await fetch(`${apiBase()}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: combineSignals([AbortSignal.timeout(timeoutMs), signal]),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new CallMeError(`${method} ${path} returned ${response.status}: ${text.slice(0, 300)}`, response.status)
  }
  return text ? JSON.parse(text) : {}
}

/** Trim to a ceiling on a word boundary when there is one, so a cut sentence still reads. */
export function clamp(value, max) {
  const text = String(value ?? '').trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`
}

/**
 * Ring the phone, say `text`, and block until the human hangs up or the call
 * times out.
 *
 * @returns {Promise<{status: string, transcript: string, session_token?: string, from?: string}>}
 *   `status` is completed | missed | declined | timeout | failed. Only
 *   `completed` carries a transcript, and `failed` means the push was rejected
 *   (a dead install), not that nobody picked up.
 */
export async function placeCall({ to, text, label, timeoutS, signal }) {
  const wait = Math.min(MAX_CALL_WAIT_S, Math.max(MIN_CALL_WAIT_S, Math.round(timeoutS || MAX_CALL_WAIT_S)))
  const result = await requestJson('/ring', {
    method: 'POST',
    body: { to, text: clamp(text, MAX_QUESTION_CHARS), from: label, timeout_s: wait },
    // The server holds the request open for the whole call; leave headroom for
    // the ring itself before the client gives up on a call that IS happening.
    timeoutMs: (wait + 45) * 1000,
    signal,
  })
  return {
    status: String(result.status || 'unknown'),
    transcript: String(result.transcript || '').trim(),
    session_token: result.session_token,
    from: result.from,
  }
}

/**
 * Text the phone. One-way and fast.
 *
 * `delivered:false` is the interesting case: the message is stored but the phone
 * never showed it (notifications declined). Older servers omit the field, so an
 * absent value counts as delivered instead of crying wolf on every send.
 */
export async function sendText({ to, body, label, signal }) {
  const result = await requestJson('/text', {
    method: 'POST',
    body: { to, body: clamp(body, MAX_MESSAGE_CHARS), from: label },
    signal,
  })
  return {
    delivered: result.delivered !== false,
    message_id: result.message_id,
    session_token: result.session_token,
    from: result.from,
  }
}

/**
 * Long-poll the thread for inbound events: texts and voicemails from the phone,
 * plus calls that were missed or declined.
 *
 * `wait` is the server-side hold in seconds (max 55). The returned `cursor` is
 * what the next poll must pass, and it is unchanged when nothing arrived.
 */
export async function pollEvents({ token, cursor = 0, waitS = 25, signal }) {
  const query = new URLSearchParams({
    session_token: token,
    cursor: String(cursor),
    wait: String(Math.min(55, Math.max(0, Math.round(waitS)))),
  })
  const result = await requestJson(`/sessions/events?${query}`, {
    timeoutMs: (Math.min(55, waitS) + 20) * 1000,
    signal,
  })
  return { events: Array.isArray(result.events) ? result.events : [], cursor: Number(result.cursor ?? cursor) }
}

/** Rename the phone-side thread, so a project's calls arrive under its own name. */
export async function setThreadLabel({ token, label, signal }) {
  return requestJson('/sessions/label', {
    method: 'POST',
    body: { session_token: token, label: clamp(label, 80) },
    signal,
  })
}
