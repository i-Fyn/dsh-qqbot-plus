import { getScopePeer } from "../shared/index.js";
/** /new — 换一条新会话（旧的留在盘上，历史不删） */
export function newCommand({ manager }) {
    return {
        name: 'new',
        category: 'agent',
        scope: 'all',
        description: '换一条新会话（旧的留着，下一条消息就是新开头）',
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            // 共享会话模式下 remove 会轮换共享 id，非共享模式只换 key 的映射，
            // 两种情况都给下一条消息留下一条干净会话；旧会话不删。
            await manager.remove(scope, peerId);
            return '✅ 换了条新会话（旧的还在，下一条消息就是新开头）';
        },
    };
}
