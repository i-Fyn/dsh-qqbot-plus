/**
 * 发不出去要让模型当场知道。
 *
 * 以前发送失败只进日志：模型以为自己说过了，顺着那句话往下聊，
 * 对方其实一个字都没收到。这里把失败翻成一句人话，再 inject 回同一个 agent
 * ——不唤醒，下一个 step 就能看到（宿主 injectUserContext 就是这么做）。
 *
 * 同一个 turn、同一类失败只喊一次；第二次起改成一句条数汇总，不刷屏。
 *
 * @module dsh-qqbot-plus/transport/notify
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** 已经喊过的（会话 + 步号 + 类别），只留最近几百条，防止长期运行涨内存。 */
const seen = new Map()
const SEEN_LIMIT = 400

/** 把各种形态的错误拍平成 { code, http, text }。 */
function shapeOf(error) {
  if (error === null || error === undefined) return { code: '', http: 0, text: '' }
  if (typeof error === 'string') return { code: '', http: 0, text: error }
  const code = error.bizCode ?? error.biz_code ?? error.code ?? ''
  const http = Number(error.httpStatus ?? error.status ?? 0) || 0
  const text = String(error.bizMessage ?? error.message ?? error.error ?? '')
  return { code: code === null || code === undefined ? '' : String(code), http, text }
}

/**
 * 分类：返回 { kind, text }。
 * kind 用来去重（限额和审核是两件事，各喊一次），text 是给模型看的一句话。
 */
function classify(error) {
  const { code, http, text } = shapeOf(error)
  const hay = `${code} ${text}`
  const codeTag = code === '' ? '' : `（code=${code}）`

  // 1. 被动回复窗口过期：msg_id 失效，平台直接拒
  if (code === '40034005' || /msg_?id/i.test(hay) && /过期|失效|expire|invalid/i.test(hay)) {
    return { kind: 'expired', text: `被动回复窗口过期了，这条对方没收到${codeTag}` }
  }
  // 2. 限流 / 主动消息额度
  if (code === '22009' || code === '22011' || http === 429 || /限流|过于频繁|频率|rate.?limit|too many/i.test(hay)) {
    return { kind: 'ratelimit', text: `被限流或主动消息额度用完了，这条对方没收到${codeTag}` }
  }
  // 3. 平台判内容不合规
  if (code === '40034' || /审核|audit|不合规|敏感|违规|reject|forbidden/i.test(hay)) {
    return { kind: 'audit', text: `内容被平台拦了，这条对方没收到，换个说法重发${codeTag}` }
  }
  // 4. 超时 / 断网：最危险的一类——不知道到底出去没有
  //    httpStatus === 0 只有 SDK 的 ApiError 会带（表示压根没拿到响应），普通字符串错误不算
  const offline = typeof error === 'object' && error !== null && 'httpStatus' in error && http === 0
  if (offline || /timeout|timed out|network|fetch failed|ECONN|ETIMEDOUT|socket|abort/i.test(hay)) {
    return { kind: 'network', text: `发送超时或网络断了，不确定有没有发出去，别默认对方看到了${codeTag}` }
  }
  // 5. 服务端临时故障
  if (http >= 500) {
    return { kind: 'server', text: `QQ 服务端临时故障（HTTP ${http}），这条没发出去，可以重试${codeTag}` }
  }
  // 6. 其余原样带出来，别吞掉细节
  const detail = text === '' ? String(error ?? '原因不明') : text
  return { kind: 'unknown', text: `发送失败：${detail.slice(0, 160)}${codeTag}` }
}

/** 给模型看的一句话（导出给工具回执复用）。 */
export function classifySendError(error) {
  return classify(error).text
}

/** 同类失败的类名（去重用）。 */
export function classifySendErrorKind(error) {
  return classify(error).kind
}

function prune() {
  if (seen.size <= SEEN_LIMIT) return
  const drop = seen.size - SEEN_LIMIT
  let i = 0
  for (const key of seen.keys()) {
    seen.delete(key)
    if (++i >= drop) break
  }
}

/** 往 agent 手里塞一条「这是系统事件、不是用户说的」消息。 */
function deliver(agent, text) {
  try {
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'qqbot-send-failure' },
    })
    if (typeof agent.inject === 'function') {
      agent.inject(message)
      return true
    }
    if (typeof agent.followup === 'function') {
      agent.followup(message)
      return true
    }
    return false
  }
  catch {
    return false
  }
}

/**
 * 把一条人话塞给这个会话的 agent。
 * @returns 是否真的投进去了（没 agent / 没 inject 就是 false）
 */
export function notifyAgent(record, text, dedupKey = 'send') {
  const agent = record?.pendingAgent ?? record?.agent
  if (agent === null || agent === undefined) return false
  if (typeof agent.inject !== 'function' && typeof agent.followup !== 'function') return false
  const seq = agent.session?.seq ?? '-'
  const base = `${record.sessionKey ?? record.sessionId ?? agent.id}#${seq}#${dedupKey}`
  const prev = seen.get(base)
  if (prev !== undefined) {
    prev.count += 1
    if (prev.count === 2) {
      // 同类第一次已经喊过，第二次只补一句条数，避免每块都刷一遍
      deliver(agent, `（这一类发送失败这一轮又出现一次，累计 ${prev.count} 次；上面说的那几条对方都没收到）`)
    }
    return true
  }
  seen.set(base, { count: 1, at: Date.now() })
  prune()
  return deliver(agent, text)
}

/**
 * 发送失败的统一出口：分类 → 组织一句话 → 注入。
 * @param context.kind 'text' | 'file' | 'notice'
 * @param context.sent / context.total 分块发送时已发出的块数
 * @param context.name 文件名之类，给模型认东西用
 */
export function notifySendFailure(record, error, context = {}) {
  const { kind: failKind, text } = classify(error)
  const what = context.kind === 'file' ? '文件' : context.kind === 'notice' ? '提示' : '这条消息'
  const parts = [`⚠️ 刚${what}没发到 QQ：${text}。`]
  if (Number.isFinite(context.total) && context.total > 0) {
    const sent = Number(context.sent ?? 0)
    parts.push(`分 ${context.total} 块发，第 ${sent + 1} 块起没出去${sent > 0 ? '（前面几块已经发出去了）' : ''}。`)
  }
  if (typeof context.name === 'string' && context.name !== '') parts.push(`（${context.name}）`)
  const dedup = `${context.kind ?? 'text'}:${failKind}:${context.dedup ?? ''}`
  return notifyAgent(record, parts.join(''), dedup)
}
