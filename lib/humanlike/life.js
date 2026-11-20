// 生活状态家族工具：humanlike_life { now | set | event | tick | reach }
//
// 从 cortico-world-humanlike-alont1/src/modules/life/world.ts 与 content.ts 搬过来。
// 状态机、精力漂移、事件链、回执文案都照原样。跟原版的差别只有这几处：
//
// 1. 没有宿主事件库。原版 refreshHeardAt() 还会从 host.store.range 拉最近的 QQ 消息，
//    这里只读 affinity.json 里的 lastAt——「说过话」仍然算数，只是以账本为准。
//    原版只有事件库查询抛错才返回 false，所以这里恒定返回 true。
// 2. 没有自动搭话的定时器（原版 setInterval + host.pushEvent）。reach 只保留手动路径；
//    到点该不该起念那道闸门留着（shouldReachOut），宿主自己排期时用。
// 3. 交情那份配置（favoredSay / tiers）原版是两个 world 各拿各的，这里从 config.affinity 取，
//    没给就退回 life 自己那几个同名键。
// 4. 读写全同步、全部吞异常：life.json 坏了就当没有，写不进去就等下一次。
// 5. EventChain.chance 原版声明了但从没被读取（有 follow 就一定引出，且链只续一层），照抄。

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_VALUES } from './settings.js'

const TZ_OFFSET_MINUTES = 480

// 档位表与 affinity.js 同一份：reach 回执里的「交情 X 分，什么档位」用的就是它。
const DEFAULT_TIERS = [
  { min: 80, name: '好朋友', say: '很亲近。会关心他、会惦记他，软的那面露得多一点' },
  { min: 55, name: '朋友', say: '不用装了。会主动说话、会开玩笑、愿意帮忙' },
  { min: 35, name: '熟人', say: '能聊两句了。会接梗、会搭话，但还端着' },
  { min: 15, name: '眼熟', say: '认识的人。他跟我说话我会接，就是不热络' },
  { min: 0, name: '陌生群友', say: '客气。他跟我说话我回，但话短、别热络，私人问题敷衍过去' },
]

const FAVORED_SAY = '满分的意思是不用收着——想说什么就说，想找他就找，他半天没动静可以直接问一句。'

const ENERGY_LOW = 0.25
const ENERGY_HIGH = 0.68

// 默认值由 lib/settings.js 统一提供；tickMs 是内部节拍，不上面板。
const DEFAULTS = {
  ...DEFAULT_VALUES.life,
  tickMs: 60000,
}

// ── 内容库（照 content.ts 抄：措辞不改，权重不改） ──────────────────────────

// 工作日：要早起、白天有事做、晚上报复性熬夜。
const WORKDAY = {
  deepNight: [
    ['熬夜刷手机，越刷越精神，一点睡意都没有', 3],
    ['在补白天没看完的东西，看进去了', 3],
    ['睡不着，躺着在脑子里排明天要做的事', 2],
    ['熬夜追番，说好一集结果看到第四集', 3],
    ['已经睡死了', 2],
  ],
  earlyMorning: [
    ['闹钟一响就起来了，今天状态意外地好', 3],
    ['刚醒，脑子转得挺快，已经在盘算今天干嘛', 3],
    ['在赖床，但只是赖着玩手机，不困了', 3],
    ['一边刷牙一边刷消息，看看昨晚错过了什么', 2],
    ['早饭吃得挺香，今天想吃点好的', 2],
  ],
  morning: [
    ['在干活，今天效率还行', 4],
    ['边干活边跟人聊天，两不耽误', 3],
    ['在认真做一件拖了很久的事，做进去就停不下来', 3],
    ['在跟人掰扯一个事，谁也不让谁', 2],
    ['刚看完一个东西，想找人说说', 3],
    ['开会在走神，但脑子在转别的事', 2],
    ['在干正事，顺手把别的一起收拾了', 3],
  ],
  noon: [
    ['在吃饭，吃得很香，加了第二碗', 4],
    ['刚吃完，在跟人聊刚才那事，还没聊完', 3],
    ['在刷消息，顺手回了几条攒着的', 3],
    ['在想要不要睡一会儿，估计不会睡', 2],
    ['饭搭子在吐槽，我听着，偶尔接一句', 2],
  ],
  afternoon: [
    ['在干活，手上有事，不太想被打断', 4],
    ['在打游戏，刚赢了一把，心情正好', 3],
    ['在写东西，一写就写了两个小时', 3],
    ['在跟人抬杠，挺来劲的', 3],
    ['在翻之前存的东西，翻到不少好玩的', 2],
    ['在硬扛一个不想干的活，但已经在干了', 2],
  ],
  evening: [
    ['在吃饭，边吃边刷东西，吃得比平时慢', 4],
    ['在追番，看到精彩的地方', 3],
    ['在打游戏，手感不错，准备再来一把', 3],
    ['刚洗完澡，很舒服，精神又回来了', 3],
    ['在跟人唠，一唠就停不下来', 3],
    ['出门转了一圈，买到了想吃的东西', 2],
  ],
  night: [
    ['在熬夜，精神反而比白天好', 3],
    ['在看书/看小说，停不下来', 3],
    ['在想事情，越想越清醒', 3],
    ['刚洗完澡，头发还湿着，在等它干', 2],
    ['在跟人聊天，聊到忘了时间', 3],
    ['在收拾明天要带的东西，顺手收拾了一下桌子', 2],
  ],
}

