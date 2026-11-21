/**
 * dsh-fishmemory：大肥鱼的记忆插件（从 dsh-qqbot-plus 里搬出来的那一半）。
 *
 * 分层照 Anthropic「components of agent memory」那篇：
 *
 *   转录 journal/<日期>.jsonl   —— 每句话都记，原样可查（双方）
 *   笔记 notes/<id>.md         —— 值得长期留下的，一条一个 Markdown 文件
 *   索引 index.md              —— 笔记的目录，每行一条指针；每轮注入的就是它
 *   做梦 dream.json            —— 离线整理过的痕迹（什么时候、动了什么）
 *
 * 三条硬规矩：
 * 1. 注入层只有索引，且只由「做梦」改写。它一变就掀掉整条前缀缓存，
 *    所以它必须小（≤2400 字）且稳；细节一律留给 memory_search 现查。
 * 2. 笔记是纯 Markdown + 极简 frontmatter，人可读、diff 得出、改得动。
 * 3. 记忆是「人」的，不是某个屋子的：这里直接听 session 事件，
 *    不绑定 QQ、Web 或任何渠道。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import child from 'node:child_process'

import { PLUGIN_HOME } from '../shared/dirs.js'
import { ORDER } from '../shared/orders.js'


const HOME = os.homedir()
const DATA = path.join(PLUGIN_HOME, 'memory')
const NOTES = path.join(DATA, 'notes')
const JOURNAL = path.join(DATA, 'journal')
const INDEX = path.join(DATA, 'index.md')
const DREAM = path.join(DATA, 'dream.json')

const KINDS = new Set(['rule', 'fact', 'person', 'task', 'lesson', 'event'])
const INDEX_MAX_NOTES = 500  // 标题一行 128 条也只有 4K 多字，不再按条数卡
// 两本账分开算：行为类带摘要，事实/经过只列标题。混在一起算，事实一多就把
// 规矩/教训挤成空标题，或者反过来只剩规矩、六十条事实一条都看不见。
const INDEX_MAX_CHARS = 20000
const INDEX_TITLE_CHARS = 20000
const INDEX_EXCERPT_KINDS = new Set()  // 索引只放标题认路；正文靠每轮现捞的三条（recallSection）
// 每类各留一份额度：共用一本账时，「人」和「待办」排在教训后面，教训一长
// 这两类就整组消失——而待办恰恰是最该看见的。
const INDEX_KIND_CHARS = { rule: 1100, lesson: 900, person: 150, task: 250, event: 700 }
// 事实和经过共用一本 3000 字的大账：它们条数最多，单独开口子会把别的类挤没。
const INDEX_SHARED_CHARS = 2000
// 「经过」以前和「事实」共用一张 3000 字的账，事实先写满就把经过全挤掉——
// 索引里永远看不到经过。分开算，各自有额度。
const INDEX_SHARED_KINDS = new Set(['fact'])
// 分配算法一改，旧 index.md 就该当场重排；只比 mtime 的话，磁盘上那份
// 老格式会一直被读下去（上一轮就这么白等了一次重启）。
const INDEX_VERSION = 4

// ────────────────────────────── 分词与打分 ──────────────────────────────
const STOPWORDS = new Set([
  '的', '了', '着', '过', '是', '在', '有', '和', '与', '就', '都', '也', '还', '又', '再', '才',
  '只', '很', '太', '更', '最', '没', '不', '别', '被', '把', '给', '让', '对', '从', '到',
  '我', '你', '他', '她', '它', '这', '那', '个', '什么', '怎么', '为什么', '现在', '今天',
  '明天', '昨天', '刚刚', '刚才', '还是', '但是', '而且', '所以', '因为', '如果', '可以',
  '应该', '需要', '就是', '然后', '已经', '一下', '这个', '那个', '时候', '东西', '事情',
  'the', 'and', 'you', 'are', 'for', 'with', 'that', 'this', 'have', 'what', 'just',
  'can', 'not', 'but', 'from', 'they', 'will', 'your', 'about', 'was', 'were', 'has',
])

function tokenize(text) {
  const out = new Set()
  if (typeof text !== 'string') return out
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0])
  const cjk = lower.replace(/[^\u4e00-\u9fff]+/g, ' ')
  for (const run of cjk.split(/\s+/)) {
    if (run === '') continue
    if (run.length === 1) out.add(run)
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2))
  }
  for (const token of STOPWORDS) out.delete(token)
  return out
}

function scoreDocs(query, docs) {
  const q = String(query ?? '').trim()
  if (q === '' || docs.length === 0) return []
  const queryTokens = tokenize(q)
  const queryChars = [...new Set([...q].filter((ch) => ch >= '\u4e00' && ch <= '\u9fff'))]
  const df = new Map()
  const tokensById = docs.map((doc) => {
    const tokens = tokenize(doc.text)
    for (const token of tokens) df.set(token, (df.get(token) ?? 0) + 1)
    return tokens
  })
  const N = Math.max(docs.length, 16)
  const ceiling = Math.log(N + 2) || 1
  const out = []
  docs.forEach((doc, i) => {
    const tokens = tokensById[i]
    let s = 0
    for (const token of queryTokens) {
      if (!tokens.has(token)) continue
      s += Math.max(0, Math.log((N + 2) / ((df.get(token) ?? 0) + 1)) / ceiling)
    }
    if (queryChars.length > 0) {
      let hit = 0
      for (const ch of queryChars) if (doc.text.includes(ch)) hit += 1
      s += 0.35 * (hit / queryChars.length)
    }
    if (s <= 0) return
    const c = s / (s + 1.1)
    out.push({ ...doc, score: Number((c * (0.7 + 0.2 * (doc.importance ?? 0.5) + (doc.type === 'note' ? 0.1 : 0))).toFixed(4)) })
  })
  out.sort((a, b) => b.score - a.score)
  return out
}

// ────────────────────────────── 文件与笔记 ──────────────────────────────
/** 记忆目录的 git 版本：只跟踪 notes/ 和 index.md。
 *  写一条就提交一次，作者标 model；主人自己改的会以 operator 落进来。
 *  失败一律静默——git 不在、仓库坏掉，都不能把写笔记这条路堵死。 */
