// 主动找人的定时器。
//
// 原版走 host.pushEvent（一条「想找他说句话」的事件，再由宿主总线投给 agent）。
// dsh 这边没有那条总线，就照 dsh-day / dsh-map 那套自己投：
//   setInterval 每分钟 → shouldReachOut() 过闸 → pickReachTarget(true) 挑到人
//   → 找会话 → agent.followup 投一条念头 → 投不出去就存 missed，下一轮由注入段带出来。
//
// 分寸都在 life.js 里（half 夜不找、刚说过话不找、间隔 55/180 分钟、概率 0.4/0.25），
// 这里只负责「到点了就真去说一次」，不重复判一遍。

import { pickAgent } from '../session/pick-agent.js'

const MAX_MISSED = 5

export function mountReachOut (ctx, { life, logger, intervalSec = 60, warmupSec = 30 } = {}) {
  const missed = []

  function silentText (hours) {
    if (!Number.isFinite(hours)) return '很久没说过话'
    const n = Math.max(0, Math.round(hours))
    if (n >= 48) return `静了 ${Math.round(n / 24)} 天`
    return `静了 ${n} 小时`
  }

  function compose (target) {
    const tail = target?.lastSaid
      ? `他上一句是「${target.lastSaid}」，接得上就接着聊。`
      : ''
    return `你有点想找 ${target.qq} 说句话（交情 ${Math.round(target.score)} 分，${silentText(target.silentHours)}）。`
      + tail
      + '想说就说，不想说就算了。'
  }

  async function deliver (text) {
    // 和闹钟叫醒同一套：先找主人私聊那条会话，别把念头投进群里。
    let agent = null
    try {
      agent = await pickAgent(ctx.get?.('agents'))
    } catch (error) {
      logger?.warn?.(`humanlike: 挑会话失败 ${String(error)}`)
    }
    if (!agent) return false
    const message = {
      id: `humanlike-reach-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'humanlike', type: 'reach' },
    }
    try {
      if (typeof agent.followup === 'function') {
        Promise.resolve(agent.followup(message)).catch((error) => {
          logger?.warn?.(`humanlike: 主动找人投递失败 ${String(error)}`)
          push(text)
        })
        return true
      }
      const sessionId = agent?.session?.id
      const sc = ctx.get?.('sessionController')
      if (sessionId && typeof sc?.prompt === 'function') {
        Promise.resolve(sc.prompt({ sessionId, content: message.content, mode: 'queue' }, { source: 'humanlike' })).catch((error) => {
          logger?.warn?.(`humanlike: 主动找人排队投递失败 ${String(error)}`)
          push(text)
        })
        return true
      }
    } catch (error) {
      logger?.warn?.(`humanlike: 主动找人投递异常 ${String(error)}`)
    }
    return false
  }

  function push (text) {
    if (missed.includes(text)) return
    missed.push(text)
    while (missed.length > MAX_MISSED) missed.shift()
  }

  async function tick () {
    try {
      if (!life?.shouldReachOut?.()) return
      const target = life.pickReachTarget?.(true)
      if (!target) return
      const text = compose(target)
      if (!(await deliver(text))) push(text)
      // 投出去就算「找过他了」：不记这一笔，一分钟一跳的闸门下一轮还会放行，
      // 隔够分钟数就再投一遍，两分钟里能连着起两遍念。
      else life.noteReached?.(target)
    } catch (error) {
      logger?.warn?.(`humanlike: 主动找人这一轮出错 ${String(error)}`)
    }
  }

  let timer = null
  try {
    const first = setTimeout(() => { void tick() }, Math.max(5, warmupSec) * 1000)
    first.unref?.()
    timer = setInterval(() => { void tick() }, Math.max(15, intervalSec) * 1000)
    timer.unref?.()
  } catch (error) {
    logger?.warn?.(`humanlike: 主动找人定时器没起起来 ${String(error)}`)
  }

  try {
    ctx.effect?.(() => () => {
      if (timer) clearInterval(timer)
      timer = null
    })
  } catch {
    // 没有 effect 就留着定时器，进程退了自然没
  }

  return {
    tick,
    // 只读：注入段每轮都可能被渲两次，读一次就清空会只送到一半（见 dsh-day 那套）。
    missedText: () => missed.map((t) => `- ${t}`).join('\n'),
    clearMissed: () => { missed.length = 0 },
    stats: () => ({ missed: missed.length }),
  }
}
