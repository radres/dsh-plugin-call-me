/**
 * Offline tests. No network, no dsh, no phone: a fake Cordis context plus a
 * recording `fetch`, so every branch that can ring somebody is exercised without
 * ringing anybody.
 *
 * AIPHONE_STATE_DIR is redirected first, before anything can read or write the
 * real ~/.aiphone on the machine running these.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

const ROOT = mkdtempSync(join(tmpdir(), 'callme-dsh-test-'))
process.env.AIPHONE_STATE_DIR = ROOT
delete process.env.CALLME_USER_NUMBER
delete process.env.AIPHONE_API

/** Every test gets its own state dir: a thread token left behind by one test
 * would let the next one start an inbound poll it never asked for. */
let stateSeq = 0

const { apply, Config, name, inject } = await import('../lib/index.js')

const PHONE = '5551234567'

/** One recorded request plus whatever the test wants the service to answer. */
function fakeFetch(responder) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), method: init.method || 'GET', body })
    const answer = (await responder?.(String(url), body)) ?? {}
    return new Response(JSON.stringify(answer), { status: answer.__status || 200, headers: { 'content-type': 'application/json' } })
  }
  return calls
}

function fakeAgent(overrides = {}) {
  const agent = {
    id: 'session-1',
    status: 'idle',
    delivered: [],
    followup(message) {
      agent.delivered.push({ via: 'followup', message })
    },
    steer(message) {
      agent.delivered.push({ via: 'steer', message })
    },
    inject(message) {
      agent.delivered.push({ via: 'inject', message })
    },
    ...overrides,
  }
  return agent
}

const live = []

function fakeCtx(agent) {
  const tools = new Map()
  const listeners = new Map()
  const disposers = []
  const sections = []
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    agents: { get: () => agent },
    systemPrompt: { section: (section) => (sections.push(section), () => {}) },
    logger: { warn: () => {}, info: () => {} },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    inject(_deps, callback) {
      callback(this)
    },
    // test handles
    tools_: tools,
    emit: (event, ...args) => listeners.get(event)?.(...args),
    has: (event) => listeners.has(event),
    sections_: sections,
    dispose: () => disposers.forEach((fn) => fn()),
  }
  live.push(ctx)
  return ctx
}

function settle(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const realFetch = globalThis.fetch

beforeEach(() => {
  stateSeq += 1
  process.env.AIPHONE_STATE_DIR = mkdtempSync(join(ROOT, `s${stateSeq}-`))
})

afterEach(() => {
  // Disposing is what stops a plugin's inbound poll; a leaked one would keep
  // recording into the next test's fetch stub.
  while (live.length) live.pop().dispose()
  globalThis.fetch = realFetch
  delete process.env.CALLME_USER_NUMBER
})

describe('plugin shape', () => {
  it('declares what dsh needs to load it', () => {
    assert.equal(name, 'call-me')
    assert.deepEqual(inject, ['tools', 'agents'])
    assert.equal(typeof Config, 'function', 'Config must be a schema, not a plain object')
  })

  it('fills its own defaults through the schema', () => {
    const config = new Config({})
    assert.equal(config.turnEnd.mode, 'text')
    assert.equal(config.turnEnd.graceSeconds, 120)
    assert.equal(config.approval.mode, 'text')
    assert.equal(config.inbound.enabled, true)
    assert.equal(config.quietSeconds, 900)
  })

  it('registers both tools with object-rooted parameter schemas', () => {
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, {})
    assert.deepEqual([...ctx.tools_.keys()].sort(), ['call_me', 'text_me'])
    for (const tool of ctx.tools_.values()) {
      assert.equal(tool.parameters.type, 'object')
      assert.equal(tool.parameters.additionalProperties, false)
      assert.equal(typeof tool.output.schema, 'object')
      assert.equal(typeof tool.output.render, 'function')
      // The raw JSON Schema subset dsh enforces: no minLength/minimum/format.
      for (const property of Object.values(tool.parameters.properties)) {
        assert.deepEqual(
          Object.keys(property).filter((key) => !['type', 'description', 'enum', 'const', 'items', 'properties', 'required', 'additionalProperties', 'title', 'default', 'examples'].includes(key)),
          [],
        )
      }
    }
  })

  it('contributes a prompt section whose text is resolved per assembly', () => {
    process.env.CALLME_USER_NUMBER = PHONE
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, {})
    const section = ctx.sections_.find((entry) => entry.name === 'tool:call-me')
    assert.ok(section, 'expected a tool:call-me section')
    assert.equal(typeof section.text, 'function')
    assert.match(section.text(), /555-123-4567/)
  })
})

