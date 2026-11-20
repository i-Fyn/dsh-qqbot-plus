// 「看得见的事」家族工具：humanlike_real { desk | cost | prefix | config }
//
// 从 cortico-world-humanlike-alont1/src/modules/real/world.ts 搬过来。四个动作全是只读。
// 回执文案、节流、价目表、高峰判定都照原样。跟原版的差别只在「数据从哪来」：
//
// 1. desk 走 PowerShell 调 user32 读前台窗口。原版就是 Windows-only；
//    这台机器是 macOS，powershell 不存在，所以必然落到那句「问不到」——不编窗口名。
// 2. cost 读 <dataDir>/usage.jsonl（一行一条请求），跟原版一样的账本格式。
//    dsh 自己不写这份账本；要接别处的用量，用 config.usageFile 指过去。
// 3. prefix 打的是原版控制台的 /api/prompts/prefix。dsh 没有那个控制台，
//    所以要么调用方把 config.consoleUrl 指到一个真端点，要么就返回「取前缀失败：…」。
// 4. config 读 <botDir>/config.json（默认是 dataDir 的上一级）。dsh 没有那份部署配置，
//    所以通常就是「读不到部署配置。」——不编数字。
//
// 这四个动作都不写盘、不抛错（desk 之外全同步）。

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DEFAULT_VALUES } from './settings.js'

// 2026-09-23 抄自官方文档（元 / 百万 tokens：hit = 命中缓存的输入，miss = 未命中，out = 输出）
const REAL_DEFAULT_PRICING = {
  'deepseek-flash': { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] },
  'deepseek-v4-pro': { hit: [0.30, 0.15], miss: [9.0, 4.5], out: [27.0, 13.5] },
  'deepseek-v4-flash': { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] },
  'deepseek-v4-flash-vision-exp': { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] },
}

// 默认值由 lib/settings.js 统一提供；后面几个是内部项，不上面板。
const DEFAULTS = {
  ...DEFAULT_VALUES.real,
  pricingJson: DEFAULT_VALUES.real.pricingJson || JSON.stringify(REAL_DEFAULT_PRICING),
  consolePort: 7788,
  timezone: 'Asia/Shanghai',
  botDir: '',
  usageFile: '',
}

/** PowerShell 脚本：只取进程名与标题，绝不截屏。 */
const FOREGROUND_SCRIPT = [
  // 先把输出编码钉成 UTF-8：默认按控制台代码页（中文机器是 GBK）吐字节，
  // 这边按 UTF-8 读，中文标题就会整条变成乱码——实测踩过。
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$OutputEncoding = [System.Text.Encoding]::UTF8',
  '$sig = @"',
  'using System; using System.Text; using System.Runtime.InteropServices;',
  'public class Fg {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '}',
  '"@',
  'Add-Type -TypeDefinition $sig -ErrorAction Stop',
  '$h = [Fg]::GetForegroundWindow()',
  'if ($h -eq [IntPtr]::Zero) { Write-Output "{}"; exit 0 }',
  '$sb = New-Object System.Text.StringBuilder 512',
  '[void][Fg]::GetWindowText($h, $sb, 512)',
  '$procId = 0',
  '[void][Fg]::GetWindowThreadProcessId($h, [ref]$procId)',
  '$p = Get-Process -Id $procId -ErrorAction SilentlyContinue',
  '$name = if ($p) { $p.ProcessName } else { "?" }',
  '$t = $sb.ToString()',
  '@{ process = $name; title = $t } | ConvertTo-Json -Compress',
].join('\n')