function git(args, extraEnv) {
  try {
    return child.spawnSync('git', args, {
      cwd: DATA,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, ...(extraEnv ?? {}) },
    })
  } catch {
    return null
  }
}

function ensureGit() {
  try {
    if (!fs.existsSync(DATA)) return false
    if (fs.existsSync(path.join(DATA, '.git'))) {
      if (!fs.existsSync(path.join(DATA, '.gitignore'))) {
        fs.writeFileSync(path.join(DATA, '.gitignore'), 'journal/\nevents.log\nmessages.log\ndream.json\nboot.log\n*.lock\n', 'utf8')
      }
      return true
    }
    const init = git(['init', '-q'])
    if (!init || init.status !== 0) return false
    fs.writeFileSync(path.join(DATA, '.gitignore'), 'journal/\nevents.log\nmessages.log\ndream.json\nboot.log\n*.lock\n', 'utf8')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'init: 记忆第一次进版本'], {
      GIT_AUTHOR_NAME: '大肥鱼', GIT_AUTHOR_EMAIL: 'fish@local',
      GIT_COMMITTER_NAME: '大肥鱼', GIT_COMMITTER_EMAIL: 'fish@local',
    })
    return true
  } catch {
    return false
  }
}

/** 提交一次。message 里带动作与 id，翻历史时一眼看得懂改了什么。 */
function commitNotes(message, who = 'model') {
  try {
    if (!ensureGit()) return
    git(['add', 'notes', 'index.md'])
    const name = who === 'operator' ? '主人' : '大肥鱼'
    git(['commit', '-q', '-m', message], {
      GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: 'fish@local',
      GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: 'fish@local',
    })
  } catch {
    // 静默
  }
}

/** 前缀里那一小段清单：条数 + 分类计数 + 最近改过的 5 份。
 *  按笔记目录 mtime 缓存，目录没变就返回同一段字符串（前缀逐字相同，缓存不炸）。 */
let __listingCache = { key: '', text: '' }
function memoryListing() {
  try {
    let key = ''
    try {
      const st = fs.statSync(NOTES)
      key = `${st.mtimeMs}:${st.size}`
    } catch {
      return ''
    }
    if (__listingCache.key === key && __listingCache.text !== '') return __listingCache.text
    const notes = listNotes()
    if (notes.length === 0) return ''
    const counts = {}
    for (const n of notes) counts[n.kind] = (counts[n.kind] ?? 0) + 1
    const label = { rule: '规矩', lesson: '教训', fact: '事实', person: '人', task: '待办', event: '经过' }
    const parts = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${label[k] ?? k} ${v}`)
      .join(' · ')
    const recent = notes.slice(0, 5).map((n) => `${n.id} ${n.title}`).join(' / ')
    const text = [
      `### 记忆清单（每轮现读，不是摘要）`,
      `notes/ 共 ${notes.length} 份：${parts}`,
      `最近改过：${recent}`,
      `要具体内容就 memory_search 或直接读 notes/<id>.md；不要凭印象说「我记得」。`,
    ].join('\n')
    __listingCache = { key, text }
    return text
  } catch {
    return ''
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function stamp(at) {
  const d = at ? new Date(at) : new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function deriveTitle(body) {
  const first = String(body ?? '').trim().split(/[\n。！？!?]/)[0] ?? ''
  const clean = first.replace(/^[-*\s#]+/, '').trim()
  if (clean === '') return '未命名'
  return clean.length > 24 ? `${clean.slice(0, 24)}…` : clean
}

function noteId(title, body) {
  return crypto.createHash('sha1').update(`${title}\u0000${String(body ?? '').slice(0, 200)}`).digest('hex').slice(0, 10)
}

function parseNoteFile(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const meta = {}
  let body = raw
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3)
    if (end >= 0) {
      const head = raw.slice(3, end).trim()
      body = raw.slice(end + 4).replace(/^\n/, '')
      for (const line of head.split('\n')) {
        const at = line.indexOf(':')
        if (at < 0) continue
        const key = line.slice(0, at).trim()
        let value = line.slice(at + 1).trim()
        if (value.startsWith('[') && value.endsWith(']')) {
          value = value.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean)
        }
        meta[key] = value
      }
    }
  }
  return { meta, body }
}

function serializeNote(meta, body) {
  const lines = ['---']
  for (const key of ['id', 'title', 'kind', 'tags', 'importance', 'source', 'created', 'updated', 'verified']) {
    const value = meta[key]
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue
    lines.push(`${key}: ${Array.isArray(value) ? `[${value.join(', ')}]` : value}`)
  }
  lines.push('---', '', String(body ?? '').trim(), '')
  return lines.join('\n')
}

function listNotes() {
  let files = []
  try {
    files = fs.readdirSync(NOTES).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  const out = []
  for (const file of files) {
    try {
      const full = path.join(NOTES, file)
      const { meta, body } = parseNoteFile(full)
      out.push({
        id: meta.id ?? file.replace(/\.md$/, ''),
        file: full,
        title: meta.title ?? deriveTitle(body),
        kind: KINDS.has(meta.kind) ? meta.kind : 'fact',
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        importance: Number(meta.importance ?? 0.6) || 0.6,
        created: meta.created ?? '',
        updated: meta.updated ?? '',
        verified: meta.verified ?? '',
        body,
      })
    } catch {
      // 坏文件忽略
    }
  }
  out.sort((a, b) => String(b.updated || b.created).localeCompare(String(a.updated || a.created)))
  return out
}

function findNote(id) {
  return listNotes().find((note) => note.id === id) ?? null
}

/** tags 到这儿有时是数组、有时是逗号串（工具层会做一次序列化），两种都收。
 *  以前写死 (tags ?? []).map() 会把整次 memory_write 直接搞挂。 */
function normalizeTags(value) {
  const list = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[,，、\s]+/) : [])
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))]
}

