/**
 * 表情包的设置面板接口（宿主侧）。
 *
 * 面板在浏览器里，读不到磁盘，所以图库的「读 / 改 / 删 / 换目录」都走这两条路由：
 *   GET  MEMES_PATH        列图库（含未登记、失效、目录）
 *   POST MEMES_PATH        { op: 'update' | 'remove' | 'dirs' | 'prune', ... }
 *   GET  MEMES_THUMB_PATH  缩略图字节（?path=绝对路径，只认图库目录里的文件）
 *
 * 数据操作全在 memeStore 里，这里只做 HTTP 的壳：校验来源、解析 body、映射状态码。
 */
import { MEMES_PATH, MEMES_THUMB_PATH } from '../shared/bind-protocol.js'
import { BodyError, readJsonBody } from '../shared/http-body.js'

/** 同源校验（最小 CSRF 防护：带 Origin 的必须与 Host 同源）。 */
function trusted (req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function sendJson (res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function urlOf (req) {
  try {
    return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  } catch {
    return new URL('/', 'http://localhost')
  }
}

async function handleMemes (req, res, store, logger) {
  if (!trusted(req)) {
    sendJson(res, 403, { ok: false, error: '来源不可信' })
    return
  }
  const method = req.method ?? 'GET'
  try {
    if (method === 'GET') {
      sendJson(res, 200, { ok: true, ...(await store.list()) })
      return
    }
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
      return
    }
    const body = await readJsonBody(req, { allowEmpty: true })
    const op = String(body.op ?? '').trim()
    if (op === 'update') {
      const item = store.update(body.path, { caption: body.caption, tags: body.tags })
      sendJson(res, 200, { ok: true, item })
      return
    }
    if (op === 'remove') {
      sendJson(res, 200, { ok: true, ...store.remove(body.path) })
      return
    }
    if (op === 'dirs') {
      const result = await store.setDirs(body.dirs)
      sendJson(res, 200, { ok: true, ...result })
      return
    }
    if (op === 'prune') {
      sendJson(res, 200, { ok: true, ...store.prune() })
      return
    }
    sendJson(res, 400, { ok: false, error: `不认识的 op：${op || '(空)'}` })
  } catch (error) {
    if (error instanceof BodyError) {
      sendJson(res, 400, { ok: false, error: error.message })
      return
    }
    logger?.warn?.(`im-qqbot: 表情包接口出错 ${error instanceof Error ? error.message : String(error)}`)
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

function handleThumb (req, res, store) {
  if (!trusted(req)) {
    res.writeHead(403)
    res.end()
    return
  }
  if ((req.method ?? 'GET') !== 'GET') {
    res.writeHead(405)
    res.end()
    return
  }
  const file = urlOf(req).searchParams.get('path') ?? ''
  const found = store.read(file)
  if (found === null) {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': found.mime,
    'content-length': String(found.buffer.length),
    // 面板会频繁重取同一张：允许短缓存，改名/换图时靠 mtime 变
    'cache-control': 'private, max-age=60',
  })
  res.end(found.buffer)
}

/**
 * @param {{ register: (route: { kind: string, path: string, handler: Function }) => () => void }} webServer
 * @param {object} store memeStore
 * @param {Console} [logger]
 * @returns {() => void} 注销函数
 */
export function registerMemeRoutes (webServer, store, logger = console) {
  const disposers = [
    webServer.register({
      kind: 'exact',
      path: MEMES_PATH,
      handler: (req, res) => {
        void handleMemes(req, res, store, logger)
      },
    }),
    webServer.register({
      kind: 'exact',
      path: MEMES_THUMB_PATH,
      handler: (req, res) => {
        handleThumb(req, res, store)
      },
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
