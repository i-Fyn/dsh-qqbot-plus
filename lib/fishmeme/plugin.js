/**
 * 表情包（从独立插件 dsh-fishmeme 并进来的一半）。
 *
 * 只做一件事：把「本地图库里的哪张图适合现在」挑出来，给你一个绝对路径。
 * 真正发出去交给渠道 —— QQ 里就是 qq_draft 的 image 参数。
 * 并进来的理由：表情包本来只为 QQ 这一个渠道服务，没必要单独占一个 bundle。
 *
 * 数据从旧插件目录迁过来：
 *   索引 ~/.dsh/dsh-qqbot-plus/memes/index.json（首次运行从 ~/.dsh/dsh-fishmeme/index.json 拷一份）
 *   发图暂存 ~/.dsh/dsh-qqbot-plus/memes/out（要在 sendFile.extraRoots 里）
 * 图库目录默认 ~/.dsh/meme-packs 和 ~/Desktop/表情包；文件本身不动。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { PLUGIN_HOME } from '../shared/dirs.js'
import { writeJsonAtomic } from '../shared/json-file.js'
import { ORDER } from '../shared/orders.js'
import { registerMemeRoutes } from './routes.js'

const HOME = os.homedir()
const DATA_DIR = path.join(PLUGIN_HOME, 'memes')
const INDEX_FILE = path.join(DATA_DIR, 'index.json')
/** 发图前把图复制到这里再给渠道：QQ 的路径白名单只放 media / 工作目录 / extraRoots。 */
const OUT_DIR = path.join(DATA_DIR, 'out')
/** 旧独立插件的数据目录：首次运行迁过来，之后不再读。 */
const LEGACY_DIR = path.join(HOME, '.dsh', 'dsh-fishmeme')
/** 发图前的长边上限（老 QQ 插件是 stickerMaxPx=240，这里保持一致）。0 = 不缩。 */
const MAX_PX = Math.max(0, Number(process.env.DSH_FISHMEME_MAX_PX ?? 300) || 0)
const MEDIA_EXT = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.avif'])
const TAGS = ['happy', 'angry', 'sad', 'shy', 'confused', 'daily']

const DEFAULT_DIRS = [path.join(HOME, '.dsh', 'meme-packs'), path.join(HOME, 'Desktop', '表情包')]

const RULES = [
  '### 表情包（dsh-fishmeme）',
  '- 想发表情包先调 meme_search（可给 tag 或 query），拿到 path；QQ 里把 path 交给 qq_draft 的 image，正文照常写。',
  '- 情绪桶：happy / angry / sad / shy / confused / daily。挑不到就别硬发，别自己编文件名。',
  '- 用户发来新图或说「入库 / 学这张」：用 meme_scan 看有哪些没登记的，看图后用 meme_learn 写描述和标签。',
].join('\n')

function expandHome (p) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  if (s === '~') return HOME
  if (s.startsWith('~/')) return path.join(HOME, s.slice(2))
  return s
}

/**
 * 首次运行：把旧插件的索引搬过来。
 *
 * 只搬一次，判据是「新位置没有索引、旧位置有」。搬完旧文件留着不动，
 * 但之后再也不会读它——两个插件同时挂着时也不会两边各写一份。
 */
function migrateLegacy () {
  try {
    if (fs.existsSync(INDEX_FILE)) return
    const legacy = path.join(LEGACY_DIR, 'index.json')
    if (!fs.existsSync(legacy)) return
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.copyFileSync(legacy, INDEX_FILE)
  } catch {
    // 迁不过去就当没有索引，用默认目录重开一份
  }
}

function readIndex () {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'))
    const dirs = Array.isArray(raw.dirs) && raw.dirs.length
      ? raw.dirs.map(expandHome).filter(Boolean)
      : DEFAULT_DIRS.slice()
    const items = raw.items && typeof raw.items === 'object' ? raw.items : {}
    return { dirs, items }
  } catch {
    return { dirs: DEFAULT_DIRS.slice(), items: {} }
  }
}

function writeIndex (index) {
  // 原子写：meme_learn / update / prune / dirs 都是读改写，
  // 半截 JSON 会让整个索引读不出来（32 张表情一起消失）。
  return writeJsonAtomic(INDEX_FILE, index)
}

/** 递归扫图库目录（最多三层），返回绝对路径列表。 */
async function scan (dirs) {
  const out = []
  const walk = async (dir, depth) => {
    if (depth > 3) return
    let ents = []
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of ents) {
      if (ent.name.startsWith('.')) continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(full, depth + 1)
      } else if (MEDIA_EXT.has(path.extname(ent.name).toLowerCase())) {
        out.push(full)
      }
    }
  }
  for (const dir of dirs) await walk(dir, 0)
  return out
}