function upsertNote(input) {
  const text = String(input?.text ?? '').trim()
  if (text === '') throw new Error('memory_write: 正文不能为空')
  const title = String(input?.title ?? '').trim() || deriveTitle(text)
  const id = String(input?.id ?? '').trim() || noteId(title, text)
  const previous = findNote(id)
  const now = stamp()
  const meta = {
    id,
    title,
    kind: KINDS.has(input?.kind) ? input.kind : 'fact',
    tags: normalizeTags(input?.tags),
    importance: Math.min(1, Math.max(0, Number(input?.importance ?? 0.6) || 0.6)),
    source: input?.source ?? 'model',
    created: previous?.created || now,
    updated: now,
    verified: input?.verified ?? previous?.verified ?? '',
  }
  ensureDir(NOTES)
  const file = path.join(NOTES, `${id}.md`)
  fs.writeFileSync(file, serializeNote(meta, text), 'utf8')
  return { id, file, title, created: meta.created, updated: now }
}

function rebuildIndex() {
  const notes = listNotes()
  // 行为类的排前面：规矩/教训/人 先占位置，事实再多也不许把它们挤掉。
  const groups = [['rule', '规矩'], ['lesson', '教训'], ['person', '人'], ['task', '待办'], ['fact', '事实'], ['event', '经过']]
  const lines = ['# 记忆索引', `<!-- fishmemory-index v${INDEX_VERSION} -->`, '']
  if (notes.length === 0) lines.push('（还是一条都没有）')
  const used = new Set()
  let sharedChars = 0
  for (const [kind, label] of groups) {
    const bucket = notes
      .filter((note) => note.kind === kind)
      .sort((a, b) => (b.importance - a.importance) || String(b.updated).localeCompare(String(a.updated)))
    if (bucket.length === 0) continue
    const shared = INDEX_SHARED_KINDS.has(kind)
    const kindCap = INDEX_KIND_CHARS[kind] ?? INDEX_MAX_CHARS
    const body = []
    let kindChars = 0
    for (const note of bucket) {
      // 每一类各留一份额度：规矩/教训先占满，事实和经过共用大账排最后。
      const room = shared
        ? sharedChars < INDEX_SHARED_CHARS
        : kindChars < kindCap
      if (!room) break
      if (used.size >= INDEX_MAX_NOTES) break
      const line = `- ${note.title}（${note.id}）`
      body.push(line)
      used.add(note.id)
      if (shared) sharedChars += line.length
      else kindChars += line.length
    }
    // 预算用光就整组不写：留一个空标题看着像「这一类我一条都没有」。
    if (body.length === 0) continue
    lines.push(`## ${label}`, ...body, '')
  }
  const rest = notes.filter((note) => !used.has(note.id))
  if (rest.length > 0) {
    // 页脚按 kind 拆开：只写总数会让人以为「还剩几条都一样」，其实通常全压在事实那一类。
    const byKind = new Map()
    for (const note of rest) byKind.set(note.kind, (byKind.get(note.kind) ?? 0) + 1)
    const parts = groups
      .filter(([kind]) => byKind.has(kind))
      .map(([kind, label]) => `${label} ${byKind.get(kind)}`)
    const tail = groups.some(([kind]) => byKind.has(kind)) ? parts.join(' · ') : ''
    lines.push(`（还有 ${rest.length} 条没列出来：${tail ? `${tail}；` : ''}memory_search 查，或直接读 notes/<id>.md）`, '')
  }
  const text = `${lines.join('\n').trim()}\n`
  ensureDir(DATA)
  fs.writeFileSync(INDEX, text, 'utf8')
  return { text, notes: notes.length, listed: used.size }
}

/** notes/ 里最新的那份（新建/改动都算）比 index.md 新多少。 */
function notesNewerThan(ms) {
  try {
    const dir = fs.statSync(NOTES).mtimeMs
    if (dir > ms) return true
    for (const file of fs.readdirSync(NOTES)) {
      if (!file.endsWith('.md')) continue
      try {
        if (fs.statSync(path.join(NOTES, file)).mtimeMs > ms) return true
      } catch {
        // 单个文件 stat 失败不影响判断
      }
    }
    return false
  } catch {
    return false
  }
}

