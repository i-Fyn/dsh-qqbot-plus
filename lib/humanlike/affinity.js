// 好感度家族工具：humanlike_affinity { get | adjust | list }
//
// 从 cortico-world-humanlike-alont1/src/modules/affinity/world.ts 搬过来，
// 分数、档位、情绪余波的算法与文案都照原样；唯一的差别在 get：
// 原版会去宿主事件库里按游标把「普通搭话」折算成分数（syncMessages），
// dsh 这边没有那套事件库，所以分数只由 adjust 推动。
// 这一点写进了工具描述里——不写的话模型会以为问了话就自动涨分。

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_VALUES } from './settings.js'

const TZ_OFFSET_MINUTES = 480

const DEFAULT_TIERS = [
  { min: 80, name: '好朋友', say: '很亲近。会关心他、会惦记他，软的那面露得多一点' },
  { min: 55, name: '朋友', say: '不用装了。会主动说话、会开玩笑、愿意帮忙' },
  { min: 35, name: '熟人', say: '能聊两句了。会接梗、会搭话，但还端着' },
  { min: 15, name: '眼熟', say: '认识的人。他跟我说话我会接，就是不热络' },
  { min: 0, name: '陌生群友', say: '客气。他跟我说话我回，但话短、别热络，私人问题敷衍过去' },
]

// 默认值由 lib/settings.js 统一提供；这里只补不上面板的内部参数。
const DEFAULTS = {
  ...DEFAULT_VALUES.affinity,
  gainPraise: 0.6,
  gainShare: 0.8,
  lossCommand: 0.3,
  minScore: 0,
  maxScore: 100,
  tiers: DEFAULT_TIERS,
}

const round1 = (n) => Math.round(n * 10) / 10

function nowIso () {
  const d = new Date(Date.now() + TZ_OFFSET_MINUTES * 60_000)
  return d.toISOString().replace('Z', '+08:00')
}

function todayKey () {
  return nowIso().slice(0, 10)
}

function tierOf (score, tiers) {
  const sorted = [...tiers].sort((a, b) => b.min - a.min)
  return sorted.find((t) => score >= t.min) ?? sorted[sorted.length - 1]
}

function nextTier (score, tiers) {
  const higher = [...tiers].sort((a, b) => a.min - b.min).find((t) => t.min > score)
  return higher ? { tier: higher, need: round1(higher.min - score) } : null
}

