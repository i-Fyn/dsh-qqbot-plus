/**
 * SessionManager — 管理 QQ peer → dsh Agent 的映射和生命周期
 *
 * sessionKey 格式: `qqbot:${appId}:${kind}:${peerId}`
 *   - c2c:   peerId = senderId (用户 openid)
 *   - group: peerId = groupOpenid
 *
 * sessionKey → sessionId 的映射存于 prefs（`model-prefs.json`），新会话 id 由
 * `mintSessionId()` 铸造（`session-` + UUID，与宿主一致）。0.5.x 的 SHA-256 确定性
 * 派生 id 仅用于探测存量会话并迁移，不再用于新建——确定性 id 跨进程必然相同，
 * 两个进程各自新建会把同一 id 写入不同 project 目录。
 *
 * 支持 agent-presets 系统：通过 setup hook 在 create/resume 时
 * 挂载 preset（工具集、prompt sections 等），实现场景化配置。
 */
import { legacyDerivedSessionId, mintSessionId } from "./session-id.js";
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createHostAdapter } from "../host/adapter.js";
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolveAgentCwd, PLUGIN_HOME } from "../shared/dirs.js";
import { writeJsonAtomic } from "../shared/json-file.js";
import { ORDER } from "../shared/orders.js";
import { armResumeCheck, MIN_RESTART_GAP_MS } from "../resume-check.js";
import { ModelResolver } from "../model/model-resolver.js";
import { IdleEvictor } from "./idle-evictor.js";
import { MemoryRuntime, expandHome } from "../identity/runtime.js";
import { defaultPersonaFile, defaultPortraitFile } from "../identity/paths.js";
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
/**
 * 机器人自己的共享会话 id：只生成一次，落在 PLUGIN_HOME/shared-session.json。
 * 群聊和私聊都指向同一条 session，但这条会话由本插件创建、在
 * ~/.dsh/dsh-qqbot-plus/workspace 下，不再依赖 dsh-qq。
 */