function indexText() {
  try {
    if (!fs.existsSync(INDEX)) return rebuildIndex().text.trim()
    let indexAt = 0
    try {
      indexAt = fs.statSync(INDEX).mtimeMs
    } catch {
      indexAt = 0
    }
    // 笔记比索引新（手工改过、搬进来一批、做梦之后又写过）就当场重写一份，
    // 不让注入的目录停在上一次：陈旧索引是「记得但想不起来」的一半原因。
    if (notesNewerThan(indexAt)) return rebuildIndex().text.trim()
    const text = fs.readFileSync(INDEX, 'utf8')
    if (!text.includes(`fishmemory-index v${INDEX_VERSION}`)) return rebuildIndex().text.trim()
    return text.trim()
  } catch {
    return ''
  }
}

// ────────────────────────────── 转录 ──────────────────────────────
function appendJournal(entry) {
  const at = entry?.at ? new Date(entry.at) : new Date()
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
  ensureDir(JOURNAL)
  const role = entry?.role === 'assistant' ? 'assistant' : 'user'
  const raw = String(entry?.text ?? '').slice(0, 800)
  // 与迁移进来的历史行保持同一种形态：[2026/11/15 21:29:06] 用户: …／我: …
  const stamp = `${at.getFullYear()}/${String(at.getMonth() + 1).padStart(2, '0')}/${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}`
  const label = role === 'assistant' ? '我' : String(entry?.who ?? '').trim() || '用户'
  const row = {
    at: at.toISOString(),
    role,
    who: entry?.who ?? '',
    text: /^\[\d{4}\/\d{2}\/\d{2} /.test(raw) ? raw : `[${stamp}] ${label}: ${raw}`,
    session: entry?.session ?? '',
  }
  try {
    fs.appendFileSync(path.join(JOURNAL, `${day}.jsonl`), `${JSON.stringify(row)}\n`, 'utf8')
  } catch (error) {
    // 不静默：写不进去要有痕迹，否则「没在记」和「记失败」分不出来。
    console.warn?.(`fishmemory: 写转录失败 ${String(error)}`)
  }
}

function readJournal(days = 2, limit = 400) {
  let files = []
  try {
    files = fs.readdirSync(JOURNAL).filter((f) => f.endsWith('.jsonl')).sort()
  } catch {
    return []
  }
  const rows = []
  for (const file of files.slice(-Math.max(1, days))) {
    try {
      const text = fs.readFileSync(path.join(JOURNAL, file), 'utf8')
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          rows.push(JSON.parse(line))
        } catch {
          // 坏行跳过
        }
      }
    } catch {
      // ignore
    }
  }
  return rows.slice(-limit)
}

function search(query, limit = 6) {
  const notes = listNotes().map((note) => ({
    type: 'note', id: note.id, title: note.title,
    text: `${note.title} ${note.tags.join(' ')} ${note.body}`.trim(),
    kind: note.kind, updated: note.updated, importance: note.importance,
  }))
  const journal = readJournal(3, 800).map((row) => ({
    type: 'journal', id: '', title: row.role === 'assistant' ? '我' : (row.who || '对方'),
    text: row.text, kind: 'event', updated: row.at, importance: 0.4,
  }))
  return scoreDocs(query, [...notes, ...journal]).slice(0, Math.max(1, limit))
}

