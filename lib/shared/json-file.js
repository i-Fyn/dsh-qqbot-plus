import fs from 'node:fs'
import path from 'node:path'

/**
 * 原子地写一份 JSON：先写同目录临时文件再 rename 覆盖。
 *
 * 直接 writeFileSync 覆盖状态文件，赶上进程被杀 / 断电就会留下半截 JSON；
 * 读的一方（settings.json 尤其明显）解析失败就当没文件、回落默认值，
 * 面板设置就这么"自己回到默认"了。tmp + rename 在同一个文件系统上是原子的。
 *
 * @param {string} file 目标路径
 * @param {unknown} data 要写的数据
 * @param {{ indent?: number, trailingNewline?: boolean, mode?: number }} [options]
 * @returns {boolean} 写成功返回 true（失败返回 false，不抛）
 */
export function writeJsonAtomic (file, data, options = {}) {
  const { indent = 2, trailingNewline = true, mode } = options
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const body = JSON.stringify(data, null, indent) + (trailingNewline ? '\n' : '')
    fs.writeFileSync(tmp, body, { encoding: 'utf8', ...(mode === undefined ? {} : { mode }) })
    fs.renameSync(tmp, file)
    return true
  } catch {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // 临时文件清不掉就算了，别把真正要报的错盖掉
    }
    return false
  }
}
