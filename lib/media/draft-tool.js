/**
 * 起草—确认：让模型先 qq_draft 起稿，再 qq_confirm 发出去。
 *
 * 和 dsh-qq 那套一致：回复正文永远不自动发；想发几条就重复 draft + confirm，
 * 每条是独立的一条 QQ 消息；本轮结束还没确认的草稿直接作废。
 * 这一轮不想说话就 qq_skip（只写日志，不发任何东西）。
 *
 * @module dsh-qqbot-plus/media/draft-tool
 */
import { statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chunkMarkdownText } from '../transport/chunker.js'
import { notifySendFailure, classifySendError } from '../transport/notify.js'
import { isPathAllowed, resolveAgentCwd } from './send-media.js'
import { markSpoke, endTurn } from '../turn-check.js'

const textResult = (value) => [{ type: 'text', text: String(value) }]

/** 草稿/发送回执里给人看的去处标签：私聊 QQ <id>，群 QQ 群 <id>。 */
function targetLabel(target) {
  if (!target || !target.targetId) return 'QQ'
  return target.scope === 'group' ? `QQ 群 ${target.targetId}` : `QQ ${target.targetId}`
}

/**
 * 这一轮的来处：'qq' = QQ 发来的，'auto' = 插件心跳叫醒的，'console' = 控制台/面板里敲的。
 * 判据两样：消息正文有没有投递前缀（[私聊 …] / [群「…」 …]），以及消息的 source.kind。
 */
const AUTO_KINDS = new Set(['bili-autonomy', 'xhs-autonomy', 'bili-duty-scan', 'dsh-day', 'day-wake', 'humanlike', 'resume'])
/** 注入消息的识别：这些不是他说的，判来处时要跳过。 */
const INJECTED_RE = /^(Current runtime context|\[Reference attachments\]|Time sampled|\[Compressed conversation section\]|<system-reminder|<skill|<available_skills>|The available skill catalog changed|Use only names in this replacement catalog|（宿主刚重启过)/m

/** 最后一条 QQ 入站是不是刚刚。事件里翻不到人话时的最后一道判据。
 * 窗口给到 10 分钟：一个回合里可能先跑了几分钟工具，收尾时才起草；
 * 90 秒会把「他刚在群里问我」误判成 console，宁可多发一条。 */
function justInbound(ms = 10 * 60_000) {
  try {
    const raw = readFileSync(join(homedir(), '.dsh', 'dsh-qqbot-plus', 'runtime.json'), 'utf8')
    const at = Date.parse(String(JSON.parse(raw)?.lastInbound?.at ?? ''))
    if (!Number.isFinite(at)) return false
    return Date.now() - at <= ms
  }
  catch {
    return false
  }
}

/** 这条消息是不是通道刚收到的那条入站（runtime.json 的 lastInbound.text）。 */
function isInboundText(text) {
  try {
    const raw = readFileSync(join(homedir(), '.dsh', 'dsh-qqbot-plus', 'runtime.json'), 'utf8')
    const want = String(JSON.parse(raw)?.lastInbound?.text ?? '').trim()
    if (want === '' || text === '') return false
    return text.includes(want) || want.includes(text.slice(0, 40))
  }
  catch {
    return false
  }
}