describe('unpaired', () => {
  it('never touches the network and says exactly what to do', async () => {
    const calls = fakeFetch()
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, {})
    await assert.rejects(
      () => ctx.tools_.get('call_me').execute({ question: 'ship it?' }, {}),
      /No phone is paired/,
    )
    await assert.rejects(() => ctx.tools_.get('text_me').execute({ message: 'hi' }, {}), /go\/dsh/)
    assert.equal(calls.length, 0)
  })

  it('stays silent on a turn ending', async () => {
    const calls = fakeFetch()
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, { turnEnd: { mode: 'call', graceSeconds: 0 } })
    ctx.emit('session/event', { id: 'session-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await settle()
    assert.equal(calls.length, 0)
  })
})

describe('paired', () => {
  beforeEach(() => {
    process.env.CALLME_USER_NUMBER = PHONE
  })

  it('reads the number this machine is already paired with', async () => {
    delete process.env.CALLME_USER_NUMBER
    writeFileSync(join(process.env.AIPHONE_STATE_DIR, 'config.json'), JSON.stringify({ user_number: '4445556666' }))
    const calls = fakeFetch(() => ({ ok: true, message_id: 1 }))
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, { inbound: { enabled: false } })
    await ctx.tools_.get('text_me').execute({ message: 'from the shared config' }, {})
    assert.equal(calls[0].body.to, '4445556666')
  })

  it('texts through /text and reports the delivery verdict', async () => {
    const calls = fakeFetch(() => ({ ok: true, message_id: 7, delivered: false, session_token: 'curl_abc' }))
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, { inbound: { enabled: false } })
    const result = await ctx.tools_.get('text_me').execute({ message: 'deploy finished' }, {})
    assert.deepEqual(result, { delivered: false, note: '' })
    const text = calls.find((call) => call.url.endsWith('/text'))
    assert.equal(text.method, 'POST')
    assert.equal(text.body.to, PHONE)
    assert.equal(text.body.body, 'deploy finished')
    assert.match(text.body.from, /^DSH: /)
    const rendered = ctx.tools_.get('text_me').output.render({}, result)
    assert.match(rendered[0].text, /did not show it/)
  })

  it('clamps an over-long text instead of taking a 422', async () => {
    const calls = fakeFetch(() => ({ ok: true }))
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, { inbound: { enabled: false } })
    await assert.rejects(() => ctx.tools_.get('text_me').execute({ message: 'x'.repeat(2001) }, {}), /at most 2000/)
    assert.equal(calls.length, 0)
  })

  it('returns the spoken answer from a completed call', async () => {
    const calls = fakeFetch(() => ({ status: 'completed', transcript: 'yes, ship it', session_token: 'curl_abc', from: '7412163257' }))
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, { inbound: { enabled: false } })
    const result = await ctx.tools_.get('call_me').execute({ question: 'ship it?', timeout_seconds: 45 }, {})
    assert.deepEqual(result, { answered: true, status: 'completed', transcript: 'yes, ship it' })
    const ring = calls.find((call) => call.url.endsWith('/ring'))
    assert.equal(ring.body.timeout_s, 45)
    assert.equal(ring.body.text, 'ship it?')
    assert.match(ctx.tools_.get('call_me').output.render({}, result)[0].text, /yes, ship it/)
  })

  it('does not pretend a missed call was answered', async () => {
    fakeFetch(() => ({ status: 'missed', transcript: '' }))
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, { inbound: { enabled: false } })
    const result = await ctx.tools_.get('call_me').execute({ question: 'ship it?' }, {})
    assert.deepEqual(result, { answered: false, status: 'missed', transcript: '' })
    assert.match(ctx.tools_.get('call_me').output.render({}, result)[0].text, /Nobody picked up/)
  })

  it('clamps the call timeout to what the service accepts', async () => {
    const calls = fakeFetch(() => ({ status: 'timeout', transcript: '' }))
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, { inbound: { enabled: false } })
    await ctx.tools_.get('call_me').execute({ question: 'still there?', timeout_seconds: 5000 }, {})
    assert.equal(calls[0].body.timeout_s, 300)
  })
})