/** 文件名去掉序号和扩展名，当兜底描述。 */
function stem (file) {
  return path.basename(file, path.extname(file)).replace(/^[\d\s_-]+/, '') || path.basename(file)
}

function normTags (tags) {
  if (!tags) return []
  const list = Array.isArray(tags) ? tags : String(tags).split(/[\s,，/]+/)
  return [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter(Boolean))]
}

function score (entry, tokens) {
  const caption = String(entry.caption ?? '').toLowerCase()
  const tags = normTags(entry.tags)
  const base = path.basename(entry.path, path.extname(entry.path)).toLowerCase()
  let s = 0
  for (const t of tokens) {
    if (tags.includes(t)) s += 4
    if (caption.includes(t)) s += 3
    else if (base.includes(t)) s += 2
  }
  return s
}

function fmtLine (entry, i) {
  const cap = entry.caption ? entry.caption : stem(entry.path)
  const tags = normTags(entry.tags)
  const send = entry.send ? `\n   send=${entry.send}` : ''
  return `${i + 1}. [表情: ${cap}]${tags.length ? ` #${tags.join(' #')}` : ''}\n   path=${entry.path}${send}`
}

/** sharp 惰性加载：装了就跨平台用，没装（或原生包坏了）就当它不存在。 */
let sharpModule
async function loadSharp () {
  if (sharpModule !== undefined) return sharpModule
  try {
    sharpModule = (await import('sharp')).default
  } catch {
    sharpModule = null
  }
  return sharpModule
}

/**
 * 把图缩到长边 MAX_PX 写成 png。
 * 只走 sharp —— 它是可选依赖，npm 装插件时会在目标机器上装好对应平台的那份。
 * 拿不到 sharp 就不缩，原图照发，不报错。
 * 返回 true = 缩成功；false = 这张不用缩、或者这台机器缩不了。
 */
async function shrinkTo (file, target) {
  const sharp = await loadSharp()
  if (!sharp) return false
  try {
    const meta = await sharp(file, { animated: false }).metadata()
    const w = Number(meta.width ?? 0)
    const h = Number(meta.height ?? 0)
    if (!(w > MAX_PX || h > MAX_PX)) return false
    await sharp(file)
      .rotate()
      .resize({ width: MAX_PX, height: MAX_PX, fit: 'inside', withoutEnlargement: true })
      .png()
      .toFile(target)
    return true
  } catch {
    return false
  }
}

/**
 * 把图搬进 out 目录，并在那里把长边缩到 MAX_PX（QQ 里不缩就会顶一屏）。
 * 动图、本来就够小的、或这台机器一个缩图工具都没有的：原样复制。
 */
async function stageForSend (file) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const dirKey = crypto.createHash('md5').update(path.dirname(file)).digest('hex').slice(0, 6)
    const ext = path.extname(file).toLowerCase()
    const base = path.basename(file, path.extname(file))

    if (MAX_PX > 0 && ext !== '.gif') {
      const target = path.join(OUT_DIR, `${base}-${dirKey}.png`)
      const fresh = fs.existsSync(target) && fs.statSync(target).mtimeMs >= fs.statSync(file).mtimeMs
      if (fresh) return target
      if (await shrinkTo(file, target)) {
        if (fs.existsSync(target)) return target
      }
    }

    const target = path.join(OUT_DIR, `${base}-${dirKey}${ext}`)
    if (!fs.existsSync(target) || fs.statSync(target).size !== fs.statSync(file).size) {
      fs.copyFileSync(file, target)
    }
    return target
  } catch {
    return ''
  }
}

async function entries (index) {
  const files = await scan(index.dirs)
  return files.map((file) => {
    const meta = index.items[file] ?? {}
    return { path: file, caption: meta.caption ?? '', tags: meta.tags ?? [] }
  })
}

function pickTagged (list, tag) {
  const t = String(tag ?? '').trim().toLowerCase()
  if (!t || t === 'all' || t === 'any') return list
  return list.filter((e) => normTags(e.tags).includes(t))
}

