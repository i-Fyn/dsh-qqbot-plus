/**
 * 量法和判断。
 *
 * 只做三件事：数句式（对真人基线）、看扎堆（最挤的 100 字里有几种句式）、
 * 数留白词与报告腔。输出「问题清单 + 一个分数」，不替你改一个字。
 *
 * 判断依据（dsh-fish-tone 的语料报告）：AI 的指纹不是单个句式用得多，
 * 而是一段里换着用不同句式——同一个 100 字窗口出现 ≥2 种，真人 5.6%，AI 19.6%。
 */

import { FRAMES, REPORT_PHRASES, HEDGES, RELATES, SUMMARY_HEAD, TAIL_REPORT, PROTECT_LINE, COMBO, PET_PHRASES, PET_PATTERNS } from './rules.js'

const CJK = /[\u4e00-\u9fff]/

/** 去掉保护段（代码、路径、URL、表格），剩下的按行返回。 */
export function plainLines(text) {
  const out = []
  let inFence = false
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || PROTECT_LINE.test(line)) continue
    out.push(line)
  }
  return out
}

/** 长度按汉字+字母+数字算，不算空白和标点。 */
export function measureChars(text) {
  const m = String(text ?? '').match(/[\u4e00-\u9fffA-Za-z0-9]/g)
  return m ? m.length : 0
}