function resolveOwnSharedSession(logger) {
    const file = join(PLUGIN_HOME, 'shared-session.json');
    try {
        if (existsSync(file)) {
            const data = JSON.parse(readFileSync(file, 'utf8'));
            const id = typeof data?.sessionId === 'string' ? data.sessionId.trim() : '';
            if (id !== '')
                return id;
        }
    }
    catch {
        // 文件坏了就重新生成一个
    }
    const id = mintSessionId();
    writeSharedSession(id, logger);
    logger.info?.(`im-qqbot: 创建自己的共享会话 ${id}`);
    return id;
}
/** 把共享会话 id 落盘（换会话时也要走这里）。 */
function writeSharedSession(id, logger) {
    const file = join(PLUGIN_HOME, 'shared-session.json');
    try {
        mkdirSync(PLUGIN_HOME, { recursive: true });
        writeFileSync(file, JSON.stringify({ sessionId: id, createdAt: new Date().toISOString() }, null, 2), 'utf8');
    }
    catch (error) {
        logger.warn?.(`im-qqbot: 保存共享会话 id 失败 ${String(error)}`);
    }
}
/** ManualCompactionError 各 code 的友好提示 */
const COMPACTION_ERROR_HINTS = {
    busy: '压缩服务忙，请稍后重试',
    cancelled: '压缩已取消',
    changed: '历史在压缩过程中发生变化，请重试',
    commit: '压缩提交失败',
    persistence: '压缩完成但保存失败',
};
/** 复刻宿主 latestCompletedPrefixBoundary：最后一个 turn/end 起到下一 turn 开始前的边界 */
export function latestCompletedPrefixBoundary(events) {
    const list = events;
    let lastTurnEndSeq;
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const candidate = list[i];
        if (candidate?.type === 'turn/end') {
            lastTurnEndSeq = candidate.seq;
            break;
        }
    }
    if (lastTurnEndSeq === undefined)
        return undefined;
    let boundary = lastTurnEndSeq;
    for (const next of list.slice(boundary + 1)) {
        if (next.type === 'turn/start'
            || (next.type === 'user/message' && next.surfaceOp === 'append')
            || next.type === 'agent/inbox/spliced')
            break;
        if (next.seq !== undefined)
            boundary = next.seq;
    }
    return boundary;
}
export class SessionManager {
    sessions = new Map();
    /**
     * 同 key 正在进行的 getOrCreate（singleflight）。
     *
     * 斜杠命令与待答问题截获位于 concurrencyGuard 之前（见 gateway/middleware-setup），
     * 与普通消息不串行：同 key 并发进入会各自 resume/create，产出两个 agent，
     * 后写入 sessions 的覆盖前者且前者无人 dispose（泄漏）。
     */
    inflight = new Map();
    evictor;
    modelResolver;
    ctx;
    host;
    agents;
    config;
    logger;
    /** 由 bootstrap 注入的问答通道（ask_user_question → QQ），会话回收时清理其待答问题 */
    questionChannel;
    /** 由 bootstrap 注入的审批通道（approval/request → QQ），会话回收时清理其待批审批 */
    approvalChannel;
    constructor(ctx, agents, config, logger) {
        this.ctx = ctx;
        this.agents = agents;
        this.config = config;
        this.logger = logger;
        this.host = createHostAdapter(ctx, logger);
        this.logger.info(`host adapter capabilities: ${this.host.capabilities.join(', ')}`);
        this.modelResolver = new ModelResolver(ctx, config, logger);
        // 默认每个 peer 各一条会话（跟官方原版一致）：群聊和私聊的上下文、草稿、回复目标
        // 互不干扰。想回到「群聊/私聊共用一条」的旧行为，把 config.sharedSession 打开。
        this.sharedSessionId = config.sharedSession === true ? resolveOwnSharedSession(logger) : null;
        // 共用 session 时，同一条会话可能对应多个 peer，出站消息要回到「最后说话的那个」。
        this.activeBySession = new Map();
        if (this.sharedSessionId !== null) {
            this.logger.info(`im-qqbot: 使用自己的共享会话 ${this.sharedSessionId}`);
        }
        else {
            this.logger.info('im-qqbot: 每个群/私聊各用一条独立会话');
        }
        this.memory = this.createMemory();
        // 共用 session 时所有 peer 共用同一个 agent，闲置回收会把别人正在用的会话关掉，所以不挂 evictor。
        this.evictor = this.sharedSessionId !== null
            ? undefined
            : new IdleEvictor(this.sessions, config.sessionIdleTimeout, (key, record) => {
                this.logger.info(`evicting idle session: key=${key}`);
                this.sessions.delete(key);
                record.agent.cancel({ kind: 'user' });
                void record.handle.dispose().catch(() => { });
                // 回收会话时统一清理其待答问题/待批审批，避免 pending 悬挂泄漏
                this.questionChannel?.cancelPending(key);
                this.approvalChannel?.cancelPending(key);
            });
        this.registerScopePromptInjection();
    }
    /**
     * 通过 system-prompt/assemble waterfall 注入群聊/私聊额外 system prompt。
     *
     * 该事件在每次 turn 构建 request 时触发；此处按会话 scope（群聊/私聊）
     * 追加对应的额外 prompt section。会话尚未建立（首次 assemble）或未配置
     * 额外 prompt 时原样返回，不做改动。
     */
    registerScopePromptInjection() {
        const assemble = async (_assembly, context, next) => {
            const assembled = await next();
            if (!context.agent)
                return assembled;
            const record = this.findByAgent(context.agent);
            if (!record)
                return assembled;
            const sections = [...(assembled.sections ?? [])];
            const base = sections.length;
            // 人设（order 20）→ 画像（4800）→ 通道附加提示（90）。
            // 顺序只影响拼装位置；人设最靠前，记忆里的事实最后作参考。
            const persona = this.memory?.personaText();
            if (persona)
                sections.push({ name: 'qqbot:persona', order: ORDER.persona, text: persona });
            const portrait = this.memory?.portraitText();
            if (portrait)
                sections.push({ name: 'qqbot:portrait', order: ORDER.portrait, text: portrait });
            // 记忆不在这里：长期记忆和转录归 lib/fishmemory/plugin.js（它自己听 session
            // 事件、自己注入索引与「这一轮你可能要用到的」）。这里只放稳定的人设和画像。
            if (sections.length === base)
                return assembled;
            return { ...assembled, sections };
        };
        this.ctx.on('system-prompt/assemble', assemble);
    }
    /**
     * 记忆运行时：用自己的数据目录（~/.dsh/dsh-qqbot-plus）。
     * 人设/画像都写在这个目录里，不跟 dsh-qq 共用，也不从那边复制。
     */
    createMemory() {
        const settings = this.config.memory ?? {};
        const home = PLUGIN_HOME;
        const pick = (value, fallback) => {
            const text = expandHome(value, homedir()) || fallback;
            return text;
        };
        try {
            return new MemoryRuntime({
                logger: this.logger,
                ctx: this.ctx,
                enabled: settings.enabled !== false,
                allowSilence: this.config.allowSilence !== false,
                personaFile: pick(settings.personaFile, defaultPersonaFile()),
                portraitFile: pick(settings.portraitFile, defaultPortraitFile()),
            });
        }
        catch (error) {
            this.logger.warn?.(`im-qqbot: 记忆初始化失败 ${String(error)}`);
            return undefined;
        }
    }
    /**
     * 动态获取 agentPresets 服务（可选，未注入时返回 undefined）
     */
    getPresetsService() {
        try {
            return this.ctx.get('agentPresets');
        }
        catch {
            return undefined;
        }
    }
    /**
     * 从 session 持久化 header 读 session 当初的 preset（started 锁定语义）。
     * 读不到（服务缺失 / session 不存在 / 未记录 agentPreset）返回 undefined。
     */
    async resolvePersistedPreset(sessionId) {
        return (await this.host.sessionHeader(sessionId))?.agentPreset;
    }
    // ── 模型相关（委托给 ModelResolver） ──
    getEffectiveModel(scope, peerId) {
        return this.modelResolver.getEffectiveRoute(this.sessionKey(scope, peerId));
    }
    /**
     * 获取指定 peer 的生效 preset（per-peer 覆盖 > config.preset）
     */
    getEffectivePreset(scope, peerId) {
        return this.getEffectivePresetByKey(this.sessionKey(scope, peerId));
    }
    /** 按 sessionKey 解析生效 preset */
    getEffectivePresetByKey(key) {
        return this.modelResolver.getPreset(key) ?? this.config.preset;
    }
    /**
     * 列出所有可用 preset（/preset 命令用）
     */
    async listPresets() {
        const presets = this.getPresetsService();
        if (!presets)
            return [];
        try {
            const list = await presets.list();
            return list.map((p) => ({ id: p.id, name: p.name, description: p.description }));
        }
        catch (err) {
            this.logger.warn(`list presets failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }
    /**
     * 切换模型（fork + 重建会话，保留历史）
     */
    async setModelOverride(scope, peerId, route) {
        const key = this.sessionKey(scope, peerId);
        this.modelResolver.setOverride(key, route);
        const record = this.sessions.get(key);
        if (!record) {
            this.logger.info(`model pref saved (no active session): key=${key} → ${route.provider}/${route.model}`);
            return;
        }
        await this.rebuildSession(record, { route });
        this.logger.info(`model switched via fork: key=${key} → ${route.provider}/${route.model}`);
    }
    /**
     * 切换指定 peer 的 agent preset（per-peer 覆盖）
     *
     * 已开始的会话保持锁定（blank-session contract）：只持久化为新会话默认，
     * 不 fork/rebuild 当前会话，避免历史工具调用与新 preset 工具集冲突。
     */
    async setPresetOverride(scope, peerId, presetId) {
        const key = this.sessionKey(scope, peerId);
        // 1. 校验 preset 存在 + 可加载（broken 拒绝）
        const presets = this.getPresetsService();
        if (!presets)
            return { ok: false, reason: 'unavailable' };
        let resolved;
        try {
            resolved = await presets.resolve(presetId);
        }
        catch (err) {
            return { ok: false, reason: 'unknown-preset', message: err instanceof Error ? err.message : String(err) };
        }
        if (resolved.broken !== undefined) {
            return { ok: false, reason: 'broken', message: resolved.broken };
        }
        // 2. 持久化 per-peer 覆盖（新会话生效）
        this.modelResolver.setPreset(key, presetId);
        const hasActive = this.sessions.has(key);
        this.logger.info(`preset pref saved: key=${key} → ${presetId}${hasActive ? ' (active session locked, next session applies)' : ''}`);
        return { ok: true, presetId };
    }
    /**
     * 清除 per-peer preset 覆盖，回到 config.preset / 默认（新会话生效）
     */
    async clearPresetOverride(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        this.modelResolver.clearPreset(key);
        this.logger.info(`preset pref cleared: key=${key} (next session applies)`);
        return { ok: true };
    }
    /**
     * fork + 重建会话（保留历史，换 model）
     *
     * options.route 缺省时沿用当前生效值。preset 沿用当前生效 preset（getEffectivePresetByKey）。
     * fork 不可用或失败时降级为 dispose（下次消息重建）。
     */
    async rebuildSession(record, options) {
        const key = record.sessionKey;
        // 对齐宿主官方 fork（commands.fork）：buildForkSeed 产物原样作 seed，
        // create 传 inheritedEventCount + isSeeded + parentSession
        const events = this.host.sessionEvents(record.agent.session);
        const boundary = latestCompletedPrefixBoundary(events);
        if (boundary === undefined) {
            this.logger.warn(`fork unavailable (no completed turn), fallback to dispose: key=${key}`);
            this.sessions.delete(key);
            record.agent.cancel({ kind: 'user' });
            await record.handle.dispose().catch(() => { });
            return;
        }
        const seed = await this.host.buildForkSeed(events, boundary);
        if (seed === undefined) {
            this.logger.warn(`fork seed unavailable (old host), fallback to dispose: key=${key}`);
            this.sessions.delete(key);
            record.agent.cancel({ kind: 'user' });
            await record.handle.dispose().catch(() => { });
            return;
        }
        const childId = SessionId(mintSessionId());
        const effectiveRoute = options.route ?? this.modelResolver.getEffectiveRoute(key);
        const composed = await this.composePreset(this.getEffectivePresetByKey(key));
        const created = await this.agents.create({
            sessionId: childId,
            seed,
            inheritedEventCount: boundary + 1,
            meta: {
                cwd: this.workspaceDir(),
                isSeeded: true,
                // 旧版宿主的 delivery 豁免要求 parentSession，新版忽略——都传
                parentSession: record.sessionId,
                ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
            },
            ...(effectiveRoute ? { agentOptions: effectiveRoute } : {}),
            ...(composed.setup ? { setup: composed.setup } : {}),
        });
        this.modelResolver.setSessionId(key, childId);
        const oldHandle = record.handle;
        record.sessionId = childId;
        record.agent = created.agent;
        record.handle = created;
        record.agentPreset = composed.agentPreset;
        record.lastActivity = Date.now();
        void oldHandle.dispose().catch(() => { });
        this.logger.info(`session rebuilt via fork: key=${key} preset=${composed.agentPreset ?? 'none'} sessionId=${childId}`);
    }
    clearModelOverride(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        this.modelResolver.clearOverride(key);
        this.modelResolver.clearSessionId(key);
    }
    async listAvailableModels() {
        return this.modelResolver.listModels();
    }
    listProviders() {
        return this.modelResolver.listProviders();
    }
    // ── 会话状态 / 统计 ──
    getSessionRecord(scope, peerId) {
        return this.sessions.get(this.sessionKey(scope, peerId));
    }
    getStatus(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        const route = this.getEffectiveModel(scope, peerId);
        return {
            active: !!record,
            sessionId: record?.sessionId,
            provider: route?.provider,
            model: route?.model,
            preset: record?.agentPreset,
            lastActivity: record?.lastActivity,
            messageCount: this.countMessages(record),
        };
    }
    getTokenUsage(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        const stats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        if (!record)
            return stats;
        const events = this.host.sessionEvents(record.agent.session);
        if (!events)
            return stats;
        for (const event of events) {
            if (event.type !== 'assistant/message' || !event.usage)
                continue;
            stats.input += event.usage.input ?? 0;
            stats.output += event.usage.output ?? 0;
            stats.cacheRead += event.usage.cacheRead ?? 0;
            stats.cacheWrite += event.usage.cacheWrite ?? 0;
        }
        return stats;
    }
    exportMarkdown(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        if (!record)
            return '';
        const events = this.host.sessionEvents(record.agent.session);
        if (!events || events.length === 0)
            return '';
        const lines = [`# QQ 会话导出\n`, `> session: ${record.sessionId}\n`];
        for (const event of events) {
            if (event.type === 'user/message') {
                const text = extractMessageText(event.message);
                if (text)
                    lines.push(`## 用户\n\n${text}\n`);
            }
            else if (event.type === 'assistant/message') {
                const text = extractMessageText(event.message);
                if (text)
                    lines.push(`## 助手\n\n${text}\n`);
            }
        }
        return lines.join('\n');
    }
    countMessages(record) {
        if (!record)
            return 0;
        const events = this.host.sessionEvents(record.agent.session);
        if (!events)
            return 0;
        let count = 0;
        for (const event of events) {
            if (event.type === 'user/message' || event.type === 'assistant/message') {
                count += 1;
            }
        }
        return count;
    }
    // ── Session 生命周期管理 ──
    sessionKey(scope, peerId) {
        return `qqbot:${this.config.appId}:${scope}:${peerId}`;
    }
    /** prefs 命中沿用；共用 session 时永远指向那一条，miss 才回落到 0.5.x 派生候选 */
    currentSessionId(sessionKey) {
        if (this.sharedSessionId !== null)
            return this.sharedSessionId;
        return this.modelResolver.getSessionId(sessionKey) ?? legacyDerivedSessionId(sessionKey);
    }
    /** 候选命中后落盘，后续永远走 prefs（共用 session 时不写，免得多一份映射） */
    persistSessionId(sessionKey, sessionId) {
        if (this.sharedSessionId !== null)
            return;
        if (this.modelResolver.getSessionId(sessionKey) !== sessionId) {
            this.modelResolver.setSessionId(sessionKey, sessionId);
        }
    }
    /** 记下「这条会话最后是哪个 peer 在说话」，出站按它找回回复目标。 */
    markActive(record) {
        if (record?.sessionId !== undefined)
            this.activeBySession.set(record.sessionId, record.sessionKey);
    }
    async composePreset(presetId) {
        const presets = this.getPresetsService();
        if (!presets)
            return {};
        try {
            const resolved = await presets.resolve(presetId);
            const resolvedId = resolved.id;
            return {
                agentPreset: resolvedId,
                setup: async (agentCtx) => {
                    await presets.mount(agentCtx, resolvedId);
                },
            };
        }
        catch (err) {
            this.logger.warn(`im-qqbot: preset ${presetId ?? '(default)'} unavailable: ${err instanceof Error ? err.message : String(err)} — using host composition`);
            return {};
        }
    }
    /** 获取或恢复或创建会话（get → resume → create）；同 key 并发合并为一次 */
    async getOrCreate(scope, peerId, senderId, replyTarget) {
        const key = this.sessionKey(scope, peerId);
        const existing = this.sessions.get(key);
        if (existing) {
            existing.replyTarget = replyTarget;
            existing.lastActivity = Date.now();
            this.markActive(existing);
            return existing;
        }
        // singleflight：同 key 并发复用同一次 resume/create，后到者只更新回复目标
        const pending = this.inflight.get(key);
        if (pending) {
            const shared = await pending;
            shared.replyTarget = replyTarget;
            shared.lastActivity = Date.now();
            this.markActive(shared);
            return shared;
        }
        const task = this.openSession(key, scope, peerId, senderId, replyTarget);
        this.inflight.set(key, task);
        try {
            const record = await task;
            this.markActive(record);
            return record;
        }
        finally {
            this.inflight.delete(key);
        }
    }
    /** getOrCreate 的实际打开流程（已通过 singleflight 保证同 key 串行） */
    async openSession(key, scope, peerId, senderId, replyTarget) {
        const route = this.modelResolver.getEffectiveRoute(key);
        // prefs 命中 = 已知存量会话；miss 时取 0.5.x 派生 id 仅作存量探测候选，不用于新建
        const candidateIsLegacy = this.modelResolver.getSessionId(key) === undefined;
        let sessionId = SessionId(this.currentSessionId(key));
        this.logger.info(`getOrCreate: key=${key} route=${route ? `${route.provider}/${route.model}` : 'host-default'} sessionId=${sessionId}`);
        let agent;
        let handle;
        let agentPreset;
        const live = this.agents.get(sessionId);
        if (live) {
            agent = live;
            this.persistSessionId(key, sessionId);
            this.logger.info(`reusing live agent: key=${key}`);
        }
        else {
            // preset 只解析一次：resume/create 共用同一组合，避免重复 resolve/mount 目录。
            // 优先 session 当初的 preset（started 锁定语义），无则用当前 effective preset。
            const persistedPreset = await this.resolvePersistedPreset(sessionId);
            let presetId = persistedPreset ?? this.getEffectivePresetByKey(key);
            let composed = await this.composePreset(presetId);
            // session 记着的 preset 已经不在了（比如提供它的插件被卸载）：回落到当前
            // 配置的 preset，否则这一轮会带着空 preset 恢复——没有工具集也没有 prompt。
            if (presetId !== undefined && composed.agentPreset === undefined) {
                const fallbackId = this.getEffectivePresetByKey(key);
                if (fallbackId !== undefined && fallbackId !== presetId) {
                    this.logger.warn(`im-qqbot: session preset ${presetId} 不可用，回落到 ${fallbackId}`);
                    presetId = fallbackId;
                    composed = await this.composePreset(fallbackId);
                }
            }
            agentPreset = composed.agentPreset;
            try {
                const resumeRoute = this.modelResolver.getResumeRoute(key);
                const resumed = await this.agents.resume({
                    resumeSessionId: sessionId,
                    ...(resumeRoute ? { agentOptions: resumeRoute } : {}),
                    ...(composed.setup ? { setup: composed.setup } : {}),
                });
                agent = resumed.agent;
                handle = resumed;
                // 0.5.x 迁移：候选命中老会话，沿用并落盘
                this.persistSessionId(key, sessionId);
                this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumeRoute ? `${resumeRoute.provider}/${resumeRoute.model}` : 'session-own'}`);
            }
            catch (err) {
                if (!(await this.mayCreateAfterResumeFailure(key, sessionId, err)))
                    throw err;
                // 共用 session 时固定用自己那条 id，不铸造新 id，否则各 peer 会分叉。
                sessionId = this.sharedSessionId !== null
                    ? SessionId(this.sharedSessionId)
                    : this.resolveCreateId(key, sessionId, candidateIsLegacy);
                const created = await this.agents.create({
                    sessionId,
                    meta: {
                        cwd: this.workspaceDir(),
                        ...(agentPreset ? { agentPreset } : {}),
                    },
                    ...(route ? { agentOptions: route } : {}),
                    ...(composed.setup ? { setup: composed.setup } : {}),
                });
                agent = created.agent;
                handle = created;
                this.persistSessionId(key, sessionId);
                this.logger.info(`created new session: key=${key} sessionId=${sessionId} preset=${agentPreset ?? 'none'}`);
            }
        }
        const record = {
            sessionKey: key,
            sessionId,
            agent,
            handle: handle ?? { agent, dispose: async () => { } },
            replyTarget,
            scope,
            peerId,
            senderId,
            lastActivity: Date.now(),
            agentPreset,
        };
        this.sessions.set(key, record);
        // 挂工作区 + 起默认标题（失败不影响收发，但要吭声：挂不上侧栏就看不到）。
        const attached = await this.attachWorkspace(sessionId, agent).catch((error) => {
            this.logger.warn(`im-qqbot: 挂工作区失败 ${error instanceof Error ? error.message : String(error)}`);
            return false;
        });
        if (!attached)
            this.logger.warn(`im-qqbot: 会话 ${sessionId} 没挂上工作区，侧栏里会看不到它`);
        return record;
    }
    /**
     * resume 失败后是否允许首次创建。
     *
     * 只有「会话确实不在盘上」才可创建：损坏/占用/后端故障沿用同一 id 重建，会把
     * 同一 sessionId 写进多个 project 目录，宿主 `list()` 随后报 duplicate，会话
     * 列表整体打不开（对齐宿主 `restoreOrCreateConfigured` 的 fail-loud 语义）。
     *
     * @returns 允许创建返回 true；拒绝时已记录 warn，调用方应抛出原 resume 错误。
     */
    async mayCreateAfterResumeFailure(key, sessionId, resumeError) {
        const context = `key=${key} sessionId=${sessionId} resumeErr=${errorText(resumeError)}`;
        let exists;
        try {
            exists = await this.host.sessionExists(sessionId);
        }
        catch (probeError) {
            // 求证本身失败（持久化后端故障）：无法断言不在盘上，按存在处理
            this.logger.warn(`refusing to recreate session, existence unknown: ${context} probeErr=${errorText(probeError)}`);
            return false;
        }
        if (exists === true) {
            this.logger.warn(`refusing to recreate existing session: ${context}`);
            return false;
        }
        if (exists === undefined) {
            // 宿主无 sessionPersistence.stat：没有求证手段，只能按 resume 结果创建（= 修复前行为）
            this.logger.warn(`creating session without existence check (host lacks sessionPersistence.stat): ${context}`);
        }
        return true;
    }
    /**
     * 确认候选会话缺失后决定用哪个 id 新建。
     *
     * - resume 等待期间 prefs 被并发改写（换新会话）：采用 prefs 的最新 id，
     *   否则内存与 prefs 指向不同会话，重启后用户被切走；
     * - 候选来自 0.5.x 确定性派生：一律铸造新 id，确定性 id 不进入新建路径；
     * - 候选来自 prefs 且确认缺失：沿用该 id 新建，prefs 无需改写。
     */
    resolveCreateId(key, candidate, candidateIsLegacy) {
        const latest = this.modelResolver.getSessionId(key);
        if (latest !== undefined && latest !== candidate) {
            this.logger.info(`adopting concurrently written session id: key=${key} sessionId=${latest}`);
            return SessionId(latest);
        }
        if (candidateIsLegacy) {
            const minted = SessionId(mintSessionId());
            this.logger.info(`migrated to minted session id: key=${key} sessionId=${minted}`);
            return minted;
        }
        return candidate;
    }
    findBySessionId(sessionId) {
        // 共用 session 时多个 peer 指向同一条会话：先按「最后说话的那个」找。
        const activeKey = this.activeBySession.get(sessionId);
        if (activeKey !== undefined) {
            const active = this.sessions.get(activeKey);
            if (active !== undefined && active.sessionId === sessionId)
                return active;
        }
        for (const record of this.sessions.values()) {
            if (record.sessionId === sessionId)
                return record;
        }
        return undefined;
    }
    findByAgent(agent) {
        const sessionId = agent?.session?.id;
        if (typeof sessionId === 'string') {
            const record = this.findBySessionId(sessionId);
            if (record !== undefined) {
                if (record.agent === agent)
                    return record;
                // 同一条会话被另一个入口复活（比如控制台打开了同一条 id）时，
                // 身份对不上，但门还是那一扇：用现有记录，并把 agent 指到活着的这个。
                record.agent = agent;
                return record;
            }
        }
        for (const record of this.sessions.values()) {
            if (record.agent === agent)
                return record;
        }
        // 兜底：回合可能是别的插件（dsh-day 的心跳）把这条会话唤醒后直接跑起来的，
        // 这时 agent 对象不是 qqbot 手里那个，session.id 也可能读不到。
        // 只配了一个 peer（当前就是私聊一条）时，sessions 里只有一条记录，就认它。
        if (this.sessions.size === 1) {
            const only = this.sessions.values().next().value
            if (only !== undefined) {
                // 不拿外来 agent 顶掉这条记录：它不是这条会话的，顶上去下一批真实消息会跟着跑
                this.logger.warn('qq_draft: 会话不在本通道表里，按唯一记录兜底（外部插件唤醒的回合）')
                return only
            }
        }
        // 兜底二：会话压根不在表里（dsh-day 心跳、控制台把同一条 id 拉起来、或者刚重启）。
        // 用 runtime.json 里最后一条入站（没有就用最后的发送目标）拼一条临时记录，
        // 让回复有门可走；只用这一次，不写回 sessions（写回会把真实聊天吸走）。
        if (typeof sessionId === 'string') {
            const info = this.lastInbound
            const target = info?.replyTarget ?? this.lastTarget
            const targetId = typeof target?.targetId === 'string' ? target.targetId : ''
            if (targetId !== '') {
                const scope = target.scope === 'group' ? 'group' : 'c2c'
                const peerId = typeof info?.peerId === 'string' && info.peerId !== '' ? info.peerId : targetId
                const key = this.sessionKey(scope, peerId)
                const synthetic = {
                    sessionKey: key,
                    sessionId,
                    agent,
                    handle: { agent, dispose: async () => { } },
                    replyTarget: { scope, targetId, msgId: target?.msgId ?? '' },
                    scope,
                    peerId,
                    senderId: info?.senderId ?? peerId,
                    lastActivity: Date.now(),
                }
                // 只给这一次出站用，绝不写进 sessions / activeBySession：
                // 这条会话不是本通道建的（做梦、day 心跳、控制台唤醒都可能），一旦按
                // 「最后一条入站」认成某个群/私聊的会话，下一批真实的 QQ 消息会命中这条
                // 记录，整条聊天就被搬进那个外来会话里（2026-11-18 群被做梦会话吸走）。
                this.logger.warn(`qq_draft: 会话不在本通道表里，按最后一条入站临时拼记录（${scope}:${peerId}，不写表）`)
                return synthetic
            }
        }
        return undefined;
    }
    async remove(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        // 共享会话模式下所有 peer 都固定指向同一条 id：只换 key 的映射不会生效，
        // 必须换一个新的共享 id，并放下所有活着的 agent，下一条消息才会建一条干净会话。
        // 旧会话本身留在盘上（历史不删），侧栏里仍能看到。
        if (this.sharedSessionId !== null) {
            const next = mintSessionId();
            writeSharedSession(next, this.logger);
            this.sharedSessionId = next;
            this.activeBySession.clear();
            const records = [...this.sessions.values()];
            this.sessions.clear();
            this.inflight.clear();
            const handles = new Set(records.map((record) => record.handle));
            for (const record of records) {
                record.agent.cancel({ kind: 'user' });
            }
            await Promise.allSettled([...handles].map((handle) => handle.dispose().catch(() => { })));
            this.logger.info(`shared session rotated: ${key} → ${next}`);
            return;
        }
        const record = this.sessions.get(key);
        this.modelResolver.setSessionId(key, mintSessionId());
        if (!record)
            return;
        this.sessions.delete(key);
        record.agent.cancel({ kind: 'user' });
        await record.handle.dispose().catch(() => { });
        this.logger.info(`session removed: key=${key}`);
    }
    /** Agent 工作目录：显式配置优先，缺省独立目录 ~/.dsh/dsh-qqbot-plus/workspace（不随宿主进程 cwd） */
    workspaceCache;
    workspaceDir() {
        if (this.workspaceCache)
            return this.workspaceCache;
        const dir = resolveAgentCwd(this.config.cwd);
        mkdirSync(dir, { recursive: true });
        this.workspaceCache = dir;
        return dir;
    }
    /** 运行时状态：记录上次停机时间与最后一条未回完的消息，供重启说明/接话使用。 */
    runtimeFile() {
        return join(PLUGIN_HOME, 'runtime.json');
    }
    readRuntime() {
        try {
            return JSON.parse(readFileSync(this.runtimeFile(), 'utf8'));
        }
        catch {
            return {};
        }
    }
    writeRuntime(patch) {
        try {
            mkdirSync(PLUGIN_HOME, { recursive: true });
            writeJsonAtomic(this.runtimeFile(), { ...this.readRuntime(), ...patch });
        }
        catch {
            // 状态文件写不了不影响收发
        }
    }
    /** 把重启这条链路的每一步写进 resume.log：下次出问题先看这个，不用猜。 */
    resumeLog(line) {
        try {
            mkdirSync(PLUGIN_HOME, { recursive: true });
            appendFileSync(join(PLUGIN_HOME, 'resume.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
        }
        catch {
            // 记日志失败不影响主流程
        }
    }

    /** 网关启动时调用一次：算出停机间隔，取出最后一条未回完的消息与上次的发送目标。 */
    beginBoot() {
        const state = this.readRuntime();
        const stoppedAt = Number(state.stoppedAt) || 0;
        const prevStarted = Number(state.startedAt) || 0;
        // 优雅退出会写 stoppedAt；被硬关（杀进程、崩溃）时它是 null，
        // 这时候按上一次的启动时刻算，别把停机当成 0 秒直接放过去。
        const anchor = stoppedAt > 0 ? stoppedAt : prevStarted;
        this.bootGapMs = anchor > 0 ? Math.max(0, Date.now() - anchor) : 0;
        this.bootEvidence = { prevStoppedAt: stoppedAt, prevStarted, anchor, gapMs: this.bootGapMs };
        this.lastInbound = state.lastInbound ?? null;
        this.lastTarget = state.lastTarget ?? this.lastInbound?.replyTarget ?? null;
        this.writeRuntime({ startedAt: Date.now(), stoppedAt: null });
        // 开机就上锁，不等第一条消息把会话拉起来。registry 还没就绪时留空，
        // 后面 attachWorkspace 打开会话时还会再装一次。
        this.protectWorkspace();
    }
    /**
     * 重启后：不往任何会话注文本，只在本地记一个「待检查」标记。
     * 以前这里是 getOrCreate(最后一次入站的那条) + followup——那条常常是旧会话，
     * 而且每重启一次就多一段用户消息。现在由 qq_resume_check 工具按需读走。
     */
    async resumeInterrupted(logger) {
        const ev = this.bootEvidence ?? {};
        this.resumeLog(`beginBoot stoppedAt=${ev.prevStoppedAt} startedAt=${ev.prevStarted} gapMs=${this.bootGapMs}`);
        if (this.bootGapMs < MIN_RESTART_GAP_MS) {
            this.resumeLog('跳过硬关说明：停机太短');
            return;
        }
        const info = this.lastInbound;
        const armed = armResumeCheck({
            gapMs: this.bootGapMs,
            lastInbound: info ?? null,
            lastTarget: this.lastTarget ?? null,
        });
        if (!armed)
            return;
        this.resumeLog(`已挂起标记 gap=${Math.round(this.bootGapMs / 1000)}s`);
        logger.info(`im-qqbot: 重启接话检查已挂起（停机 ${Math.round(this.bootGapMs / 1000)}s），等 qq_resume_check 读取`);
        // 除了挂标记，还往主人那条会话里真投一条（和主动找人同一套），
        // 这样重启这件事在会话里看得见，模型也会被叫起来决定要不要接话。
        await this.deliverResumeNotice(info, logger);
    }
    /** 重启说明：投一条会话内可见的消息（主动找人那套：pickAgent + followup）。
     *  宿主刚起来时会话还没装载，pickAgent 常拿不到人，所以隔几秒重试，
     *  最多试 24 次（约 2 分钟），拿到会话才投，投过就不再试。 */
    async deliverResumeNotice(info, logger) {
        if (this.resumeNoticeDelivered)
            return false;
        const gapSec = Math.round((this.bootGapMs || 0) / 1000);
        const text = info?.text
            ? `（宿主刚重启过，停机 ${gapSec} 秒。）他最后说的是「${String(info.text).slice(0, 200)}」，接得上就接着聊，接不上就先问一句。`
            : `（宿主刚重启过，停机 ${gapSec} 秒。）没有窗口内的最后一条消息，自己看这轮上下文决定要不要说话。`;
        const attempt = async (left) => {
            if (this.resumeNoticeDelivered)
                return true;
            let agent = null;
            try {
                const { pickAgent } = await import('./pick-agent.js');
                agent = await pickAgent(this.ctx.get?.('agents'));
            }
            catch (error) {
                logger.warn(`im-qqbot: 重启说明挑会话失败 ${String(error)}`);
            }
            this.resumeLog(`第 ${25 - left} 次挑会话 ${agent ? `拿到 ${agent.session?.id ?? '?'} / ${String(agent.status)}` : '没拿到'}`);
            if (agent && typeof agent.followup === 'function') {
                try {
                    Promise.resolve(agent.followup({
                        id: `qqbot-resume-${Date.now()}`,
                        role: 'user',
                        content: [{ type: 'text', text }],
                        source: { kind: 'resume', type: 'boot' },
                    })).catch((error) => {
                        logger.warn(`im-qqbot: 重启说明投递失败 ${String(error)}`);
                    });
                    this.resumeNoticeDelivered = true;
                    this.resumeLog('已投进会话');
                    logger.info('im-qqbot: 重启说明已投进会话');
                    return true;
                }
                catch (error) {
                    logger.warn(`im-qqbot: 重启说明投递异常 ${String(error)}`);
                }
            }
            if (left <= 1) {
                this.resumeLog('放弃：2 分钟内一直没拿到会话');
                logger.warn('im-qqbot: 重启说明没投出去（2 分钟内一直没拿到会话）');
                return false;
            }
            setTimeout(() => { void attempt(left - 1) }, 5000).unref?.();
            return false;
        };
        return attempt(24);
    }
    noteInbound(info) {
        this.lastInbound = info;
        this.writeRuntime({ lastInbound: info, lastTarget: info.replyTarget });
    }
    clearInbound() {
        if (!this.lastInbound)
            return;
        this.lastInbound = null;
        this.writeRuntime({ lastInbound: null });
    }
    markStopped() {
        this.writeRuntime({ stoppedAt: Date.now() });
    }
    /** 取一个可用的 workspaceRegistry（list() 不抛才说明真的就绪）。 */
    workspaceRegistry() {
        let registry;
        try {
            registry = this.ctx.get('workspaceRegistry');
        }
        catch {
            return undefined;
        }
        if (!registry || typeof registry.list !== 'function' || typeof registry.create !== 'function')
            return undefined;
        try {
            registry.list();
        }
        catch {
            return undefined;
        }
        return registry;
    }
    /** 把会话挂到机器人自己的工作区，并顺手起标题、上锁。返回是否真的挂上了。 */
    async attachWorkspace(sessionId, agent) {
        const registry = this.workspaceRegistry();
        if (!registry) {
            this.logger.warn('im-qqbot: 没有 workspace registry，跳过挂工作区');
            return false;
        }
        const cwd = this.workspaceDir();
        let workspace = null;
        try {
            workspace = (await registry.resolveByPath?.(cwd)) ?? null;
        }
        catch (error) {
            this.logger.warn(`im-qqbot: 按路径找工作区失败 ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
        if (!workspace) {
            try {
                workspace = await registry.create(cwd, 'QQ机器人');
            }
            catch (error) {
                // 标题被占用时退一步，工作区本身还是要建出来。
                try {
                    workspace = await registry.create(cwd, 'QQ机器人（机器人）');
                }
                catch (error2) {
                    this.logger.warn(`im-qqbot: 建工作区失败 ${error2 instanceof Error ? error2.message : String(error2)}（第一次：${error instanceof Error ? error.message : String(error)}）`);
                    return false;
                }
            }
        }
        if (typeof workspace?.attachSession === 'function') {
            const members = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
            if (!members.includes(sessionId))
                await workspace.attachSession(sessionId);
        }
        this.protectWorkspace(registry);
        return true;
    }
    /** 这个 workspaceId 是不是机器人自己的工作区。 */
    isOwnWorkspace(workspaceId, registry = this.workspaceRegistry()) {
        if (typeof workspaceId !== 'string' || workspaceId === '' || !registry)
            return false;
        try {
            const workspace = registry.get?.(workspaceId);
            if (!workspace || typeof workspace.path !== 'string')
                return false;
            return resolve(workspace.path) === resolve(this.workspaceDir());
        }
        catch {
            return false;
        }
    }
    /** 这个 sessionId 是不是机器人自己的会话。 */
    isOwnSession(sessionId, registry = this.workspaceRegistry()) {
        if (typeof sessionId !== 'string' || sessionId === '')
            return false;
        for (const record of this.sessions.values()) {
            if (record.sessionId === sessionId)
                return true;
        }
        if (!registry)
            return false;
        try {
            for (const workspace of registry.list()) {
                if (typeof workspace?.path !== 'string')
                    continue;
                if (resolve(workspace.path) !== resolve(this.workspaceDir()))
                    continue;
                if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId))
                    return true;
            }
        }
        catch {
            return false;
        }
        return false;
    }
    /** 工作区与会话上锁：别的 UI 删除/归档会被拒绝。 */
    protectWorkspace(registry = this.workspaceRegistry()) {
        if (!registry || typeof registry.delete !== 'function')
            return;
        if (this.workspaceProtection?.registry === registry)
            return;
        if (this.workspaceProtection) {
            try {
                this.workspaceProtection.dispose();
            }
            catch { /* ignore */ }
        }
        const manager = this;
        const originalDelete = registry.delete;
        const originalArchive = registry.archiveSession;
        const deleteGuard = async function (workspaceId) {
            if (manager.isOwnWorkspace(workspaceId, registry)) {
                const error = new Error('im-qqbot: QQ 工作区由插件管理，不能删除');
                error.code = 'im-qqbot/protected-workspace';
                throw error;
            }
            return originalDelete.apply(this, arguments);
        };
        const archiveGuard = typeof originalArchive === 'function'
            ? async function (sessionId) {
                if (manager.isOwnSession(sessionId, registry)) {
                    const error = new Error('im-qqbot: QQ 会话由插件管理，不能归档');
                    error.code = 'im-qqbot/protected-session';
                    throw error;
                }
                return originalArchive.apply(this, arguments);
            }
            : originalArchive;
        const dispose = () => {
            try {
                if (registry.delete === deleteGuard)
                    registry.delete = originalDelete;
            }
            catch { /* ignore */ }
            try {
                if (registry.archiveSession === archiveGuard)
                    registry.archiveSession = originalArchive;
            }
            catch { /* ignore */ }
            if (this.workspaceProtection?.dispose === dispose)
                this.workspaceProtection = null;
        };
        try {
            registry.delete = deleteGuard;
            if (typeof originalArchive === 'function')
                registry.archiveSession = archiveGuard;
            this.workspaceProtection = { registry, dispose };
            this.logger.info('im-qqbot: QQ 工作区与会话已上锁（不能删除/归档）');
        }
        catch (error) {
            this.logger.warn(`im-qqbot: 工作区上锁失败 ${String(error)}`);
        }
    }
    /**
     * 原地压缩当前会话历史（保留 sessionId，用摘要替换旧历史）。
     *
     * compaction 是 preset 作用域服务，经 host adapter 从会话 preset 解析，
     * 全局注册的部署再兜底。这是「压缩上下文」的语义，区别于 remove() 的「换新会话」。
     */
    async compact(scope, peerId, revive) {
        const key = this.sessionKey(scope, peerId);
        let record = this.sessions.get(key);
        if (!record) {
            // 无活跃会话（重启/闲置回收）时从磁盘拉起，历史在磁盘上仍可压缩
            if (!revive)
                return { ok: false, reason: 'no-session' };
            record = await this.getOrCreate(scope, peerId, revive.senderId, revive.replyTarget);
        }
        if (record.agent.status !== 'idle')
            return { ok: false, reason: 'busy' };
        const compaction = (await this.host.serviceFor(record.agent, 'compaction')
            ?? this.host.globalService('compaction'));
        if (!compaction)
            return { ok: false, reason: 'unavailable' };
        const route = this.modelResolver.getEffectiveRoute(key);
        const agentCtx = {
            session: record.agent.session,
            options: { provider: route?.provider, model: route?.model },
            runMaintenance: record.agent.runMaintenance.bind(record.agent),
        };
        try {
            const result = await compaction.compactNow(agentCtx, new AbortController().signal);
            if (result === null)
                return { ok: true, shadowed: 0, tokens: 0 };
            return { ok: true, shadowed: result.shadowedSeqs.length, tokens: result.shadowedTokenCount };
        }
        catch (err) {
            const code = err?.code;
            // summary = 摘要没有更小 = 历史不足以压缩，属正常结果而非失败
            if (code === 'summary') {
                return { ok: true, shadowed: 0, tokens: 0 };
            }
            // 其他 ManualCompactionError 预期失败，给友好文案（debug 记录，不 warn 刷屏）
            if (code !== undefined && code in COMPACTION_ERROR_HINTS) {
                this.logger.debug(`compact declined: key=${key} code=${code}`);
                return { ok: false, reason: 'failed', message: COMPACTION_ERROR_HINTS[code] };
            }
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`compact failed: key=${key} err=${message}`);
            return { ok: false, reason: 'failed', message };
        }
    }
    async disposeAll() {
        this.markStopped();
        this.evictor?.dispose?.();
        this.workspaceProtection?.dispose?.();
        const records = [...this.sessions.values()];
        this.sessions.clear();
        for (const record of records) {
            record.agent.cancel({ kind: 'user' });
        }
        // 共享会话不随插件重载销毁：销毁会触发宿主 session/disposed → 桌面端收到
        // api-session/removed，把侧栏里这一行摘掉；持久化会话要等下次全量重连
        // 才会回来（表现为「会话突然看不到了」）。留在宿主里，下次重载直接复用。
        const keepAlive = this.sharedSessionId;
        const disposals = records
            .filter((record) => keepAlive === null || record.sessionId !== keepAlive)
            .map((record) => record.handle.dispose());
        await Promise.allSettled(disposals);
        this.memory?.dispose();
        this.logger.info(`all sessions disposed (count=${records.length}, kept=${records.length - disposals.length})`);
    }
    get size() {
        return this.sessions.size;
    }
}
/** 错误文案（日志用） */
function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
/** 从消息对象中提取纯文本（用于导出/统计） */
function extractMessageText(message) {
    const blocks = message?.content;
    if (!blocks || !Array.isArray(blocks))
        return '';
    const parts = [];
    for (const block of blocks) {
        if (block.type === 'text' && block.text) {
            parts.push(block.text);
        }
    }
    return parts.join('\n').trim();
}
//# sourceMappingURL=session-manager.js.map