/** 工具表：放在外面，注册时统一包一层 try/catch 和文本渲染。 */
function buildTools () {
  const tools = []

  tools.push({
    name: 'meme_search',
    description: '表情包：按情绪标签或关键词挑图，返回带绝对 path 的候选。QQ 里把 path 交给 qq_draft 的 image。',
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: `情绪标签：${TAGS.join(' / ')}；不填就是全部` },
        query: { type: 'string', description: '关键词，匹配描述、标签、文件名，空格分隔多个' },
        limit: { type: 'number', description: '返回几条，默认 6' },
      },
    },
    async execute ({ tag = '', query = '', limit = 6 } = {}) {
      const index = readIndex()
      let list = await entries(index)
      if (!list.length) return `图库是空的。目录：${index.dirs.join('、')}`
      list = pickTagged(list, tag)
      const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean)
      if (tokens.length) {
        list = list
          .map((e) => ({ e, s: score(e, tokens) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .map((x) => x.e)
      } else {
        list = list.map((e) => ({ e, r: Math.random() })).sort((a, b) => a.r - b.r).map((x) => x.e)
      }
      if (!list.length) return `没挑到合适的（tag=${tag || '全部'} query=${query || '无'}）。可以先 meme_scan 看看库里有什么。`
      const n = Math.max(1, Math.min(20, Number(limit) || 6))
      const picked = list.slice(0, n)
      const staged = await Promise.all(picked.map((e) => stageForSend(e.path)))
      return picked.map((e, i) => fmtLine({ ...e, send: staged[i] }, i)).join('\n')
    },
  })

  tools.push({
    name: 'meme_scan',
    description: '表情包：扫图库，列出还没登记描述的图和已失效的记录（只读，不入库）。',
    parameters: { type: 'object', properties: {} },
    async execute () {
      const index = readIndex()
      const files = await scan(index.dirs)
      const missing = Object.keys(index.items).filter((p) => fs.existsSync(p) === false)
      const fresh = files.filter((f) => !index.items[f] || !index.items[f].caption)
      const lines = [`目录：${index.dirs.join('、')}`, `文件 ${files.length} 张，已登记 ${files.length - fresh.length} 张`]
      if (fresh.length) lines.push('', '还没描述：', ...fresh.map((f, i) => `${i + 1}. ${f}`))
      if (missing.length) lines.push('', `失效记录 ${missing.length} 条（文件没了，meme_prune 可清）`, ...missing.slice(0, 10).map((m) => `- ${m}`))
      if (!fresh.length && !missing.length) lines.push('', '全部登记好了。')
      return lines.join('\n')
    },
  })

  tools.push({
    name: 'meme_learn',
    description: '表情包：登记一张图的描述与情绪标签（只写索引，不动文件）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '图片绝对路径或文件名' },
        caption: { type: 'string', description: '这张图是什么、什么语气，一句话' },
        tags: { type: 'string', description: `情绪标签，逗号分隔：${TAGS.join(' / ')}；也可自定` },
      },
      required: ['path'],
    },
    async execute ({ path: p = '', caption = '', tags = '' } = {}) {
      const index = readIndex()
      const files = await scan(index.dirs)
      const want = expandHome(p)
      let target = files.find((f) => f === want)
      if (!target) target = files.find((f) => path.basename(f) === path.basename(want))
      if (!target) return `图库里没找到：${p}`
      const prev = index.items[target] ?? {}
      index.items[target] = {
        caption: String(caption || prev.caption || stem(target)).trim(),
        tags: normTags(tags).length ? normTags(tags) : normTags(prev.tags),
        addedAt: prev.addedAt ?? Date.now(),
      }
      writeIndex(index)
      return `登记好了：${path.basename(target)}\n[表情: ${index.items[target].caption}] #${index.items[target].tags.join(' #')}`
    },
  })

  tools.push({
    name: 'meme_update',
    description: '表情包：改一张图已登记的描述或标签（只改索引，不动文件）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '图片绝对路径或文件名' },
        caption: { type: 'string' },
        tags: { type: 'string', description: '给新的标签列表（覆盖）；给空串则清空标签' },
      },
      required: ['path'],
    },
    async execute ({ path: p = '', caption, tags } = {}) {
      const index = readIndex()
      const want = expandHome(p)
      const key = Object.keys(index.items).find((k) => k === want || path.basename(k) === path.basename(want))
      if (!key) return `索引里没有这张：${p}（先用 meme_learn 登记）`
      if (caption !== undefined) index.items[key].caption = String(caption).trim()
      if (tags !== undefined) index.items[key].tags = normTags(tags)
      writeIndex(index)
      const it = index.items[key]
      return `改了：${path.basename(key)}\n[表情: ${it.caption}] #${normTags(it.tags).join(' #')}`
    },
  })

  tools.push({
    name: 'meme_list',
    description: '表情包：列图库清单（可按情绪标签或关键词过滤）。',
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number', description: '默认 30' },
      },
    },
    async execute ({ tag = '', query = '', limit = 30 } = {}) {
      const index = readIndex()
      let list = await entries(index)
      list = pickTagged(list, tag)
      const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean)
      if (tokens.length) list = list.filter((e) => score(e, tokens) > 0)
      if (!list.length) return '没有符合条件的图。'
      const counts = {}
      for (const e of list) for (const t of normTags(e.tags)) counts[t] = (counts[t] ?? 0) + 1
      const head = `共 ${list.length} 张` + (Object.keys(counts).length ? `（${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}）` : '')
      const n = Math.max(1, Math.min(200, Number(limit) || 30))
      return [head, ...list.slice(0, n).map(fmtLine)].join('\n')
    },
  })

  tools.push({
    name: 'meme_prune',
    description: '表情包：清掉索引里文件已不存在的记录。',
    parameters: { type: 'object', properties: {} },
    async execute () {
      const index = readIndex()
      const gone = Object.keys(index.items).filter((p) => !fs.existsSync(p))
      for (const g of gone) delete index.items[g]
      if (gone.length) writeIndex(index)
      return gone.length ? `清掉 ${gone.length} 条失效记录` : '没有失效记录'
    },
  })

  tools.push({
    name: 'meme_dirs',
    description: '表情包：看图库目录，或改成新的一组目录（绝对路径，逗号分隔）。',
    parameters: {
      type: 'object',
      properties: { dirs: { type: 'string', description: '新的目录列表，逗号分隔；不填只读' } },
    },
    async execute ({ dirs } = {}) {
      const index = readIndex()
      if (dirs) {
        const next = String(dirs).split(/[,，]/).map(expandHome).filter(Boolean)
        if (!next.length) return '没给有效目录'
        index.dirs = next
        writeIndex(index)
        return `图库目录改成：${next.join('、')}`
      }
      const files = await scan(index.dirs)
      return `目录：${index.dirs.join('、')}\n其中图片 ${files.length} 张，索引 ${Object.keys(index.items).length} 条\n索引文件：${INDEX_FILE}`
    },
  })

  return tools
}

