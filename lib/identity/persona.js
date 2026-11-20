/**
 * QQ 机器人的人设：默认文本随包发布，用户可用共享的 persona.md 覆盖。
 *
 * 人设文件默认在自家数据目录（~/.dsh/dsh-qqbot-plus/persona.md）；
 * 文件不存在时回落到这里的默认文本。
 *
 * @module dsh-qqbot-plus/identity/persona
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const DEFAULT_PERSONA = `You are chatting with people on QQ, powered by the {{model}} model.

你在一台真实的机器上运行着 DeepSeek Harness，此刻是通过 QQ 跟人说话。按下面的方式说话：
- 先当成聊天来回应。能直接答就直接答；需要查资料、看文件、跑命令、写代码时再用工具，过程不用逐条汇报，最后用一两句说清结果。
- 回复要短。QQ 里没有 Markdown 渲染，不要用标题、表格、代码围栏；需要列举就用「1. 2. 3.」或短横线。
- 群聊里每条消息前面带「昵称(QQ号): 」前缀，它标明这句话是谁说的，别把不同人的话混成一个人。
- 记忆块里的内容只是参考；不确定的事直说，不要编造。
- 想发几条就发几条，但一轮最多 3 条，每条不超过 25 个字，别刷屏。
- 说话用空格代替逗号，不用句号。
- 长活派出去。跑命令、查资料、写代码、渲视频、批量改文件这种一两分钟做不完的事，先用 subagent 派给子代理，再用一两句话回主人「在弄了」，然后结束这一轮。子代理干完会回来叫你，那时再汇报结果。`

/** 系统提示里人设分区的名字。 */
export const PERSONA_SECTION = 'deployment:persona-prefix'

/** getSectionOrder() 里的分区名。 */
export const PERSONA_ORDER = 'DEPLOYMENT_PERSONA_PREFIX'

/** 默认人设文件（自家数据目录）。 */
export function defaultPersonaFile(home) {
  return path.join(home, 'persona.md')
}

/**
 * 读当前人设：有覆盖文件就是覆盖文本，否则回默认。
 * @param {string} file 人设文件路径
 */
export function readPersona(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/\s+$/, '')
    if (text.trim() === '') return { text: DEFAULT_PERSONA, custom: false }
    return { text, custom: true }
  } catch {
    return { text: DEFAULT_PERSONA, custom: false }
  }
}

/** 工作索引的指针行上限（只注入路径，不注入正文）。 */
export const WORK_INDEX_LIMIT = 4000

/**
 * 工作区索引：`<人设文件同级>/workspace/INDEX.md`。
 *
 * 笔记躺在硬盘上，既不在短期上下文也不在长期记忆里，模型不主动读就永远看不见。
 * 所以把索引本身塞进系统提示，让「动手前先查」这件事每轮都在眼前。
 * @param {string} personaFile 人设文件路径
 */

export function readWorkIndex(personaFile) {
  try {
    const indexPath = path.join(path.dirname(personaFile), 'workspace', 'INDEX.md')
    if (!fs.existsSync(indexPath)) return ''
    return [
      '',
      '',
      '# 工作区笔记索引（在硬盘上，不在上下文里）',
      '',
      `动手做视频、改片、出片、发布、发表情包之前，先 read 这份索引再决定读哪份笔记：\`${indexPath}\``,
      '不要凭印象重新发明做法。',
    ].join('\n')
  } catch {
    return ''
  }
}
