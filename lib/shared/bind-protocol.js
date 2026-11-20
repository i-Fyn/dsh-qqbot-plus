/**
 * 端内绑定协议 —— 宿主路由与客户端面板的共享契约
 *
 * 类型与路径常量的唯一事实源：宿主（setup/bind-routes.ts）与浏览器
 * （client/bind-page.ts）各自 import，杜绝两端协议漂移。
 * 本模块必须保持纯类型 + 纯常量（零 node 依赖、零副作用）：
 * 客户端 tsdown 构建会将其内联进 bundle。
 */
/** 状态查询（绑定页轮询） */
export const BIND_STATE_PATH = '/qqbot/im-qqbot/bind';
/** 刷新二维码（绑定页按钮） */
export const BIND_REFRESH_PATH = '/qqbot/im-qqbot/bind/refresh';
/** 手动填写/编辑凭据（绑定页表单） */
export const BIND_MANUAL_PATH = '/qqbot/im-qqbot/bind/manual';
/** 解绑：移除已保存凭据，回到绑定流程 */
export const BIND_UNBIND_PATH = '/qqbot/im-qqbot/bind/unbind';
/** 配置读写（设置面板表单） */
export const BIND_CONFIG_PATH = '/qqbot/im-qqbot/config';
/** 模型 / 预设目录（设置面板下拉） */
export const BIND_CATALOG_PATH = '/qqbot/im-qqbot/catalog';
/** 人设 / 画像（设置面板编辑，存在自家数据目录） */
export const BIND_PERSONA_PATH = '/qqbot/im-qqbot/persona';
export const BIND_PORTRAIT_PATH = '/qqbot/im-qqbot/portrait';
/** 记忆（设置面板查看 / 删除） */
/** 规则（在 QQ 里怎么回话：rules.md，设置面板编辑） */
export const BIND_RULES_PATH = '/qqbot/im-qqbot/rules';
/** 选择文件夹（表情包目录用系统选择器） */
export const BIND_PICK_DIR_PATH = '/qqbot/im-qqbot/pick-dir';
//# sourceMappingURL=bind-protocol.js.map