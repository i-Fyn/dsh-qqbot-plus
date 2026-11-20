/**
 * qq_resume_check：把「宿主刚重启」这件事变成一次工具调用。
 *
 * 以前是宿主启动时往会话里注一段用户消息；那段消息会去找最后一条入站的会话
 * （常常是旧的），而且每重启一次就多一段历史。现在只留这一个工具：
 * 系统提示里出现一行「先调它」，调完这行就消失，内容都在回执里。
 */
import { consumeResume, resumeCheckPayload } from './resume-check.js';

const textResult = (value) => [{ type: 'text', text: String(value) }];

export function registerResumeTool(ctx, logger) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger?.warn?.('im-qqbot: tools 服务不可用，qq_resume_check 未注册');
        return;
    }
    tools.register({
        name: 'qq_resume_check',
        description: '宿主刚重启过时先调这个：看上一轮对方有没有还没回的话、这次停了多久。有就接着做完再回话，没有就 qq_skip。调一次这条提醒就清掉。',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        output: { schema: { type: 'string' }, render: (_args, value) => textResult(value) },
        async execute() {
            const payload = resumeCheckPayload();
            consumeResume();
            return JSON.stringify(payload);
        },
    });
}
