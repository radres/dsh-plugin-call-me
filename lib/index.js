/**
 * dsh-plugin-call-me: your DeepSeek Harness agent rings your actual phone.
 *
 * Three integration points, all documented extension points, no core patched:
 *
 *   - `call_me` / `text_me` tools (`ctx.tools`) — the model reaches you on
 *     purpose. `call_me` blocks until you hang up and returns what you SAID,
 *     transcribed, so a spoken "yes, ship it" is a tool result.
 *   - turn-end reachability (`session/event`) — when a run stops and you are not
 *     at the keyboard, your phone gets a line about it. In `call` mode the
 *     answer goes back through `agent.steer()`, so the run continues from what
 *     you said out loud without you touching the keyboard.
 *   - approval by phone (`approval/request`) — a tool waiting for permission can
 *     ring you and take the answer from your voice.
 *
 * Design rules that are load-bearing:
 *
 *   - NOTHING happens until a phone is paired. Every path resolves the number
 *     first and returns quietly when there is none, so installing the plugin
 *     cannot surprise anyone with a phone call.
 *   - A listener never throws. `agent/turn-stopping` and `approval/request` sit
 *     in the agent's own control flow; a rejected promise there is somebody's
 *     run breaking because a phone network blipped.
 *   - Unsolicited notifications are throttled and grace-delayed. The plugin
 *     that rings on every turn gets uninstalled by lunchtime.
 *
 * @module dsh-plugin-call-me
 */

import Schema from 'schemastery'

import {
  clamp,
  MAX_CALL_WAIT_S,
  MAX_MESSAGE_CHARS,
  MAX_QUESTION_CHARS,
  MIN_CALL_WAIT_S,
  placeCall,
  pollEvents,
  sendText,
  setThreadLabel,
} from './api.js'
import { defaultLabel, displayNumber, readThread, resolveNumber, writeThread } from './identity.js'

export const name = 'call-me'

/** `tools` for the two tools, `agents` to hand a phone reply back to the run it belongs to. */
export const inject = ['tools', 'agents']

const APP_LINK = 'https://serdaroztetik.com/aiphone/go/dsh'

const NOT_PAIRED = [
  'No phone is paired with this machine yet, so /call-me has nowhere to ring.',
  `Get the app (${APP_LINK}), open it, and it shows a 10-digit number.`,
  'Then either put that number in the call-me plugin config, or run',
  '`callme pair <number>` if the /call-me CLI is already on this machine.',
  'Tell the user this verbatim; it is not something you can fix yourself.',
].join(' ')

/** Voice is transcribed, so an approval taken by phone accepts only a clear yes. */
const AFFIRMATIVE = /\b(yes|yeah|yep|yup|sure|approved?|approve|allow|go ahead|do it|ship it|merge it|ok|okay|confirm(ed)?|permission granted)\b/i

const TURN_END_REASONS = ['completed', 'blocked', 'error', 'max-tokens', 'aborted']

/** Floor on one inbound poll cycle, so a server that does not hold the poll cannot be hammered. */
const MIN_POLL_CYCLE_MS = 3_000

export const Config = Schema.object({
  number: Schema.string().default('')
    .description('The 10-digit number the /call-me app shows. Leave empty to use the number this machine is already paired with (~/.aiphone/config.json), or $CALLME_USER_NUMBER.'),
  label: Schema.string().default('')
    .description('Thread name on the phone. Empty means "DSH: <workspace folder>", so one project keeps one conversation.'),
  callTimeoutSeconds: Schema.number().min(MIN_CALL_WAIT_S).max(MAX_CALL_WAIT_S).default(MAX_CALL_WAIT_S)
    .description('How long a call may wait for an answer before it gives up.'),
  quietSeconds: Schema.number().min(0).default(900)
    .description('Minimum gap between UNSOLICITED contacts (turn-end and approval). Tools the model calls on purpose are never throttled.'),
  turnEnd: Schema.object({
    mode: Schema.union(['off', 'text', 'call']).default('text')
      .description('What happens when a run stops and nobody is at the keyboard: nothing, a text, or a call whose answer resumes the run.'),
    graceSeconds: Schema.number().min(0).max(3600).default(120)
      .description('Seconds to wait first. Typing anything in that window cancels it, so being at the keyboard means your phone stays quiet. Use 0 for one-shot headless runs.'),
    reasons: Schema.array(Schema.union(TURN_END_REASONS)).default(['completed', 'blocked', 'error'])
      .description('Which turn endings are worth a phone: completed, blocked, error, max-tokens, aborted.'),
  }).default({}),
  approval: Schema.object({
    mode: Schema.union(['off', 'text', 'answer']).default('text')
      .description('A tool is waiting for permission: text you about it, or ring you and take the decision from your voice. "answer" holds the desktop prompt while the phone rings, and anything that is not a clear yes denies.'),
  }).default({}),
  inbound: Schema.object({
    enabled: Schema.boolean().default(true)
      .description('Deliver texts and voice messages you send FROM the phone into the running session. An idle run wakes up; a busy one picks it up at its next step.'),
  }).default({}),
})