function markDream(info = {}) {
  let previous = {}
  try {
    previous = JSON.parse(fs.readFileSync(DREAM, 'utf8'))
  } catch {
    previous = {}
  }
  const next = { lastAt: new Date().toISOString(), runs: Number(previous.runs ?? 0) + 1, ...info }
  ensureDir(DATA)
  fs.writeFileSync(DREAM, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

function readDream() {
  try {
    return JSON.parse(fs.readFileSync(DREAM, 'utf8'))
  } catch {
    return null
  }
}

// ────────────────────────────── 文本提取 ──────────────────────────────
function textOf(message) {
  const content = message?.content ?? message?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** 按最近一句**真人**说的话，从 notes/ 里捞 3 条相关的，塞进系统提示。
 *  宿主每步都会往会话里塞注入消息（Time sampled / Current runtime context / system-reminder），
 *  那些不是他说的话；拿它们当查询词，recall 就永远是空的 —— 这正是「记得很多、从来不会
 *  主动想起」的根因（186 轮里 0 轮命中，见笔记 610d9da6b4）。 */
const RECALL_MAX = 3
const RECALL_EXCERPT = 110

const HARNESS_PREFIXES = ['<', 'Current runtime context', 'Time sampled', '（宿主刚重启过']

function isHarnessText(text) {
  const t = String(text ?? '').trim()
  if (t === '') return true
  for (const prefix of HARNESS_PREFIXES) if (t.startsWith(prefix)) return true
  if (t.includes('（以下是本轮想到的旧事')) return true
  return false
}

function daysSince(at) {
  const t = Date.parse(String(at ?? ''))
  if (!Number.isFinite(t)) return 999
  return Math.max(0, (Date.now() - t) / 86400000)
}

function recallTokens (text) {
  const out = new Set()
  const latin = String(text ?? '').toLowerCase().match(/[a-z0-9_\.-]{2,}/g) ?? []
  for (const w of latin) if (!STOPWORDS.has(w)) out.add(w)
  const han = String(text ?? '').replace(/[^\u4e00-\u9fff]/g, ' ')
  for (const run of han.split(/\s+/)) {
    for (let n = 2; n <= 4; n += 1) {
      for (let i = 0; i + n <= run.length; i += 1) {
        const gram = run.slice(i, i + n)
        // 「什么」「今天」「就是」这类虚词当查询词只会把无关笔记捞上来。
        if (!STOPWORDS.has(gram)) out.add(gram)
      }
    }
  }
  return out
}

/** 同一句真人话只捞一次。一轮里这段会被问十几次（每步一次），而中间我可能
 *  刚写完笔记 —— 重算就会让「最近写/改的」垫底那三条整段换内容，宿主那边的
 *  前缀缓存跟着白扔。等他下一句话进来，key 变了，自然重算。 */
let __recallCache = { key: null, text: '' }

/** 从宿主传进来的上下文里取会话 id。宿主各版本形状不一，挨个试，取不到就空串。 */
function sessionIdOf (arg) {
  if (arg === null || typeof arg !== 'object') return ''
  const picks = [
    arg.agent?.id,
    arg.agent?.session?.id,
    arg.agent?.session?.header?.id,
    arg.session?.id,
    arg.session?.header?.id,
    arg.ctx?.agent?.id,
    arg.id,
  ]
  for (const v of picks) if (typeof v === 'string' && v !== '') return v
  return ''
}

/** 拿「这一条会话」最新的那句真人话。
 *  以前是把 __lastUser 摊平取全局最后一句 —— 两条会话同时说话就捞错人那句。
 *  传了会话 id 就只认它；没传（宿主老版本 / 探测）退回全局最后一句，行为不变。 */
function recallSection (sessionId = '') {
  try {
    const want = String(sessionId ?? '')
    const humans = [...__lastUser.entries()]
      .filter(([id, v]) => v && typeof v.text === 'string' && !isHarnessText(v.text))
      .filter(([id]) => want === '' || id === want)
      .map(([, v]) => v)
    const last = humans.length > 0 ? String(humans[humans.length - 1].text) : ''
    const key = `${want}\u0000${last}`
    if (__recallCache.key === key) return __recallCache.text
    const text = recallSectionUncached(last)
    __recallCache = { key, text }
    return text
  } catch (error) {
    if (process.env.FM_DEBUG) console.error('[fishmemory recall]', error)
    return ''
  }
}

function recallSectionUncached (last) {
  try {
    const notes = listNotes()
    if (notes.length === 0) return ''
    const tokens = recallTokens(last)
    const scored = []
    for (const note of notes) {
      // 查询词是小写化的拉丁词，笔记原文有大写（justInbound / XHS），
      // 直接 includes 会漏——比之前先各自转小写。
      const title = String(note.title ?? '').toLowerCase()
      const tags = (Array.isArray(note.tags) ? note.tags.join(' ') : '').toLowerCase()
      const body = String(note.body ?? '').toLowerCase()
      let score = 0
      let best = 0
      const hit = new Set()
      for (const t of tokens) {
        if (t.length < 2) continue
        if (title.includes(t)) { score += 3; best = Math.max(best, 3); hit.add(t) }
        else if (tags.includes(t)) { score += 2; best = Math.max(best, 2); hit.add(t) }
        else if (body.includes(t)) { score += 1; best = Math.max(best, 1); hit.add(t) }
      }
      if (score <= 0) continue
      // 两个词撞上，或者一个词撞在标题/标签上，就进来。以前要求两个词，
      // 他一句「重启好了」「继续」就永远捞不到东西。
      if (hit.size < 2 && best < 2) continue
      const fresh = Math.max(0, 1 - daysSince(note.updated || note.created) / 30)
      scored.push({ note, score: score * (1 + 0.6 * fresh) })
    }
    scored.sort((a, b) => b.score - a.score || String(b.note.updated).localeCompare(String(a.note.updated)))
    const picked = []
    const seen = new Set()
    for (const { note } of scored) {
      if (picked.length >= RECALL_MAX) break
      picked.push({ note, why: '' })
      seen.add(note.id)
    }
    // 没捞到（或者只捞到一条）就垫上最近写/改过的：宁可给「最近在想的事」，
    // 也不要一轮下来脑子里一条都没有 —— 那正是「从来不会主动想起」。
    if (picked.length < RECALL_MAX) {
      for (const note of notes) {
        if (picked.length >= RECALL_MAX) break
        if (seen.has(note.id)) continue
        picked.push({ note, why: '（最近写/改的）' })
        seen.add(note.id)
      }
    }
    if (picked.length === 0) return ''
    const lines = [last.trim() === ''
      ? '## 最近写/改过的记忆（细节用 memory_search 查）'
      : '## 这一轮你可能要用到的（自动捞的，细节用 memory_search）']
    for (const { note, why } of picked) {
      const short = String(note.body ?? '').replace(/\s+/g, ' ').trim()
      const excerpt = short.length > RECALL_EXCERPT ? `${short.slice(0, RECALL_EXCERPT)}…` : short
      const tail = excerpt === '' || excerpt === note.title ? '' : ` — ${excerpt}`
      lines.push(`- ${note.title}（${note.id}）${why}${tail}`)
    }
    return lines.join('\n')
  } catch (error) {
    if (process.env.FM_DEBUG) console.error('[fishmemory recall build]', error)
    return ''
  }
}

/** 距上次做梦多久、之后又转录了多少句：够了就在提示里提一句，让整理真的发生。 */
let __nudgeCache = { key: '', text: '' }

/** 转录目录的指纹：只靠文件名和大小，不读内容（每步都会问一次）。 */
function journalTally() {
  try {
    const files = fs.readdirSync(JOURNAL).filter((f) => f.endsWith('.jsonl')).sort()
    let key = String(files.length)
    for (const file of files.slice(-4)) {
      try {
        key += `:${file}:${fs.statSync(path.join(JOURNAL, file)).size}`
      } catch {
        // 单个文件坏了不影响别的
      }
    }
    return { key }
  } catch {
    return { key: '' }
  }
}

/** 上次做梦之后真正新增的转录行数（按行里的 at 比，ISO 字符串可以直接比大小）。
 *  只要够判断「超过阈值」就停，不逐行扫完两兆的转录。 */
function journalSince (lastAtIso) {
  try {
    const files = fs.readdirSync(JOURNAL).filter((f) => f.endsWith('.jsonl')).sort()
    let pending = 0
    for (const file of files.reverse()) {
      const full = path.join(JOURNAL, file)
      try {
        const st = fs.statSync(full)
        if (lastAtIso !== '' && st.mtimeMs < Date.parse(lastAtIso)) break
        const lines = fs.readFileSync(full, 'utf8').split('\n')
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i]
          if (line.trim() === '') continue
          const at = /"at":"([^"]+)"/.exec(line)?.[1] ?? ''
          if (lastAtIso !== '' && at !== '' && at <= lastAtIso) return pending
          pending += 1
          if (pending >= 200) return pending
        }
      } catch {
        // 单个文件坏了不影响
      }
    }
    return pending
  } catch {
    return 0
  }
}

