import { persistCredentialsToProfile, removeCredentialsFromProfile, updateProfileConfig, } from "./persist.js";
import { getProfileDir } from "../shared/index.js";
import { readJsonBody as readJsonBodyShared } from "../shared/http-body.js";
import { AccessControlSchema } from "../config.js";
import { BIND_CATALOG_PATH, BIND_CONFIG_PATH, BIND_MANUAL_PATH, BIND_PERSONA_PATH, BIND_PICK_DIR_PATH, BIND_PORTRAIT_PATH, BIND_REFRESH_PATH, BIND_RULES_PATH, BIND_STATE_PATH, BIND_UNBIND_PATH, } from "../shared/bind-protocol.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { DEFAULT_PERSONA, readPersona } from '../identity/persona.js';
import { readPortrait } from '../identity/portrait.js';
import { expandHome } from '../identity/runtime.js';
import { defaultPersonaFile, defaultPortraitFile } from '../identity/paths.js';
import { QQ_RULES_DEFAULT, RULES_FILE, qqRulesText } from '../rules.js';
// 协议单一来源：shared/bind-protocol.ts（类型 + 路径常量，客户端共用）
export { BIND_CATALOG_PATH, BIND_CONFIG_PATH, BIND_MANUAL_PATH, BIND_PERSONA_PATH, BIND_PICK_DIR_PATH, BIND_PORTRAIT_PATH, BIND_REFRESH_PATH, BIND_RULES_PATH, BIND_STATE_PATH, BIND_UNBIND_PATH };
/** 可经 UI 编辑的配置键（白名单：只收用户必要的字段，其余走 patch/env） */
const EDITABLE_CONFIG_KEYS = new Set([
    'requireMention', 'allowSilence', 'streaming', 'midTurnSteer', 'resumeOnBoot', 'debug',
    'burstWindowMs', 'maxBurstMs', 'maxBurstCount',
    'provider', 'model', 'preset',
    'access',
    'sharedSession',
]);
/** 白名单键的子 Schema（服务端校验：客户端校验仅为体验，安全边界在宿主） */
const EDITABLE_CONFIG_SCHEMAS = {
    requireMention: (v) => booleanSchema(v, 'requireMention'),
    allowSilence: (v) => booleanSchema(v, 'allowSilence'),
    streaming: (v) => booleanSchema(v, 'streaming'),
    midTurnSteer: (v) => booleanSchema(v, 'midTurnSteer'),
    resumeOnBoot: (v) => booleanSchema(v, 'resumeOnBoot'),
    sharedSession: (v) => booleanSchema(v, 'sharedSession'),
    debug: (v) => booleanSchema(v, 'debug'),
    burstWindowMs: (v) => numberSchema(v, 'burstWindowMs', 0, 30000),
    maxBurstMs: (v) => numberSchema(v, 'maxBurstMs', 1000, 180000),
    maxBurstCount: (v) => numberSchema(v, 'maxBurstCount', 1, 50),
    provider: stringSchema('provider'),
    model: stringSchema('model'),
    preset: stringSchema('preset'),
    access: (v) => AccessControlSchema(v),
};
function booleanSchema(value, name) {
    if (typeof value !== 'boolean')
        throw new TypeError(`${name} 必须是布尔值`);
    return value;
}
function stringSchema(name) {
    return (value) => {
        if (typeof value !== 'string')
            throw new TypeError(`${name} 必须是字符串`);
        if (value.length > 20000)
            throw new TypeError(`${name} 过长`);
        return value;
    };
}
function numberSchema(value, name, min, max) {
    const num = Number(value);
    if (typeof value === 'boolean' || !Number.isFinite(num))
        throw new TypeError(`${name} 必须是数字`);
    if (num < min || num > max)
        throw new TypeError(`${name} 必须在 ${min}~${max} 之间`);
    return num;
}
/** manual 请求体大小上限（appId + appSecret 远小于此值） */
const MAX_MANUAL_BODY_BYTES = 4096;
/**
 * config 请求体大小上限：对齐 Schema 的业务边界——白名单字符串字段单个
 * 允许 20000 字符（全中文 UTF-8 约 60KB），allowlist 不设条目上限（openid
 * 短标识，512KB 约容纳 1.4 万条）。上限只是反滥用闸门，语义校验在 Schema。
 */