describe('turn-end reachability', () => {
  beforeEach(() => {
    process.env.CALLME_USER_NUMBER = PHONE
  })

  it('texts the last thing the agent said, once', async () => {
    const calls = fakeFetch(() => ({ ok: true, session_token: 'curl_abc' }))
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, { turnEnd: { mode: 'text', graceSeconds: 0 }, inbound: { enabled: false } })
    const session = { id: 'session-1' }
    ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'Migration done. Want me to deploy?' }] } },
    })
    ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await settle()
    const texts = calls.filter((call) => call.url.endsWith('/text'))
    assert.equal(texts.length, 1)
    assert.match(texts[0].body.body, /Migration done\. Want me to deploy\?/)

    // The quiet window swallows the next one.
    ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await settle()
    assert.equal(calls.filter((call) => call.url.endsWith('/text')).length, 1)
  })

  it('stands down when the human types instead', async () => {
    const calls = fakeFetch(() => ({ ok: true }))
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, { turnEnd: { mode: 'text', graceSeconds: 60 }, inbound: { enabled: false } })
    const session = { id: 'session-1' }
    ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    ctx.emit('session/event', session, { type: 'user/message', data: { source: { kind: 'user' } } })
    await settle()
    assert.equal(calls.length, 0)
    ctx.dispose()
  })

  it('ignores a turn ending that is not in the configured reasons', async () => {
    const calls = fakeFetch(() => ({ ok: true }))
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, { turnEnd: { mode: 'text', graceSeconds: 0, reasons: ['error'] }, inbound: { enabled: false } })
    ctx.emit('session/event', { id: 'session-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await settle()
    assert.equal(calls.length, 0)
  })

  it('feeds a spoken answer back into the finished run', async () => {
    fakeFetch(() => ({ status: 'completed', transcript: 'deploy it, but hold the migration' }))
    const agent = fakeAgent()
    const ctx = fakeCtx(agent)
    apply(ctx, { turnEnd: { mode: 'call', graceSeconds: 0 }, inbound: { enabled: false } })
    ctx.emit('session/event', { id: 'session-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await settle(50)
    assert.equal(agent.delivered.length, 1)
    assert.equal(agent.delivered[0].via, 'followup', 'an idle run must be woken, not injected into')
    assert.match(agent.delivered[0].message.content[0].text, /deploy it, but hold the migration/)
    assert.equal(agent.delivered[0].message.source.plugin, 'call-me')
    assert.equal(agent.delivered[0].message.role, 'user')
    assert.ok(agent.delivered[0].message.id)
  })
})

describe('approval by phone', () => {
  beforeEach(() => {
    process.env.CALLME_USER_NUMBER = PHONE
  })

  it('texts and delegates without holding the decision', async () => {
    const calls = fakeFetch(() => ({ ok: true }))
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, { approval: { mode: 'text' }, inbound: { enabled: false } })
    let delegated = false
    const outcome = await ctx.emit('approval/request', { toolName: 'bash' }, async () => {
      delegated = true
      return 'allowed-once'
    })
    assert.equal(delegated, true)
    assert.equal(outcome, 'allowed-once')
    await settle()
    assert.match(calls[0].body.body, /permission to run bash/)
  })

  it('takes yes for an answer and nothing else', async () => {
    fakeFetch(() => ({ status: 'completed', transcript: 'yeah go ahead' }))
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, { approval: { mode: 'answer' }, inbound: { enabled: false } })
    assert.equal(await ctx.emit('approval/request', { toolName: 'bash' }, async () => 'unavailable'), 'allowed-once')
  })

  it('denies anything that is not a clear yes', async () => {
    fakeFetch(() => ({ status: 'completed', transcript: 'no, not the production one' }))
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, { approval: { mode: 'answer' }, quietSeconds: 0, inbound: { enabled: false } })
    assert.equal(await ctx.emit('approval/request', { toolName: 'bash' }, async () => 'unavailable'), 'rejected')
  })

  it('hands an unanswered call back to whoever is at the keyboard', async () => {
    fakeFetch(() => ({ status: 'missed', transcript: '' }))
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, { approval: { mode: 'answer' }, quietSeconds: 0, inbound: { enabled: false } })
    let delegated = false
    await ctx.emit('approval/request', { toolName: 'bash' }, async () => {
      delegated = true
      return 'unavailable'
    })
    assert.equal(delegated, true, 'silence must never approve')
  })

  it('delegates untouched when the network fails', async () => {
    globalThis.fetch = async () => {
      throw new Error('network down')
    }
    const ctx = fakeCtx(fakeAgent())
    apply(ctx, { approval: { mode: 'answer' }, inbound: { enabled: false } })
    assert.equal(await ctx.emit('approval/request', { toolName: 'bash' }, async () => 'unavailable'), 'unavailable')
  })
})

