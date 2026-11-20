/**
 * 拦住「QQ 机器人用 plugin_manager 动自己」这一类调用。
 *
 * 为什么要有它：QQ 的 agent 就跑在本插件自己的 fiber 里，它对自己调
 * `plugin_manager {action:"set_plugin", target:"include:im-qqbot", enabled:true}`
 * 重载时，插件被卸载而这次工具调用永远不返回——整个回合卡死，之后的消息
 * 只能堆进收件箱（2026-11-15 连卡两次，都是这一条调用）。
 *
 * 只拦「瞄准自己」的写操作：管理别的插件照旧（list 之类也不动）。
 * 用 tools.guard 而不是 tools/pre-execute：guard 是同步、单调的，
 * 后注册的监听者无法把拒绝翻回允许。
 */
import { readFileSync } from 'node:fs'

/** 本插件的入口 id / bundle 包名，两个都算「自己」。 */
const SELF_TARGETS = new Set(['im-qqbot'])
try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (typeof pkg?.name === 'string' && pkg.name !== '') SELF_TARGETS.add(pkg.name)
} catch {
  // 读不到 package.json 就只按入口 id 判，不影响拦截
  SELF_TARGETS.add('dsh-qqbot-plus')
}

/** 会改变插件装载状态的动作（list_* 是只读，不管）。 */
const MUTATING_ACTIONS = new Set(['set_plugin', 'set_bundle', 'install_bundle', 'remove_bundle'])

/**
 * target 是不是本插件。
 * 形态有 `im-qqbot`、`include:im-qqbot`、`dsh-qqbot-plus`、`dsh-qqbot-plus@1.2.3`、
 * 以及 install_bundle 的 `file:/x/y/dsh-qqbot-plus`，所以按包名段判。
 */
export function targetsSelf(raw) {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text === '') return false
  const bare = text.replace(/^(include|exclude):/, '')
  for (const name of SELF_TARGETS) {
    if (bare === name) return true
    if (bare.startsWith(`${name}@`)) return true
    if (bare.endsWith(`/${name}`)) return true
  }
  return false
}

/**
 * 注册守卫。
 * @param ctx - 插件 ctx（用它挂 effect，插件卸载时守卫一起撤）
 * @param manager - SessionManager，用来判断这次调用是不是 QQ 会话发起的
 * @returns 是否注册成功
 */
export function installSelfGuard(ctx, manager, logger) {
  let tools
  try {
    tools = ctx.get('tools')
  } catch {
    tools = undefined
  }
  if (typeof tools?.guard !== 'function') {
    logger.warn?.('im-qqbot: tools.guard 不可用，plugin_manager 自毁未拦')
    return false
  }
  ctx.effect(() => tools.guard((exec) => {
    if (exec?.name !== 'plugin_manager') return undefined
    // 只拦 QQ 会话：桌面/其它 agent 想重载本插件仍然允许
    if (manager.findByAgent(exec.agent) === undefined) return undefined
    const args = exec.arguments ?? {}
    if (!MUTATING_ACTIONS.has(args.action)) return undefined
    if (!targetsSelf(args.target)) return undefined
    logger.warn?.(`im-qqbot: 拦下 plugin_manager ${args.action} ${args.target}（QQ 会话不能动本插件自己）`)
    return 'plugin_manager 不能动 dsh-qqbot-plus 自己（im-qqbot）：这条回合就跑在这个插件里，重载/卸载它会把当前回合卡死。管理别的插件没问题；本插件的代码改动请让主人重启 DSH 再生效。'
  }), 'qqbot self guard')
  logger.info('im-qqbot: 已拦截「plugin_manager 动自己」')
  return true
}
