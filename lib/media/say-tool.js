/**
 * 内置 qqbot_say 工具 —— 让模型自己决定「这一轮回哪几句」。
 *
 * 官方插件默认把 assistant 的整段正文直接发出去（流式或整块），像客服。这里改成
 * 由模型按人设主动说话：想回就调 1–3 次 qqbot_say，每句短；调过之后本轮正文
 * 不再自动发送（outbound 看 record.saidViaTool 抑制），没调用才退回原来的
 * 「轮末发一条正文」的兜底行为。
 */
import { chunkMarkdownText } from "../transport/chunker.js";
/** 工具名（qqbot 前缀避免与其他通道的同名工具冲突） */
export const SAY_TOOL_NAME = 'qqbot_say';
const DESCRIPTION = 'Send one short chat message to the QQ user or group of the current conversation. '
    + 'Call this 1-3 times per turn to say what you want to say, one sentence per call. '
    + 'Keep each message under 25 Chinese characters. '
    + 'If you call this at least once, the assistant text of this turn will NOT be sent again.';
/** 注册 qqbot_say 工具（tools 服务缺失时优雅降级，不阻断插件启动） */
export function registerSayTool(ctx, sender, manager, config, logger) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn('im-qqbot: tools 服务不可用，qqbot_say 工具未注册');
        return;
    }
    const limit = Math.max(1, Math.min(config.textChunkLimit ?? 4500, 2000));
    const definition = {
        name: SAY_TOOL_NAME,
        description: DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                text: {
                    type: 'string',
                    description: '一条要发出去的聊天消息（尽量 25 字以内）',
                },
            },
            required: ['text'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    chars: { type: 'integer' },
                },
                required: ['ok', 'chars'],
                additionalProperties: false,
            },
            render: (_args, value) => [{ type: 'text', text: `已发送（${value.chars} 字）` }],
        },
        async execute(args, exec) {
            const text = String(args?.text ?? '').trim();
            if (!text) {
                throw new Error('qqbot_say: text 不能为空');
            }
            if (text.length > limit) {
                throw new Error(`qqbot_say: 单条太长（${text.length} > ${limit}），请拆成更短的几句`);
            }
            const record = manager.findByAgent(exec.agent);
            if (record === undefined) {
                throw new Error('qqbot_say: 当前会话不是 QQ 会话，无法发送');
            }
            const chunks = chunkMarkdownText(text, config.textChunkLimit ?? 4500);
            for (const chunk of chunks) {
                await sender.sendMarkdown(record.replyTarget, chunk);
            }
            record.saidViaTool = true;
            return { ok: true, chars: text.length };
        },
    };
    tools.register(definition);
    logger.info('im-qqbot: qqbot_say 工具已注册');
}