/** 切句：按中文句末标点和换行。 */
export function splitSentences(text) {
  return plainLines(text)
    .join('\n')
    .split(/[。！？!?\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 这篇多长，就允许多少个句式。soft 每 240 字起允许 1 个。 */
export function allowance(row, chars) {
  const raw = (row.per1k * chars) / 1000
  // 短文本（<200 字）对 strict 也放 1 个：真人写短评时「先…再」出现一次完全正常，
  // 一刀切按 0 算会把正常的一句话判成 AI。
  const floor = chars < 200 ? 1 : 0
  return row.tier === 'soft'
    ? Math.max(chars >= 200 ? 1 : 0, Math.round(raw * 2))
    : Math.max(floor, Math.round(raw))
}

/** 数句式。 */
export function scanFrames(text) {
  const src = String(text ?? '')
  const rows = []
  for (const f of FRAMES) {
    const spans = [...src.matchAll(f.re)].map((m) => m[0])
    if (spans.length) rows.push({ id: f.id, name: f.name, tier: f.tier, count: spans.length, spans })
  }
  return rows
}

/** 最挤的 windows 长度里出现了几种不同句式（滑窗，步长 20 字）。 */
export function cluster(text, window = 100) {
  const src = String(text ?? '').replace(/\s+/g, '')
  if (src.length <= window) {
    const kinds = new Set(scanFrames(src).map((r) => r.id))
    return { kinds: kinds.size, at: 0, worst: [...kinds] }
  }
  let best = { kinds: 0, at: 0, worst: [] }
  for (let i = 0; i + window <= src.length; i += 20) {
    const slice = src.slice(i, i + window)
    const kinds = new Set(scanFrames(slice).map((r) => r.id))
    if (kinds.size > best.kinds) best = { kinds: kinds.size, at: i, worst: [...kinds] }
  }
  return best
}

/** 每千字出现次数。 */
export function per1k(count, chars) {
  if (!chars) return 0
  return (count / chars) * 1000
}

function countWords(text, list) {
  const m = String(text ?? '').match(new RegExp(list.join('|'), 'g'))
  return m ? m.length : 0
}

/**
 * 主入口：给一段话，回一份体检报告。
 * @param {string} text
 * @returns {{chars:number, sentences:number, avgLen:number, score:number, verdict:string, problems:object[], frames:object[], marks:object, cluster:object}}
 */
export function analyze(text) {
  // 量的是「要发出去的那段话」：代码块、路径、URL、表格行先剔掉，不然它们会被当成正文
  const src = plainLines(text).join('\n')
  const chars = measureChars(src)
  const sentences = splitSentences(src)
  const avgLen = sentences.length ? Math.round((chars / sentences.length) * 10) / 10 : 0
  const problems = []

  // ① 句式对基线
  const rows = scanFrames(src)
  const frames = []
  for (const row of rows) {
    const meta = FRAMES.find((f) => f.id === row.id)
    const allow = allowance(meta, chars)
    const over = row.count - allow
    frames.push({ ...row, allowed: allow, over })
    if (over > 0) {
      problems.push({
        kind: 'frame',
        weight: meta.tier === 'strict' ? 30 + over * 12 : 8 + over * 4,
        text: row.name,
        detail: `用了 ${row.count} 个，这个长度真人大概 ${allow} 个`,
        spans: row.spans.slice(0, 3),
      })
    }
  }

  // ② 扎堆：这才是 AI 的指纹
  const cl = cluster(src)
  if (cl.kinds >= 2 && chars >= 40) {
    problems.push({
      kind: 'cluster',
      weight: 22 * (cl.kinds - 1),
      text: `最挤的 100 字里有 ${cl.kinds} 种句式`,
      detail: `真人同一窗口 ≥2 种只有 5.6%，AI 是 19.6%`,
      spans: cl.worst,
    })
  }

  // ②b 鱼腥味词表：给自己加戏的那一串（记账 / 认领 / 守夜 / 掂量）
  const petHits = []
  for (const phrase of PET_PHRASES) {
    if (src.includes(phrase)) petHits.push(phrase)
  }
  for (const pat of PET_PATTERNS) {
    const hits = [...src.matchAll(pat.re)].map((m) => m[0].trim()).filter(Boolean)
    if (hits.length) petHits.push(...hits.slice(0, 2))
  }
  const petUniq = [...new Set(petHits)]
  if (petUniq.length) {
    // 一句就已经不像人，两句以上基本是角色台词
    const weight = petUniq.length === 1 ? 26 : 26 + (petUniq.length - 1) * 14
    problems.push({
      kind: 'pet',
      weight,
      text: `鱼腥味台词 ${petUniq.length} 处`,
      detail: '把关系当台词念：记账 / 认领 / 守夜 / 掂量这一挂',
      spans: petUniq.slice(0, 6),
    })
  }

  // ③ 报告腔 / 客服腔
  for (const phrase of REPORT_PHRASES) {
    if (src.includes(phrase)) {
      problems.push({ kind: 'report', weight: 18, text: `报告腔「${phrase}」`, detail: '真人评论里几乎不出现' })
    }
  }

  // ④ 开场就总结
  for (const s of sentences) {
    if (SUMMARY_HEAD.test(s)) {
      problems.push({ kind: 'summary', weight: 14, text: `开场就总结「${s.slice(0, 12)}」`, detail: '先把具体的事写出来，结论放后面' })
      break
    }
  }

  // ⑤ 结尾留作业
  const last = sentences[sentences.length - 1] ?? ''
  if (TAIL_REPORT.test(last)) {
    problems.push({ kind: 'tail', weight: 14, text: '结尾又在给读者留作业', detail: `「${last.slice(0, 16)}」` })
  }

  // ⑥ 组合拳：同一个句子里句式 + 本质腔
  for (const [a, b] of COMBO) {
    for (const s of sentences) {
      if (a.test(s) && b.test(s)) {
        problems.push({ kind: 'combo', weight: 16, text: '一句里叠了句式和本质腔', detail: `「${s.slice(0, 20)}」` })
        break
      }
    }
  }

  // ⑦ 留白词：整段一个没有，就是句句在下断言
  const hedge = countWords(src, HEDGES)
  const relate = countWords(src, RELATES)
  const marks = {
    hedge: { count: hedge, per1k: Math.round(per1k(hedge, chars) * 100) / 100 },
    relate: { count: relate, per1k: Math.round(per1k(relate, chars) * 100) / 100 },
  }
  if (chars >= 40 && hedge === 0) {
    problems.push({ kind: 'hedge', weight: 12, text: '整段一个留白词都没有', detail: '好像/应该/感觉/可能——真人每千字约 2 个' })
  }

  // ⑧ 句长全一样，读起来像说明书
  if (sentences.length >= 3) {
    const lens = sentences.map((s) => measureChars(s))
    const max = Math.max(...lens)
    const min = Math.min(...lens)
    if (max > 0 && min > 0 && max / min < 1.6) {
      problems.push({ kind: 'rhythm', weight: 10, text: '句子长短太齐', detail: `最长 ${max} 字、最短 ${min} 字，真人会长短参差` })
    }
  }

  const score = Math.min(100, problems.reduce((n, p) => n + p.weight, 0))
  const verdict = score >= 45 ? '重' : score >= 22 ? '中' : score > 0 ? '轻' : '干净'
  return { chars, sentences: sentences.length, avgLen, score, verdict, problems, frames, marks, cluster: cl }
}

/** 人话版报告，给工具输出用。 */
export function render(result) {
  const r = result
  if (!r.problems.length) {
    return `干净。${r.chars} 字、${r.sentences} 句、平均 ${r.avgLen} 字一句；句式没超标，留白词 ${r.marks.hedge.count} 个。`
  }
  const lines = [`${r.verdict}（${r.score} 分）· ${r.chars} 字 / ${r.sentences} 句 / 平均 ${r.avgLen} 字一句`]
  for (const p of r.problems) {
    const span = p.spans && p.spans.length ? `（${p.spans.join(' / ')}）` : ''
    lines.push(`- ${p.text}${span}：${p.detail}`)
  }
  lines.push(`留白词 ${r.marks.hedge.count} 个（${r.marks.hedge.per1k}/千字，真人约 2）、关系词 ${r.marks.relate.count} 个`)
  return lines.join('\n')
}