const MAX_CONFIG_BODY_BYTES = 512 * 1024;
/** rules 请求体大小上限：正文上限 4000 字（全中文 UTF-8 约 12KB），64KB 足够且留余量 */
const MAX_RULES_BODY_BYTES = 64 * 1024;
/** 规则正文长度上限（按可见字符计，不是 UTF-16 码元） */
const MAX_RULES_CHARS = 4000;
/**
 * 注册绑定路由（状态查询 / 刷新二维码 / 手动凭据）。
 *
 * @param webServer - ctx.webServer
 * @param service - 绑定状态机；已绑定 fiber 传 null（无扫码流程）
 * @param logger - 日志
 * @param options - 行为注入（bound 态回显、manual 处理）
 * @returns 注销函数（与插件 fiber 生命周期绑定）
 */
export function registerBindRoutes(webServer, service, logger, options = {}) {
    const defaultManual = (credentials) => {
        const persisted = persistCredentialsToProfile(credentials, getProfileDir() ?? undefined, logger);
        return persisted ? { persisted: true } : { persisted: false, error: '无法定位 profile 目录或写入失败，请改用环境变量配置' };
    };
    const handleManualSubmit = options.onManualCredentials ?? defaultManual;
    const disposers = [
        webServer.register({
            kind: 'exact',
            path: BIND_STATE_PATH,
            handler: (req, res) => { handleState(req, res, service, options); },
        }),
        webServer.register({
            kind: 'exact',
            path: BIND_REFRESH_PATH,
            handler: (req, res) => { handleRefresh(req, res, service); },
        }),
        webServer.register({
            kind: 'exact',
            path: BIND_MANUAL_PATH,
            handler: (req, res) => handleManual(req, res, handleManualSubmit),
        }),
        webServer.register({
            kind: 'exact',
            path: BIND_UNBIND_PATH,
            handler: (req, res) => handleUnbind(req, res, options),
        }),
        webServer.register({
            kind: 'exact',
            path: BIND_CONFIG_PATH,
            handler: (req, res) => handleConfig(req, res, options),
        }),
        webServer.register({
            kind: 'exact',
            path: BIND_CATALOG_PATH,
            handler: (req, res) => handleCatalog(req, res, options),
        }),
        webServer.register({
            kind: 'exact',
            path: BIND_PERSONA_PATH,
            handler: (req, res) => handlePersona(req, res, options),
        }),
        webServer.register({
            kind: 'exact',
            path: BIND_PORTRAIT_PATH,
            handler: (req, res) => handlePortrait(req, res, options),
        }),
        webServer.register({
            kind: 'exact',
            path: BIND_RULES_PATH,
            handler: (req, res) => handleRules(req, res),
        }),
        webServer.register({
            kind: 'exact',
            path: BIND_PICK_DIR_PATH,
            handler: (req, res) => handlePickDir(req, res),
        }),
    ];
    logger.info(`im-qqbot: 端内绑定页已就绪: ${BIND_STATE_PATH}`);
    return () => { for (const dispose of disposers)
        dispose(); };
}
/**
 * 请求来源校验（最小 CSRF 防护）。
 *
 * 带 Origin 的请求必须与 Host 同源；同源 fetch 与 Desktop IPC 桥
 * （后者会删除 origin 头）均放行。本路由数据不敏感且动作无害，
 * 该级别的防护足够。
 */