export function apply(ctx, config = {}) {
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`call-me: ${message}`)
    } catch {
      // A logger that throws must not be the reason a run dies.
    }
  }

  // Cordis fills these from the exported schema. Restated here so the module
  // still behaves when it is loaded without one — which is exactly what the
  // offline tests do.
  const turnEnd = { mode: 'text', graceSeconds: 120, reasons: ['completed', 'blocked', 'error'], ...(config.turnEnd || {}) }
  const approval = { mode: 'text', ...(config.approval || {}) }
  const inboundConfig = { enabled: true, ...(config.inbound || {}) }
  const quietMs = Math.max(0, config.quietSeconds ?? 900) * 1000

  const label = clamp(config.label || defaultLabel(), 80)
  const callTimeoutS = config.callTimeoutSeconds || MAX_CALL_WAIT_S

  // Resolved per use with a short cache: pairing the app while dsh is already
  // running should start working without a restart, and re-reading a small JSON
  // file on every send is still wasteful inside one turn.
  let numberCache = { value: '', at: 0 }
  const number = () => {
    const now = Date.now()
    if (now - numberCache.at > 5_000) numberCache = { value: resolveNumber(config.number), at: now }
    return numberCache.value
  }

  const thread = { token: '', cursor: 0, loaded: false }
  const loadThread = () => {
    if (thread.loaded) return
    const saved = readThread(number(), label)
    thread.token = saved.token
    thread.cursor = saved.cursor
    thread.loaded = true
  }

  /** Keep the derived token from any send; it is what the inbound poll needs. */
  const rememberThread = (result) => {
    if (!result?.session_token || result.session_token === thread.token) return
    loadThread()
    thread.token = result.session_token
    writeThread(number(), label, thread)
    // A fresh thread starts named after whatever label opened it; renaming is
    // best-effort, and a failure here costs a thread name, not a message.
    setThreadLabel({ token: thread.token, label }).catch(() => {})
  }

  const lifecycle = new AbortController()
  ctx.effect(() => () => lifecycle.abort(), 'call-me.lifecycle')

  // ---------------------------------------------------------------- the tools

  const TEXT_RESULT = {
    schema: {
      type: 'object',
      properties: {
        delivered: { type: 'boolean', description: 'Whether the phone actually showed it.' },
        note: { type: 'string', description: 'Anything the service wants the model to know.' },
      },
      required: ['delivered', 'note'],
      additionalProperties: false,
    },
    // Renderers run on live streaming AND on session-log replay, so this stays a
    // pure function of the canonical value: no reading the paired number here.
    render: (_args, value) => [{
      type: 'text',
      text: value.delivered
        ? `Text delivered to their phone.${value.note ? ` ${value.note}` : ''}`
        : `Stored, but the phone did not show it (notifications are off for /call-me). Do not assume they have read it.${value.note ? ` ${value.note}` : ''}`,
    }],
  }

  const CALL_RESULT = {
    schema: {
      type: 'object',
      properties: {
        answered: { type: 'boolean', description: 'They picked up and said something.' },
        status: { type: 'string', description: 'completed | missed | declined | timeout | failed' },
        transcript: { type: 'string', description: 'What they said, transcribed. Empty unless answered.' },
      },
      required: ['answered', 'status', 'transcript'],
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: renderCall(value) }],
  }

  ctx.effect(() => ctx.tools.register({
    name: 'call_me',
    description: [
      'Ring the human running this session on their actual phone, speak one question, and wait for their answer.',
      'The answer comes back transcribed, so this is how you get a decision from someone who is not at the keyboard.',
      'Use it when you are genuinely blocked on something only they can decide (which option, whether to deploy, a credential you cannot see).',
      'Do not use it for progress updates; use text_me for those.',
      'Keep the question to one or two spoken sentences: they hear it, they do not read it.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'What to ask out loud. One or two sentences, ends in a question they can answer by speaking.',
        },
        timeout_seconds: {
          type: 'integer',
          description: `How long to wait for an answer, ${MIN_CALL_WAIT_S} to ${MAX_CALL_WAIT_S}. Defaults to the plugin setting.`,
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
    output: CALL_RESULT,
    // The call itself is the deadline; a tool-level timeout on top would cut a
    // live conversation off mid-sentence.
    async execute(args, exec) {
      const question = typeof args?.question === 'string' ? args.question.trim() : ''
      if (!question) throw new Error('call_me: question is required.')
      if (question.length > MAX_QUESTION_CHARS) {
        throw new Error(`call_me: the spoken question must be at most ${MAX_QUESTION_CHARS} characters.`)
      }
      const to = number()
      if (!to) throw new Error(`call_me: ${NOT_PAIRED}`)

      remember(exec?.agent)
      const result = await placeCall({
        to,
        text: question,
        label,
        timeoutS: Number(args?.timeout_seconds) || callTimeoutS,
        signal: exec?.signal,
      })
      rememberThread(result)
      startInbound()
      return {
        answered: result.status === 'completed' && result.transcript !== '',
        status: result.status,
        transcript: result.transcript,
      }
    },
  }), 'call-me.tool.call')

  ctx.effect(() => ctx.tools.register({
    name: 'text_me',
    description: [
      "Send a one-way text to the phone of the human running this session. Returns as soon as it is sent, so it never blocks a run.",
      'Use it for the update somebody who walked away wants: a long job finished, a deploy went out, something needs them later.',
      'When you actually need an answer before continuing, call_me instead.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The text to send. Plain sentences, no markdown.' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    output: TEXT_RESULT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const body = typeof args?.message === 'string' ? args.message.trim() : ''
      if (!body) throw new Error('text_me: message is required.')
      if (body.length > MAX_MESSAGE_CHARS) {
        throw new Error(`text_me: the message must be at most ${MAX_MESSAGE_CHARS} characters.`)
      }
      const to = number()
      if (!to) throw new Error(`text_me: ${NOT_PAIRED}`)

      remember(exec?.agent)
      const result = await sendText({ to, body, label, signal: exec?.signal })
      rememberThread(result)
      startInbound()
      return { delivered: result.delivered, note: '' }
    },
  }), 'call-me.tool.text')

  // The prompt section is a provider, not a string: pairing state and the phone
  // number can both change while the process runs.
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.effect(() => scoped.systemPrompt.section({
      name: 'tool:call-me',
      order: 140,
      text: () => promptText(number()),
    }), 'call-me.prompt')
  })

  // ------------------------------------------------- unsolicited contact rules

  let lastReachOutAt = 0
  const quiet = () => quietMs > 0 && Date.now() - lastReachOutAt < quietMs

  /** Every unsolicited path goes through here, so the throttle cannot be forgotten. */
  async function reachOut(kind, body) {
    const to = number()
    if (!to) return null
    lastReachOutAt = Date.now()
    try {
      if (kind === 'call') {
        const result = await placeCall({ to, text: body, label, timeoutS: callTimeoutS, signal: lifecycle.signal })
        rememberThread(result)
        return result
      }
      const result = await sendText({ to, body, label, signal: lifecycle.signal })
      rememberThread(result)
      return result
    } catch (error) {
      warn(`${kind} failed: ${String(error?.message || error)}`)
      return null
    } finally {
      startInbound()
    }
  }

  // ------------------------------------------------- turn-end reachability

  /** sessionId -> { timer, text } for a notification that has not fired yet. */
  const pending = new Map()
  /** sessionId -> the last assembled assistant text, which is what a phone line quotes. */
  const lastSaid = new Map()
  /** The run a phone reply belongs to: whoever we last reached out for. */
  let target = null

  function remember(agent) {
    if (agent && typeof agent === 'object') target = agent
  }

  function agentFor(sessionId) {
    try {
      return ctx.agents?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  function cancelPending(sessionId) {
    const armed = pending.get(sessionId)
    if (!armed) return
    clearTimeout(armed.timer)
    pending.delete(sessionId)
  }

  ctx.effect(() => () => {
    for (const armed of pending.values()) clearTimeout(armed.timer)
    pending.clear()
  }, 'call-me.pending')

  function armTurnEnd(session, reason) {
    const mode = turnEnd.mode
    if (mode === 'off' || !number()) return
    if (!turnEnd.reasons.includes(String(reason?.kind || ''))) return
    if (quiet()) return

    const sessionId = session?.id
    if (!sessionId) return
    cancelPending(sessionId)

    const said = lastSaid.get(sessionId) || ''
    const summary = said || `The run finished (${reason?.kind || 'done'}).`
    const fire = () => {
      pending.delete(sessionId)
      // This session's own agent, not whoever we last reached out for: a server
      // runs several at once, and steering the wrong one is worse than silence.
      const agent = agentFor(sessionId) || target
      remember(agent)
      void notifyTurnEnd(mode, summary, agent)
    }

    const graceMs = Math.max(0, turnEnd.graceSeconds) * 1000
    if (graceMs === 0) {
      fire()
      return
    }
    const timer = setTimeout(fire, graceMs)
    // Ref'd timers in a one-shot headless run would delay its exit by the whole
    // grace period; a long-lived surface has other handles keeping it alive, so
    // the timer still fires there.
    timer.unref?.()
    pending.set(sessionId, { timer })
  }

  async function notifyTurnEnd(mode, summary, agent) {
    if (mode === 'text') {
      await reachOut('text', `${label} stopped.\n\n${clamp(summary, MAX_MESSAGE_CHARS - label.length - 20)}`)
      return
    }
    const result = await reachOut('call', `${clamp(summary, MAX_QUESTION_CHARS - 60)} What should I do next?`)
    if (!result || result.status !== 'completed' || !result.transcript) return
    deliver(agent, `Answer from your human, spoken on the phone: "${result.transcript}"`, 'answered the phone', true)
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type === 'assistant/message') {
        const text = textOf(event.data?.message?.content)
        if (text) {
          // Bounded: a long-lived server sees many sessions, and only the tail
          // of the last thing said ever reaches a phone.
          if (lastSaid.size > 100 && !lastSaid.has(session.id)) {
            lastSaid.delete(lastSaid.keys().next().value)
          }
          lastSaid.set(session.id, clamp(text, MAX_MESSAGE_CHARS))
        }
        return
      }
      if (event?.type === 'user/message') {
        // A real human prompt means they are right here: stand down.
        if (event.data?.source?.kind === 'user') cancelPending(session.id)
        return
      }
      if (event?.type === 'turn/end') armTurnEnd(session, event.data?.reason)
    } catch (error) {
      warn(`session/event listener failed: ${String(error?.message || error)}`)
    }
  })

  // ------------------------------------------------------- approval by phone

  ctx.on('approval/request', async (request, next) => {
    const mode = approval.mode
    try {
      if (mode === 'off' || !number()) return next()
      const tool = String(request?.toolName || 'a tool')
      remember(request?.agent)

      if (mode === 'text') {
        // Fire and forget on purpose: holding the decision slot while a text
        // goes out would keep the desktop prompt hidden for no reason.
        if (!quiet()) void reachOut('text', `${label} is waiting for permission to run ${tool}. Approve it in the app you started dsh from.`)
        return next()
      }

      const result = await reachOut('call', `${label} wants to run ${tool}. Say yes to allow it, or no to deny.`)
      if (!result || result.status !== 'completed' || !result.transcript) {
        // Nobody picked up: hand the question back so the human at the keyboard
        // can still answer it. Never approve on silence.
        return next()
      }
      if (AFFIRMATIVE.test(result.transcript)) return 'allowed-once'
      return 'rejected'
    } catch (error) {
      warn(`approval listener failed: ${String(error?.message || error)}`)
      return next()
    }
  })

  // -------------------------------------------------------- inbound from phone

  let inbound = null

  function startInbound() {
    if (!inboundConfig.enabled || inbound || !number()) return
    loadThread()
    if (!thread.token) return

    const poll = new AbortController()
    inbound = poll
    lifecycle.signal.addEventListener('abort', () => poll.abort(), { once: true })

    void (async () => {
      while (!poll.signal.aborted) {
        const startedAt = Date.now()
        try {
          const { events, cursor } = await pollEvents({
            token: thread.token,
            cursor: thread.cursor,
            waitS: 25,
            signal: poll.signal,
          })
          if (cursor !== thread.cursor) {
            thread.cursor = cursor
            writeThread(number(), label, thread)
          }
          for (const event of events) handleInbound(event)
        } catch (error) {
          if (poll.signal.aborted) break
          warn(`inbound poll failed: ${String(error?.message || error)}`)
          await sleep(10_000, poll.signal)
        }
        // The service holds a poll open for its whole `wait`, so a cycle that
        // returns immediately means something upstream is NOT holding it. This
        // floor is what keeps that case a slow retry instead of a hot loop that
        // trips the rate limiter.
        const elapsed = Date.now() - startedAt
        if (elapsed < MIN_POLL_CYCLE_MS) await sleep(MIN_POLL_CYCLE_MS - elapsed, poll.signal)
      }
      if (inbound === poll) inbound = null
    })()
  }

  /** Aborts the held long-poll socket, which is what lets a one-shot run exit. */
  function stopInbound() {
    inbound?.abort()
    inbound = null
  }

  function handleInbound(event) {
    const paired = number()
    const from = String(event?.payload?.from || '').replace(/\D/g, '')
    if (event?.type === 'message' || event?.type === 'voicemail') {
      if (from !== paired) return
      const body = String(event.payload?.body || event.payload?.transcript || '').trim()
      if (!body) return
      const kind = event.type === 'voicemail' ? 'voice message' : 'text'
      deliver(
        target,
        `Message from your human, sent from their phone as a ${kind}: "${body}". Treat it as new user input; reply with text_me if it needs an answer.`,
        `${kind} from your phone`,
        true,
      )
    }
  }

  // `agent/disposed` is also what ends the poll in a one-shot run: with nobody
  // to deliver to there is nothing to wait for, and the held socket would keep
  // the process alive after its job printed its answer.
  ctx.on('agent/disposed', (payload) => {
    try {
      const gone = payload?.agent ?? payload
      if (gone && target === gone) {
        target = null
        stopInbound()
      }
      const sessionId = gone?.id
      if (sessionId) {
        cancelPending(sessionId)
        lastSaid.delete(sessionId)
      }
    } catch {
      // Disposal bookkeeping is never worth an exception.
    }
  })

  /**
   * Put text in front of the model. An idle run is WOKEN (`followup`), a busy one
   * picks it up at its next step (`inject`) — the difference is what makes a
   * phone reply able to restart a finished run.
   */
  function deliver(agent, text, summary, wake) {
    if (!agent) {
      warn('nothing to deliver a phone reply to; the run it belongs to is gone.')
      return
    }
    const message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'call-me', form: 'notice', summary: clamp(summary, 120) },
    }
    try {
      const idle = agent.status !== 'running'
      if (wake && idle && typeof agent.followup === 'function') agent.followup(message)
      else if (wake && typeof agent.steer === 'function') agent.steer(message)
      else agent.inject(message)
    } catch (error) {
      warn(`could not deliver to the run: ${String(error?.message || error)}`)
    }
  }

  if (!number()) {
    warn(`no phone paired yet. Get the app (${APP_LINK}) and put its 10-digit number in this plugin's \`number\` setting, or pair it once with the /call-me CLI.`)
  } else {
    try {
      // Measured on dsh 0.1.0-rc.6: neither info NOR warn from ctx.logger
      // reaches `dsh web`'s stdout at the default level, so nothing here is an
      // onboarding channel. The tool errors and the prompt section are: the
      // model is the UI. Do not go looking for these lines in a boot log.
      ctx.logger?.info?.(`call-me: ready. "${label}" reaches ${displayNumber(number())}; turn-end ${turnEnd.mode}, approvals ${approval.mode}.`)
    } catch {
      // Logging is never the point.
    }
    startInbound()
  }
}

