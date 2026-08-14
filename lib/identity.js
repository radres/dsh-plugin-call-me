/**
 * Who to reach, and where the thread state lives.
 *
 * The paired number has ONE home on a machine: `~/.aiphone/config.json`. That is
 * the same file the /call-me CLI and the Claude Code plugin read, so a laptop
 * that already reaches its human keeps working here with no second pairing step
 * and no number typed into a config file. Resolution order is env override,
 * then this plugin's config, then that file.
 *
 * @module dsh-plugin-call-me/identity
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** Digits only: the app shows 584-158-6160, humans paste "(584) 158-6160". */
export function normalizeNumber(value) {
  return String(value ?? '').replace(/\D/g, '')
}

export function isValidNumber(value) {
  return /^\d{10}$/.test(normalizeNumber(value))
}

/** The grouping the iPhone app shows, so a number reads back the same. */
export function displayNumber(value) {
  const digits = normalizeNumber(value)
  return digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : digits
}

/** The /call-me state home. AIPHONE_STATE_DIR is honored for test rigs. */
export function stateDir() {
  return process.env.AIPHONE_STATE_DIR || join(homedir(), '.aiphone')
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The phone this machine is paired with.
 *
 * @param configured - the plugin's own `number` setting, if the user set one.
 * @returns 10 digits, or '' when nothing on this machine is paired yet.
 */
export function resolveNumber(configured) {
  const override = normalizeNumber(process.env.CALLME_USER_NUMBER || '')
  if (isValidNumber(override)) return override
  const fromConfig = normalizeNumber(configured || '')
  if (isValidNumber(fromConfig)) return fromConfig
  const shared = readJson(join(stateDir(), 'config.json'))
  const stored = normalizeNumber(shared?.user_number || '')
  return isValidNumber(stored) ? stored : ''
}

/**
 * The thread name on the phone. One thread per project rather than per session:
 * the server derives a thread from (recipient, label, IP), so a stable label
 * keeps a week of runs in one conversation instead of one thread per boot.
 */
export function defaultLabel(cwd = process.cwd()) {
  const project = basename(cwd) || 'workspace'
  return `DSH: ${project}`
}

function threadFile(number, label) {
  const key = `${number}-${label}`.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 80)
  return join(stateDir(), `dsh-${key}.json`)
}

/**
 * The derived session token plus the inbound cursor.
 *
 * Cached only so a restart does not re-read the same inbound events and text
 * them into a fresh session as if they were new. Losing this file costs one
 * duplicate delivery, never a lost thread: the token is DERIVED server-side
 * from the same three inputs every time.
 */
export function readThread(number, label) {
  const saved = readJson(threadFile(number, label))
  if (!saved || typeof saved.token !== 'string') return { token: '', cursor: 0 }
  return { token: saved.token, cursor: Number(saved.cursor) || 0 }
}

export function writeThread(number, label, thread) {
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
    writeFileSync(
      threadFile(number, label),
      `${JSON.stringify({ token: thread.token, cursor: thread.cursor, label }, null, 2)}\n`,
      { mode: 0o600 },
    )
    return true
  } catch {
    // A read-only home must not take the agent down; the cost is a duplicate
    // inbound delivery after a restart.
    return false
  }
}
