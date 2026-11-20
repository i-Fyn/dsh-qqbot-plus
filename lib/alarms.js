/**
 * 唤醒器（闹钟）：alarm_set / alarm_list / alarm_cancel + 每秒心跳。
 *
 * 从 Coopanion 的 core/alarms.ts 搬过来（时间换算与文案照抄，别自己重写）。
 * dsh 没有宿主事件总线，叫醒只能走 agent.followup；
 * 心跳每秒一次，但**先把 agent 挑到 idle 再 takeDue**，否则到点那条被删了却发不出去。
 *
 * @module dsh-qqbot-plus/alarms
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pickAgent } from './session/pick-agent.js'

const STATE_DIR = join(homedir(), '.dsh', 'dsh-qqbot-plus')
const STATE_FILE = join(STATE_DIR, 'alarms.json')
const LOG_FILE = join(STATE_DIR, 'alarms.log')
const LOG_MAX_BYTES = 1024 * 1024
const TICK_MS = 1000
const MISSED_AFTER_MS = 60_000
const TIMEZONE = 'Asia/Shanghai'

/** 往 alarms.log 追加一行——宿主 console 看不见，出问题只能靠这个。
 *  超过 1MB 就把旧文件改名成 alarms.log.1（只留一代），不会无限长下去。 */