function renderCall(value) {
  if (value.answered) return `They picked up and said: "${value.transcript}"`
  switch (value.status) {
    case 'declined':
      return 'They declined the call. Do not call again for this; send a text if it still matters.'
    case 'missed':
    case 'timeout':
      return 'Nobody picked up. Carry on with your best judgment, or leave a text with text_me.'
    case 'completed':
      return 'They picked up but said nothing that could be transcribed. Try a text.'
    case 'failed':
      return 'The phone could not be reached at all (the app may be uninstalled or the number may be wrong). Tell the user.'
    default:
      return `The call ended as "${value.status}".`
  }
}

function promptText(paired) {
  if (!paired) {
    return [
      '## Reaching the human by phone (call-me)',
      '',
      'The call_me and text_me tools exist but no phone is paired with this machine yet.',
      'If the user asks to be called or texted, call the tool once and repeat its instructions to them.',
    ].join('\n')
  }
  return [
    '## Reaching the human by phone (call-me)',
    '',
    `You can reach the person running this session on their phone (${displayNumber(paired)}).`,
    '',
    '- `call_me` rings the phone, speaks your question, waits, and returns what they said out loud.',
    '  Use it when you are blocked on a decision only they can make, and keep the question to one or two spoken sentences.',
    '- `text_me` sends a one-way text and returns immediately. Use it for updates: a job finished, a deploy went out.',
    '',
    'A call interrupts a person, so do not use one where a text would do, and never call twice about the same thing.',
    'If a tool answers that no phone is paired, repeat its instructions to the user verbatim.',
  ].join('\n')
}

/** Model content is blocks; a phone line only wants the words. */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