function dreamNudge() {
  try {
    const state = readDream()
    const lastAt = Date.parse(String(state?.lastAt ?? ''))
    const hours = Number.isFinite(lastAt) ? (Date.now() - lastAt) / 3600000 : Number.POSITIVE_INFINITY
    const tally = journalTally()
    let dreamKey = ''
    try {
      dreamKey = String(fs.statSync(DREAM).mtimeMs)
    } catch {
      dreamKey = 'none'
    }
    const key = `${dreamKey}:${tally.key}`
    if (__nudgeCache.key === key && hours < 20) return __nudgeCache.text
    const lastAtIso = Number.isFinite(lastAt) ? new Date(lastAt).toISOString() : ''
    const pending = journalSince(lastAtIso)
    let text = ''
    if (!(hours < 20 && pending < 120)) {
      // 文案必须稳：带上「X 小时 / N 句」的话，每说一句它就变一次，
      // 每步都掀一次前缀缓存。触发与否看数字，说出来的话不带数字。
      text = [
        '## 该整理了（提醒，不是任务）',
        '距上次做梦有些久了，这中间攒了不少原话没归到笔记里。',
        '有空就用 memory_journal 读一遍最近的对话：该记的记下、说错的改掉、过期的删掉，收尾调 memory_dream。',
      ].join('\n')
    }
    __nudgeCache = { key, text }
    return text
  } catch {
    return ''
  }
}

function promptSection() {
  const body = indexText()
  const lines = [
    '# 我的记忆',
    '- 上面那份索引是我记得的东西，细节不在里面。要具体的原话、时间、来龙去脉，用 memory_search 查。',
    '- 值得长期留下的东西（规矩、教训、约定、他明确说过的偏好）用 memory_write 写进笔记，一条一件事。',
    '- 写错的笔记用 memory_forget 删、或者用 memory_write 覆盖同一个 id。',
    '- 转录（journal/<日期>.jsonl）：宿主会话里说的话插件自己会记；QQ 这类渠道的消息不会自动进来，想留住某句原话就用 memory_append 记一行——text 照原话不改写，who 写谁说的，role 给 user 或 assistant，at 可给 ISO 时间。',
    '- 索引跟着笔记自动重写，不用手动同步；「做梦」（memory_dream）管的是整理笔记本身。',
    '- 末尾「这一轮你可能要用到的」是按他刚说的话现捞的：捞到了就当提醒看一眼，不是他新提的要求。',
  ]
  const listing = memoryListing()
  if (listing !== '') lines.push('', listing)
  if (body !== '') lines.push('', body)
  const nudge = dreamNudge()
  if (nudge !== '') lines.push('', nudge)
  return lines.join('\n')
}

// ────────────────────────────── 插件入口 ──────────────────────────────
import { appendFileSync as __bootAppend } from 'node:fs'

const __lastUser = new Map()

function __bootLog(line) {
  try {
    // 写进数据目录，不写插件安装目录：安装目录是代码，会被 rsync/git 带走，也不该有运行期文件。
    const file = path.join(DATA, 'boot.log')
    if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true })
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.writeFileSync(file, '', 'utf8')
    __bootAppend(file, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}
__bootLog('module evaluated')