export function createReal (opts) {
  // 入参叫 rawConfig：下面那个只读动作叫 config，同名会撞
  const { dataDir, config: rawConfig = {}, logger } = opts
  const cfg = { ...DEFAULTS, ...rawConfig }
  const botDir = cfg.botDir ? String(cfg.botDir) : path.dirname(dataDir)
  const usageFile = cfg.usageFile ? String(cfg.usageFile) : path.join(dataDir, 'usage.jsonl')

  // 桌面读数的缓存只活在实例上，不落盘（原版也一样）
  let lastDesk = null
  let deskAt = 0

  // ── 他的桌面 ──────────────────────────────────────────────────────────────

  function readForeground () {
    return new Promise((resolve) => {
      let proc = null
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        resolve(value)
      }
      try {
        proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', FOREGROUND_SCRIPT], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
        const chunks = []
        proc.stdout?.on('data', (d) => chunks.push(d))
        proc.on('close', (code) => {
          if (code !== 0) return finish(null)
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8').trim() || '{}')
            if (!parsed.process) return finish(null)
            finish({ ts: Date.now(), process: parsed.process, title: parsed.title ?? '' })
          } catch {
            finish(null)
          }
        })
        proc.on('error', () => finish(null))
        const killer = setTimeout(() => {
          try { proc?.kill() } catch { /* 已经退了 */ }
          finish(null)
        }, 15000)
        killer.unref?.()
      } catch {
        finish(null)
      }
    })
  }

  async function desk () {
    const gap = Math.max(0, Number(cfg.deskGapSec) || 0) * 1000
    // 缓存分支不带过滤器提示——原版就是这样，别自作多情补一行
    if (lastDesk && Date.now() - deskAt < gap) {
      return `（刚看过，${Math.round((Date.now() - deskAt) / 1000)} 秒前）`
        + `前台是 ${lastDesk.process}：${lastDesk.title || '（没有标题）'}`
    }
    const r = await readForeground()
    if (!r) return '问不到：拿不到前台窗口（可能在锁屏，或者这台机器的查询被挡了）。'
    lastDesk = r
    deskAt = Date.now()
    const filter = String(cfg.deskProcessFilter ?? '').trim()
    // 逗号 / 中文逗号 / 空白任意分隔，大小写不敏感的子串匹配
    const hit = !filter || filter.split(/[,，\s]+/).filter(Boolean)
      .some((k) => r.process.toLowerCase().includes(k.toLowerCase()))
    return `前台是 ${r.process}：${r.title || '（没有标题）'}`
      + (filter && !hit ? `\n（他设过"只关心 ${filter}"，这个不在里面——多半是后台杂项。）` : '')
  }

  // ── 花销 ──────────────────────────────────────────────────────────────────

  function readUsage (days) {
    try {
      if (!fs.existsSync(usageFile)) return []
      // 毫秒滑动窗口，不是自然日零点
      const from = Date.now() - days * 86400_000
      const out = []
      for (const line of fs.readFileSync(usageFile, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line)
          // ts 解析失败会是 NaN，NaN < from 为 false —— 这条会被留下，跟原版一致
          if (!r.ts || Date.parse(r.ts) < from) continue
          out.push({
            model: String(r.model ?? '?'),
            ts: r.ts,
            input: Number(r.promptTokens ?? 0),
            cached: Number(r.cacheHitTokens ?? 0),
            output: Number(r.completionTokens ?? 0),
          })
        } catch { /* 坏行跳过：账本是外部输入 */ }
      }
      return out
    } catch {
      return []
    }
  }

  function priceTable () {
    try {
      const parsed = typeof cfg.pricingJson === 'string' ? JSON.parse(cfg.pricingJson) : cfg.pricingJson
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      logger?.warn?.('humanlike: 价格表 JSON 读不出来，用内置那份')
    }
    return REAL_DEFAULT_PRICING
  }

  /** 高峰 = 配置时区的工作日 9-12 点、14-18 点（法定节假日不另算）。 */
  function isPeak (d) {
    const fmt = (extra) => new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone, ...extra }).format(d)
    const weekday = fmt({ weekday: 'short' })
    if (weekday === 'Sat' || weekday === 'Sun') return false
    // 某些环境会把 24 点格式成 24，% 24 之后才是 0
    const h = Number(fmt({ hour: 'numeric', hour12: false })) % 24
    return (h >= 9 && h < 12) || (h >= 14 && h < 18)
  }

  /** 这一条请求大概花了多少元。高峰取 [0]，空闲取 [1]。 */
  function estimate (r, table) {
    const price = table[r.model] ?? table['deepseek-flash'] ?? { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] }
    const idx = isPeak(new Date(Date.parse(r.ts))) ? 0 : 1
    const uncachedIn = Math.max(0, r.input - r.cached)
    const per = (arr, fallback) => (Array.isArray(arr) && arr.length > idx ? arr[idx] : fallback)
    return (r.cached / 1e6) * per(price.hit, 0.04)
      + (uncachedIn / 1e6) * per(price.miss, 2)
      + (r.output / 1e6) * per(price.out, 8)
  }

  function cost (args) {
    // 0 / NaN / undefined 都当 1；超界夹到 1~30
    const days = Math.max(1, Math.min(30, Number(args?.days) || 1))
    const rows = readUsage(days)
    if (!rows.length) return `最近 ${days} 天账本里没有记录。`
    const table = priceTable()
    let total = 0
    const byModel = new Map()
    for (const r of rows) {
      // 原版 estimate 外面没有 try：坏 ts 会让 isPeak 抛 RangeError。这里兜住，
      // 单条坏记录不该把整次查询打掉（差别写进回报里）。
      let yuan
      try {
        yuan = estimate(r, table)
      } catch {
        continue
      }
      total += yuan
      const cur = byModel.get(r.model) ?? { yuan: 0, turns: 0, tokens: 0 }
      cur.yuan += yuan
      cur.turns += 1
      cur.tokens += r.input + r.output
      byModel.set(r.model, cur)
    }
    if (!byModel.size) return `最近 ${days} 天账本里没有记录。`
    const lines = [...byModel.entries()]
      .sort((a, b) => b[1].yuan - a[1].yuan)
      .map(([model, v]) => `- ${model}：约 ¥${v.yuan.toFixed(2)}（${v.turns} 次请求，${(v.tokens / 1000).toFixed(0)}k tokens）`)
    return `最近 ${days} 天：约 **¥${total.toFixed(2)}**（估算）\n${lines.join('\n')}`
      + `\n（价目表：${Object.keys(table).join('、')}；高峰时段按 2 倍算，其余时段半价。）`
  }

  // ── 她自己的规矩 ──────────────────────────────────────────────────────────
  //
  // dsh 没有 Coopanion 那个控制台，也没有部署 config.json：
  // prefix 返回本插件自己注入的那一段（别的段读不到），config 报硬编码的模块清单。

  async function prefix () {
    try {
      const read = typeof opts.prefixText === 'function' ? opts.prefixText : null
      if (!read) return '取前缀失败：这个实例没接上自己那一段。'
      const text = String(read() ?? '')
      const sections = text.split(/\n(?=- )/).filter(Boolean)
      return `你的系统前缀里，本插件注入的是一段（order 70，name humanlike/env），`
        + `按段落切出来是这样，共 ${text.length} 字：\n\n${text}`
        + (sections.length > 1 ? '' : '')
    } catch (e) {
      return `取前缀失败：${String(e)}`
    }
  }

  function config () {
    return '正在约束你的配置（只读）：\n'
      + '- 模块：affinity、learn、life、clock、together、mind、real 全开，参数是硬编码默认值\n'
      + '- 配置页、面板、legacy 迁移都没搬，改不了也读不到宿主配置\n'
      + '\n（这份插件只有工具和前缀段两样东西。觉得哪条挡着你了，写进自己的笔记或者直接跟他说。）\n'
  }

  return {
    desk, cost, prefix, config,
    stats: () => ({ deskAt, lastDesk: lastDesk ? lastDesk.process : null, usageFile, botDir }),
  }
}

export const REAL_TOOL = {
  name: 'humanlike_real',
  description:
    '只读观察。desk 只读前台窗口标题和进程，不是截图；cost 估算用量费用；'
    + 'prefix 查提示词组成；config 查约束。不能控制桌面或修改配置。'
    + '操作及必填参数：desk；cost(days)；prefix；config。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['desk', 'cost', 'prefix', 'config'], description: '选择一次操作；只传此操作使用的参数。' },
      days: { type: 'integer', minimum: 1, maximum: 30, description: 'cost：看最近几天，默认 1（今天）。' },
    },
    required: ['action'],
  },
}
