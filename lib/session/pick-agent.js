/**
 * 挑会话：把一条话投给哪个 agent。
 *
 * 闹钟叫醒会话时用它挑人。
 *
 * @module dsh-qqbot-plus/session/pick-agent
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STATE_DIR = join(homedir(), '.dsh', 'dsh-qqbot-plus')

/**
 * 找「该被叫醒的那个会话」。
 *
 * 顺序：上一条 QQ 消息所在的会话（runtime.json + model-prefs.json 反查）→ 当前 initiator
 * → 列表里最后一个是 idle 的。之前直接取 idle 列表末尾，会叫醒群聊或别的旧会话，
 * 那边没有通道绑定，醒来也说不出话（2026-11-17 早上那次就是这么丢的）。
 */
export async function pickAgent (agents) {
  try {
    // 先找他私聊那条：叫醒的话该落在私聊里，不能因为上一条群消息而叫醒群会话。
    const owner = ownerSession()
    if (owner) {
      const a = typeof agents.get === 'function' ? agents.get(owner) : null
      if (a) return a
    }
    const byPeer = lastInboundSession()
    if (byPeer) {
      const a = typeof agents.get === 'function' ? agents.get(byPeer) : null
      if (a) return a
    }
    const direct = typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : null
    const sid = direct?.session?.id
    if (sid) {
      const a = typeof agents.get === 'function' ? agents.get(sid) : null
      if (a) return a
    }
    const raw = typeof agents.list === 'function' ? agents.list() : []
    // 只认真实通道会话（session- 前缀）；子代理是裸 UUID，叫醒它们等于把话说给空气。
    const list = Array.isArray(raw)
      ? raw.filter((a) => typeof a?.session?.id === 'string' && a.session.id.startsWith('session-'))
      : []
    if (list.length === 0) return null
    const idle = list.filter((a) => a?.status === 'idle')
    return idle[idle.length - 1] ?? list[list.length - 1] ?? null
  } catch {
    return null
  }
}

/** 从 runtime.json 的 lastInbound 反查 model-prefs.json，拿到那个 peer 的会话 id。 */
function lastInboundSession () {
  try {
    const runtimeFile = join(STATE_DIR, 'runtime.json')
    const prefsFile = join(STATE_DIR, 'model-prefs.json')
    if (!existsSync(runtimeFile) || !existsSync(prefsFile)) return ''
    const runtime = JSON.parse(readFileSync(runtimeFile, 'utf8'))
    // lastInbound 是「谁刚发来一条」；宿主刚起来时它还是 null，
    // 这时候用 lastTarget（刚发出去那条的目标）兜住——同一扇门。
    const inbound = runtime?.lastInbound
    let peer = ''
    if (inbound && inbound.scope && inbound.peerId) peer = `:${inbound.scope}:${inbound.peerId}`
    else {
      const target = runtime?.lastTarget
      if (target && target.scope && target.targetId) peer = `:${target.scope}:${target.targetId}`
    }
    if (peer === '') return ''
    const suffix = peer
    const prefs = JSON.parse(readFileSync(prefsFile, 'utf8'))
    const map = prefs?.sessionIds
    if (!map || typeof map !== 'object') return ''
    for (const [key, sid] of Object.entries(map)) {
      if (key.endsWith(suffix) && typeof sid === 'string' && sid.startsWith('session-')) return sid
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * 主人的私聊会话 id。
 *
 * 叫醒这件事只能落在他跟你的私聊里：叫醒群会话，那条会话的出入口就是群，
 * 醒来一开口就在群里说话了（2026-11-19 傍晚就是这么想在群里聊的）。
 * 顺序：最近一条私聊（runtime.lastInbound / lastTarget 是 c2c 就用它）→ prefs 里唯一的 c2c。
 */
function ownerSession () {
  try {
    const prefsFile = join(STATE_DIR, 'model-prefs.json')
    if (!existsSync(prefsFile)) return ''
    const map = JSON.parse(readFileSync(prefsFile, 'utf8'))?.sessionIds
    if (!map || typeof map !== 'object') return ''
    const rows = Object.entries(map)
      .filter(([key, sid]) => key.includes(':c2c:') && typeof sid === 'string' && sid.startsWith('session-'))
    if (rows.length === 0) return ''
    let peer = ''
    try {
      const runtime = JSON.parse(readFileSync(join(STATE_DIR, 'runtime.json'), 'utf8'))
      const inbound = runtime?.lastInbound
      const target = runtime?.lastTarget
      if (inbound && inbound.scope === 'c2c' && typeof inbound.peerId === 'string') peer = inbound.peerId
      else if (target && target.scope === 'c2c' && typeof target.targetId === 'string') peer = target.targetId
    } catch { /* 没 runtime 就按最后一个 */ }
    if (peer !== '') {
      const hit = rows.find(([key]) => key.endsWith(`:c2c:${peer}`))
      if (hit) return hit[1]
    }
    return rows[rows.length - 1][1]
  } catch {
    return ''
  }
}