function originOf(agent) {
  try {
    const session = agent?.session
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events
    if (!Array.isArray(events)) return 'console'
    // 往上最多看 8 条真人消息：这一轮里还夹着宿主注入的快照、重启提示、技能目录，
    // 只看「最近一条」会被它们挡住，只看「第一条命中的」会先撞到 console。
    const seen = []
    for (let i = events.length - 1; i >= 0 && seen.length < 8; i -= 1) {
      const event = events[i]
      if (event?.type !== 'user/message' && event?.type !== 'user') continue
      const text = String(event.text ?? event.content?.[0]?.text ?? '')
      if (text === '') continue
      if (INJECTED_RE.test(text)) continue
      seen.push({ text, kind: String(event.source?.kind ?? '') })
    }
    for (const item of seen) {
      if (/^\[(私聊|群「)/.test(item.text)) return 'qq'
      if (isInboundText(item.text)) return 'qq'
    }
    for (const item of seen) {
      if (AUTO_KINDS.has(item.kind)) return 'auto'
    }
    // 事件里翻不到这一轮的人话（有时候当前回合的消息还没进快照）：
    // 通道刚收到过 QQ 消息就按 QQ 算——宁可多发一条，不要让他等着。
    return justInbound() ? 'qq' : 'console'
  }
  catch {
    return 'console'
  }
}

/** 人话体检：起草时顺手量一遍，只提示不改字、不阻断（源码在 lib/fishcheck/，抄自 dsh-fishcheck）。 */
let __fishcheck = null
async function fishHint(text) {
  if (typeof text !== 'string' || text.trim().length < 20) return ''
  try {
    if (__fishcheck === null) __fishcheck = await import('../fishcheck/measure.js')
    const r = __fishcheck.analyze(text)
    if (r.score < 22) return ''
    const tops = r.problems.slice(0, 3).map((p) => p.text)
    return `体检 ${r.score} 分（${r.verdict}）：${tops.join(' · ')}`
  }
  catch {
    return ''
  }
}

/** 语音文件允许的根目录（breeze_voice 落盘的地方）。 */
const VOICE_ROOT = join(homedir(), '.dsh', 'dsh-breeze-voice', 'audio')
/** 读回来的媒体上限，与 SDK 那侧一致。 */
const MAX_INLINE_BYTES = 50 * 1024 * 1024

/** data: URL → Buffer（只认 base64 段）。 */
function readDataUrl(text, field) {
  const comma = text.indexOf(',')
  if (comma < 0 || !/;base64/i.test(text.slice(0, comma))) {
    throw new Error(`qq_draft: ${field} 的 data URL 需要 base64 编码`)
  }
  const buffer = Buffer.from(text.slice(comma + 1), 'base64')
  if (buffer.byteLength === 0) throw new Error(`qq_draft: ${field} 的 data URL 解出来是空的`)
  if (buffer.byteLength > MAX_INLINE_BYTES) throw new Error(`qq_draft: ${field} 太大（${buffer.byteLength} 字节）`)
  return buffer
}

/** 本机/局域网地址：腾讯那侧拉不到，得自己下成 buffer。 */
function isLocalHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')
}

