// 设置面板用的本地 HTTP 接口。
//
// 前缀 /qqbot/im-qqbot/humanlike，跟 qqbot 自己的接口命名空间对齐；前端（client.js）只认这一个常量。
// 数据全部走 settings.js，这个文件只管 HTTP 那一层：读、改、重置。
//
// 只服务回环地址（桌面版的 fetch 走 IPC 桥，合成请求可能没有 remoteAddress，也算回环）。
// 改完 settings.onChange 会把工具实例与前缀段一起重建，所以这里不需要「重启生效」这种话。

import { SETTINGS_GROUPS } from './settings.js';
import { readJsonBody as readJsonBodyShared } from '../shared/http-body.js';

export const PREFIX = '/qqbot/im-qqbot/humanlike';
const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 只认本机。空 remoteAddress 也算（IPC 桥合成的请求没有这一项）。 */
export function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? '';
  if (address === '') return true;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

async function readJsonBody(req) {
  try {
    return await readJsonBodyShared(req, { maxBytes: MAX_BODY, allowEmpty: true });
  } catch (err) {
    if (err?.code === 'body-too-large') throw new HttpError(413, '请求体过大');
    if (err?.code === 'body-invalid-json') throw new HttpError(400, '请求体不是合法 JSON');
    throw err;
  }
}

/** 面板要的一整份：分组结构（标题、范围、单位）+ 当前值。 */
function view(settings) {
  const values = settings.get();
  return {
    ok: true,
    version: 1,
    file: settings.file,
    groups: SETTINGS_GROUPS.map((group) => ({
      id: group.id,
      title: group.title,
      description: group.description ?? '',
      keys: group.keys.map((item) => ({
        key: item.key,
        type: item.type,
        title: item.title,
        description: item.description ?? '',
        min: item.min,
        max: item.max,
        suffix: item.suffix ?? '',
        value: values[group.id]?.[item.key],
      })),
    })),
  };
}

/** 把前端交上来的「分组 → 键值」拆成一次一次 update，一次失败就整体报错。 */
function applyPatch(settings, groupId, patch) {
  const result = settings.update(groupId, patch);
  if (!result.ok) throw new HttpError(400, result.error ?? '没改成功');
  return result;
}

export function mountHumanlikeApi(ctx, { settings, rules, logger = console } = {}) {
  if (!settings) throw new Error('mountHumanlikeApi 缺 settings');

  const handle = async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        send(res, 204, {});
        return;
      }
      if (!isLoopback(req)) {
        send(res, 403, { ok: false, error: '只服务本机' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = url.pathname.slice(PREFIX.length) || '/';

      if (req.method === 'GET' && (route === '/' || route === '/settings')) {
        send(res, 200, view(settings));
        return;
      }

      if (req.method === 'POST' && route === '/settings') {
        const body = await readJsonBody(req);
        const groupId = typeof body.group === 'string' ? body.group : '';
        const patch = body.patch;
        if (groupId === '' || patch === null || typeof patch !== 'object') {
          throw new HttpError(400, '要给 group 和 patch');
        }
        applyPatch(settings, groupId, patch);
        send(res, 200, view(settings));
        return;
      }

      if (route === '/rules') {
        if (!rules) throw new HttpError(404, '这个版本没有规则存储');
        if (req.method === 'GET') {
          const read = rules.read();
          send(res, 200, { ok: true, ...read, defaults: rules.defaults, file: rules.file });
          return;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          send(res, 200, { ok: true, ...rules.save(body?.text) });
          return;
        }
        if (req.method === 'DELETE') {
          send(res, 200, { ok: true, ...rules.reset() });
          return;
        }
        throw new HttpError(405, '只支持 GET / POST / DELETE');
      }

      if (req.method === 'POST' && route === '/reset') {
        const body = await readJsonBody(req);
        const groupId = typeof body.group === 'string' && body.group !== '' ? body.group : undefined;
        const result = settings.reset(groupId);
        if (!result.ok) throw new HttpError(500, '重置没写进去');
        send(res, 200, view(settings));
        return;
      }

      send(res, 404, { ok: false, error: '没有这个接口' });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) logger?.warn?.(`humanlike: 设置接口出错 ${String(error?.stack ?? error)}`);
      send(res, status, { ok: false, error: String(error?.message ?? error) });
    }
  };

  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer;
    if (server === undefined || typeof server.register !== 'function') return;
    scoped.effect(
      () => server.register({ kind: 'prefix', path: PREFIX, handler: handle }),
      'dsh-humanlike: settings api',
    );
    logger?.info?.(`humanlike: 设置接口已挂载 ${PREFIX}`);
  });
}