describe('inbound from the phone', () => {
  beforeEach(() => {
    process.env.CALLME_USER_NUMBER = PHONE
  })

  it('wakes the run with a text sent from the paired phone', async () => {
    let polls = 0
    const calls = fakeFetch((url) => {
      if (url.includes('/sessions/events')) {
        polls += 1
        if (polls > 1) return { events: [], cursor: 4 }
        return {
          cursor: 4,
          events: [{ id: 4, type: 'message', payload: { from: PHONE, body: 'actually use staging' } }],
        }
      }
      return { ok: true, session_token: 'curl_abc' }
    })
    const agent = fakeAgent()
    const ctx = fakeCtx(agent)
    apply(ctx, { turnEnd: { mode: 'off' } })
    await ctx.tools_.get('text_me').execute({ message: 'starting' }, { agent })
    await settle(60)
    ctx.dispose()
    assert.ok(calls.some((call) => call.url.includes('/sessions/events')), 'expected the inbound poll to start')
    assert.equal(agent.delivered.length, 1)
    assert.equal(agent.delivered[0].via, 'followup')
    assert.match(agent.delivered[0].message.content[0].text, /actually use staging/)
  })

  it('ignores traffic from any other number', async () => {
    fakeFetch((url) => {
      if (url.includes('/sessions/events')) {
        return { cursor: 9, events: [{ id: 9, type: 'message', payload: { from: '9998887777', body: 'wrong human' } }] }
      }
      return { ok: true, session_token: 'curl_abc' }
    })
    const agent = fakeAgent()
    const ctx = fakeCtx(agent)
    apply(ctx, { turnEnd: { mode: 'off' } })
    await ctx.tools_.get('text_me').execute({ message: 'starting' }, { agent })
    await settle(60)
    ctx.dispose()
    assert.equal(agent.delivered.length, 0)
  })

  it('stops polling when the run it would deliver to is gone', async () => {
    fakeFetch((url) => (url.includes('/sessions/events') ? { events: [], cursor: 0 } : { ok: true, session_token: 'curl_abc' }))
    const agent = fakeAgent()
    const ctx = fakeCtx(agent)
    apply(ctx, { turnEnd: { mode: 'off' } })
    await ctx.tools_.get('text_me').execute({ message: 'starting' }, { agent })
    await settle(20)
    assert.equal(ctx.has('agent/disposed'), true)
    ctx.emit('agent/disposed', { agent })
    await settle(20)
    ctx.dispose()
  })
})