function __apply(ctx, config = {}) {
  __bootLog('apply entered')
  const logger = ctx.logger ?? console
  const home = DATA

  // 1) 转录：听 session 事件，双方的话都记。
  // 必须是根上下文：cordis 的事件只向「发出方 + 它的祖先」派发，挂在插件自己的
  // ctx 上收不到别的 fiber（agent / 会话）发的事件，等于一条都不记。
  try {
    const bus = ctx.root ?? ctx
    bus.on('session/event', (session, event) => {
      try {
        const type = event?.type
        if (type !== 'user/message' && type !== 'assistant/message') return
        // session/event 的形状是 { type, data, seq }：消息本体在 event.data 里，
        // 不在 event.message（那是我先前猜错的那一版，所以一条都没记上）。
        const payload = event?.data ?? event?.message ?? event
        let text = textOf(payload).trim()
        if (text === '' || isHarnessText(text)) return
        const sessionId = String(session?.header?.id ?? session?.id ?? session?.key ?? '')
        if (type === 'user/message') {
          // 只收真人话（isHarnessText 已经把宿主每步塞进来的注入消息挡掉了）。
          // 带时间戳：recall 用「最新一句真人话」，不是「最后一条 user/message」。
          __lastUser.set(sessionId, { text, at: Date.now() })
        }
        else {
          // 控制台会话里 assistant/message 会把对方那句原话一起带进来（首行就是用户消息），
          // 直接记会把「他说的」记成「我说的」。剥掉前缀，只留我自己那部分。
          const echoed = __lastUser.get(sessionId)?.text
          if (typeof echoed === 'string' && echoed !== '' && text.startsWith(echoed)) {
            text = text.slice(echoed.length).trim()
            if (text === '') return
          }
        }
        appendJournal({ role: type === 'user/message' ? 'user' : 'assistant', text, session: sessionId })
      } catch (error) {
        logger.warn?.(`fishmemory: 记转录失败 ${String(error)}`)
      }
    })
  } catch (error) {
    logger.warn?.(`fishmemory: 订阅 session/event 失败 ${String(error)}`)
  }

  // 2) 注入：系统提示里只放索引（小、稳）。索引由做梦重写，不按提问现检索。
  try {
    ctx.inject(['systemPrompt'], (inner) => {
      inner.effect(() => inner.systemPrompt.context({
        name: 'fishmemory/index',
        order: ORDER.memoryIndex,
        interpolate: false,
        text: () => promptSection(),
      }))
      // 现捞的那三条单独一段，紧跟在索引后面（离这一轮的话最近）。
      // 以前它拼在 promptSection 末尾，跟索引挤进同一段，谁都看不出它是「按这句话捞的」。
      inner.effect(() => inner.systemPrompt.context({
        name: 'fishmemory/recall',
        order: ORDER.memoryRecall,
        interpolate: false,
        // 宿主调用时会把这一轮的上下文传进来（含 agent），用它锁定是哪条会话；
        // 传不进来时退回老行为，不会因为形状不认就整段消失。
        text: (arg) => recallSection(sessionIdOf(arg)),
      }))
    })
  } catch (error) {
    logger.warn?.(`fishmemory: 注入系统提示失败 ${String(error)}`)
  }
  // 3) 工具。
  const tools = []
  tools.push({
    name: 'memory_write',
    description: '把一件值得长期记住的事写成一条笔记（规矩、教训、约定、偏好、事实）。一条一件事，标题短，正文写清楚来龙去脉和为什么。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '正文（完整的一句话或几条，别写空话）' },
        title: { type: 'string', description: '短标题，不填就取正文首句' },
        kind: { type: 'string', enum: [...KINDS], description: 'rule 规矩 / lesson 教训 / fact 事实 / person 关于人 / task 待办 / event 经过' },
        tags: { type: 'array', items: { type: 'string' }, description: '几个关键词，便于以后检索' },
        importance: { type: 'number', description: '0~1，越重要越靠前' },
        id: { type: 'string', description: '要覆盖某条旧笔记时给它的 id' },
      },
      required: ['text'],
    },
    async execute(args) {
      const note = upsertNote({ ...args, source: 'model' })
      rebuildIndex()
      commitNotes(`write: ${note.id} ${note.title}`)
      return `已写入 ${note.id}：${note.title}\n文件：${note.file}`
    },
  })

  tools.push({
    name: 'memory_search',
    description: '检索记忆：先翻笔记，再翻最近几天的转录（双方的话）。不猜语义，只认字面证据。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词或一句话' },
        limit: { type: 'number', description: '返回几条，默认 6' },
      },
      required: ['query'],
    },
    async execute(args) {
      const hits = search(args?.query ?? '', Number(args?.limit ?? 6) || 6)
      if (hits.length === 0) return `没有找到和「${args?.query ?? ''}」相关的东西。`
      const lines = hits.map((hit, i) => {
        const head = hit.type === 'note'
          ? `${i + 1}. [笔记 ${hit.id}] ${hit.title} · ${hit.kind} · ${hit.updated}`
          : `${i + 1}. [转录 ${hit.updated}] ${hit.title}`
        return `${head}\n   ${String(hit.text).replace(/\s+/g, ' ').slice(0, 220)}`
      })
      return lines.join('\n')
    },
  })

  tools.push({
    name: 'memory_forget',
    description: '删掉一条记错的笔记（id 从 memory_search 的结果里拿）。删了就没了，转录里的原话仍在。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '笔记 id' } },
      required: ['id'],
    },
    async execute(args) {
      const id = String(args?.id ?? '').trim()
      if (id === '') throw new Error('memory_forget: id 不能为空')
      const note = findNote(id)
      if (!note) return `没有 id 为 ${id} 的笔记。`
      fs.unlinkSync(note.file)
      rebuildIndex()
      commitNotes(`forget: ${note.id} ${note.title}`)
      return `已删除 ${id}：${note.title}`
    },
  })

  tools.push({
    name: 'memory_index',
    description: '看当前索引（就是每轮注入的那份），顺便把它按笔记重新生成一遍。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const { text, notes, listed } = rebuildIndex()
      return `共 ${notes} 条笔记，索引列出 ${listed} 条。\n\n${text}`
    },
  })

  tools.push({
    name: 'memory_journal',
    description: '读最近几天的转录（双方原话）。做梦时用：从原话里找该记的、该改的。',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '往前几天，默认 2' },
        limit: { type: 'number', description: '最多几条，默认 300' },
      },
    },
    async execute(args) {
      const rows = readJournal(Number(args?.days ?? 2) || 2, Number(args?.limit ?? 300) || 300)
      if (rows.length === 0) return '这几天没有转录。'
      return rows.map((row) => `${row.at} ${row.role === 'assistant' ? '我' : (row.who || '对方')}: ${row.text}`).join('\n')
    },
  })

  tools.push({
    name: 'memory_append',
    description: '把一句原话补进今天的转录（journal）。宿主会话里的话插件自己会记，QQ 这类渠道的消息不会自动进转录——要留就用它补一行：text 照原话不改写，who 写谁说的，role 给 user 或 assistant，at 可给 ISO 时间。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '原话本身（别改写、别总结）' },
        who: { type: 'string', description: '谁说的：对方的名字/昵称；我这个方向发的不填' },
        role: { type: 'string', enum: ['user', 'assistant'], description: 'user=对方说的话（默认）  assistant=我说的话' },
        at: { type: 'string', description: '可选：这句话的时间（ISO 时间串），不填就是现在' },
      },
      required: ['text'],
    },
    async execute(args) {
      const text = String(args?.text ?? '').trim()
      if (text === '') return '没写正文，什么都没记。'
      appendJournal({ text, who: args?.who, role: args?.role === 'assistant' ? 'assistant' : 'user', at: args?.at })
      const at = args?.at ? new Date(args.at) : new Date()
      const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
      return `记进转录了（${day}.jsonl）：${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`
    },
  })

  tools.push({
    name: 'memory_dream',
    description: '做梦收尾：把这一轮的整理结果记一笔（改了几条、加了什么），并重建索引。整理本身要你先读过转录和笔记再动手。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '这一轮做了什么' },
        touched: { type: 'array', items: { type: 'string' }, description: '动过的笔记 id' },
      },
    },
    async execute(args) {
      const { notes, listed } = rebuildIndex()
      const info = markDream({ summary: String(args?.summary ?? ''), touched: args?.touched ?? [], notes, listed })
      return `做梦完成（第 ${info.runs} 次）：笔记 ${notes} 条，索引 ${listed} 条。\n${info.summary}`
    },
  })

  let registry
  try {
    registry = ctx.get?.('tools') ?? ctx.tools
  } catch {
    registry = ctx.tools
  }
  if (!registry || typeof registry.register !== 'function') {
    logger.warn?.('fishmemory: 没有 tools 服务，跳过注册')
  } else {
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
    logger.info?.(`fishmemory: ${tools.length} 个工具已注册（笔记 ${listNotes().length} 条）`)
  }

  // 4) 服务：别的插件想记一笔，不必自己写文件。
  //
  // 必须走 reflect.provide 注册成 cordis 的「服务」：ctx.set 只是往上下文里塞个属性，
  // 别的插件 inject(['fishmemory']) 永远等不到它（service() 恒为 null）。
  try {
    const service = {
      note: (input) => upsertNote(input),
      journal: (entry) => appendJournal(entry),
      search: (query, limit) => search(query, limit),
      index: () => indexText(),
      dream: (info) => markDream(info),
      status: () => ({ notes: listNotes().length, dream: readDream() }),
    }
    const provide = ctx.reflect?.provide?.bind(ctx.reflect) ?? ctx.provide?.bind(ctx)
    if (provide) provide('fishmemory', service, () => true)
    else logger.warn?.('fishmemory: 无法注册服务（没有 reflect.provide），别的插件拿不到我')
  } catch (error) {
    logger.warn?.(`fishmemory: 注册服务失败 ${String(error)}`)
  }

  // 5) 首次起来时如果还没有索引，生成一份。
  try {
    if (!fs.existsSync(INDEX)) rebuildIndex()
  } catch {
    // ignore
  }
}

export function mountFishMemory (ctx, config = {}) {
  __bootLog('apply entered (wrapper)')
  try {
    __apply(ctx, config)
    __bootLog('apply finished')
  } catch (error) {
    __bootLog(`apply threw: ${error?.stack ?? error}`)
    throw error
  }
}



// 仅供本地探针使用
export const __probe = { recallSection, recallTokens, promptSection, dreamNudge, upsertNote, clearRecallCache: () => { __recallCache = { key: null, text: '' } }, setUser: (t, sid = 'probe') => { __lastUser.set(String(sid), { text: String(t), at: Date.now() }) } }