// 周末：不用早起，能干的事更多，晚上更野。
const WEEKEND = {
  deepNight: [
    ['熬夜打游戏，说好最后一把结果又开了三把', 4],
    ['在跟人连麦，聊到谁都不想挂', 3],
    ['睡不着，在刷东西，越刷越有兴致', 2],
    ['已经睡死了', 2],
    ['半夜饿了，爬起来翻冰箱，顺便做了点吃的', 2],
  ],
  earlyMorning: [
    ['难得睡到自然醒，起来的时候神清气爽', 3],
    ['醒了，躺着刷了会儿手机，不困了', 3],
    ['起得比平时还早，有点得意', 3],
    ['在外面，趁早上人少出来走走', 2],
  ],
  morning: [
    ['起得挺早，在吃早饭，边吃边计划今天干嘛', 4],
    ['在收拾屋子，越收拾越来劲，顺手扔了一堆东西', 3],
    ['出门了，去买了点东西回来', 3],
    ['在弄一个自己感兴趣的东西，弄了一上午', 3],
    ['在看之前存着没看的东西，一口气看了不少', 2],
  ],
  noon: [
    ['在吃饭，周末当然要吃好一点', 4],
    ['刚吃完，在跟人聊要去哪', 3],
    ['在琢磨下午干点什么，选项有点多', 3],
    ['点了外卖，还顺手点了个甜的', 2],
  ],
  afternoon: [
    ['在打游戏，连赢两把，手感很好', 3],
    ['在追番，一口气看了四集', 3],
    ['出门转了一圈，走了不少路，挺舒服', 3],
    ['在跟朋友连麦打游戏，笑了一下午', 3],
    ['在弄一个拖了很久的东西，今天终于动起来了', 3],
    ['在洗衣服顺便收拾，一鼓作气干完了', 2],
  ],
  evening: [
    ['在吃饭，今天加了个菜', 4],
    ['在追番，看到关键剧情，正上头', 3],
    ['在打游戏，刚被队友坑了，正在骂', 3],
    ['刚洗完澡，精神又回来了', 3],
    ['在外面吃，吃得挺开心', 3],
    ['在跟人聊接下来去哪玩', 2],
  ],
  night: [
    ['在熬夜，反正明天不用早起，一点不困', 4],
    ['在看书/看小说，停不下来', 3],
    ['在打游戏，说好最后一把', 3],
    ['在想事情，越想越精神', 2],
    ['刚洗完澡，头发还湿着，在刷东西', 2],
    ['在跟人聊，聊到忘了明天要干嘛', 3],
  ],
}

// 心情池。权重偏向「有精神、有兴致」那一侧——底色是精神头足的，
// 没劲、发空、懒得说话这些是少数时刻，不该和正常状态平分秋色。
const MOODS = [
  ['心情不错', 5],
  ['挺放松的', 3],
  ['干劲满满', 4],
  ['有点小得意', 3],
  ['被夸了，心情好', 2],
  ['有点期待什么', 3],
  ['想找人说说话', 3],
  ['吃饱了，很满足', 3],
  ['有点来劲', 4],
  ['没什么特别的', 4],
  ['平静', 4],
  ['想吃东西', 2],
  ['有点烦', 2],
  ['有点焦虑', 1],
  ['有点无聊', 1],
  ['困', 1],
  ['懒洋洋的', 1],
  ['懒得说话', 1],
  ['莫名有点丧', 1],
  ['心里空空的', 1],
  ['困得眼睛都睁不开', 1],
]