async function readLocalUrl(url, field) {
  let response
  try {
    response = await fetch(url)
  }
  catch (error) {
    throw new Error(`qq_draft: ${field} 的本机地址读不到（${url}）：${error?.message ?? error}`)
  }
  if (!response.ok) throw new Error(`qq_draft: ${field} 的本机地址返回 ${response.status}：${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength === 0) throw new Error(`qq_draft: ${field} 的本机地址内容是空的：${url}`)
  if (buffer.byteLength > MAX_INLINE_BYTES) throw new Error(`qq_draft: ${field} 太大（${buffer.byteLength} 字节）`)
  return buffer
}

export function registerDraftTools(ctx, sender, mediaSender, manager, config, logger) {
  const tools = ctx.get('tools')
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qq_draft/qq_confirm 未注册')
    return
  }
  /** sessionId → 草稿（同一会话只留最近一份） */
  const drafts = new Map()
  const chunkLimit = config.textChunkLimit ?? 4500
  const cwd = resolveAgentCwd(config.cwd)
  const mediaPolicy = config.sendFile ?? {}
  const recordOf = (agent) => (agent === undefined ? undefined : manager.findByAgent(agent))
  const sessionKeyOf = (record) => record.agent?.session?.id ?? record.sessionId
  /** 会话表里所有能发的门（每个键 = 私聊或群的一条会话）。 */
  const doors = () => {
    const out = []
    for (const record of manager.sessions?.values?.() ?? []) {
      const target = record?.replyTarget
      if (!target || typeof target.targetId !== 'string' || target.targetId === '') continue
      out.push({ record, target, scope: target.scope === 'group' ? 'group' : 'c2c' })
    }
    return out
  }
  /** 目标反查那条会话（记忆要记在收件人自己那条上，不能记在叫醒我的那条）。 */
  const recordForTarget = (target) => {
    if (!target || typeof target.targetId !== 'string') return undefined
    const scope = target.scope === 'group' ? 'group' : 'c2c'
    return doors().find((door) => door.scope === scope && door.target.targetId === target.targetId)?.record
  }
  /**
   * 解析 qq_draft 的 `to`。
   * - 不给：回给这一轮的来处（照旧）
   * - private / 私聊 / 主人：他的私聊（当前就在私聊里就沿用那条，带 msgId 走被动回复）
   * - group / 群：群
   * - private:<openid> / group:<openid>：直接指定
   * 主动换门时 msgId 留空——那不是回复，是主动消息（平台有额度，别乱用）。
   */
  const targetFor = (record, to) => {
    const raw = String(to ?? '').trim()
    if (raw === '') return record?.replyTarget ?? null
    const explicit = raw.match(/^(c2c|private|私聊|group|群|群聊)\s*[:：]\s*(\S+)$/i)
    if (explicit) {
      const scope = /^(group|群|群聊)$/i.test(explicit[1]) ? 'group' : 'c2c'
      return { scope, targetId: explicit[2], msgId: '' }
    }
    const lower = raw.toLowerCase()
    const wantPrivate = /^(private|c2c|私聊|主人|owner|me|我)$/.test(lower)
    const wantGroup = /^(group|群|群聊|这个群)$/.test(lower)
    if (!wantPrivate && !wantGroup) {
      throw new Error(`qq_draft: to 只认 private / group（也可以 private:<openid>、group:<openid>），收到的是「${raw}」`)
    }
    const scope = wantPrivate ? 'c2c' : 'group'
    const here = record?.replyTarget
    if (here && (here.scope === 'group' ? 'group' : 'c2c') === scope) return here
    const hit = doors().find((door) => door.scope === scope)
    if (hit) return { scope, targetId: hit.target.targetId, msgId: '' }
    throw new Error(wantPrivate
      ? 'qq_draft: 会话表里还没有他的私聊门——让他先在 QQ 上私聊你一句，之后才发得过去'
      : 'qq_draft: 会话表里还没有群门——群里得先有人说过话')
  }
  /**
   * 解析一个媒体参数：
   * - http(s) 公网 URL：原样交给 SDK 拉取
   * - 本机 / 局域网 URL：自己读成 buffer（腾讯服务器拉不到会报「上传URL错误」）
   * - data: URL：解成 buffer
   * - file:// URL 与本地路径：校验存在性与白名单后给 localPath，相对路径按会话 cwd 解析
   */
  const sourceOf = async (raw, field, record) => {
    const text = String(raw ?? '').trim()
    if (text === '') return null
    const sessionCwd = typeof record?.agent?.session?.header?.cwd === 'string' ? record.agent.session.header.cwd : ''
    if (text.startsWith('data:')) return { buffer: readDataUrl(text, field) }
    if (/^https?:\/\//i.test(text)) {
      let parsed
      try {
        parsed = new URL(text)
      }
      catch {
        throw new Error(`qq_draft: ${field} 不是合法 URL：${text}`)
      }
      if (isLocalHost(parsed.hostname)) return await readLocalUrl(text, field)
      return { url: text }
    }
    let file = text
    if (/^file:\/\//i.test(text)) {
      try {
        file = fileURLToPath(text)
      }
      catch {
        throw new Error(`qq_draft: ${field} 不是合法的 file:// 路径：${text}`)
      }
    }
    // 相对路径按会话实际工作目录解析；共享会话时那是 dsh-qq 的工作区。
    if (!isAbsolute(file)) file = resolve(sessionCwd === '' ? cwd : sessionCwd, file)
    let info
    try {
      info = statSync(file)
    }
    catch {
      throw new Error(`qq_draft: ${field} 指向的本地文件不存在：${file}`)
    }
    if (!info.isFile()) throw new Error(`qq_draft: ${field} 不是一个文件：${file}`)
    const extraRoots = [
      cwd,
      ...(sessionCwd === '' ? [] : [sessionCwd]),
      ...(Array.isArray(mediaPolicy.extraRoots) ? mediaPolicy.extraRoots : []),
      ...(field === 'voice' ? [VOICE_ROOT] : []),
    ]
    const allowed = isPathAllowed(file, {
      restrictPaths: mediaPolicy.restrictPaths !== false,
      extraRoots,
    }, sessionCwd === '' ? cwd : sessionCwd)
    if (!allowed) throw new Error(`qq_draft: ${field} 的路径不在允许范围（media / agent 工作目录）内：${file}`)
    return { localPath: file }
  }

  tools.register({
    name: 'qq_draft',
    description: '先起一份 QQ 消息草稿（文本 / 图片 / 视频 / 文件 / 语音），一个字都不发。要发得再调 qq_confirm(decision="send")；本轮结束前没确认的草稿会直接作废。想发几条就重复 draft + confirm。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发送的文本；QQ 里没有 Markdown 渲染，尽量简短' },
        to: { type: 'string', description: '发给谁：不给 = 回给这一轮的来处；private = 他的私聊（不在私聊里也算主动发给他）；group = 群；也可 private:<openid> / group:<openid>' },
        image: { type: 'string', description: '图片：http(s) 链接、file:// 或本地路径（相对路径按会话工作目录解析）' },
        video: { type: 'string', description: '视频：http(s) 链接、file:// 或本地路径' },
        file: { type: 'string', description: '普通文件：http(s) 链接、file:// 或本地路径' },
        voice: { type: 'string', description: '语音：本地路径或 http(s) 链接；一次草稿只放一条语音' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const origin = originOf(exec.agent)
      const to = String(args.to ?? '').trim()
      if (origin === 'console' && to === '') {
        throw new Error('qq_draft: 这一轮是在控制台说的，正文就是回复，不要往 QQ 发；真想主动发给他就带上 to（"private" 发私聊、"group" 发群）')
      }
      const record = recordOf(exec.agent)
      const target = targetFor(record, to)
      if (target === null || typeof target.targetId !== 'string' || target.targetId === '') {
        throw new Error(origin === 'qq'
          ? 'qq_draft: 这条是从 QQ 来的，但会话表里没有它的收件人记录——先别发，把情况写进正文'
          : origin === 'auto'
            ? 'qq_draft: 这一轮是心跳叫醒的，又没给 to，没有收件人——给 to="private" 发私聊，或者把话写进正文'
            : 'qq_draft: 没有收件人——给 to="private" 或 to="group"')
      }
      const text = String(args.text ?? '').trim()
      const image = await sourceOf(args.image, 'image', record)
      const video = await sourceOf(args.video, 'video', record)
      const file = await sourceOf(args.file, 'file', record)
      const voice = await sourceOf(args.voice, 'voice', record)
      if (text === '' && image === null && video === null && file === null && voice === null) {
        throw new Error('qq_draft: 草稿是空的，至少给 text / image / video / file / voice 之一')
      }
      const key = record === undefined ? String(exec.agent?.session?.id ?? 'qq') : sessionKeyOf(record)
      drafts.set(key, { text, image, video, file, voice, replyTarget: target, createdAt: Date.now() })
      const lines = [`[草稿已备好 → ${targetLabel(target)}]`]
      lines.push(text === '' ? '正文：（没有文字，只有附件）' : `正文：${text}`)
      const extras = [
        image === null ? null : '图片',
        video === null ? null : '视频',
        file === null ? null : '文件',
        voice === null ? null : '语音',
      ].filter(Boolean)
      if (extras.length > 0) lines.push(`附件：${extras.join(' / ')}`)
      const hint = await fishHint(text)
      if (hint !== '') lines.push('', hint)
      lines.push(
        '',
        '还一个字都没发出去。要发 → qq_confirm(decision="send")；不发了 → qq_confirm(decision="cancel")。',
        '本轮结束前没确认的草稿会直接作废。',
      )
      return lines.join('\n')
    },
  })

  tools.register({
    name: 'qq_confirm',
    description: '把最近这份草稿发出去（decision="send"），或者作废它（decision="cancel"）。只有最近一份草稿能被确认；想发下一条就再 qq_draft。',
    parameters: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['send', 'cancel'], description: 'send 发出去；cancel 作废' },
      },
      required: ['decision'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const record = recordOf(exec.agent)
      const key = record === undefined ? String(exec.agent?.session?.id ?? 'qq') : sessionKeyOf(record)
      const draft = drafts.get(key)
      if (draft === undefined) throw new Error('qq_confirm: 现在没有待确认的草稿（先用 qq_draft 起草）')
      const decision = String(args.decision ?? '').trim()
      if (decision === 'cancel') {
        drafts.delete(key)
        // record 在桌面/控制台会话里可能是 undefined，这里必须用可选链。
        return `草稿作废了，没有发到 ${targetLabel(draft.replyTarget ?? record?.replyTarget)}。`
      }
      if (decision !== 'send') throw new Error('qq_confirm: decision 只能是 send 或 cancel')
      const target = draft.replyTarget ?? record?.replyTarget
      if (!target || typeof target.targetId !== 'string' || target.targetId === '') {
        throw new Error('qq_confirm: 这份草稿没有收件人——重新 qq_draft 并且指明 to')
      }
      // 记忆记在收件人自己那条会话上：从群里喊出来的私聊，不能记进群那条的情节里。
      const memRecord = recordForTarget(target) ?? record
      // 每成功发掉一块就从草稿里清掉：中途某个附件失败时，重试不会把已经发过的内容再发一遍。
      const sentText = []
      const chunks = chunkMarkdownText(draft.text ?? '', chunkLimit).filter((chunk) => chunk.trim() !== '')
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]
        try {
          await sender.sendMarkdown(target, chunk)
        }
        catch (error) {
          // 剩下的留在草稿里给重试
          draft.text = chunks.slice(index).join('\n')
          notifySendFailure(memRecord, error, { kind: 'text', sent: sentText.length, total: chunks.length })
          throw new Error(`qq_confirm: 第 ${sentText.length + 1} 块（共 ${chunks.length} 块）没发出去：${classifySendError(error)}`)
        }
        sentText.push(chunk)
        draft.text = chunks.slice(index + 1).join('\n')
      }
      // 媒体：发失败就留在草稿里，并且让模型当场知道（工具也会抛，但注入能保证下一个 step 看见）
      const sendMedia = async (field, label, run) => {
        if (draft[field] == null) return
        try {
          await run(draft[field])
        }
        catch (error) {
          notifySendFailure(memRecord, error, { kind: 'file', name: label, dedup: field })
          throw new Error(`qq_confirm: ${label}没发出去：${classifySendError(error)}`)
        }
        draft[field] = null
      }
      await sendMedia('image', '图片', (source) => mediaSender.sendImage(target, source))
      await sendMedia('video', '视频', (source) => mediaSender.sendVideo(target, source))
      await sendMedia('voice', '语音', (source) => mediaSender.sendVoice(target, source))
      await sendMedia('file', '文件', (source) => {
        const { fileName, ...rest } = source
        return mediaSender.sendFile(target, rest, fileName === undefined ? undefined : { fileName })
      })
      drafts.delete(key)
      markSpoke(key)
      return `已发送到 ${targetLabel(target)}。还有下一句就继续 qq_draft + qq_confirm；不要只写在回复正文里。`
    },
  })

  tools.register({
    name: 'qq_skip',
    description: '这一轮不出声：不往 QQ 发任何东西。对方只是随口一句、话还没说完、或者你不想接，就用它——聊天里不是每句都要回。要说话用 qq_draft + qq_confirm。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么这轮不说话（只写进日志，不发给对方）' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const record = recordOf(exec.agent)
      if (record === undefined) throw new Error('qq_skip: 这一轮不是从 QQ 来的，安静着就好')
      if (config.allowSilence === false) throw new Error('qq_skip: 这里设成了每轮都要回，不能跳过（用 qq_draft + qq_confirm 回一句）')
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      logger.info(`im-qqbot: 这一轮不出声 ${record.sessionKey ?? ''}${reason === '' ? '' : ' · ' + reason}`)
      markSpoke(sessionKeyOf(record))
      return '好，这一轮不发了。'
    },
  })

  // 本轮结束还没确认的草稿作废 —— 桥绝不替模型补发。
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    try {
      const result = endTurn(session?.id)
      if (result.missed) logger.warn?.(`im-qqbot: 本轮没有发任何消息（累计 ${result.misses} 次）`)
    } catch { /* 记账失败不影响回合结束 */ }
    // 起草时的键有两种：record 存在时是 sessionKeyOf(record)（可能是 record.sessionId），
    // record 缺失时回落成字符串 'qq'。凡是可能属于这一轮的，都按同一回合作废。
    const key = session?.id
    if (typeof key !== 'string') return
    for (const candidate of [key, 'qq']) {
      const draft = drafts.get(candidate)
      if (draft === undefined) continue
      drafts.delete(candidate)
      const preview = String(draft.text ?? '').slice(0, 40)
      logger.info(`im-qqbot: 草稿没确认，作废 ${preview}`)
    }
  })

  logger.info('im-qqbot: qq_draft / qq_confirm / qq_skip 工具已注册')
}
