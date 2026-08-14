# dsh-plugin-call-me

**让 DeepSeek Harness 的 agent 打电话给你。** 它把问题念给你听，你用嘴回答，你说的话直接回到这一轮运行里。

[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[English](README.md) | 中文

其他提醒类插件发通知，这个插件打电话。手机通过 CallKit 正常响铃，你接起来，
语音念出 agent 的问题，你说「可以，发布吧，但先别跑迁移」，这句话的转写文本
就是 agent 接下来读到的内容。不用回到某个标签页，不用打开 App，不用键盘。

```
你走开  ->  agent 跑完  ->  手机响铃  ->  你开口回答  ->  运行继续
```

## 安装

```sh
dsh plugin --profile web add github:radres/dsh-plugin-call-me
```

纯 JavaScript，没有构建步骤，所以从 git 安装不需要 `allowBuilds` 授权。然后绑定手机：

1. 安装免费的 **/call-me** App：https://serdaroztetik.com/aiphone/go/dsh （iPhone）
2. 打开它，里面会显示一个 10 位数字。
3. 在 profile 的 `cordis.patch.yml` 里告诉插件这个号码：

```yaml
- insert:
    - id: call-me
      name: dsh-plugin-call-me
      config:
        number: '5551234567'
```

如果这台机器上已经有别的 agent 在用 /call-me，第 3 步可以跳过：插件会自动读取
`~/.aiphone/config.json` 里的号码，两个 agent 打到同一部手机。

没有解析出号码之前，插件完全不会动。未绑定的安装是刻意保持静默的。

### 装之前先花五秒验证电话这一半

```sh
curl -sS https://serdaroztetik.com/aiphone/ring \
  -H 'content-type: application/json' \
  -d '{"to":"<你的10位号码>","text":"能听到吗？","from":"dsh"}'
```

这就是插件发出的同一个请求。它会阻塞、让你的手机响铃，并把你说的话打印出来。

## 你得到什么

**两个模型可以主动调用的工具**

| 工具 | 作用 |
| --- | --- |
| `call_me` | 打电话、念出一个问题、等待，把你口头的回答转写成文本返回。阻塞式，最长 5 分钟。 |
| `text_me` | 单向短信，立即返回；如果手机其实没有显示出来，它会明确告诉模型。 |

**三件不需要模型开口就会发生的事**

- **回合结束后的可达性。** 一轮运行停下来，2 分钟后你的手机会收到一条消息，
  引用 agent 最后说的话。在这段时间里你随便输入点什么就会取消它，所以人在键盘前
  不会被打扰。把 `turnEnd.mode` 设为 `call` 就是打电话，并通过 `agent.steer()`
  把你的回答送回去：已经结束的运行会凭你说的话自己接着跑。
- **用电话做审批。** 等待授权的工具调用可以先给你发短信，或者
  （`approval.mode: answer`）直接打给你、按你的语音决定。不是明确的「yes」就一律拒绝，
  没人接则把问题交回给键盘前的人。沉默永远不等于同意。
- **手机上的回复会回到运行里。** 一小时后你在手机上回一条消息，它会落到那个会话：
  空闲的运行会被唤醒（`agent.followup()`），正在跑的会在下一步取走
  （`agent.inject()`）。

## 配置

每一项都有可用的默认值。只写你要改的，并注意 patch 行会整体替换 `config`，
所以需要的键都要写全。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `number` | `''` | App 里显示的 10 位号码。留空则读 `~/.aiphone/config.json`，再读 `$CALLME_USER_NUMBER`。 |
| `label` | `DSH: <目录名>` | 手机上的会话名。一个项目一个会话。 |
| `callTimeoutSeconds` | `300` | 一通电话等待回答的时长（30 到 300）。 |
| `quietSeconds` | `900` | 两次「非主动」联系之间的最小间隔。模型主动调用的工具不受限制。 |
| `turnEnd.mode` | `text` | 运行停止时：`off`、`text` 或 `call`。 |
| `turnEnd.graceSeconds` | `120` | 先等这么久，期间输入即取消。一次性 headless 运行建议设 `0`。 |
| `turnEnd.reasons` | `completed, blocked, error` | 哪些结束原因值得打扰你。还可以用 `max-tokens`、`aborted`。 |
| `approval.mode` | `text` | `off`、`text` 或 `answer`（用语音决定）。 |
| `inbound.enabled` | `true` | 把你从手机发出的消息送进正在运行的会话。 |

停下来就打给我，并且允许我用语音回答：

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

## 实现方式

不修改任何内核代码，全部是挂在已文档化扩展点上的普通 Cordis 插件：

| 功能 | 机制 |
| --- | --- |
| `call_me`、`text_me` | `ctx.tools.register()`，使用原始 JSON Schema 工具定义 |
| 什么时候该用 | 一个 `ctx.systemPrompt.section()`，每次组装时求值，所以里面写的是你当前的号码 |
| 回合结束可达性 | `session/event`（`turn/end` 布防，`user/message` 撤防，`assistant/message` 决定引用什么） |
| 让结束的运行继续 | 空闲用 `agent.followup()`，运行中用 `agent.steer()` |
| 审批 | `approval/request` waterfall，返回 `allowed-once` / `rejected`，或用 `next()` 交回 |
| 手机上的回复 | 对 /call-me 事件流长轮询，在 `agent/disposed` 时停止 |

代码坚持的三条规则，也是这类插件能长期留在你机器上的原因：

- **监听器绝不抛异常。** `approval/request` 和回合结束路径就在你 agent 的控制流里，
  手机网络抖一下不能让一次运行报废。
- **非主动联系有节流和缓冲期。** 每个回合都响铃的插件，中午之前就会被卸载。
- **未绑定就什么都不做。** 每条路径都先解析号码。

## 这是什么

/call-me 是一个免费的托管服务加一个免费的 iPhone App。来电走 CallKit 和 VoIP push，
你说的话实时转写、不做存储，agent 也永远不会知道你真实的手机号：它拨的是 App 里
那个 10 位的 /call-me 号码。

- App Store：https://serdaroztetik.com/aiphone/go/dsh
- 隐私政策：https://serdaroztetik.com/aiphone/privacy
- 同时也支持 Claude Code，并提供远程 MCP server：https://github.com/radres/call-me

需要如实说明的限制：

- **目前只有 iPhone。** Android 版本已经存在，但还在封闭测试，现在装不了。
- **`approval.mode: answer` 在响铃期间会占住桌面端的审批提示。** 这是用语音做决定的代价；
  其他模式不占用。
- **语音回答是转写文本。** 审批路径只接受明确的「yes」，其他一律拒绝，但也别把它
  用在你不愿意由一句话决定的命令上。
- 没有自建部署。

## 开发

```sh
npm install
npm test        # 24 个离线测试：假的 Cordis context 加上会记录请求的 fetch，不会有电话响
npm run check   # 语法检查
```

MIT。欢迎 issue 和 PR。