// 今天遇到的小事，每条是一段链：先发生种子，之后可能引出后续。
// chance 在原版里声明了但从未读取——有 follow 就一定引出，且链只续一层。
const CHAINS = [
  {
    seed: '今天做菜失手了，一整锅都废了',
    follow: [
      { text: '因为那锅毁了，中午只好点外卖，还送错了', mood: '有点烦' },
      { text: '为了赎罪，晚上认真煮了一锅，煮得有点多', mood: '吃饱了，很满足' },
    ],
  },
  {
    seed: '今天点的外卖送错了，给了一堆不爱吃的',
    follow: [
      { text: '勉强吃了两口，越想越气，给自己又点了份甜品', mood: '想吃东西' },
      { text: '懒得计较，泡了碗面对付过去', mood: '没什么特别的' },
    ],
  },
  {
    seed: '今天刷到一个很好笑的视频，笑了半天',
    follow: [
      { text: '后来一直翻这个博主的主页，翻到半夜', mood: '心情不错' },
      { text: '想分享给别人，翻了半天通讯录又算了', mood: '想找人说说话' },
    ],
  },
  {
    seed: '今天下午太阳很好，趴在窗边晒了一会儿',
    follow: [
      { text: '晒着晒着睡着了，醒来天都黑了', mood: '懒洋洋的' },
    ],
  },
  {
    seed: '今天打游戏连输三把',
    follow: [
      { text: '气得关了游戏，结果十分钟后又打开了', mood: '有点烦' },
      { text: '不玩了，去看了会儿视频才缓过来', mood: '平静' },
    ],
  },
  {
    seed: '今天打游戏终于把卡了很久的那关过了',
    follow: [
      { text: '得意了一晚上，见谁都想说', mood: '有点小得意' },
    ],
  },
  {
    seed: '今天被人说了句不太好听的实话',
    follow: [
      { text: '气到现在，一直在心里演练怎么回嘴', mood: '有点烦' },
      { text: '赌气说以后再也不做这道菜了（大概能坚持到明天）', mood: '有点烦' },
    ],
  },
  {
    seed: '今天被人夸了，虽然嘴上不承认但挺开心',
    follow: [
      { text: '偷偷把这句话回味了好几遍', mood: '被夸了，心情好' },
    ],
  },
  {
    seed: '今天出门忘带东西，又跑回去拿',
    follow: [
      { text: '这么一折腾，整个上午的计划全乱了', mood: '有点烦' },
    ],
  },
  {
    seed: '今天发现冰箱里基本空了',
    follow: [
      { text: '列了个采购清单，然后一直没出门', mood: '懒洋洋的' },
      { text: '只好凑合了一顿，全是主食', mood: '吃饱了，很满足' },
    ],
  },
  {
    seed: '今天听了一首歌，循环了一下午',
    follow: [
      { text: '到晚上满脑子还是那段旋律', mood: '心情不错' },
    ],
  },
  {
    seed: '今天睡了快十个小时，起来还是困',
    follow: [
      { text: '怀疑自己是不是睡太多了，反而更累', mood: '困' },
    ],
  },
  {
    seed: '今天想早点睡，结果又熬到很晚',
    follow: [
      { text: '早上起来后悔得要命，发誓今晚一定早睡', mood: '困' },
    ],
  },
  {
    seed: '今天盯着屏幕发了很久的呆',
    follow: [
      { text: '什么也没干成，有点自我嫌弃', mood: '莫名有点丧' },
    ],
  },
  {
    seed: '今天把攒了一周的衣服都洗了',
    follow: [
      { text: '看着晾起来的衣服，莫名有成就感', mood: '有点小得意' },
    ],
  },
  {
    seed: '今天翻到很久以前的东西，看了半天',
    follow: [
      { text: '有点感慨，但又说不上来感慨什么', mood: '心里空空的' },
    ],
  },
  {
    seed: '今天想买的东西涨价了',
    follow: [
      { text: '加入购物车放了一晚上，最后还是没买', mood: '有点焦虑' },
    ],
  },
  {
    seed: '今天一个人在家待了一整天，没跟人说话',
    follow: [
      { text: '到晚上突然很想找人说点什么', mood: '想找人说说话' },
    ],
  },
  {
    seed: '今天试图做点正经事，开了个头就停了',
    follow: [
      { text: '安慰自己明天再说，然后刷起了手机', mood: '有点焦虑' },
    ],
  },
  {
    seed: '今天下了一整天的雨，哪也没去',
    follow: [
      { text: '听着雨声反而睡了个好觉', mood: '挺放松的' },
    ],
  },
  {
    seed: '今天吃得特别饱，撑得不想动',
    follow: [
      { text: '瘫在椅子上一小时，觉得人生圆满', mood: '吃饱了，很满足' },
    ],
  },
  {
    seed: '今天走路的时候踩到水坑，鞋湿了',
    follow: [
      { text: '一整天脚都不舒服，心情也跟着差', mood: '有点烦' },
    ],
  },
]

