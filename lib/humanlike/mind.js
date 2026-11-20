// 「惦记」家族工具：humanlike_mind { want | list | done | drop }
//
// 从 cortico-world-humanlike-alont1/src/modules/mind/world.ts 搬过来。
// 存的是她自己写的一句话、为什么、什么时候提醒；到点只提醒一次，做不做由她决定。
// dsh 这边没有宿主事件总线，所以推送那一路（mind.due / digest / freetime）不搬，
// 只留四条工具动作、前缀计数，以及调度侧要用的几个纯判定/清理钩子。
// 回执、上限、编号、方括号容忍都照原样。

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_VALUES } from './settings.js'
import { PLUGIN_HOME } from '../shared/dirs.js'

const DEFAULT_DATA_DIR = path.join(PLUGIN_HOME, 'humanlike')
const TZ_OFFSET_MINUTES = 480
const TIME_ZONE = 'Asia/Shanghai'

const RECENT_CAP = 30
const TEXT_MAX = 200
const WHY_MAX = 200
const ABOUT_MAX = 40
const AFTER_MINUTES_MAX = 20160
const RECENT_SHOWN = 8
// 刚起来的 30 秒内不提醒：那是重启，不是「想起来了」
const STARTUP_SILENCE_MS = 30_000

// 默认值由 lib/settings.js 统一提供。
const DEFAULTS = { ...DEFAULT_VALUES.mind }

// 原版按配置时区格式化；dsh 这边没有配置面板，固定 +08:00。
function nowIso (date = new Date()) {
  const d = new Date(date.getTime() + TZ_OFFSET_MINUTES * 60_000)
  return d.toISOString().replace('Z', '+08:00')
}

// 「11/18 18:23」——月/日不带前导零，小时两位
function clock (at = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TIME_ZONE,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at)
}

function freshData () {
  return {
    version: 1,
    items: [],
    recent: [],
    day: '',
    pushesToday: 0,
    lastPushAt: 0,
    freeToday: 0,
    lastFreeAt: 0,
    lastDigestDay: '',
  }
}