export function mountFishMeme (ctx, config = {}) {
  const logger = ctx.logger ?? console
  migrateLegacy()

  // 规则段：沿用原来的 order 74（dsh-map 占 71，别撞）
  try {
    ctx.inject(['systemPrompt'], (inner) => {
      inner.effect(() => inner.systemPrompt.context({
        name: 'fishmeme/rules',
        order: ORDER.memeRules,
        interpolate: false,
        text: () => RULES,
      }))
    })
  } catch (error) {
    logger.warn?.(`fishmeme: 规则段注册失败 ${error instanceof Error ? error.message : String(error)}`)
  }

  let registry
  try {
    registry = ctx.get?.('tools') ?? ctx.tools
  } catch {
    registry = ctx.tools
  }
  if (!registry || typeof registry.register !== 'function') {
    logger.warn?.('fishmeme: 没有 tools 服务，跳过注册')
    return
  }

  const tools = buildTools()
  const asText = (value) => [{ type: 'text', text: String(value) }]
  for (const tool of tools) {
    const run = tool.execute
    registry.register({
      ...tool,
      output: tool.output ?? { schema: { type: 'string' }, render: (_args, value) => asText(value) },
      async execute (args, extra) {
        try {
          return await run(args, extra)
        } catch (error) {
          return `出错了：${error instanceof Error ? error.message : String(error)}`
        }
      },
    })
  }

  // 设置面板的接口：面板跑在浏览器里，读不到磁盘，图库的读/改/删都得走 HTTP。
  // 与工具用同一份 memeStore，面板改过的东西工具立刻能看到。
  try {
    ctx.inject(['webServer'], (scoped) => {
      const webServer = scoped.webServer
      if (!webServer || typeof webServer.register !== 'function') return
      const dispose = registerMemeRoutes(webServer, memeStore, logger)
      scoped.effect(() => dispose, 'im-qqbot.meme-routes')
    })
  } catch (error) {
    logger.warn?.(`fishmeme: 面板接口注册失败 ${error instanceof Error ? error.message : String(error)}`)
  }

  // 目录可以在 config 里写死（不想每次 meme_dirs）；写了就落到索引里
  if (config?.dirs) {
    const next = (Array.isArray(config.dirs) ? config.dirs : [config.dirs]).map(expandHome).filter(Boolean)
    if (next.length) {
      const index = readIndex()
      index.dirs = next
      writeIndex(index)
    }
  }

  logger.info?.(`fishmeme: ${tools.length} 个工具已注册（图库索引 ${INDEX_FILE}）`)
}

