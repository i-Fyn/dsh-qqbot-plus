/**
 * 记忆 / 人设 / 画像的落盘位置。
 *
 * 全部写在自己家（~/.dsh/dsh-qqbot-plus）。不再和 dsh-qq 共享，也不从那边复制：
 * 这个插件从没发布过，没有需要兼容的旧安装，首次运行就是一个空目录。
 *
 * @module dsh-qqbot-plus/identity/paths
 */
import { join } from 'node:path'
import { PLUGIN_HOME } from '../shared/dirs.js'

export function ownPersonaFile() {
  return join(PLUGIN_HOME, 'persona.md')
}
export function ownPortraitFile() {
  return join(PLUGIN_HOME, 'portrait.md')
}

/** 人设文件：自家 persona.md（不存在时用包内默认文案，不回落到别处）。 */
export function defaultPersonaFile() {
  return ownPersonaFile()
}

/** 画像文件：自家 portrait.md（不存在时就不注入画像）。 */
export function defaultPortraitFile() {
  return ownPortraitFile()
}