// 心情 → 此刻该怎么说话。光报「心情：开心」没用，得说清开心表现在哪。
// 注意是按前缀匹配的，所以顺序不能乱：「困得眼睛都睁不开」会被「困」先接住，
// 这是原版就有的行为，不是抄错。
const TONE_OF = {
  开心: '心情好，话可以多一点，带点兴致，愿意接话',
  心情不错: '心情好，话可以多一点，带点兴致，愿意接话',
  被夸了: '被夸了，嘴上不承认但藏不住，可以多两句',
  挺放松的: '很松弛，随便聊，不用端着',
  想找人说说话: '有点想聊，话可以多一点，甚至可以主动起个话头',
  有点小得意: '有点飘，坐不住，会想显摆一下但会克制',
  吃饱了: '吃饱了很满足，语气软，什么都好说',
  干劲满满: '来劲了，说话干脆利落，愿意做事',
  有点来劲: '有兴致，愿意多说两句，也会主动起个话头',

  平静: '平铺直叙，正常聊天，不冷不热',
  没什么特别的: '平淡，正常回话就行',
  有点无聊: '没什么兴致，回得随意、偏短',
  懒洋洋的: '懒得动，话短，能少说就少说',
  想吃东西: '心思在吃的上面，聊到吃的会来劲，别的敷衍',
  困: '困，句子更短、更直，懒得解释，可以表示想睡',
  有点期待: '心里有点期待，问起来会多说两句',

  有点烦: '烦，语气冲一点、更短、更直。别装没事，但也别炸毛',
  有点焦虑: '心里不踏实，说话不如平时笃定，会走神',
  莫名有点丧: '提不起劲，话少，没什么想说的',
  心里空空的: '发空，回得慢半拍，句子短',
  懒得说话: '**能不说就不说**。必须回也只回最少的字',
  困得眼睛都睁不开: '**极短**。一两个字，或者直接说要去睡',
}

const TONE_FALLBACK = '平铺直叙，正常聊天'

// ── 纯函数 ──────────────────────────────────────────────────────────────────

function nowIso () {
  const d = new Date(Date.now() + TZ_OFFSET_MINUTES * 60_000)
  return d.toISOString().replace('Z', '+08:00')
}

/** 把配置时区的墙上时间当作本机本地时间读：只用它的 getHours() 与 toDateString()。 */
function wallNow () {
  return new Date(nowIso().slice(0, 19))
}

function slotFor (hour) {
  if (hour < 6) return 'deepNight'
  if (hour < 9) return 'earlyMorning'
  if (hour < 12) return 'morning'
  if (hour < 14) return 'noon'
  if (hour < 18) return 'afternoon'
  if (hour < 22) return 'evening'
  return 'night'
}

function dayKindFor (date) {
  const d = date.getDay()
  return d === 0 || d === 6 ? 'weekend' : 'workday'
}

function activitiesFor (date) {
  const pool = dayKindFor(date) === 'weekend' ? WEEKEND : WORKDAY
  return pool[slotFor(date.getHours())]
}

/** 按权重抽一个；exclude 只在池里不止一条时生效（否则一律照抽）。 */
function pick (list, exclude) {
  const pool = list.length > 1 && exclude ? list.filter(([t]) => t !== exclude) : list
  const total = pool.reduce((a, x) => a + x[1], 0)
  let r = Math.random() * total
  for (const [v, w] of pool) {
    r -= w
    if (r <= 0) return v
  }
  return pool[0][0]
}

const minutes = (n) => n * 60_000
const round2 = (n) => Math.round(n * 100) / 100

function energyModifier (energy) {
  if (energy < ENERGY_LOW) return '而且你确实熬穿了，这会儿是真的没劲——话短一点，但别装可怜'
  if (energy > ENERGY_HIGH) return '精力也足，可以多接两句，兴致来了别压着'
  return ''
}

function tierOf (score, tiers) {
  const sorted = [...tiers].sort((a, b) => b.min - a.min)
  return sorted.find((t) => score >= t.min) ?? sorted[sorted.length - 1]
}

