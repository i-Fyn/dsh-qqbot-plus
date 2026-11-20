/**
 * dsh-im-qqbot 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';
/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema = Schema.object({
    c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('C2C访问模式（默认开放）'),
    c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单（QQ OpenID）'),
    groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('群聊访问模式（默认开放：群自带进群门槛 + @bot 触发）'),
    groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单（群 OpenID）'),
});
export const ConfigSchema = Schema.object({
    appId: Schema.string().default('').description('QQ 机器人 AppID'),
    appSecret: Schema.string().default('').description('QQ 机器人 AppSecret'),
    provider: Schema.string().description('LLM provider name'),
    model: Schema.string().description('Model name'),
    preset: Schema.string().description('Agent preset id'),
    cwd: Schema.string().description('Agent working directory (default ~/.dsh/dsh-qqbot-plus/workspace)'),
    requireMention: Schema.boolean().default(true).description('群聊是否需要@bot触发'),
    allowSilence: Schema.boolean().default(true).description('允许它不出声：这一轮可以判断没必要接，安静过去，不用硬回'),
    sharedSession: Schema.boolean().default(false).description('群聊和私聊共用同一条会话（默认关：各聊各的，回复不会串到别的群/私聊）'),
    textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
    streaming: Schema.boolean().default(true).description('是否启用流式输出（群聊始终不启用）'),
    sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置超时(ms)'),
    maxQueue: Schema.number().default(20).description('并发队列最大长度'),
    processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('处理超时(ms)，超时中断当前 LLM 调用'),
    askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('待答问题超时(ms)，超时自动拒绝并提示'),
    historyLimit: Schema.number().default(10).description('群历史缓冲条数'),
    access: AccessControlSchema.default({
        c2cMode: 'open',
        c2cAllow: [],
        groupMode: 'open',
        groupAllow: [],
    }).description('访问控制'),
    midTurnSteer: Schema.boolean().default(true).description('干活时插话：正在跑的时候新消息直接插进下一步，不等这一轮结束'),
    burstWindowMs: Schema.number().default(2500).description('连发合并：安静这么久(ms)才算说完，连着的几句合成一条投；0 = 不合并'),
    maxBurstMs: Schema.number().default(12000).description('连发合并：一直发个不停时最多等这么久(ms)就必须投'),
    maxBurstCount: Schema.number().default(6).description('连发合并：攒到这么多条立刻投'),
    resumeOnBoot: Schema.boolean().default(true).description('重启接话检查：宿主重启后只在系统提示里加一行「先调 qq_resume_check」，由工具按需读停机时长与对方最后一条话；不往任何会话注入消息'),
    debug: Schema.boolean().default(false),
    media: Schema.object({
        enabled: Schema.boolean().default(true).description('是否启用富媒体理解（图片/视频下载 + 工具分析）'),
        maxMB: Schema.number().default(200).description('富媒体下载大小上限(MB)'),
        ttlHours: Schema.number().default(24).description('富媒体存活时长(小时)，0=永不过期'),
    }).default({
        enabled: true,
        maxMB: 200,
        ttlHours: 24,
    }).description('富媒体理解配置'),
    vision: Schema.object({
        enabled: Schema.boolean().default(false).description('是否启用视觉理解（qqbot_describe_image 工具）'),
        provider: Schema.string().default('').description('视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai）'),
        model: Schema.string().default('').description('视觉模型 id（如 qwen-vl-max）'),
        defaultPrompt: Schema.string().default('Describe this image in detail.').description('默认描述 prompt'),
        maxBytes: Schema.number().default(10 * 1024 * 1024).description('图片字节上限'),
        maxTokens: Schema.number().default(1024).description('输出 token 上限'),
        timeoutMs: Schema.number().default(120000).description('视觉调用超时(ms)'),
    }).default({
        enabled: false,
        provider: '',
        model: '',
        defaultPrompt: 'Describe this image in detail.',
        maxBytes: 10 * 1024 * 1024,
        maxTokens: 1024,
        timeoutMs: 120000,
    }).description('视觉理解配置'),
    sendFile: Schema.object({
        restrictPaths: Schema.boolean().default(true).description('是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots）'),
        extraRoots: Schema.array(Schema.string()).default([]).description('额外允许访问的根目录'),
        sendPresentedFiles: Schema.boolean().default(true).description('是否将 present 声明的交付文件发送到当前会话'),
        maxFiles: Schema.number().default(4).description('单轮最多投递的交付文件数'),
    }).default({
        restrictPaths: true,
        extraRoots: [],
        sendPresentedFiles: true,
        maxFiles: 4,
    }).description('附件发送配置'),
    memory: Schema.object({
        enabled: Schema.boolean().default(true).description('是否启用人设/画像注入'),
        personaFile: Schema.string().default('').description('人设文件（留空 = ~/.dsh/dsh-qqbot-plus/persona.md）'),
        portraitFile: Schema.string().default('').description('画像文件（留空 = ~/.dsh/dsh-qqbot-plus/portrait.md）'),
    }).default({
        enabled: true,
        personaFile: '',
        portraitFile: '',
    }).description('人设 / 画像（长期记忆在 humanlike 与 memory 两块，不在这里）'),
});
//# sourceMappingURL=config.js.map