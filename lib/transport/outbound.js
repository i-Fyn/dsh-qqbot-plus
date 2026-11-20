import { chunkMarkdownText } from "./chunker.js";
import { OutboundBuffer } from "./outbound-buffer.js";
import { parseEvent, extractTurnError, } from "./events.js";
import { notifySendFailure } from "./notify.js";
export { parseStreamFrame } from "./events.js";
/** 不展示给用户的轮次错误码（底层传输/网络错误，对用户无意义，且常被重试兜住） */
const SILENT_TURN_ERROR_CODES = new Set(['STREAM_CLOSED']);
/**
 * 出站路由器：持有会话级状态，按事件类型分发到处理器
 */
class OutboundRouter {
    buffers = new Map();
    /** 每会话当前流式 attemptId：LLM 重试会发布新 attempt，用于 reset 与迟到帧过滤 */
    streamAttempts = new Map();
    /** 每会话本轮已声明的交付文件（deliverables/presented，轮末清空） */
    presentedFiles = new Map();
    /** 每会话已见过的 present callId（轮内去重，防事件重放导致重复投递） */
    presentedCalls = new Map();
    /**
     * 每会话最后一笔在途文本发送（assistant/message 的 flush 是 fire-and-forget，
     * turn/end 时需等待其完成再投递交付文件，保证回复文本先于文件到达用户）。
     */
    pendingText = new Map();
    manager;
    bot;
    config;
    logger;
    toolsRegistry;
    deliverer;
    constructor(manager, bot, config, logger, toolsRegistry, deliverer) {
        this.manager = manager;
        this.bot = bot;
        this.config = config;
        this.logger = logger;
        this.toolsRegistry = toolsRegistry;
        this.deliverer = deliverer;
    }
    /** 事件分发入口 */
    route(session, raw) {
        const event = parseEvent(raw);
        if (event === undefined)
            return;
        const record = this.manager.findBySessionId(session.header.id);
        if (record === undefined)
            return;
        switch (event.type) {
            case 'assistant/chunk':
                this.onChunk(session.header.id, record, event);
                break;
            case 'assistant/message':
                this.onMessage(session.header.id, record, event);
                break;
            case 'deliverables/presented':
                this.onPresented(session.header.id, event);
                break;
            case 'turn/end':
                this.onTurnEnd(session.header.id, record, event);
                break;
        }
    }
    /** durable assistant/chunk 事件：不再自动播给 QQ（说话只走 qq_draft + qq_confirm） */
    onChunk(_sessionId, _record, _event) {
        // 起草—确认模式下正文不落地：这里只保留事件入口，避免历史 buffer 越攒越大。
    }
    /**
     * 实时流式帧入口：起草—确认模式下不向 QQ 推送任何流式正文。
     * 这里只清理 attempt 状态，避免迟到帧再被当作新内容。
     */
    routeStreamFrame(agentId, delta) {
        if (delta.kind === 'attempt-start') {
            this.streamAttempts.set(agentId, delta.attemptId);
            this.buffers.get(agentId)?.reset();
        }
        // text-delta 一律丢弃：正文不自动发。
    }
    /** 获取或创建会话 buffer 并追加增量 */
    appendChunk(sessionId, record, text) {
        let buffer = this.buffers.get(sessionId);
        if (buffer === undefined) {
            buffer = new OutboundBuffer(record, this.bot, this.config.textChunkLimit, this.logger, this.shouldStream(record));
            this.buffers.set(sessionId, buffer);
        }
        buffer.append(text);
    }
    /** 是否启用流式：配置开启 + c2c + 有 msgId（群聊不支持流式） */
    shouldStream(record) {
        return this.config.streaming
            && record.replyTarget.scope === 'c2c'
            && !!record.replyTarget.msgId;
    }
    /** 完整 assistant 消息：正文不自动发（说话只走 qq_draft + qq_confirm） */
    onMessage(sessionId, _record, _event) {
        this.buffers.delete(sessionId);
    }
    /** 记录每会话最后一笔在途文本任务（自身吞错：错误已由 send/flush 内部记录） */
    trackText(sessionId, task) {
        this.pendingText.set(sessionId, task.catch(() => { }));
    }
    /** 收集本轮声明的交付文件：事件总是先于 turn/end 到达，轮末统一投递 */
    onPresented(sessionId, event) {
        if (this.config.sendFile?.sendPresentedFiles === false)
            return;
        let calls = this.presentedCalls.get(sessionId);
        if (calls === undefined) {
            calls = new Set();
            this.presentedCalls.set(sessionId, calls);
        }
        if (calls.has(event.callId))
            return;
        calls.add(event.callId);
        const files = this.presentedFiles.get(sessionId) ?? [];
        files.push(...event.files);
        this.presentedFiles.set(sessionId, files);
    }
    /**
     * 轮次结束：文本先送达、再投递交付文件、最后清理状态，异常结束时告知用户。
     * 外层轮次失败不撤销已完成的声明（宿主契约），故失败轮的文件仍投递。
     */
    onTurnEnd(sessionId, record, event) {
        const buffer = this.buffers.get(sessionId);
        // 起草—确认模式下轮末不补发正文：残留 buffer 直接取消。
        if (buffer !== undefined) {
            buffer.cancel();
            this.buffers.delete(sessionId);
        }
        const flushTask = Promise.resolve();
        this.streamAttempts.delete(sessionId);
        const files = this.presentedFiles.get(sessionId) ?? [];
        this.presentedFiles.delete(sessionId);
        this.presentedCalls.delete(sessionId);
        // assistant/message 已在轮内先行发送的文本可能仍在途：与 turn/end 自身的 flush 一起等待
        const pending = this.pendingText.get(sessionId) ?? Promise.resolve();
        this.pendingText.delete(sessionId);
        const failure = extractTurnError(event.reason);
        void (async () => {
            await Promise.all([flushTask, pending]);
            if (failure !== undefined && !SILENT_TURN_ERROR_CODES.has(failure.code)) {
                await this.send(record, `⚠️ 本轮异常结束\n\`${failure.code}\`: ${failure.message}`, 'sendTurnEndError');
            }
            if (files.length > 0 && this.deliverer !== undefined) {
                await this.deliverer.deliver(record, files);
            }
            this.logger.debug(`im-qqbot: turn/end sessionId=${sessionId}`);
        })();
    }
    /** 统一发送：切分 + 逐 chunk 发送 + 失败注入（失败要让模型当场知道，不能只进日志） */
    async send(record, text, tag) {
        const chunks = chunkMarkdownText(text, this.config.textChunkLimit);
        let sent = 0;
        for (const chunk of chunks) {
            try {
                await this.bot.sendMarkdown(record.replyTarget, chunk);
                sent += 1;
            }
            catch (err) {
                this.logger.error(`im-qqbot: ${tag} failed: ${err instanceof Error ? err.message : String(err)}`);
                notifySendFailure(record, err, {
                    kind: tag === 'sendTurnEndError' ? 'notice' : 'text',
                    sent,
                    total: chunks.length,
                    dedup: tag,
                });
                // 后面几块别接着发了：缺口那块补不上，再往后发出去就是错位的半截话
                break;
            }
        }
    }
}
/**
 * 创建出站事件处理器
 *
 * 返回 durable 事件与实时流式帧两个入口，分别注册到
 * ctx.on('session/event') 与 ctx.on('agent/assistant-stream', ..., { global: true })。
 * toolsRegistry 用于工具结果的结构化展示；deliverer 用于轮末投递 present 声明的交付文件。
 */
export function createOutboundHandler(manager, bot, config, logger, toolsRegistry, deliverer) {
    const router = new OutboundRouter(manager, bot, config, logger, toolsRegistry, deliverer);
    return {
        routeSessionEvent: (session, event) => router.route(session, event),
        routeStreamFrame: (agentId, delta) => router.routeStreamFrame(agentId, delta),
    };
}
//# sourceMappingURL=outbound.js.map