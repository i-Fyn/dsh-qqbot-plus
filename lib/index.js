import { ConfigSchema } from "./config.js";
import { bootstrapGateway } from "./gateway/index.js";
import { getProfileDir, resolveEnv } from "./shared/index.js";
import { ensureCredentials, persistCredentialsToProfile, registerBoundCredentialRoutes } from "./setup/index.js";
import { qqRulesText } from "./rules.js";
import { turnCheckText } from "./turn-check.js";
import { resumeCheckText } from "./resume-check.js";
import { startAlarms } from "./alarms.js";
import { ORDER } from "./shared/orders.js";
import { mountHumanlike } from "./humanlike/plugin.js";
import { mountFishMemory } from "./fishmemory/plugin.js";
// ── Cordis 插件元数据 ──
export const name = 'im-qqbot';
export const inject = ['agents'];
export const Config = ConfigSchema;
// ── 插件主体 ──
export async function apply(ctx, config) {
    // ── 硬规矩：先发消息，再写正文 ──
    // 放在最前面，凭据缺失提前 return 时也照样注册。走 context 而不是 section。
    try {
        ctx.inject(['systemPrompt'], (inner) => {
            inner.effect(() => inner.systemPrompt.context({
                name: 'qqbot/rules',
                order: ORDER.qqRules,
                interpolate: false,
                text: () => qqRulesText() + turnCheckText() + resumeCheckText(),
            }));
        });
    }
    catch (error) {
        ctx.logger?.warn?.(`qqbot 规则段注册失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    // ── 人味：注入段 + 7 个家族工具 + 主动找人 + 设置接口（2026-11-20 从 dsh-humanlike 并进来） ──
    // 放在凭据分支之前：没绑号也照样有记忆与状态段。
    try {
        mountHumanlike(ctx, {});
    }
    catch (error) {
        ctx.logger?.warn?.(`人味模块挂载失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    // ── 记忆：索引段 72 / 按句召 9990 + 7 个记忆工具 + 服务门面 ──
    // 2026-11-20 从独立插件 dsh-fishmemory 并进来，数据在 <PLUGIN_HOME>/memory。
    try {
        mountFishMemory(ctx, {});
    }
    catch (error) {
        ctx.logger?.warn?.(`记忆模块挂载失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    const agents = ctx.agents;
    const logger = ctx.logger ?? console;
    let appId = resolveEnv(config.appId, 'QQBOT_APPID');
    let appSecret = resolveEnv(config.appSecret, 'QQBOT_SECRET');
    // ── 凭据缺失时唤起扫码绑定 ──
    if (!appId || !appSecret) {
        logger.info('凭据未配置，启动扫码绑定...');
        // 关键：不 await 扫码结果。boot 会等 Loader 树稳定（loader.await()），
        // 无限期等待用户扫码会阻塞 Host ready——Desktop 界面无法进入、
        // Web 的 URL 延迟输出。绑定编排（路由/呈现/生命周期）在
        // ensureCredentials 的同步阶段即完成，凭据就绪后由异步链接管。
        void ensureCredentials(ctx, { logger, config: { ...config } })
            .then((credentials) => {
            if (!credentials) {
                // null 包括：扫码取消、手动提交（已另行持久化）、流程失败
                logger.info('扫码绑定流程结束（未获取凭据或已手动配置）');
                return;
            }
            // 持久化到 profile：成功则等待热更新重载，失败则用凭据直接启动。
            // 注意：不写入 process.env——resolveEnv 的 env 回退属于用户显式
            // export 的配置语义，运行时写入会与解绑清理不对齐（解绑后 HMR
            // 重载的新 fiber 仍从 env 读到旧凭据，状态停留 bound）
            const persisted = persistCredentialsToProfile(credentials, getProfileDir() ?? undefined, logger);
            if (persisted) {
                // 写入 cordis.patch.yml 会触发 dsh 热更新，自动重新加载本插件。
                logger.info('配置已保存，等待热更新重新加载...');
                return;
            }
            logger.warn('凭据未能持久化，本次进程将使用环境变量凭据启动（重启后需重新绑定）');
            // 本 fiber 已激活（ctx 有效），直接以凭据启动网关
            void bootstrapGateway(ctx, agents, {
                ...config,
                appId: credentials.appId,
                appSecret: credentials.appSecret,
            }, logger).catch((err) => {
                logger.error(`网关启动失败: ${err instanceof Error ? err.message : String(err)}`);
            });
        })
            .catch((err) => {
            // 全兜：unhandled rejection 会被宿主 fail-loud 判致命
            logger.error(`扫码绑定流程异常: ${err instanceof Error ? err.message : String(err)}`);
        });
        // apply 立即完成，插件 fiber 进入 ACTIVE，Host ready 不再被阻塞
        return;
    }
    // 已绑定：注册常驻路由（状态回显 + 手动编辑/更换凭据 + 配置编辑）
    registerBoundCredentialRoutes(ctx, logger, appId, { ...config });
    const resolvedConfig = { ...config, appId, appSecret };
    await bootstrapGateway(ctx, agents, resolvedConfig, logger);
    // ── 唤醒器：每秒一跳，挑到 idle 会话再取到点的条目 ──
    try {
        const alarmHandle = startAlarms({ ctx, agents, logger });
        ctx.effect(() => () => alarmHandle.stop(), 'im-qqbot.alarms');
        logger.info(`唤醒器：开（${alarmHandle.status().count} 条等着）`);
    }
    catch (error) {
        logger.warn(`唤醒器启动失败: ${error instanceof Error ? error.message : String(error)}`);
    }
}
//# sourceMappingURL=index.js.map