//#region 设置面板用的数据接口（HTTP 路由共用，不改动工具行为）
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

/** 只认图库目录里的文件：路径穿越、随便传个系统文件都挡在外面。 */
function insideDirs (file, dirs) {
  const abs = path.resolve(file)
  for (const dir of dirs) {
    const rel = path.relative(path.resolve(dir), abs)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true
  }
  return false
}

/**
 * 面板读写入口。
 *
 * 与工具的行为对齐（meme_learn / meme_update / meme_prune / meme_dirs 的同一套逻辑），
 * 但返回结构化数据而不是给人看的文本——面板要的是一张张卡片，不是一行行字。
 */
export const memeStore = {
  async list () {
    const index = readIndex()
    const list = await entries(index)
    const items = list.map((e) => {
      let size = 0
      let mtime = 0
      try {
        const st = fs.statSync(e.path)
        size = st.size
        mtime = st.mtimeMs
      } catch {}
      const meta = index.items[e.path] ?? {}
      return {
        path: e.path,
        name: path.basename(e.path),
        caption: e.caption ?? '',
        tags: normTags(e.tags),
        addedAt: meta.addedAt ?? 0,
        size,
        mtime,
        registered: Boolean(meta.caption),
      }
    })
    items.sort((a, b) => (b.addedAt || b.mtime) - (a.addedAt || a.mtime))
    const missing = Object.keys(index.items).filter((p) => !fs.existsSync(p))
    return {
      dirs: index.dirs,
      tags: TAGS,
      items,
      missing,
      fresh: items.filter((it) => !it.registered).map((it) => it.path),
      indexFile: INDEX_FILE,
    }
  },

  /** 改描述 / 标签；也可以给一张没登记的图补齐（等于 learn）。 */
  update (file, patch = {}) {
    const want = expandHome(String(file ?? ''))
    if (!want) throw new Error('没给图片路径')
    const index = readIndex()
    const key = Object.keys(index.items).find((k) => k === want) ?? want
    if (!insideDirs(key, index.dirs)) throw new Error('这张图不在图库目录里')
    if (!fs.existsSync(key)) throw new Error('文件不在了')
    const prev = index.items[key] ?? {}
    index.items[key] = {
      caption: patch.caption !== undefined ? String(patch.caption).trim() : (prev.caption ?? ''),
      tags: patch.tags !== undefined ? normTags(patch.tags) : normTags(prev.tags),
      addedAt: prev.addedAt ?? Date.now(),
    }
    writeIndex(index)
    return { path: key, ...index.items[key], tags: normTags(index.items[key].tags) }
  },

  /** 只从索引里删掉，不动文件本身。 */
  remove (file) {
    const want = expandHome(String(file ?? ''))
    const index = readIndex()
    const key = Object.keys(index.items).find((k) => k === want || path.basename(k) === path.basename(want))
    if (!key) return { removed: false }
    delete index.items[key]
    writeIndex(index)
    return { removed: true, path: key }
  },

  async setDirs (dirs) {
    const list = (Array.isArray(dirs) ? dirs : String(dirs ?? '').split(/[,，]/))
      .map((d) => expandHome(String(d).trim()))
      .filter(Boolean)
    if (!list.length) throw new Error('没给有效目录')
    const index = readIndex()
    index.dirs = list
    writeIndex(index)
    return { dirs: list }
  },

  prune () {
    const index = readIndex()
    const gone = Object.keys(index.items).filter((p) => !fs.existsSync(p))
    for (const g of gone) delete index.items[g]
    if (gone.length) writeIndex(index)
    return { removed: gone.length }
  },

  /** 面板缩略图用：把文件读成 buffer，只放图库目录里的图。 */
  read (file) {
    const want = expandHome(String(file ?? ''))
    if (!want) return null
    const index = readIndex()
    if (!insideDirs(want, index.dirs)) return null
    const mime = MIME[path.extname(want).toLowerCase()]
    if (!mime) return null
    try {
      return { buffer: fs.readFileSync(want), mime }
    } catch {
      return null
    }
  },

  get tags () {
    return TAGS.slice()
  },
}
//#endregion

/** 给别的模块（比如设置面板）读目录用。 */
export const __probe = { DATA_DIR, OUT_DIR, INDEX_FILE, readIndex, scan, stageForSend, shrinkTo, loadSharp, MAX_PX }