export function createAffinity (opts) {
  const { dataDir, config = {}, logger } = opts
  const cfg = { ...DEFAULTS, ...config }
  const tiers = Array.isArray(cfg.tiers) && cfg.tiers.length ? cfg.tiers : DEFAULT_TIERS
  const file = path.join(dataDir, 'affinity.json')
  const recentReads = new Map()

  function load () {
    try {
      if (!fs.existsSync(file)) return { version: 1, people: {} }
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw && typeof raw === 'object' && raw.people && typeof raw.people === 'object') {
        return { version: 1, people: raw.people }
      }
    } catch (error) {
      logger?.warn?.(`humanlike: 好感度文件读不出来，从空开始 ${String(error)}`)
    }
    return { version: 1, people: {} }
  }

  let data = load()

  function save () {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + '\n', 'utf8')
      fs.renameSync(tmp, file)
    } catch (error) {
      logger?.warn?.(`humanlike: 好感度写不进去 ${String(error)}`)
    }
  }

  // 身份键一律当字符串：dsh 这边不再依赖 QQ 号（以后不走 onebot 就拿不到）。
  // 老账本里的纯数字键照旧能用，当别名；新记的一律是渠道 openid。
  const keyOf = (v) => {
    const s = String(v ?? '').trim()
    return s && s !== '0' ? s : ''
  }
  const isFavored = (qq) => {
    const f = keyOf(cfg.favoredId)
    return f !== '' && keyOf(qq) === f
  }
  const scoreOf = (qq, rec) => (isFavored(qq) ? cfg.favoredScore : rec.score)

  function ensure (qq) {
    const key = String(qq)
    let rec = data.people[key]
    if (!rec) {
      const start = isFavored(qq) ? cfg.favoredScore : cfg.startScore
      rec = { score: start, msgs: 0, best: start, firstAt: '', lastAt: '', note: '' }
      data.people[key] = rec
    }
    return rec
  }

  function decayedIntensity (e) {
    const elapsed = Date.now() - Date.parse(e.peakAt)
    if (!Number.isFinite(elapsed) || elapsed <= 0) return e.intensity
    return e.intensity * Math.pow(0.5, elapsed / e.halfLifeMs)
  }

  function liveEmotions (rec) {
    return (rec.emotions ?? [])
      .map((e) => ({ e, now: decayedIntensity(e) }))
      .filter((x) => x.now >= cfg.emotionFloor)
  }

  function recordEmotion (rec, delta, reason) {
    const intensity = Math.min(1, Math.max(0.3, Math.abs(delta) / 3))
    const e = {
      kind: delta < 0 ? 'upset' : 'happy',
      intensity: round1(intensity),
      reason: reason || '（没记原因）',
      peakAt: nowIso(),
      halfLifeMs: cfg.emotionHalfLifeMinutes * 60_000,
    }
    rec.emotions = [e, ...(rec.emotions ?? [])].slice(0, 3)
  }

  function describe (qq, rec) {
    if (isFavored(qq)) {
      return [
        `${qq}：分数固定 ${cfg.favoredScore}，不进涨跌。`,
        `态度：${cfg.favoredSay}`,
        '这个是固定的，不会掉，也不需要理由。',
      ].join('\n')
    }
    const score = scoreOf(qq, rec)
    const t = tierOf(score, tiers)
    const lines = [
      `${qq}：好感 ${round1(score)} / 100，档位「${t.name}」，聊过 ${rec.msgs} 句。`,
      `态度：${t.say}`,
    ]
    const up = nextTier(score, tiers)
    if (up) lines.push(`再涨 ${up.need} 分进「${up.tier.name}」档。`)
    if (rec.best >= cfg.friendFloor) lines.push(`他做过朋友，所以掉不破 ${cfg.friendFloor} 分。`)
    if (rec.note) lines.push(`上次变动：${rec.note}`)
    const live = liveEmotions(rec)
    if (live.length) {
      const e = live[0]
      const mins = Math.max(0, Math.round((Date.now() - Date.parse(e.e.peakAt)) / 60_000))
      const feel = e.e.kind === 'upset' ? '还有点气' : '还挺高兴'
      const fresh = mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`
      lines.push(`情绪：${fresh}${e.e.reason ? `因为「${e.e.reason}」` : ''}，你现在${feel}（${round1(e.now * 100)}%）`)
    }
    return lines.join('\n')
  }

  // 情绪余波那一段（前缀用）
  function emotionBlock () {
    const rows = []
    for (const [qq, rec] of Object.entries(data.people)) {
      for (const { e, now } of liveEmotions(rec)) {
        rows.push({
          qq,
          kind: e.kind === 'upset' ? 'upset' : 'happy',
          strength: Math.round(now * 100),
          minutes: Math.max(0, Math.round((Date.now() - Date.parse(e.peakAt)) / 60_000)),
        })
      }
    }
    if (!rows.length) return ''
    rows.sort((a, b) => b.strength - a.strength)
    const lines = ['模拟情绪记录（是否及如何回应由 Persona 结合上下文决定）：']
    for (const row of rows.slice(0, cfg.emotionInPrompt)) {
      lines.push(`${row.qq}：类型 ${row.kind}，当前强度 ${row.strength}%，记录距今 ${row.minutes} 分钟。`)
    }
    lines.push('原始原因请用 humanlike_affinity_get 按需核对；记录不证明相关事件真实发生。')
    return lines.join('\n')
  }

  function num (v) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  function get (args) {
    const qq = keyOf(args?.qq)
    if (!qq) return '[bad input] qq 要是一个身份键（openid 或老 QQ 号）'
    const rec = ensure(qq)
    const text = describe(qq, rec)
    const recent = recentReads.get(qq)
    if (recent && Date.now() - recent.at < 5 * 60_000 && recent.text === text) {
      const tier = tierOf(scoreOf(qq, rec), tiers)
      return `${qq}：刚查过，没有变化。${isFavored(qq) ? `固定 ${cfg.favoredScore} 分；态度：${cfg.favoredSay}` : `${rec.score} 分，${tier.name}；态度：${tier.say}`}。`
    }
    recentReads.set(qq, { at: Date.now(), text })
    save()
    return text
  }

  function adjust (args) {
    const qq = keyOf(args?.qq)
    const delta = num(args?.delta)
    const reason = String(args?.reason ?? '').trim()
    if (!qq) return '[bad input] qq 要是一个身份键（openid 或老 QQ 号）'
    if (delta === null || delta === 0) return '[bad input] delta 要是非零数字'
    if (Math.abs(delta) > 3) return '[bad input] 一次最多 ±3，要更多就分几次'
    if (isFavored(qq)) return `这个人的分数固定在 ${cfg.favoredScore}，不进涨跌。`

    const rec = ensure(qq)
    const before = rec.score
    let next = before + delta

    if (delta > 0) {
      const today = todayKey()
      if (rec.day !== today) { rec.day = today; rec.gainedToday = 0 }
      const room = Math.max(0, cfg.dailyGainCap - (rec.gainedToday ?? 0))
      next = before + Math.min(delta, room)
    }

    if (rec.best >= cfg.friendFloor && next < cfg.friendFloor) next = cfg.friendFloor
    next = Math.min(cfg.maxScore, Math.max(cfg.minScore, next))

    rec.score = round1(next)
    rec.best = Math.max(rec.best, rec.score)
    const appliedDelta = round1(rec.score - before)
    if (appliedDelta > 0) rec.gainedToday = round1((rec.gainedToday ?? 0) + appliedDelta)
    if (appliedDelta !== 0) {
      if (reason) rec.note = `${appliedDelta > 0 ? '+' : ''}${appliedDelta} ${reason}`
      recordEmotion(rec, appliedDelta, reason)
    }
    recentReads.delete(qq)
    save()

    if (appliedDelta === 0) {
      return `${rec.score} → ${rec.score}\n分数未变：已达${delta > 0 ? '每日加分上限或分数上限' : '分数下限或朋友保底'}。`
    }
    const from = tierOf(before, tiers).name
    const to = tierOf(rec.score, tiers).name
    const bumped = from !== to ? `（${from} → **${to}**）` : ''
    const feel = appliedDelta < 0 ? '你现在还有点气，别装作没事' : '你现在心情不错，这股劲会持续一阵'
    return `${round1(before)} → ${rec.score}${bumped}\n现在：${tierOf(rec.score, tiers).say}\n（${feel}）`
  }

  function list () {
    const rows = Object.entries(data.people)
      .map(([qq, rec]) => ({ qq, rec, score: scoreOf(qq, rec) }))
      .sort((a, b) => b.score - a.score)
    if (!rows.length) return '还没有记下任何人。'
    const top = rows.slice(0, 25)
    const lines = top.map(({ qq, rec, score }, i) => {
      const label = isFavored(qq) ? '固定' : tierOf(score, tiers).name
      return `${i + 1}. ${qq} — ${round1(score)} 分 · ${label} · 聊过 ${rec.msgs} 句`
    })
    if (rows.length > top.length) lines.push(`…另外还有 ${rows.length - top.length} 个人`)
    return lines.join('\n')
  }

  /**
   * 记一笔「真发生过接触」：他说话了，或者我回过去了。
   *
   * 只动 lastAt / msgs / firstAt，不动分数——分数只有 adjust 能动。
   * 这是给别的插件（qqbot-plus 的 noteInbound）调的入口，所以不返回文案、不抛错，
   * 参数不对就当没这回事返回 false。
   */
  function noteContact (qq, at, said) {
    const id = keyOf(qq)
    if (!id) return false
    const when = at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString()
    const rec = ensure(id)
    if (!rec.firstAt) rec.firstAt = when
    // 他最后说的那句留一层：主动找人起念时要把「上一句是什么」带上，
    // 不然那一轮看着就是凭空冒出来的一句。
    const line = typeof said === 'string' ? said.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
    if (line) rec.lastSaid = line
    rec.lastAt = when
    rec.msgs = (Number(rec.msgs) || 0) + 1
    save()
    return true
  }

  return {
    get, adjust, list, emotionBlock, noteContact,
    stats: () => ({ people: Object.keys(data.people).length }),
    reload: () => { data = load() },
  }
}

export const AFFINITY_TOOL = {
  name: 'humanlike_affinity',
  description:
    '交情账。get 查询一个人跟你的交情（多少分、什么档位、该用什么态度）；adapt 之外没有别的加分来源——'
    + 'adjust 记一笔有依据的变化（他做了让你高兴或生气的事）；list 列出你心里排前面的几个人。'
    + '注意：这个宿主没有事件库，普通搭话**不会**自动涨分，分数只由 adjust 推动；'
    + 'get 也不会因为「聊过几句」自己变，msgs 是历史计数。'
    + '参考幅度：夸你／说好话 +0.6；分享他自己的事 +0.8；骂你（笨／傻／滚）-1.5；'
    + '人身攻击 -3；命令式使唤 -0.3。一次最多 ±3，每日加分有上限。'
    + '写入后以回执为准，不重复查询确认。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['get', 'adjust', 'list'], description: '选择一次操作；只传此操作使用的参数。' },
      qq: { type: 'string', description: 'get/adjust：对方的身份键——渠道 openid，或老账本里的 QQ 号。' },
      delta: { type: 'number', description: 'adjust：变化量，正数涨、负数跌。一次不要超过 ±3。' },
      reason: { type: 'string', description: 'adjust：为什么变。一句话。他看不到，是给你自己以后看的。' },
    },
    required: ['action'],
  },
}
