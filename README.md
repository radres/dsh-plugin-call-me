# dsh-plugin-call-me

**Your DeepSeek Harness agent rings your actual phone.** It asks the question out
loud, you answer out loud, and what you said goes straight back into the run.

[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![tests](https://github.com/radres/dsh-plugin-call-me/actions/workflows/test.yml/badge.svg)](https://github.com/radres/dsh-plugin-call-me/actions/workflows/test.yml)

English | [中文](README.zh.md)

Every other reachability plugin sends you a notification. This one places a
phone call. Your phone rings through CallKit like any other call, you pick it up,
a voice reads the agent's question, you say "yes, ship it, but hold the
migration", and the transcript of that sentence is what the agent reads next. No
tab to come back to, no app to open, no keyboard.

```
you walk away  ->  agent finishes  ->  your phone rings  ->  you answer out loud  ->  the run continues
```

## Install

```sh
dsh plugin --profile web add github:radres/dsh-plugin-call-me
```

Plain JavaScript, no build step, so a git install needs no `allowBuilds`
permission. Then pair a phone:

1. Get the **/call-me** app: https://serdaroztetik.com/aiphone/go/dsh (iPhone)
2. Open it. It shows a 10-digit number.
3. Tell the plugin about it, in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: call-me
      name: dsh-plugin-call-me
      config:
        number: '5551234567'
```

If this machine already runs /call-me for another agent, skip step 3: the number
in `~/.aiphone/config.json` is picked up automatically, and both agents reach the
same phone.

Nothing rings until a number resolves. An unpaired install is inert on purpose.

### Prove the phone half in five seconds, before installing anything

```sh
curl -sS https://serdaroztetik.com/aiphone/ring \
  -H 'content-type: application/json' \
  -d '{"to":"<YOUR_10_DIGITS>","text":"Can you hear me?","from":"dsh"}'
```

That is the same call the plugin makes. It blocks, rings your phone, and prints
what you said back.

## What you get

**Two tools the model can call on purpose**

| Tool | What it does |
| --- | --- |
| `call_me` | Rings your phone, speaks one question, waits, returns your spoken answer transcribed. Blocking, up to 5 minutes. |
| `text_me` | One-way text. Returns immediately, and tells the model when your phone did not actually show it. |

**Three things that happen without the model asking**

- **Turn-end reachability.** A run stops, and 2 minutes later your phone gets a
  line quoting what the agent last said. Type anything in that window and your
  phone stays quiet, so being at the keyboard costs you nothing. Set
  `turnEnd.mode: call` and it calls instead, then feeds your answer back with
  `agent.steer()`: a finished run picks itself up from what you said.
- **Approvals by phone.** A tool waiting for permission can text you about it, or
  (`approval.mode: answer`) ring you and take the decision from your voice.
  Anything that is not a clear yes denies, and an unanswered call hands the
  question back to whoever is at the keyboard. Silence never approves.
- **Replies from the phone reach the run.** Text the thread from your phone an
  hour later and it lands in that session: an idle run wakes up
  (`agent.followup()`), a busy one picks it up at its next step
  (`agent.inject()`).

## Configuration

Every field has a default that works. Add only what you want to change, and
remember that a patch row replaces the whole `config` value, so restate the keys
you need.

| Field | Default | Meaning |
| --- | --- | --- |
| `number` | `''` | The 10-digit number the app shows. Empty means read `~/.aiphone/config.json`, then `$CALLME_USER_NUMBER`. |
| `label` | `DSH: <folder>` | Thread name on the phone. One project keeps one conversation. |
| `callTimeoutSeconds` | `300` | How long a call waits for an answer (30 to 300). |
| `quietSeconds` | `900` | Minimum gap between UNSOLICITED contacts. Tools the model calls are never throttled. |
| `turnEnd.mode` | `text` | `off`, `text`, or `call` when a run stops. |
| `turnEnd.graceSeconds` | `120` | Wait this long first; typing cancels it. Use `0` for one-shot headless runs. |
| `turnEnd.reasons` | `completed, blocked, error` | Which turn endings are worth a phone. Also available: `max-tokens`, `aborted`. |
| `approval.mode` | `text` | `off`, `text`, or `answer` (decide by voice). |
| `inbound.enabled` | `true` | Deliver texts you send from the phone into the running session. |

Ring-the-phone-when-I-stop, and let me answer by voice:

```yaml
- insert:
    - id: call-me
      name: dsh-plugin-call-me
      config:
        number: '5551234567'
        turnEnd:
          mode: call
          graceSeconds: 60
        approval:
          mode: answer
```

## How it works

No core is patched. Everything is an ordinary Cordis plugin on a documented
extension point:

| Feature | Mechanism |
| --- | --- |
| `call_me`, `text_me` | `ctx.tools.register()` with raw JSON-Schema tool definitions |
| when to use them | one `ctx.systemPrompt.section()`, resolved per assembly so it names your live number |
| turn-end reachability | `session/event` (`turn/end` to arm, `user/message` to stand down, `assistant/message` for what to quote) |
| resuming a finished run | `agent.followup()` on an idle agent, `agent.steer()` on a busy one |
| approvals | the `approval/request` waterfall, which returns `allowed-once` or `rejected`, or delegates with `next()` |
| replies from the phone | a long poll on the /call-me event stream, stopped on `agent/disposed` |

Three rules the code keeps, because they are what makes a plugin like this safe
to leave installed:

- **A listener never throws.** `approval/request` and the turn-end path sit in
  your agent's own control flow. A phone network blip must not end a run.
- **Unsolicited contact is throttled and grace-delayed.** A plugin that rings on
  every turn gets uninstalled by lunchtime.
- **Nothing happens unpaired.** Every path resolves the number first.

## What this is

/call-me is a hosted service plus an iPhone app. Calls arrive over
CallKit and VoIP push, what you say is transcribed live and not stored, and the
agent never learns your real phone number: it dials a 10-digit /call-me number
that belongs to the app.

- App Store: https://serdaroztetik.com/aiphone/go/dsh
- Privacy policy: https://serdaroztetik.com/aiphone/privacy
- Also available for Claude Code and as a remote MCP server: https://github.com/radres/call-me

Known limits, stated plainly:

- **iPhone only.** There is no Android app.
- **`approval.mode: answer` holds the desktop prompt while the phone rings.**
  That is the cost of taking the decision by voice; the other modes hold nothing.
- **A voice answer is a transcript.** The approval path accepts only a clear yes
  and denies everything else, but do not point it at commands you would not want
  decided by a sentence.
- There is no self-hosted deployment.

## Development

```sh
npm install
npm test        # 24 offline tests: a fake Cordis context and a recording fetch, no phone rings
npm run check   # syntax
```

MIT. Issues and PRs welcome.