function note (line) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    try {
      if (statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`)
    } catch {}
    writeFileSync(LOG_FILE, `${new Date().toISOString()} 唤醒器 ${line}\n`, { flag: 'a' })
  } catch {}
}

const zh = {
  minutesTooFew: 'in_minutes 至少是 1',
  noTime: '要给 at 或 in_minutes',
  past: (at) => `${at} 已经过去了`,
  badAt: (got) => `at 应为 HH:MM 或 YYYY-MM-DD HH:MM,收到 ${got}`,
  due: (setAt, id, daily, note) => `[唤醒器] 你在 ${setAt} 设的唤醒到了(${id}${daily ? ',每天' : ''}):${note}`,
  missed: (when) => `原定 ${when},那时应用没开着,现在才送到。`,
  listLine: (id, when, clock, note) => `- ${id}:${when}${clock ? `(每天 ${clock})` : ''} ${note}`,
  noteEmpty: '[alarm_set 没执行] note 不能为空。',
  setFailed: (why) => `[alarm_set 没执行] ${why}。`,
  set: (id, when, clock) => `已设 ${id}:${when}${clock ? `,之后每天 ${clock}` : ''}。`,
  none: '没有设着的唤醒器。',
  missing: (id) => `[alarm_cancel 没执行] 没有 ${id} 这个唤醒器。`,
  cancelled: (id) => `已取消 ${id}。`,
}

/** UTC 减本地，分钟，`timezone` 在 `d` 那一刻。 */
function offsetMinutes (timezone, d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]))
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return (d.getTime() - d.getMilliseconds() - local) / 60_000
}

/** `timezone` 里某面钟的时刻对应的 epoch ms；被夏令时跳过的钟点往后顺延一个缺口。 */
function localToEpoch (timezone, y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const first = guess + offsetMinutes(timezone, new Date(guess)) * 60_000
  const second = guess + offsetMinutes(timezone, new Date(first)) * 60_000
  const wall = second - offsetMinutes(timezone, new Date(second)) * 60_000
  return wall === guess ? second : Math.max(first, second)
}

function localDate (timezone, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { year: +p.year, month: +p.month, day: +p.day }
}

function nextClock (timezone, now, hour, minute, withinMinute = 0) {
  const { year, month, day } = localDate(timezone, now)
  const at = localToEpoch(timezone, year, month, day, hour, minute) + withinMinute
  return at > now ? at : localToEpoch(timezone, year, month, day + 1, hour, minute) + withinMinute
}

/** `MM-DD HH:MM`，`timezone` 里。 */
function localLabel (timezone, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/** `at`（HH:MM 取下一个这样的点，或 YYYY-MM-DD HH:MM）或 `inMinutes` 对应的到点时刻，或给不出的原因。 */
function dueTime (timezone, now, at, inMinutes) {
  const t = zh
  if (typeof inMinutes === 'number') {
    if (!(inMinutes >= 1)) return t.minutesTooFew
    return now + Math.round(inMinutes * 60_000)
  }
  if (typeof at !== 'string') return t.noTime
  const full = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(at.trim())
  if (full) {
    const [, y, mo, d, h, mi] = full.map(Number)
    if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59) return t.badAt(JSON.stringify(at))
    const ms = localToEpoch(timezone, y, mo, d, h, mi)
    return ms > now ? ms : t.past(at)
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(at.trim())
  if (!clock || +clock[1] > 23 || +clock[2] > 59) return t.badAt(JSON.stringify(at))
  return nextClock(timezone, now, +clock[1], +clock[2])
}

function validAlarm (a) {
  return a && typeof a === 'object' &&
    typeof a.id === 'string' && typeof a.note === 'string' && typeof a.daily === 'boolean' &&
    typeof a.at === 'number' && Number.isFinite(a.at) && typeof a.setAt === 'number' && Number.isFinite(a.setAt)
}

function restoreSaved (value) {
  const saved = value && typeof value === 'object' ? value : {}
  const records = Array.isArray(saved.alarms) ? saved.alarms : []
  const alarms = records.filter(validAlarm)
  if (alarms.length < records.length) {
    // 坏记录丢掉，其余留着；只打日志，不炸。
    note(`丢掉 ${records.length - alarms.length} 条坏记录`)
  }
  const next = Number.isSafeInteger(saved.next) && saved.next >= 1 ? saved.next : 1
  return { next, alarms }
}

const TOOL_DECLS = [
  {
    name: 'alarm_set',
    description: '给自己设一个唤醒器：到点你会被一条带着你写的 note 的事件叫醒。设了以后用 alarm_list 看还剩哪些、alarm_cancel 撤掉不要的——dsh 这边没有设置窗口可看。用它准时提醒主人、在某个钟点去做一件事，或者过一阵回来看一眼。应用关着的时候错过的，下次启动时补投，并说明原定时间。注意：那一轮正忙时不会打断，等空下来下一跳才送，可能晚几十秒。',
    parameters: {
      type: 'object',
      properties: {
        at: { type: 'string', description: "本地钟点（宿主时区）：HH:MM（今天过了就算明天），或 YYYY-MM-DD HH:MM。被夏令时跳过的钟点往后顺延一个缺口。给这个或 in_minutes。" },
        in_minutes: { type: 'number', minimum: 1, description: '从现在起几分钟后。' },
        note: { type: 'string', description: '到点要做什么、为什么设这一条——写给你那时候的自己看。' },
        daily: { type: 'boolean', description: 'true = 每天这个本地钟点都叫一次，直到 alarm_cancel；夏令时变了也跟着走。' },
      },
      required: ['note'],
    },
  },
  {
    name: 'alarm_list',
    description: '列出你设着的唤醒器：id、时间（本地时间）、note。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'alarm_cancel',
    description: '取消一个唤醒器；每天的会整个停掉。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'alarm_set 回执或 alarm_list 里的 id，形如 a3。' } },
      required: ['id'],
    },
  },
]

export class Alarms {
  constructor (file = STATE_FILE, timezone = TIMEZONE, now = Date.now) {
    this.file = file
    this.timezone = timezone
    this.now = now
    this.saved = { next: 1, alarms: [] }
    this.load()
  }

  load () {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      this.saved = restoreSaved(raw)
    } catch (error) {
      note(`读 alarms.json 失败 ${error instanceof Error ? error.message : String(error)}`)
      this.saved = { next: 1, alarms: [] }
    }
    // 老记录缺 clock 的，从 at 反推出来（每天那条要用它重新排期）。
    for (const alarm of this.saved.alarms) {
      if (alarm.daily && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(alarm.clock ?? ''))) {
        alarm.clock = localLabel(this.timezone, alarm.at).slice(-5)
      }
    }
  }

  save () {
    try {
      if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(this.file, `${JSON.stringify(this.saved, null, 2)}\n`)
      return true
    } catch (error) {
      note(`写 alarms.json 失败 ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** 把 `now` 已经到点的那些取下来（每天的重新排到第二天的同一个钟点），各自带上「是不是错过了」。 */
  takeDue (now = this.now()) {
    const due = this.saved.alarms.filter((a) => a.at <= now)
    if (!due.length) return []
    this.saved.alarms = this.saved.alarms.filter((a) => a.at > now)
    for (const a of due) {
      if (!a.daily) continue
      const [hour, minute] = a.clock.split(':').map(Number)
      const at = nextClock(this.timezone, now, hour, minute, a.at % 60_000)
      this.saved.alarms.push({ ...a, at })
    }
    this.save()
    return due.map((alarm) => ({ alarm, missed: now - alarm.at > MISSED_AFTER_MS }))
  }

  /** 设着的，最近的那个在前。 */
  list () {
    return this.saved.alarms.slice().sort((a, b) => a.at - b.at)
  }

  /** 取掉 `id`；没有就回 null。 */
  cancel (id) {
    const alarm = this.saved.alarms.find((a) => a.id === id)
    if (!alarm) return null
    this.saved.alarms = this.saved.alarms.filter((a) => a !== alarm)
    this.save()
    return alarm
  }

  dueText (alarm, missed) {
    const t = zh
    return [
      t.due(localLabel(this.timezone, alarm.setAt), alarm.id, alarm.daily, alarm.note),
      ...(missed ? [t.missed(localLabel(this.timezone, alarm.at))] : []),
    ].join('\n')
  }

  /**
   * 三个工具绑好 handler 交出去。
   * `handlers` 里返回 `{ text, failed }`，由调用方转成工具回执。
   */
  tools (now = this.now) {
    const tz = this.timezone
    const listText = () => this.list().map((a) => zh.listLine(a.id, localLabel(tz, a.at), a.daily ? a.clock : undefined, a.note)).join('\n')
    const run = {
      alarm_set: (args = {}) => {
        const noteText = typeof args.note === 'string' ? args.note.trim() : ''
        if (!noteText) return { text: zh.noteEmpty, failed: true }
        const time = now()
        const at = dueTime(tz, time, args.at, args.in_minutes)
        if (typeof at === 'string') return { text: zh.setFailed(at), failed: true }
        const alarm = { id: `a${this.saved.next++}`, at, note: noteText, daily: args.daily === true, setAt: time }
        if (alarm.daily) {
          alarm.clock = typeof args.in_minutes !== 'number' && typeof args.at === 'string'
            ? args.at.trim().match(/\d{1,2}:\d{2}$/)[0].padStart(5, '0')
            : localLabel(tz, at).slice(-5)
        }
        this.saved.alarms.push(alarm)
        this.save()
        return { text: zh.set(alarm.id, localLabel(tz, at), alarm.clock), alarm }
      },
      alarm_list: () => ({ text: this.saved.alarms.length ? listText() : zh.none }),
      alarm_cancel: (args = {}) => {
        if (!this.cancel(args.id)) return { text: zh.missing(JSON.stringify(args.id)), failed: true }
        return { text: zh.cancelled(String(args.id)) }
      },
    }
    return { run, decls: TOOL_DECLS }
  }
}

/** 进程内共用一份：工具写、心跳取，两边得看同一份内存，不然刚设的会被旧快照盖掉。 */
let shared = null
export function alarmsOf () {
  if (!shared) shared = new Alarms(STATE_FILE, TIMEZONE)
  return shared
}

/**
 * 把三个工具挂到 tools 服务上。
 *
 * 回执形状照 `lib/media/draft-tool.js` 的 register：`output.schema` 是 string，`render` 取 .text。
 */
export function registerAlarmTools (ctx, alarms, logger) {
  const tools = ctx.get?.('tools') ?? ctx.tools
  if (!tools?.register) {
    logger?.warn?.('im-qqbot: tools 服务不可用，alarm_set/alarm_list/alarm_cancel 未注册')
    return false
  }
  const { run, decls } = alarms.tools()
  for (const decl of decls) {
    tools.register({
      name: decl.name,
      description: decl.description,
      parameters: decl.parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute (args = {}) {
        try {
          const result = run[decl.name]?.(args) ?? { text: `[bad input] ${decl.name} 没有这个动作`, failed: true }
          return result.text
        } catch (error) {
          logger?.warn?.(`im-qqbot: ${decl.name} 出错 ${error instanceof Error ? error.message : String(error)}`)
          return `出错了：${error instanceof Error ? error.message : String(error)}`
        }
      },
    })
  }
  logger?.info?.('im-qqbot: 唤醒器工具已注册（alarm_set · alarm_list · alarm_cancel）')
  return true
}

/**
 * 每秒一跳：先挑到 idle 的会话再 takeDue，然后把到点的每一条投进去。
 *
 * 挑不到或正忙就**什么都不取**——取下来又发不出去，那条就丢了（她踩过）。
 */
export function startAlarms ({ ctx, agents, logger, timezone = TIMEZONE } = {}) {
  const alarms = alarmsOf()
  let busy = false

  async function tick () {
    if (busy) return
    busy = true
    try {
      const agent = await pickAgent(agents)
      if (!agent || agent.status !== 'idle') return
      const due = alarms.takeDue(Date.now())
      if (!due.length) return
      for (const { alarm, missed } of due) {
        const text = alarms.dueText(alarm, missed)
        try {
          agent.followup({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'qq-alarm', id: alarm.id },
          })
          note(`叫醒 ${alarm.id}${missed ? '（错过补投）' : ''}`)
          logger?.info?.(`唤醒器：叫醒 ${alarm.id}`)
        } catch (error) {
          // 投不出去就放回去，下一跳再试；别丢。
          alarms.saved.alarms.push(alarm)
          alarms.save()
          note(`投递失败 ${alarm.id} ${error instanceof Error ? error.message : String(error)}`)
          logger?.warn?.(`唤醒器：投递失败 ${error instanceof Error ? error.message : String(error)}`)
          break
        }
      }
    } catch (error) {
      note(`tick 异常 ${error instanceof Error ? error.message : String(error)}`)
      logger?.warn?.(`唤醒器 tick 异常 ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => { void tick() }, TICK_MS)
  if (typeof timer.unref === 'function') timer.unref()

  return {
    alarms,
    tick,
    stop: () => clearInterval(timer),
    status: () => ({ file: STATE_FILE, count: alarms.list().length, alarms: alarms.list() }),
  }
}
