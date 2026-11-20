/**
 * QQ 通道的人设 / 画像 + 发消息指南。
 *
 * 这一层只管「人设 / 画像 / 在 QQ 里怎么说话」，不碰长期记忆。
 * 长期记忆（笔记 / 转录 / 索引）在同插件的 lib/fishmemory/plugin.js，
 * 两边各注入各的段，互不调用。
 *
 * @module dsh-qqbot-plus/identity/runtime
 */
import fs from 'node:fs'
import path from 'node:path'
import { readPersona, readWorkIndex } from './persona.js'
import { readPortrait, portraitBlock } from './portrait.js'

function sendGuide(allowSilence) {
  const lines = [
    '',
    '# 在 QQ 里怎么回话',
    '- 说话分两步：先 qq_draft 起草（一次一条），再 qq_confirm(decision="send") 发出去。',
    '- 想发几条就重复 draft + confirm，每条是独立的一条 QQ 消息。',
    '- 回复正文不会自动发到 QQ；只写在正文里对方看不到。',
  ]
  lines.push('- 装了记忆插件就有 memory_search / memory_write / memory_append 这些工具：想不起旧事就查，值得留下的记一条，某句原话真漏了用 memory_append 补进转录。')
  if (allowSilence) {
    lines.push('- 聊天里不是每句都要接：对方只是顺手一句、话还没说完、或者你没什么想说的，就 qq_skip 安静过去，不用硬回。')
  } else {
    lines.push('- 这一轮必须回：直接 qq_draft + qq_confirm，不要 qq_skip。')
  }
  return lines.join('\n')
}

function expandHome(input, home) {
  if (typeof input !== 'string' || input.trim() === '') return ''
  const text = input.trim()
  if (text === '~') return home
  if (text.startsWith('~/')) return path.join(home, text.slice(2))
  return text
}

export class MemoryRuntime {
  constructor(options) {
    this.logger = options.logger ?? console
    this.enabled = options.enabled !== false
    this.allowSilence = options.allowSilence !== false
    this.personaFile = options.personaFile
    this.portraitFile = options.portraitFile
  }

  /** 常驻画像（不检索）。 */
  portraitText() {
    if (!this.enabled) return ''
    try {
      return portraitBlock(readPortrait(this.portraitFile).text)
    } catch {
      return ''
    }
  }

  /** 人设 + 发消息方式。 */
  personaText() {
    if (!this.enabled) return ''
    try {
      return (
        readPersona(this.personaFile).text +
        readWorkIndex(this.personaFile) +
        sendGuide(this.allowSilence)
      )
    } catch {
      return sendGuide(this.allowSilence)
    }
  }

  dispose() {
    // 没有要收的东西。
  }
}

export { expandHome }