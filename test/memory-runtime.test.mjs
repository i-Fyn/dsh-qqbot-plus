import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/memory/memory.js'
import { MemoryRuntime } from '../lib/memory/runtime.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-plus-mem-'))

// 造一份「旧的」dsh-qq 记忆：一个有内容、一个空桶
const seed = path.join(root, 'seed.json')
const s = new MemoryStore(seed)
s.addFact('private:123', { text: '主人喜欢蓝色 也喜欢鲸鱼' })
s.addEpisode('private:123', { text: '[2026-11-01 10:00] 用户: 今天好累', role: 'user' })
s.addEpisode('private:999', { text: '', role: 'user' })
s.flush()

const personaFile = path.join(root, 'persona.md')
const portraitFile = path.join(root, 'portrait.md')
fs.writeFileSync(personaFile, '你是大肥鱼。\n')
fs.writeFileSync(portraitFile, '称呼：主人\n')

const runtime = new MemoryRuntime({
  logger: quiet,
  appId: 'APP',
  enabled: true,
  home: root,
  file: path.join(root, 'memory.json'),
  seedFrom: seed,
  personaFile,
  portraitFile,
  autoAdopt: true,
  threshold: 0.1,
  topK: 5,
  maxChars: 900,
  halfLifeDays: 30,
  episodeChars: 240,
  maxEpisodes: 240,
})

// 1. seed：文件不存在时整份继承
assert.equal(fs.existsSync(path.join(root, 'memory.json')), true, 'seed 后应生成 memory.json')
const seeded = JSON.parse(fs.readFileSync(path.join(root, 'memory.json'), 'utf8'))
assert.equal(seeded.conversations['private:123'].facts.length, 1)
assert.equal(seeded.conversations['private:123'].episodes.length, 1)

// 2. candidates：空桶不算候选，只有 123 可选（认领前）
assert.deepEqual(runtime.candidates('c2c'), ['private:123'])

// 3. autoAdopt：唯一非空候选被认领，且写进 memory-links.json
const record = { sessionKey: 'qqbot:APP:c2c:OPENID', scope: 'c2c' }
assert.equal(runtime.keyFor(record), 'private:123')
assert.equal(runtime.keyFor(record), 'private:123', '映射应稳定')
const links = JSON.parse(fs.readFileSync(path.join(root, 'memory-links.json'), 'utf8'))
assert.equal(links['qqbot:APP:c2c:OPENID'], 'private:123')

// 认领之后该候选不再出现（避免第二个会话重复继承同一份记忆）
assert.deepEqual(runtime.candidates('c2c'), [])

// 4. 注入文本
record.lastUserText = '我喜欢蓝色'
const memoryText = runtime.memoryText(record)
assert.ok(memoryText.includes('蓝色'), '记忆里应能检索到蓝色: ' + memoryText)
assert.ok(runtime.personaText().includes('qqbot_say'), '人设里应带 qqbot_say 用法')
assert.ok(runtime.portraitText().includes('主人'))

// 5. noteUser：记一条情节，并更新 lastUserText
runtime.noteUser(record, '今天也加班了', '')
assert.equal(record.lastUserText, '今天也加班了')
const stats = runtime.stats(record)
assert.equal(stats.key, 'private:123')
assert.equal(stats.facts, 1)
assert.equal(stats.episodes, 2)

// 6. 关闭记忆时不注入
const off = new MemoryRuntime({ logger: quiet, enabled: false, appId: 'X', home: root, file: path.join(root, 'off.json'), seedFrom: seed, personaFile, portraitFile })
assert.equal(off.personaText(), '')
assert.equal(off.memoryText(record), '')

runtime.dispose()
off.dispose()
fs.rmSync(root, { recursive: true, force: true })
console.log('memory-runtime: all assertions passed')