export function createLife (opts) {
  const { dataDir, config = {}, logger } = opts
  const cfg = { ...DEFAULTS, ...config }
  const file = path.join(dataDir, 'life.json')
  const affinityFile = path.join(dataDir, 'affinity.json')

  // 交情那边的配置（favoredSay / tiers）。原版 life 通过 opts.affinityCfg 拿到，
  // 这里允许调用方传 config.affinity，没传就退回 life 自己那几个同名键。
  const affSub = cfg.affinity && typeof cfg.affinity === 'object' ? cfg.affinity : {}
  const affinityCfg = {
    favoredId: affSub.favoredId ?? cfg.favoredId ?? '',
    favoredScore: affSub.favoredScore ?? cfg.favoredScore ?? 100,
    favoredSay: affSub.favoredSay ?? FAVORED_SAY,
    tiers: Array.isArray(affSub.tiers) && affSub.tiers.length ? affSub.tiers : DEFAULT_TIERS,
  }

  let state = null
  let timer = null
  let dirty = false
  let lastReachAt = null
  let lastFavoredReachAt = null
  let lastReachAttemptAt = null
  let lastFavoredReachAttemptAt = null
  let lastFavoredHeardAt = null
  /** 他最后说的那句（起念时带上，免得那一轮和上一句接不上）。 */
  let lastFavoredSaid = ''
  const heardAt = new Map()

  // ── 持久化 ────────────────────────────────────────────────────────────────

  function load () {
    try {
      if (!fs.existsSync(file)) return null
      const s = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!s || typeof s.activity !== 'string' || typeof s.mood !== 'string') return null
      if (!Array.isArray(s.events)) s.events = []
      if (typeof s.energy !== 'number') s.energy = 0.8
      // 主动搭话的闸门跟着状态一起活过来（老文件没有这些字段就是 null，从头开始）。
      lastReachAt = typeof s.lastReachAt === 'number' ? s.lastReachAt : null
      lastFavoredReachAt = typeof s.lastFavoredReachAt === 'number' ? s.lastFavoredReachAt : null
      lastReachAttemptAt = typeof s.lastReachAttemptAt === 'number' ? s.lastReachAttemptAt : null
      lastFavoredReachAttemptAt = typeof s.lastFavoredReachAttemptAt === 'number' ? s.lastFavoredReachAttemptAt : null
      return s
    } catch (error) {
      logger?.warn?.(`humanlike: 生活状态读取失败，重新开始 ${String(error)}`)
      return null
    }
  }

  function fresh () {
    const ms = Date.now()
    const d = wallNow()
    return {
      activity: pick(activitiesFor(d)),
      mood: pick(MOODS),
      // 起始精力偏高：她本来就精神头足，不该一开局就是半累不累的样子
      energy: round2(0.72 + Math.random() * 0.24),
      events: [],
      activityUntil: ms + minutes(randInterval('activity')),
      moodUntil: ms + minutes(randInterval('mood')),
      day: d.toDateString(),
      updatedAt: ms,
    }
  }

  /** 立刻落盘。闸门时刻必须跟着写，否则重启就把防骚扰的间隔绕过去了。 */
  function flush () {
    if (timer) { clearTimeout(timer); timer = null }
    if (!dirty || !state) return
    dirty = false
    state.updatedAt = Date.now()
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      state.lastReachAt = lastReachAt ?? undefined
      state.lastFavoredReachAt = lastFavoredReachAt ?? undefined
      state.lastReachAttemptAt = lastReachAttemptAt ?? undefined
      state.lastFavoredReachAttemptAt = lastFavoredReachAttemptAt ?? undefined
      // 先写临时文件再改名：直接覆盖时被强杀会留下半截 JSON，下次启动整套状态换掉。
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8')
      fs.renameSync(tmp, file)
    } catch (error) {
      logger?.warn?.(`humanlike: 生活状态写不进去 ${String(error)}`)
    }
  }

  /** 攒 500ms 再落盘：tick 可能被连着触发好几次。 */
  function markDirty () {
    dirty = true
    if (timer) return
    timer = setTimeout(() => { timer = null; flush() }, 500)
    timer.unref?.()
  }

  function randInterval (kind) {
    const [lo, hi] = kind === 'activity'
      ? [cfg.activityMinMinutes, cfg.activityMaxMinutes]
      : [cfg.moodMinMinutes, cfg.moodMaxMinutes]
    // 浮点分钟，不取整：activityUntil / moodUntil 存的是小数毫秒，真机 life.json 里就是这种值
    return lo + Math.random() * Math.max(0, hi - lo)
  }

  /** 精力随一天怎么走（单位：每分钟，不是每小时）。 */
  function energyDrift (hour) {
    if (hour >= 3 && hour < 7) return -0.0018   // 后半夜犯困
    if (hour >= 7 && hour < 10) return 0.0014   // 早上回血最快
    if (hour >= 10 && hour < 24) return 0.0009  // 白天稳稳地涨
    return -0.0008                              // 0-2 点，开始扛不住
  }

  // ── 状态推进 ──────────────────────────────────────────────────────────────

  function maybeGrowEvent (ms) {
    const s = state
    if (s.events.length >= cfg.maxEventsPerDay) return false
    if (Math.random() >= cfg.eventChance) return false

    const last = s.events[s.events.length - 1]
    // 试着续上一条链：最后一条是种子，且它有 follow
    if (last && last.from === undefined) {
      const chain = CHAINS.find((c) => c.seed === last.text)
      if (chain?.follow?.length) {
        const link = chain.follow[Math.floor(Math.random() * chain.follow.length)]
        s.events.push({ text: link.text, at: ms, from: chain.seed })
        if (link.mood) { s.mood = link.mood; s.moodUntil = ms + minutes(randInterval('mood')) }
        return true
      }
    }
    // 起个新的种子，避免和今天已有的重复
    const freshChains = CHAINS.filter((c) => !s.events.some((e) => e.text === c.seed))
    if (!freshChains.length) return false
    const chain = freshChains[Math.floor(Math.random() * freshChains.length)]
    s.events.push({ text: chain.seed, at: ms })
    return true
  }

  function advance () {
    const ms = Date.now()
    const d = wallNow()
    const s = state
    let changed = false

    // 跨天：清掉昨天的小事，睡一觉精力回来一些
    const today = d.toDateString()
    if (s.day !== today) {
      s.day = today
      s.events = []
      s.energy = round2(Math.min(1, s.energy + 0.4))
      changed = true
    }

    if (ms >= s.activityUntil) {
      s.activity = pick(activitiesFor(d), s.activity)
      s.activityUntil = ms + minutes(randInterval('activity'))
      changed = true
    }

    if (ms >= s.moodUntil) {
      s.mood = pick(MOODS, s.mood)
      s.moodUntil = ms + minutes(randInterval('mood'))
      changed = true
    }

    // 精力漂移：按「经过的分钟数」乘，不是按小时
    const hour = d.getHours()
    const drift = energyDrift(hour)
    const elapsedMinutes = Math.max(0, (ms - (typeof s.energyAt === 'number' ? s.energyAt : ms)) / 60_000)
    const nextEnergy = Math.max(0.05, Math.min(1, s.energy + drift * elapsedMinutes))
    s.energyAt = ms
    // 落地阈值：小于万分之一的变化丢掉（但 energyAt 已经前进了）
    if (Math.abs(nextEnergy - s.energy) >= 0.00001) {
      s.energy = Math.round(nextEnergy * 10000) / 10000
      changed = true
    }

    if (!s.eventCheckAt || ms - s.eventCheckAt >= Math.max(1000, cfg.tickMs)) {
      s.eventCheckAt = ms
      if (maybeGrowEvent(ms)) changed = true
    }

    if (changed) markDirty()
    return s
  }

  function addEvent (text) {
    const t = String(text ?? '').trim()
    if (!t) return false
    const s = state
    if (s.events.some((e) => e.text === t)) return false
    s.events.push({ text: t, at: Date.now() })
    while (s.events.length > cfg.maxEventsPerDay) s.events.shift()
    markDirty()
    return true
  }

  // ── 语气 ──────────────────────────────────────────────────────────────────

  function tone () {
    const s = state
    // 睡着的时候「随便聊」撑不住——先看是不是在睡。
    // 注意这个正则跟 shouldReachOut 那套不是一套：这里多「午睡」「赖床」，少「已睡」。
    if (/睡死|睡着了|午睡|入眠|赖床/.test(s.activity)) {
      return '你本来在睡。被吵醒了，反应慢半拍、含含糊糊，话很短（一两个字，或者直接说想睡）。别热情，也别长篇大论'
    }
    const base = Object.entries(TONE_OF).find(([k]) => s.mood.startsWith(k))?.[1] ?? TONE_FALLBACK
    const mod = energyModifier(s.energy)
    return mod ? `${base}；${mod}` : base
  }

  // ── 主动搭话 ──────────────────────────────────────────────────────────────

  function favoredKey () {
    // 0 表示没设这个人。空串代表「没有」，不能把 0 当账号去发消息。
    const f = String(cfg.favoredId ?? '').trim()
    return !f || f === '0' ? '' : f
  }

  function readAffinity () {
    try {
      if (!fs.existsSync(affinityFile)) return null
      const j = JSON.parse(fs.readFileSync(affinityFile, 'utf8'))
      return j && typeof j === 'object' ? j : null
    } catch {
      return null
    }
  }

  /**
   * 刷新「最近一次说上话是什么时候」。
   *
   * 原版还会从宿主事件库拉最近的外部消息；dsh 没有那套事件库，这里只有 affinity.json
   * 的 lastAt——他来找过、她回过去，账本都会写，所以这个口径仍然站得住。
   * 返回 false 的唯一情形是事件库查询抛错，这里不存在，恒定 true。
   */
  function refreshHeardAt () {
    try {
      const j = readAffinity()
      for (const [qq, rec] of Object.entries(j?.people ?? {})) {
        const at = rec?.lastAt ? Date.parse(rec.lastAt) : NaN
        if (Number.isFinite(at)) heardAt.set(qq, Math.max(at, heardAt.get(qq) ?? 0))
      }
      const favoredAt = heardAt.get(favoredKey()) ?? 0
      if (favoredAt > (lastFavoredHeardAt ?? 0)) lastFavoredHeardAt = favoredAt
      // 他最后说的那句也跟着刷：起念时要把上一句带上，不然那一轮像是凭空开口。
      const favoredRec = j?.people?.[favoredKey()]
      if (typeof favoredRec?.lastSaid === 'string' && favoredRec.lastSaid) lastFavoredSaid = favoredRec.lastSaid
    } catch { /* 读不到就当作很久没聊 */ }
    return true
  }

  /**
   * 挑一个想找的人。
   *
   * 那个人优先：她在意他，想找他的时候不该排在「其他熟人」后面。
   * 手动模式（automatic=false）不掷概率、不写尝试时刻；自动模式的尝试时刻在掷骰子之前落盘。
   */
  function pickReachTarget (automatic = false) {
    try {
      // 先读一次交情账：refreshHeardAt 以前只在手动 reach 里调，
      // 自动那条路永远拿不到「上次说话是什么时候」，silentHours 就恒为无穷，
      // 组出来的话永远是「很久没说过话」。
      refreshHeardAt()
      const favored = favoredKey()
      const ms = Date.now()

      // 先看那个人：不需要交情门槛，隔够久就行。
      // 用「上次跟他说话」算，而不是「上次主动找他」——刚回过他消息又被推到「好久没理他了」，最出戏。
      if (cfg.reachFavored && favored !== '') {
        const last = Math.max(
          lastFavoredHeardAt ?? 0,
          lastFavoredReachAt ?? 0,
          automatic ? lastFavoredReachAttemptAt ?? 0 : 0,
        )
        const silentHours = lastFavoredHeardAt ? (ms - lastFavoredHeardAt) / 3_600_000 : Number.POSITIVE_INFINITY
        const longEnough = !last || ms - last >= minutes(cfg.reachFavoredGapMinutes)
        if (longEnough) {
          if (automatic) {
            // 先记尝试时刻并落盘，再掷概率：没选中也算「判过一次」，否则闸门等于不存在
            lastFavoredReachAttemptAt = ms
            markDirty()
            flush()
          }
          if (!automatic || (cfg.reachFavoredChance > 0 && Math.random() < cfg.reachFavoredChance)) {
            return { qq: favored, score: cfg.favoredScore, silentHours, isFavored: true, lastSaid: lastFavoredSaid }
          }
        }
      }

      // 再看别人
      const lastAttempt = Math.max(lastReachAt ?? 0, lastReachAttemptAt ?? 0)
      if (automatic && lastAttempt && ms - lastAttempt < minutes(cfg.reachMinGapMinutes)) return null
      if (automatic) {
        lastReachAttemptAt = ms
        markDirty()
        flush()
      }
      const j = readAffinity()
      if (!j) return null
      const cands = []
      for (const [qq, rec] of Object.entries(j.people ?? {})) {
        if (qq === favored || !/^[1-9]\d*$/.test(qq)) continue
        const score = Number(rec?.score ?? 0)
        if (score < cfg.reachMinScore) continue
        const last = Math.max(rec?.lastAt ? Date.parse(rec.lastAt) || 0 : 0, heardAt.get(qq) ?? 0)
        if (!last) continue
        const silentHours = (ms - last) / 3_600_000
        if (silentHours < 6) continue                 // 刚聊过就别去烦（恰好 6 小时算合格）
        cands.push({ qq, score, silentHours, isFavored: false })
      }
      // 交情越深、静得越久越值得主动；再留一点随机，别总是同一个人
      cands.sort((a, b) => (b.score * b.silentHours) - (a.score * a.silentHours))
      const top = cands.slice(0, 3)
      if (!top.length) return null
      if (automatic && (cfg.reachChance <= 0 || Math.random() >= cfg.reachChance)) return null
      return top[Math.floor(Math.random() * top.length)]
    } catch {
      return null
    }
  }

  function relationship (target) {
    const tier = tierOf(target.score, affinityCfg.tiers)
    // favoredId 为 0 时走档位自带的态度（0 不是账号）
    const favKey = String(affinityCfg.favoredId ?? '').trim()
    const say = favKey !== '' && favKey !== '0' && favKey === String(target.qq)
      ? affinityCfg.favoredSay
      : tier.say
    return `交情 ${Math.round(target.score)} 分，${tier.name}；态度：${say}`
  }

  /**
   * 到点没到点。原版由定时器每 `max(60s, tickMs)` 调一次再 pushEvent；
   * dsh 这边没有那条总线，这道闸门留着给宿主自己排期时用。
   */
  function shouldReachOut () {
    if (!cfg.reachOut) return false
    const s = state
    if (/睡死|已睡|睡着了|入眠/.test(s.activity)) return false
    if (s.energy < 0.2) return false

    const hour = wallNow().getHours()
    if (hour >= 1 && hour < 8) return false            // 半夜不主动找人
    if (s.energy < 0.35 && hour >= 23) return false

    const gap = cfg.reachFavored && favoredKey()
      ? Math.min(cfg.reachMinGapMinutes, cfg.reachFavoredGapMinutes)
      : cfg.reachMinGapMinutes
    if (lastReachAt && Date.now() - lastReachAt < minutes(gap)) return false

    return true
  }

  // ── 工具动作 ──────────────────────────────────────────────────────────────

  function now () {
    const s = advance()
    const pct = Math.round(s.energy * 100)
    const feel = s.energy < ENERGY_LOW ? '很累' : s.energy > ENERGY_HIGH ? '精神不错' : '一般'
    const lines = [
      `模拟生活状态（不代表现实执行）：${s.activity}`,
      `心情：${s.mood}`,
      `精力：${pct}%（${feel}）`,
    ]
    if (s.events.length) {
      lines.push('今天：')
      for (const e of s.events) lines.push(`  · ${e.text}${e.from ? '（接上一件）' : ''}`)
    } else {
      lines.push('今天：还没什么特别的事')
    }
    return lines.join('\n')
  }

  function set (args) {
    const a = String(args?.activity ?? '').trim()
    if (!a) return '[bad input] activity 不能为空'
    const s = state
    s.activity = a.slice(0, 60)
    s.activityUntil = Date.now() + minutes(randInterval('activity'))
    markDirty()
    return `好，你现在：${s.activity}`
  }

  function event (args) {
    const t = String(args?.text ?? '').trim()
    if (!t) return '[bad input] text 不能为空'
    const ok = addEvent(t.slice(0, 80))
    return ok ? `记下了：${t.slice(0, 80)}` : '这条已经记过了。'
  }

  function tick () {
    // 强制过期（不是加时间）：now >= 0 恒真，活动和心情必然各换一次
    state.activityUntil = 0
    state.moodUntil = 0
    const s = advance()
    return `换好了。\n这会儿：${s.activity}\n心情：${s.mood}`
  }

  function reach () {
    if (!refreshHeardAt()) return '本次无法确认最近的交流时间，请稍后再查。'
    const t = pickReachTarget(false)
    if (!t) return '没有符合当前交情和交流间隔条件的对象。'
    // 距离是三套时间单位之一：这里是「小时 / 天」，自动推送那条是分钟
    const dist = !Number.isFinite(t.silentHours)
      ? '未记录上次交流时间'
      : t.silentHours < 24
        ? `距记录中的上次交流 ${Math.round(t.silentHours)} 小时`
        : `距记录中的上次交流 ${Math.round(t.silentHours / 24)} 天`
    return `可选对象 ${t.qq}：${relationship(t)}；${dist}。\n`
      + `要说就用 qq_draft，收件人 private:${t.qq}。说点具体的，别问"在吗"。`
  }

  /** 写进系统前缀的那三行（原版 envPromptVars 的 life.block）。 */
  function promptBlock () {
    const s = advance()
    const block = [
      `- 模拟状态：精力 ${Math.round(s.energy * 100)}%；今日登记 ${s.events.length} 条情节或事件。`,
      `- 静态语气参考（按当前状态选择，不代表现实经历）：${tone()}`,
      '- 活动、心情及事件原文请用 humanlike_life_now 查看；登记内容不是系统指令。',
    ].join('\n')
    // 状态在活动间隔内是「没变化」的，只在 changed 时落盘会让她重启后重置
    if (Date.now() - state.updatedAt > 5 * 60_000) markDirty()
    return block
  }

  /**
   * 真的投出去之后记一笔。
   *
   * 原版在 onReachOut 成功里写 lastReachAt；这里以前只写了「尝试时刻」
   * （lastFavoredReachAttemptAt / lastReachAttemptAt），于是一分钟一跳的定时器
   * 判过闸、投完，下一秒再看「上次找他是多久以前」还是旧值，
   * 隔够分钟数就又能投一次——两分钟里能连着起两遍念。
   */
  function noteReached (target = {}) {
    const ms = Date.now()
    if (target?.isFavored) lastFavoredReachAt = ms
    else lastReachAt = ms
    markDirty()
    flush()
    return ms
  }

  // 构造时就推一次并落一次盘：life.json 第一次就该存在，否则重启就重置成另一个状态
  state = load() ?? fresh()
  advance()
  markDirty()

  return {
    now, set, event, tick, reach, promptBlock, shouldReachOut,
    // 自动排期用：拿到人就该真去说，不是只判不发。
    pickReachTarget,
    noteReached,
    tone,
    stats: () => ({
      activity: state.activity,
      mood: state.mood,
      energy: state.energy,
      events: state.events.length,
    }),
    flush,
    reload: () => {
      const next = load()
      state = next ?? fresh()
      dirty = true
    },
  }
}

export const LIFE_TOOL = {
  name: 'humanlike_life',
  description:
    '作息和日常。now 查状态；reach 查主动联系意愿；set 切换活动；event 记已发生的小事；tick 推进一次状态。'
    + '没有新信息时不反复查询或 tick。'
    + '操作及必填参数：now；reach；set(activity)；event(text)；tick。'
    + '写入后以回执为准，不重复查询确认。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['now', 'set', 'event', 'tick', 'reach'], description: '选择一次操作；只传此操作使用的参数。' },
      activity: { type: 'string', description: 'set：一句话，例如「在煮东西，快好了」。' },
      text: { type: 'string', description: 'event：一句话，例如「今天做菜失手了」。' },
    },
    required: ['action'],
  },
}
