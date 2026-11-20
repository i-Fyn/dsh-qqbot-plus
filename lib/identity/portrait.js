/**
 * 关于「他」的画像：一小段常驻在系统提示里，不靠检索。
 *
 * 画像文件默认在自家数据目录（~/.dsh/dsh-qqbot-plus/portrait.md）。
 *
 * @module dsh-qqbot-plus/identity/portrait
 */
import fs from 'node:fs'

/** 读画像；没有就是空串（不注入）。 */
export function readPortrait(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/\s+$/, '')
    return { text, custom: text.trim() !== '', file }
  } catch {
    return { text: '', custom: false, file }
  }
}

/** 变成系统提示里的那一段。 */
export function portraitBlock(text) {
  const body = String(text ?? '').trim()
  if (body === '') return ''
  return ['## 关于他', '', body].join('\n')
}