export function createMind (opts = {}) {
  const { dataDir = DEFAULT_DATA_DIR, config = {}, logger } = opts
  const cfg = { ...DEFAULTS, ...config }
  const file = path.join(dataDir, 'mind.json')
  const startedAt = Date.now()

  let data = freshData()
  let nextId = 1

  // 编号接着最大的往下发，重启后不会撞号
  function computeNextId () {
    const maxId = [...data.items, ...data.recent]
      .map((i) => Number(String(i.id).replace(/^m/, '')))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => Math.max(a, b), 0)
    nextId = maxId + 1
  }

  // 读：先摆一份空账，再逐字段做类型兜底；坏了只 warn，从空账开始。
  function load () {
    data = freshData()
    try {
      if (!fs.existsSync(file)) {
        computeNextId()
        return
      }
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const items = Array.isArray(raw.items) ? raw.items.filter((i) => i && typeof i.text === 'string') : []
      data = {
        version: 1,
        items: items.map((i) => ({ ...i, pushedCount: Number.isFinite(i.pushedCount) ? i.pushedCount : 0 })),
        recent: Array.isArray(raw.recent) ? raw.recent.slice(0, RECENT_CAP) : [],
        day: typeof raw.day === 'string' ? raw.day : '',
        pushesToday: Number.isFinite(raw.pushesToday) ? Number(raw.pushesToday) : 0,
        lastPushAt: Number.isFinite(raw.lastPushAt) ? Number(raw.lastPushAt) : 0,
        freeToday: Number.isFinite(raw.freeToday) ? Number(raw.freeToday) : 0,
        lastFreeAt: Number.isFinite(raw.lastFreeAt) ? Number(raw.lastFreeAt) : 0,
        lastDigestDay: typeof raw.lastDigestDay === 'string' ? raw.lastDigestDay : '',
      }
    } catch (error) {
      logger?.warn?.(`humanlike: 惦记账本读取失败，从空账开始 ${String(error)}`)
      data = freshData()
    }
    computeNextId()
  }
  load()

  // 写：先进 tmp 再 rename，原子替换（原版如此）。
  function save () {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8')
      fs.renameSync(tmp, file)
    } catch (error) {
      logger?.warn?.(`humanlike: 惦记账本落盘失败 ${String(error)}`)
    }
  }

  // 了结一件：打上标记、从 items 挪进 recent。
  function retire (item, patch) {
    Object.assign(item, patch)
    data.items = data.items.filter((i) => i.id !== item.id)
    data.recent = [item, ...data.recent].slice(0, RECENT_CAP)
  }

  // 编号容忍外面套一对方括号（[m1]），只剥首尾各一个
  function find (id) {
    const key = id.trim().replace(/^\[|\]$/g, '')
    return data.items.find((i) => i.id === key)
  }

  // ── want ──────────────────────────────────────────────────────────────────
  function want (args) {
    const text = String(args?.text ?? '').trim()
    const why = String(args?.why ?? '').trim()
    if (!text) return 'text 不能为空——要记的是你想做的那件事。'
    if (!why) return 'why 不能为空——没有理由的事不值得占一个位置。'
    const pending = data.items
    // 上限按 max(1, maxPending) 判，但文案打印原始 maxPending
    if (pending.length >= Math.max(1, cfg.maxPending)) {
      return `已经惦记着 ${pending.length} 件了（上限 ${cfg.maxPending}）。`
        + '先 humanlike_mind_done 或 humanlike_mind_drop 掉一件，或者干脆别记——手上这些做完了再说。\n'
        + pending.map((i) => `- [${i.id}] ${i.text}`).join('\n')
    }
    const id = `m${nextId++}`
    let dueAt
    const afterMinutes = Number(args?.afterMinutes)
    const atTime = String(args?.atTime ?? '').trim()
    // afterMinutes 优先，两者都给时 atTime 被忽略
    if (Number.isFinite(afterMinutes) && afterMinutes > 0) {
      // 只 Math.min 封顶，不取整
      dueAt = nowIso(new Date(Date.now() + Math.min(afterMinutes, AFTER_MINUTES_MAX) * 60_000))
    } else if (/^\d{1,2}:\d{2}$/.test(atTime)) {
      const [hh, mm] = atTime.split(':').map(Number)
      if (hh <= 23 && mm <= 59) {
        // 这一步照原版用进程本地时区的 setHours；本机时区与 +08:00 一致，
        // 所以「已经过了就明天」和回执上的钟点不会错位。
        const target = new Date()
        target.setHours(hh, mm, 0, 0)
        if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1)
        dueAt = nowIso(target)
      }
    }
    const about = String(args?.about ?? '').trim()
    const item = {
      id,
      text: text.slice(0, TEXT_MAX),
      why: why.slice(0, WHY_MAX),
      ...(about ? { about: String(args.about).trim().slice(0, ABOUT_MAX) } : {}),
      ...(dueAt ? { dueAt } : {}),
      createdAt: nowIso(),
      pushedCount: 0,
    }
    data.items.push(item)
    save()
    return dueAt
      ? `记下了 [${id}]：${item.text}\n到点（${clock(new Date(Date.parse(dueAt)))}）我会把你这句话还给你一次，做不做那时候再说。`
      : `记下了 [${id}]：${item.text}\n没定时间——它只挂在 humanlike_mind_list 里，你想起来的时候自己看。`
  }

  // ── list ──────────────────────────────────────────────────────────────────
  function list () {
    const now = Date.now()
    const pending = data.items
    const head = pending.length
      ? pending.map((i) => {
          // 正好等于也算到点（<=）
          const when = i.dueAt
            ? Date.parse(i.dueAt) <= now ? '**已到点**' : `到点 ${clock(new Date(Date.parse(i.dueAt)))}`
            : '没定时间'
          return `- [${i.id}] ${i.text}${i.about ? `（关于 ${i.about}）` : ''}　${when}　（因为：${i.why}）`
        }).join('\n')
      : '（手上没有惦记的事——这很正常。）'
    const recent = data.recent.slice(0, RECENT_SHOWN).map((i) => {
      // 判定顺序：doneAt → droppedAt → 过期
      const how = i.doneAt
        ? `做完了${i.outcome ? `：${i.outcome}` : ''}`
        : i.droppedAt ? '放下了' : '过期了'
      return `- [${i.id}] ${i.text}　→ ${how}`
    }).join('\n')
    return `还惦记着的（${pending.length}/${cfg.maxPending}）：\n${head}`
      + (recent ? `\n\n最近了结的：\n${recent}` : '')
  }

  // ── done ──────────────────────────────────────────────────────────────────
  function done (args) {
    const item = find(String(args?.id ?? ''))
    if (!item) return `没有编号 ${String(args?.id ?? '')} 这一条（用 humanlike_mind_list 看编号）。`
    const outcome = String(args?.outcome ?? '').trim()
    // 回执用未截断的原始 trim 值，账本存 slice(0, 200)
    retire(item, { doneAt: nowIso(), ...(outcome ? { outcome: outcome.slice(0, TEXT_MAX) } : {}) })
    save()
    return `了了 [${item.id}]：${item.text}${outcome ? `\n（记了一句：${outcome}）` : ''}`
  }

  // ── drop ──────────────────────────────────────────────────────────────────
  function drop (args) {
    const item = find(String(args?.id ?? ''))
    if (!item) return `没有编号 ${String(args?.id ?? '')} 这一条（用 humanlike_mind_list 看编号）。`
    retire(item, { droppedAt: nowIso() })
    save()
    return `放下了 [${item.id}]：${item.text}`
  }

  // 写进系统前缀的一段：只报件数与到点数，不放原文
  function promptBlock () {
    const pending = data.items
    if (!pending.length) return ''
    const due = pending.filter((i) => i.dueAt && Date.parse(i.dueAt) <= Date.now()).length
    return `记着 ${pending.length} 件，其中 ${due} 件已到点。用 humanlike_mind_list 查看条目内容。`
  }

  // ── 调度侧（不是工具动作，宿主每次 tick 自己挑着调）──────────────────────
  // 静默判定：两值相等 = 不静默；起始点含、结束点不含。
  function inQuietHours (d = new Date()) {
    if (cfg.quietFrom === cfg.quietTo) return false
    const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', hour12: false }).format(d)) % 24
    return cfg.quietFrom > cfg.quietTo
      ? (h >= cfg.quietFrom || h < cfg.quietTo)
      : (h >= cfg.quietFrom && h < cfg.quietTo)
  }

  // 跨天归零 + 过期清理。过期在静默/暂停判定之前跑，静默期里也清；
  // 正好到时限（now - lastPushedAt === expireMs）会被清，判的是 <。
  function sweep (now = Date.now()) {
    const day = nowIso(new Date(now)).slice(0, 10)
    let changed = false
    if (data.day !== day) {
      data.day = day
      data.pushesToday = 0
      data.freeToday = 0
      changed = true
    }
    const expireMs = Math.max(1, cfg.expireAfterH) * 3600_000
    for (const item of [...data.items]) {
      if (!item.pushedCount || !item.lastPushedAt) continue
      if (now - Date.parse(item.lastPushedAt) < expireMs) continue
      retire(item, { droppedAt: nowIso() })
      logger?.info?.(`humanlike: 惦记的事过期清掉 ${item.id}`)
      changed = true
    }
    if (changed) save()
    return changed
  }

  // 该不该推：启动静默 → 静默时段 → 每日配额 → 全局间隔（判 <，正好等间隔也压住）
  function canPush (now = Date.now()) {
    if (now - startedAt < STARTUP_SILENCE_MS) return false
    if (inQuietHours(new Date(now))) return false
    if (cfg.dailyPushes > 0 && data.pushesToday >= cfg.dailyPushes) return false
    if (cfg.pushGapSec > 0 && now - data.lastPushAt < cfg.pushGapSec * 1000) return false
    return true
  }

  // 推过一次就记这本账（全局间隔 + 当天次数共用）
  function notePush (now = Date.now()) {
    data.lastPushAt = now
    data.pushesToday += 1
    save()
  }

  return {
    want, list, done, drop, promptBlock,
    inQuietHours, sweep, canPush, notePush,
    stats: () => ({
      pending: data.items.length,
      due: data.items.filter((i) => i.dueAt && Date.parse(i.dueAt) <= Date.now()).length,
      recent: data.recent.length,
    }),
    reload: () => { load() },
  }
}

