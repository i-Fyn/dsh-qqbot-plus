/**
 * 系统提示段的 order，全插件唯一来源。
 *
 * 这些数字以前散在五个文件里，撞了不会报错、只会静默丢一段（later wins / 同 order 覆盖）。
 * 改顺序只改这里。
 *
 * 顺带记一下邻居：dsh-map 的前缀段是 71，它不在本插件里。
 */
export const ORDER = {
  // QQ 会话的稳定人设与范围说明
  persona: 20,
  portrait: 4800,
  // QQ 里怎么回话（硬规矩）
  qqRules: 4950,
  // 人味
  humanlikeEnv: 70,
  humanlikeRules: 73, // 72 让给记忆索引
  humanlikeMissed: 9994,
  // 记忆
  memoryIndex: 72,
  memoryRecall: 9990,
  // 表情包（2026-11-21 从 dsh-fishmeme 并进来，沿用原来的 74）
  memeRules: 74,
  // 别人家的，别占
  mapPrefix: 71,
}
