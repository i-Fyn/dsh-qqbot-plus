// 读 HTTP 请求体并解析成 JSON —— qqbot 自己的接口和人味设置接口共用这一份。
//
// 以前有两份几乎一样的实现（lib/setup/bind-routes.js 与人味 settings-api.js），
// 上限与空体处理略不同，排查时要看两个地方。现在都走这里，行为由参数决定：
//   maxBytes  请求体上限（字节）
//   allowEmpty 空体返回 {}（人味接口如此）还是抛错（凭据提交接口如此）
//
// 抛出的错误带 `code`：'body-too-large' | 'body-empty' | 'body-invalid-json'，
// 调用方自己决定映射成什么 HTTP 状态。

export class BodyError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'BodyError'
    this.code = code
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {{ maxBytes?: number, allowEmpty?: boolean }} [options]
 * @returns {Promise<any>}
 */
export async function readJsonBody (req, options = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024
  const allowEmpty = options.allowEmpty ?? false
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new BodyError('body-too-large', '请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) {
    if (allowEmpty) return {}
    throw new BodyError('body-empty', '请求体是空的')
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BodyError('body-invalid-json', '请求体不是合法 JSON')
  }
}