export const MIND_TOOL = {
  name: 'humanlike_mind',
  description:
    '惦记的账：给自己记一件想做、为什么、什么时候提醒；列出来；做完了；放掉。\n'
    + 'want：**给你自己记一件事**：你想做什么、为什么、大概什么时候做。到点我会把你写下的原话还给你一次，'
    + '做不做那一刻由你决定。要说的话、要发的消息都还是走你当前渠道已提供的发送工具，'
    + '这里只管"记住我想做这件事"。\n'
    + '**别拿它排满日程**——攒上好几件就变成待办清单了，那不是我。真的心里挂着才记。\n'
    + 'list：看你手上还惦记着什么（含到点时间），以及最近了结掉的几件（做完的、放掉的、过期的）。\n'
    + 'done：把惦记的一件标记成做完了，可以顺手写一句结果（那句话会留在你自己的账里）。\n'
    + 'drop：把惦记的一件放掉（不想做了、或者那件事已经不成立了）。放下也是回答，别让它在账上反复出现。\n'
    + '操作及必填参数：want(text, why，可带 about/afterMinutes 或 atTime)；list()；done(id，可带 outcome)；drop(id)。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['want', 'list', 'done', 'drop'], description: '选择一次操作；只传此操作使用的参数。' },
      text: { type: 'string', maxLength: TEXT_MAX, description: 'want：一句话：你想做什么（上限 200 字）。' },
      why: { type: 'string', maxLength: WHY_MAX, description: 'want：为什么想做——没有理由的事不值得记（上限 200 字）。' },
      about: { type: 'string', maxLength: ABOUT_MAX, description: 'want：可选：这事关于谁，或者要发给谁（如「主人」）。到点会原样提醒你。' },
      afterMinutes: { type: 'integer', minimum: 1, maximum: AFTER_MINUTES_MAX, description: 'want：多少分钟之后提醒我（1 分钟 ~ 14 天）。' },
      atTime: { type: 'string', description: 'want：或者直接给钟点，形如 "21:30"；已经过了就是明天这个点。' },
      id: { type: 'string', description: 'done：条目编号，如 m1（humanlike_mind_list 里的那个）。／drop：条目编号。' },
      outcome: { type: 'string', maxLength: TEXT_MAX, description: 'done：可选：后来怎么了。' },
    },
    required: ['action'],
  },
}