function trusted(req) {
    const origin = req.headers.origin;
    if (origin === undefined)
        return true;
    try {
        return new URL(origin).host === req.headers.host;
    }
    catch {
        return false;
    }
}
function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(payload);
}
function handleState(req, res, service, options) {
    if (!trusted(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }
    // 已绑定优先（appSecret 不回传，appId 非机密可回显）
    const boundAppId = options.boundAppId?.() ?? null;
    if (boundAppId !== null) {
        sendJson(res, 200, { phase: 'bound', appId: boundAppId });
        return;
    }
    sendJson(res, 200, service === null ? { phase: 'starting' } : service.wireState());
}
function handleRefresh(req, res, service) {
    if (!trusted(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }
    // 丢弃可能的请求体（refresh 无参数）
    req.resume();
    service?.refresh();
    // 新二维码异步生成，统一由状态轮询收敛
    sendJson(res, 200, { phase: 'starting' });
}
/** 读取并解析 JSON 请求体（带大小上限）——实现收在 shared/http-body.js，人味接口共用同一份 */
async function readJsonBody(req, maxBytes = MAX_MANUAL_BODY_BYTES) {
    return readJsonBodyShared(req, { maxBytes });
}
/** 校验手动提交的凭据形态（不打印内容） */
function parseCredentials(body) {
    if (typeof body !== 'object' || body === null)
        return null;
    const record = body;
    const appId = typeof record.appId === 'string' ? record.appId.trim() : '';
    const appSecret = typeof record.appSecret === 'string' ? record.appSecret.trim() : '';
    if (appId.length === 0 || appSecret.length === 0)
        return null;
    if (appId.length > 128 || appSecret.length > 256)
        return null;
    return { appId, appSecret };
}
async function handleManual(req, res, submit) {
    if (!trusted(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }
    let body;
    try {
        body = await readJsonBody(req);
    }
    catch (err) {
        sendJson(res, 400, { ok: false, error: `invalid request body: ${err instanceof Error ? err.message : String(err)}` });
        return;
    }
    const credentials = parseCredentials(body);
    if (credentials === null) {
        sendJson(res, 400, { ok: false, error: 'appId 与 appSecret 不能为空' });
        return;
    }
    const result = submit(credentials);
    if (!result.persisted) {
        sendJson(res, 500, { ok: false, error: result.error ?? '保存失败' });
        return;
    }
    // 写入 profile patch 触发 HMR 重载，新 fiber 以新凭据启动网关
    sendJson(res, 200, { ok: true, message: '凭据已保存，插件将自动重载' });
}
/**
 * 模型 / 预设目录：设置面板的 Provider、Model、Preset 下拉都从这里取。
 * provider 与模型来自宿主 llm 服务；预设来自 agentPresets 服务。
 * 目录读不到时返回空数组，客户端会退回到纯文本输入。
 */
async function handleCatalog(req, res, options) {
    if (!trusted(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }
    let value;
    try {
        value = (await options.catalog?.()) ?? { providers: [], presets: [] };
    }
    catch (err) {
        value = { providers: [], presets: [], error: err instanceof Error ? err.message : String(err) };
    }
    sendJson(res, 200, value);
}
/** 配置里的记忆 / 人设路径；与 SessionManager 的默认规则保持一致。 */
function memorySettings(config) {
    return config?.memory ?? {};
}
function resolveConfigPath(raw, fallback) {
    const text = expandHome(String(raw ?? '').trim(), homedir());
    return text === '' ? fallback : text;
}
function personaFileOf(config) {
    return resolveConfigPath(memorySettings(config).personaFile, defaultPersonaFile());
}
function portraitFileOf(config) {
    return resolveConfigPath(memorySettings(config).portraitFile, defaultPortraitFile());
}
function writeTextFile(file, text) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
}
function personaView(config) {
    const file = personaFileOf(config);
    const current = readPersona(file);
    return { text: current.text, defaultText: DEFAULT_PERSONA, custom: current.custom === true, file };
}
function portraitView(config) {
    const file = portraitFileOf(config);
    const current = readPortrait(file);
    return { text: current.text, custom: current.custom === true, file };
}
/** 人设：GET 读当前文本，POST 写回共享的 persona.md（默认文本也可恢复）。 */
async function handlePersona(req, res, options) {
    if (!trusted(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }
    const config = options.currentConfig?.() ?? {};
    if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, personaView(config));
        return;
    }
    let body;
    try {
        body = await readJsonBody(req, MAX_CONFIG_BODY_BYTES);
    }
    catch (err) {
        sendJson(res, 400, { ok: false, error: `invalid request body: ${err instanceof Error ? err.message : String(err)}` });
        return;
    }
    const text = typeof body?.text === 'string' ? body.text : '';
    try {
        writeTextFile(personaFileOf(config), text);
    }
    catch (err) {
        sendJson(res, 500, { ok: false, error: `写入人设失败：${err instanceof Error ? err.message : String(err)}` });
        return;
    }
    sendJson(res, 200, { ok: true, ...personaView(config) });
}
/** 画像：与 persona 相同的读写方式，文件在自家数据目录。 */
async function handlePortrait(req, res, options) {
    if (!trusted(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }
    const config = options.currentConfig?.() ?? {};
    if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, portraitView(config));
        return;
    }
    let body;
    try {
        body = await readJsonBody(req, MAX_CONFIG_BODY_BYTES);
    }
    catch (err) {
        sendJson(res, 400, { ok: false, error: `invalid request body: ${err instanceof Error ? err.message : String(err)}` });
        return;
    }
    const text = typeof body?.text === 'string' ? body.text : '';
    try {
        writeTextFile(portraitFileOf(config), text);
    }
    catch (err) {
        sendJson(res, 500, { ok: false, error: `写入画像失败：${err instanceof Error ? err.message : String(err)}` });
        return;
    }
    sendJson(res, 200, { ok: true, ...portraitView(config) });
}
/**
 * 规则视图：与 lib/rules.js 的读取口径完全一致——有 rules.md 且非空就是
 * 自定义，否则是内置默认。custom 用于设置页标题旁的「默认」标记。
 */
function rulesView() {
    let custom = false;
    try {
        custom = readFileSync(RULES_FILE, 'utf8').trim() !== '';
    }
    catch {
        custom = false;
    }
    return { ok: true, text: qqRulesText(), defaultText: QQ_RULES_DEFAULT, custom, file: RULES_FILE };
}
/**
 * 规则（在 QQ 里怎么回话）：GET 读当前文本，POST 写入 rules.md，
 * DELETE 删掉 rules.md 回到内置默认。
 *
 * 写入前先按可见字符数卡 4000 字上限（超了 400，不落盘），空文本等同
 * DELETE——用户把框清空再点保存就是恢复默认，不用再找「恢复默认」按钮。
 */
async function handleRules(req, res) {
    if (!trusted(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, rulesView());
        return;
    }
    if (req.method === 'DELETE') {
        req.resume();
        try {
            rmSync(RULES_FILE, { force: true });
        }
        catch (err) {
            sendJson(res, 500, { ok: false, error: `恢复默认失败：${err instanceof Error ? err.message : String(err)}` });
            return;
        }
        sendJson(res, 200, { message: '已恢复默认规则，下一轮生效', ...rulesView() });
        return;
    }
    let body;
    try {
        body = await readJsonBody(req, MAX_RULES_BODY_BYTES);
    }
    catch (err) {
        sendJson(res, 400, { ok: false, error: `invalid request body: ${err instanceof Error ? err.message : String(err)}` });
        return;
    }
    const text = typeof body?.text === 'string' ? body.text : '';
    // 空文本（含只有空白）视为恢复默认：删文件，读取侧自动落回内置默认。
    if (text.trim() === '') {
        try {
            rmSync(RULES_FILE, { force: true });
        }
        catch (err) {
            sendJson(res, 500, { ok: false, error: `恢复默认失败：${err instanceof Error ? err.message : String(err)}` });
            return;
        }
        sendJson(res, 200, { message: '已恢复默认规则，下一轮生效', ...rulesView() });
        return;
    }
    const length = [...text].length;
    if (length > MAX_RULES_CHARS) {
        sendJson(res, 400, { ok: false, error: `规则太长（${length} 字，上限 ${MAX_RULES_CHARS}）` });
        return;
    }
    try {
        writeTextFile(RULES_FILE, text);
    }
    catch (err) {
        sendJson(res, 500, { ok: false, error: `写入规则失败：${err instanceof Error ? err.message : String(err)}` });
        return;
    }
    sendJson(res, 200, { message: '规则已保存，下一轮生效', ...rulesView() });
}
/** 用系统选择器选一个文件夹（macOS 的 choose folder），取消时返回 path: null。 */
const execFileAsync = promisify(execFile);
async function handlePickDir(req, res) {
    if (!trusted(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }
    req.resume();
    if (process.platform !== 'darwin') {
        sendJson(res, 501, { ok: false, error: '当前只支持 macOS 系统选择器，请手动填写路径' });
        return;
    }
    try {
        const { stdout } = await execFileAsync('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择表情包文件夹")'], { timeout: 120000 });
        const picked = String(stdout ?? '').trim().replace(/\/$/, '');
        sendJson(res, 200, { ok: true, path: picked === '' ? null : picked });
    }
    catch (error) {
        const message = String(error?.stderr ?? error?.message ?? error);
        // 用户点取消 = osascript 非 0；按「没选」处理，不报错。
        if (/User cancelled|User canceled|-128/.test(message)) {
            sendJson(res, 200, { ok: true, path: null });
            return;
        }
        sendJson(res, 500, { ok: false, error: message.slice(0, 300) });
    }
}
/** 解绑：仅已绑定态可执行；移除 profile patch 中的凭据并触发 HMR 重载 */
function handleUnbind(req, res, options) {
    if (!trusted(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }
    req.resume();
    if ((options.boundAppId?.() ?? null) === null) {
        sendJson(res, 409, { ok: false, error: '当前未绑定' });
        return;
    }
    const result = options.onUnbind === undefined
        ? (() => {
            const removed = removeCredentialsFromProfile(getProfileDir() ?? undefined, undefined);
            if (removed) {
                // 清除进程内凭据：扫码绑定成功时会写入 env（供热更新后的下次
                // apply 兜底读取）；不清则 HMR 重载后新 fiber 仍从 env 读到
                // 凭据，解绑不生效（状态一直停留在 bound）
                delete process.env.QQBOT_APPID;
                delete process.env.QQBOT_SECRET;
            }
            return removed
                ? { persisted: true }
                : { persisted: false, error: '无法定位 profile 目录或写入失败，请手动编辑 cordis.patch.yml' };
        })()
        : options.onUnbind();
    if (!result.persisted) {
        sendJson(res, 500, { ok: false, error: result.error ?? '解绑失败' });
        return;
    }
    // 移除后写入触发 HMR 重载，插件回到未绑定态（绑定流程重新可用）
    sendJson(res, 200, { ok: true, message: '已解绑，插件将重载并重新进入绑定流程' });
}
/**
 * 配置读写：
 * - GET：回显当前生效配置（appSecret 剔除，cwd 等只读字段正常返回）
 * - POST：白名单 + 子 Schema 校验 → 最小写入 profile patch → HMR 重载
 */
async function handleConfig(req, res, options) {
    if (!trusted(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }
    if (req.method === 'GET') {
        const current = options.currentConfig?.() ?? {};
        // appSecret 永不回传；其余（含只读 cwd）原样回显
        const { appSecret: _s, ...safe } = current;
        sendJson(res, 200, { config: safe });
        return;
    }
    let body;
    try {
        body = await readJsonBody(req, MAX_CONFIG_BODY_BYTES);
    }
    catch (err) {
        sendJson(res, 400, { ok: false, error: `invalid request body: ${err instanceof Error ? err.message : String(err)}` });
        return;
    }
    if (typeof body !== 'object' || body === null) {
        sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
        return;
    }
    const submitted = body;
    // 白名单与凭据/只读字段拦截
    for (const key of Object.keys(submitted)) {
        if (!EDITABLE_CONFIG_KEYS.has(key)) {
            const reason = key === 'appId' || key === 'appSecret'
                ? '凭据请使用绑定/更换/解绑功能'
                : key === 'cwd'
                    ? 'cwd 为只读字段'
                    : '不支持的字段';
            sendJson(res, 400, { ok: false, error: `${reason}: ${key}` });
            return;
        }
    }
    // 逐键 Schema 校验（非法值拒绝，返回首个错误）
    let validated = {};
    try {
        validated = Object.fromEntries(Object.entries(submitted).map(([key, value]) => {
            const check = EDITABLE_CONFIG_SCHEMAS[key];
            if (check === undefined)
                throw new TypeError(`不支持的字段: ${key}`);
            return [key, check(value)];
        }));
    }
    catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof TypeError ? err.message : String(err) });
        return;
    }
    const persisted = options.onUpdateConfig === undefined
        ? updateProfileConfig(validated, getProfileDir() ?? undefined, undefined)
        : options.onUpdateConfig(validated);
    if (!persisted) {
        sendJson(res, 500, { ok: false, error: '无法定位 profile 目录或写入失败' });
        return;
    }
    sendJson(res, 200, { ok: true, message: '配置已保存，插件将自动重载（进行中的机器人会话将重置）' });
}
//# sourceMappingURL=bind-routes.js.map