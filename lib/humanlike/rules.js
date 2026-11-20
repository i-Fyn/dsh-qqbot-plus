/**
 * 人味插件自己的「追加规则」：存在 <dataDir>/append-rules.md，面板里能改。
 *
 * 跟 dsh-bili 的 src/rules.js 是同一套做法。规则作为一段系统提示注入，
 * 所以它必须短、稳、可核对；空串等于恢复默认。
 *
 * @module dsh-humanlike/lib/rules
 */
import fs from 'node:fs'
import path from 'node:path'

const MAX = 4000

export class RulesStore {
  #file
  #defaults
  #logger

  constructor({ dataDir, defaults, logger }) {
    this.#file = path.join(dataDir, 'append-rules.md')
    this.#defaults = defaults
    this.#logger = logger
  }

  get file() {
    return this.#file
  }

  get defaults() {
    return this.#defaults
  }

  /** @returns {{text: string, isDefault: boolean}} */
  read() {
    try {
      const text = fs.readFileSync(this.#file, 'utf8')
      if (text.trim() !== '') return { text, isDefault: false }
    } catch {
      // 没有文件就用默认
    }
    return { text: this.#defaults, isDefault: true }
  }

  /** 保存；空串等于恢复默认 */
  save(text) {
    const body = typeof text === 'string' ? text : ''
    if (body.trim() === '') return this.reset()
    if (body.length > MAX) {
      const error = new Error(`规则太长（${body.length} 字，上限 ${MAX}）`)
      error.status = 400
      throw error
    }
    fs.mkdirSync(path.dirname(this.#file), { recursive: true })
    fs.writeFileSync(this.#file, body, 'utf8')
    this.#logger?.info?.(`humanlike: 规则已保存 ${this.#file}`)
    return { text: body, isDefault: false }
  }

  reset() {
    try {
      fs.rmSync(this.#file, { force: true })
    } catch {
      // 删不掉也无所谓，read() 会继续用默认
    }
    return { text: this.#defaults, isDefault: true }
  }
}
