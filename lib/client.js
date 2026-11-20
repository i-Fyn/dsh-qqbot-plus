/**
 * dsh-qqbot-plus 的前端半边（整份只有一个模块，宿主只认这一个）。
 *
 * 分区（自上而下）：
 *   1. 绑定协议常量 + 小工具（fetch 包装、格式化、样式表 STYLE_ID$1）
 *   2. BindPanelBody —— 扫码 / 手动绑定 / 解绑
 *   3. QQBotConfigBody —— 机器人配置表单（原 ConfigPanel，接宿主配置 + 插件自有数据）
 *   4. ConfigPanel —— 页签外壳：机器人 / 人味，两句都在这一个入口里
 *   5. QQBotSettingsSection —— 设置页里的「QQ 机器人」分区（绑定位 + 上面那套页签）
 *   6. QQBotPage / OpenQqBotAction —— 插件详情页的独立页与「设置」按钮
 *   7. HumanlikeSection + mountHumanlikeSettings —— 人味七组参数、规则卡、locales 与样式，
 *      由主 apply 调用挂上（人味已并进本插件，不再单独注册设置分区）
 *
 * 改这里注意：exports.inject 必须写全用到的服务（slots / locale / sidebarRight …），
 * 少一个不会报错，只会在运行时静默不渲染。
 */
window.__ModuleLoader__.load({
	id: "dsh-qqbot-plus",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/shared/bind-protocol.ts
		/**
		* 端内绑定协议 —— 宿主路由与客户端面板的共享契约
		*
		* 类型与路径常量的唯一事实源：宿主（setup/bind-routes.ts）与浏览器
		* （client/bind-page.ts）各自 import，杜绝两端协议漂移。
		* 本模块必须保持纯类型 + 纯常量（零 node 依赖、零副作用）：
		* 客户端 tsdown 构建会将其内联进 bundle。
		*/
		/** 状态查询（绑定页轮询） */
		const BIND_STATE_PATH = "/qqbot/im-qqbot/bind";
		/** 刷新二维码（绑定页按钮） */
		const BIND_REFRESH_PATH = "/qqbot/im-qqbot/bind/refresh";
		/** 手动填写/编辑凭据（绑定页表单） */
		const BIND_MANUAL_PATH = "/qqbot/im-qqbot/bind/manual";
		/** 解绑：移除已保存凭据，回到绑定流程 */
		const BIND_UNBIND_PATH = "/qqbot/im-qqbot/bind/unbind";
		/** 配置读写（设置面板表单） */
		const BIND_CONFIG_PATH = "/qqbot/im-qqbot/config";
		/** 模型 / 预设目录（设置面板下拉） */
		const BIND_CATALOG_PATH = "/qqbot/im-qqbot/catalog";
		/** 人设 / 画像（机器人自己的数据目录） */
		const BIND_PERSONA_PATH = "/qqbot/im-qqbot/persona";
		const BIND_PORTRAIT_PATH = "/qqbot/im-qqbot/portrait";
		/** 规则（在 QQ 里怎么回话：rules.md，设置面板编辑） */
		const BIND_RULES_PATH = "/qqbot/im-qqbot/rules";
		const BIND_PICK_DIR_PATH = "/qqbot/im-qqbot/pick-dir";
		//#endregion
		//#region src/client/bind-page.ts
		/**
		* 端内绑定面板 — 扫码 / 手动填写 / 已绑定编辑
		*
		* 宿主插件注册 /qqbot/im-qqbot/bind 路由（待绑定与已绑定 fiber 均常驻）：
		* - 未绑定：waiting（二维码）/ starting / saving / failed 相位 + manual 提交
		* - 已绑定：bound 相位（回显脱敏 appId，secret 不回传）+ manual 更换 + 解绑
		* 扫码成功或手动保存均写入 profile patch 并经 HMR 重载生效。
		*
		* 样式为注入式 CSS 类（imqb-* 命名空间，随面板挂载注入一次）：
		* hover/过渡/focus 样式无法用 inline style 表达，统一走类；
		* 颜色尽量取 DSW 主题变量（--dsw-alias-*），缺省值兜底。
		*
		* 同一组件复用于两种展示位（侧栏绑定页 / 设置页 QQ Bot 栏目）。
		* 运行时仅依赖 react（dsh 客户端平台种子表提供）；宿主通信走同源 fetch，
		* Desktop 下由壳的 IPC 桥自动附加 Host 认证转发。
		*/
		/** 轮询间隔（毫秒）：活跃轮询 / 失败退避 */
		const ACTIVE_POLL_MS = 2e3;
		const RETRY_POLL_MS = 3e3;
		/** 样式注入标记（幂等） */
		const STYLE_ID$1 = "im-qqbot-bind-panel-styles";
		/**
		* 注入面板样式（全局一次，幂等）。交互态（hover/active/focus）无法用 inline
		* style 表达，统一收敛到类；DSW 主题变量缺失时用中性值兜底。
		* 插件激活时即安装：插件详情按钮渲染在面板之外，需提前可见；
		* 安装后不再随挂载移除，避免多个展示位互相清掉样式。
		*/
		function installPanelStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID$1) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID$1;
			style.textContent = `
.imqb-panel {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px; padding: 24px; min-height: 320px; text-align: center; font-size: 14px;
}
.imqb-title { margin: 0; font-size: 16px; font-weight: 600; }
.imqb-hint { margin: 0; opacity: 0.75; line-height: 1.6; }
.imqb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.imqb-link { font-size: 13px; opacity: 0.85; color: var(--dsw-alias-brand, #4d6bfe); text-decoration: none; }
.imqb-link:hover { text-decoration: underline; }
.imqb-icon { font-size: 32px; line-height: 1; }
.imqb-qr { border-radius: 10px; background: #fff; padding: 10px; max-width: 100%; }
.imqb-row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.imqb-btn, .imqb-pill {
  font: inherit; cursor: pointer; color: inherit;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease, opacity .15s ease;
}
.imqb-btn:disabled, .imqb-pill:disabled { opacity: 0.5; cursor: default; }
.imqb-btn {
  padding: 7px 18px; border-radius: 8px; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4));
  background: transparent;
}
.imqb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }
.imqb-btn--primary {
  border-color: transparent;
  background: var(--dsw-alias-brand, #4d6bfe); color: #fff; font-weight: 500;
}
.imqb-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-brand-strong, #3b5cf0); }
.imqb-btn--danger { color: var(--dsw-alias-danger, #f26d6d); border-color: var(--dsw-alias-danger, rgba(242, 109, 109, 0.5)); }
.imqb-btn--danger:hover:not(:disabled) { background: var(--dsw-alias-danger, rgba(242, 109, 109, 0.12)); }
.imqb-ghost {
  border: none; background: transparent; opacity: 0.65; padding: 4px 8px;
  font: inherit; font-size: 13px; cursor: pointer; color: inherit;
}
.imqb-ghost:hover { opacity: 1; text-decoration: underline; }
/* 插件详情「设置」按钮：30px，略高于旁边的 sm 次要按钮 */
.imqb-pluginOpen {
  display: inline-flex; align-items: center; justify-content: center;
  box-sizing: border-box; height: 30px; padding: 0 14px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4));
  border-radius: 8px; background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit); font: inherit;
  font-size: 13px; line-height: 20px; cursor: pointer;
}
.imqb-pluginOpen:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }
.imqb-pluginOpen:focus-visible { outline: 2px solid var(--dsw-alias-brand, #4d6bfe); outline-offset: 3px; }
@media (pointer: coarse) { .imqb-pluginOpen { height: 44px; } }
/* 主面板页面容器（layout.selectPanel 目标）：滚动 + 留白 */
.imqb-pluginPage {
  height: 100%; min-height: 0; overflow: auto; box-sizing: border-box;
  padding: 24px clamp(16px, 4vw, 48px) 32px;
  color: var(--dsw-alias-label-primary, #1f2329);
}
.imqb-pluginPageContent { max-width: 1080px; margin: 0 auto; }
.imqb-pill {
  padding: 5px 16px; border-radius: 999px; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4)); background: transparent;
}
.imqb-pill:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }
.imqb-btn:focus-visible, .imqb-pill:focus-visible, .imqb-input:focus-visible, .imqb-ghost:focus-visible {
  outline: 2px solid var(--dsw-alias-brand, #4d6bfe); outline-offset: 1px;
}
.imqb-form { display: flex; flex-direction: column; gap: 12px; width: min(320px, 100%); box-sizing: border-box; }
.imqb-field { display: flex; flex-direction: column; gap: 5px; text-align: left; font-size: 13px; }
.imqb-input {
  padding: 8px 10px; border-radius: 8px; box-sizing: border-box; width: 100%;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4));
  background: var(--dsw-alias-bg-input, rgba(128, 128, 128, 0.08));
  color: inherit; font: inherit; font-size: 13px; outline: none;
}
.imqb-input:focus { border-color: var(--dsw-alias-brand, #4d6bfe); }
.imqb-error { margin: 0; font-size: 12px; color: var(--dsw-alias-danger, #f26d6d); }
/* 紧凑状态视图（已绑定 / 过渡态）：设置行风格，无居中大卡留白 */
.imqb-status { display: flex; flex-direction: column; text-align: left; font-size: 14px; }
.imqb-status-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
.imqb-status-icon { font-size: 24px; line-height: 1; flex: none; }
.imqb-qqicon {
  flex: none; display: block; border-radius: 8px; /* 透明底，QQ 蓝徽标在明暗主题下均清晰 */
}
.imqb-status-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.imqb-status-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5; }
.imqb-status-sub { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, inherit); opacity: .85; }
.imqb-status-actions { display: flex; align-items: center; gap: 8px; padding: 4px 0 12px; }
/* 扫码成功后的连接过渡：二维码模糊变暗 + 覆盖层 */
.imqb-scanned { position: relative; display: inline-block; }
.imqb-scanned-qr {
  display: block; border-radius: 10px; background: #fff; padding: 10px;
  filter: blur(6px) saturate(0.6); opacity: 0.55;
}
.imqb-scanned-veil {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 6px; text-align: center;
}
.imqb-scanned-title { margin: 0; font-size: 15px; font-weight: 600; }
.imqb-scanned-sub { margin: 0; font-size: 12px; opacity: 0.75; line-height: 1.6; }
    `;
			document.head.appendChild(style);
		}
		function usePanelStyles() {
			(0, react.useEffect)(() => {
				installPanelStyles();
			}, []);
		}
		/**
		* 绑定状态轮询 hook。
		*
		* 404 语义分两种：从未拿到过路由 = 插件未启用（终态）；
		* 曾经拿到过 = HMR 重载窗口期（manual/unbind 保存后路由短暂消失），
		* 低频等待恢复而不是判定终态——否则保存成功提示会被
		* 「插件未启用」覆盖且无法自愈。
		*
		* bound 为稳定态：轮询大幅降频（30s）。因此解绑等本地动作后必须
		* 调用 recheck() 立即重置节拍——否则视图最长停留 30s+ 才收敛到
		* 新相位（如解绑后的 waiting 二维码）。
		*
		* @returns 轮询快照与 recheck：state 为宿主相位（null = 加载中），
		*          gone 表示插件未启用（从未注册过路由），recheck 废弃当前
		*          定时器并立即重新轮询（新轮询链取代旧链，不产生双计时器）。
		*/
		function useBindState(enabled = true) {
			const [state, setState] = (0, react.useState)(null);
			const [gone, setGone] = (0, react.useState)(false);
			const recheckRef = (0, react.useRef)(() => {});
			(0, react.useEffect)(() => {
				if (!enabled) return;
				let stopped = false;
				let sawRoute = false;
				let generation = 0;
				let running = false;
				let restartAfterFlight = false;
				let urgentUntil = 0;
				let timer;
				const schedule = (ms) => {
					timer = setTimeout(() => {
						tick();
					}, ms);
				};
				const intervalFor = (phase) => {
					const base = phase === "saving" ? 500 : phase === "bound" ? 3e4 : ACTIVE_POLL_MS;
					return Date.now() < urgentUntil ? Math.min(base, ACTIVE_POLL_MS) : base;
				};
				const tick = async () => {
					if (stopped || running) return;
					running = true;
					const myGeneration = generation;
					const alive = () => myGeneration === generation && !stopped;
					try {
						const res = await fetch(BIND_STATE_PATH, { cache: "no-store" });
						if (res.status === 404) {
							if (!stopped && !sawRoute) setGone(true);
							else if (alive()) schedule(Date.now() < urgentUntil ? 1e3 : 3e3);
							return;
						}
						if (!res.ok) {
							if (alive()) schedule(RETRY_POLL_MS);
							return;
						}
						sawRoute = true;
						const body = await res.json();
						if (!alive()) return;
						setState(body);
						schedule(intervalFor(body.phase));
						return;
					} catch {} finally {
						running = false;
						if (restartAfterFlight && !stopped) {
							restartAfterFlight = false;
							tick();
						}
					}
					if (alive()) schedule(RETRY_POLL_MS);
				};
				recheckRef.current = () => {
					generation += 1;
					urgentUntil = Date.now() + 15e3;
					if (timer !== void 0) clearTimeout(timer);
					if (running) {
						restartAfterFlight = true;
						return;
					}
					tick();
				};
				tick();
				return () => {
					stopped = true;
					if (timer !== void 0) clearTimeout(timer);
				};
			}, []);
			return {
				state,
				gone,
				recheck: (0, react.useCallback)(() => {
					recheckRef.current();
				}, [])
			};
		}
		/** 手动提交凭据（填写 / 更换共用） */
		async function submitManualCredentials(appId, appSecret) {
			try {
				const res = await fetch(BIND_MANUAL_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						appId,
						appSecret
					})
				});
				const body = await res.json().catch(() => ({}));
				if (res.ok && body.ok) return {
					ok: true,
					message: body.message
				};
				return {
					ok: false,
					error: body.error ?? `保存失败（HTTP ${res.status}）`
				};
			} catch (err) {
				return {
					ok: false,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		}
		/**
		* 手动凭据表单（填写 / 更换共用）。
		*
		* appSecret 永不回显（占位符提示），提交成功后展示保存结果；
		* 宿主写入 profile patch 并经 HMR 重载，状态轮询随后收敛为 bound。
		*/
		function ManualForm({ initialAppId }) {
			const [appId, setAppId] = (0, react.useState)(initialAppId ?? "");
			const [appSecret, setAppSecret] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [result, setResult] = (0, react.useState)(null);
			const submit = (0, react.useCallback)((event) => {
				event.preventDefault();
				if (busy) return;
				const trimmedId = appId.trim();
				const trimmedSecret = appSecret.trim();
				if (trimmedId.length === 0 || trimmedSecret.length === 0) {
					setResult({
						ok: false,
						error: "appId 与 appSecret 均为必填"
					});
					return;
				}
				setBusy(true);
				submitManualCredentials(trimmedId, trimmedSecret).then((outcome) => {
					setResult(outcome);
					setBusy(false);
				});
			}, [
				appId,
				appSecret,
				busy
			]);
			if (result !== null && result.ok) return (0, react.createElement)("div", { className: "imqb-status" }, (0, react.createElement)("div", { className: "imqb-status-row" }, (0, react.createElement)("div", { className: "imqb-status-icon" }, "✅"), (0, react.createElement)("div", { className: "imqb-status-meta" }, (0, react.createElement)("p", { className: "imqb-status-title" }, result.message ?? "凭据已保存"), (0, react.createElement)("p", { className: "imqb-status-sub" }, "插件将自动重载；稍后即可开始对话"))));
			return (0, react.createElement)("form", {
				className: "imqb-form",
				onSubmit: submit
			}, (0, react.createElement)("label", { className: "imqb-field" }, "AppID", (0, react.createElement)("input", {
				className: "imqb-input",
				value: appId,
				placeholder: "QQ 机器人 AppID",
				onChange: (event) => {
					setAppId(event.currentTarget.value);
				},
				autoComplete: "off",
				spellCheck: false
			})), (0, react.createElement)("label", { className: "imqb-field" }, "AppSecret", (0, react.createElement)("input", {
				className: "imqb-input",
				type: "password",
				value: appSecret,
				placeholder: initialAppId === void 0 ? "QQ 机器人 AppSecret" : "输入新的 AppSecret（不回显）",
				onChange: (event) => {
					setAppSecret(event.currentTarget.value);
				},
				autoComplete: "new-password"
			})), result !== null && !result.ok ? (0, react.createElement)("p", { className: "imqb-error" }, result.error) : null, (0, react.createElement)("button", {
				className: "imqb-btn imqb-btn--primary",
				type: "submit",
				disabled: busy
			}, busy ? "正在保存…" : "保存"));
		}
		/** QQ 机器人 logo 路径（assets/icons/qqbot_logo.svg，内嵌以保持 bundle 自包含） */
		const QQ_BOT_LOGO_PATH = "M19.3862 15.5001C19.3861 11.4203 16.0789 8.11296 11.999 8.11292C7.91915 8.11292 4.61203 11.4203 4.61182 15.5001V17.0001C4.61182 18.5949 5.90429 19.8873 7.49902 19.8873H16.499C18.0937 19.8873 19.3862 18.5949 19.3862 17.0001V15.5001ZM10.6118 14.0001C10.6118 14.6145 10.1129 15.1134 9.49853 15.1134C8.8843 15.1132 8.38672 14.6144 8.38672 14.0001V12.0006C8.38672 11.3863 8.8843 10.8875 9.49853 10.8873C10.1129 10.8873 10.6118 11.3862 10.6118 12.0006V14.0001ZM15.6113 14.0001C15.6113 14.6143 15.1136 15.1131 14.4995 15.1134C13.8851 15.1134 13.3862 14.6145 13.3862 14.0001V12.0006C13.3862 11.3862 13.8851 10.8873 14.4995 10.8873C15.1136 10.8876 15.6113 11.3864 15.6113 12.0006V14.0001ZM14.2607 3.04895C14.2607 3.89351 13.7957 4.62474 13.1108 5.0133V5.95374C17.8958 6.50514 21.6112 10.5676 21.6113 15.5001V17.0001C21.6113 19.8237 19.3225 22.1124 16.499 22.1124H7.49902C4.67546 22.1124 2.38672 19.8237 2.38672 17.0001V15.5001C2.38691 10.568 6.10139 6.50571 10.8857 5.95374V5.01185C10.2017 4.62305 9.73583 3.89286 9.73583 3.04895C9.73609 1.79961 10.7496 0.787231 11.999 0.787231C13.2484 0.787297 14.2605 1.79966 14.2607 3.04895Z";
		/** QQ 机器人图标（logo 矢量渲染，透明底，随 size 缩放） */
		function QqBotIcon({ size = 28 }) {
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": true,
				className: "imqb-qqicon"
			}, (0, react.createElement)("path", {
				d: QQ_BOT_LOGO_PATH,
				fill: "#0085FF"
			}));
		}
		/** 已绑定视图：回显 appId + 更换凭据 / 解绑入口 */
		function BoundView({ appId, recheck }) {
			const [editing, setEditing] = (0, react.useState)(false);
			const [unbindResult, setUnbindResult] = (0, react.useState)(null);
			const unbind = (0, react.useCallback)(() => {
				if (!window.confirm("确定解绑吗？\n解绑后机器人立即下线，插件将重新进入扫码绑定流程。")) return;
				fetch(BIND_UNBIND_PATH, { method: "POST" }).then(async (res) => {
					const body = await res.json().catch(() => ({}));
					if (res.ok && body.ok === true) {
						setUnbindResult({
							ok: true,
							message: body.message ?? "已解绑，插件将重载并重新进入绑定流程"
						});
						recheck();
						return;
					}
					setUnbindResult({
						ok: false,
						message: body.error ?? `解绑失败（HTTP ${res.status}）`
					});
				}).catch((err) => {
					setUnbindResult({
						ok: false,
						message: err instanceof Error ? err.message : String(err)
					});
				});
			}, [recheck]);
			if (unbindResult !== null) return (0, react.createElement)("div", { className: "imqb-status" }, (0, react.createElement)("div", { className: "imqb-status-row" }, (0, react.createElement)("div", { className: "imqb-status-icon" }, unbindResult.ok ? "👋" : "⚠️"), (0, react.createElement)("div", { className: "imqb-status-meta" }, (0, react.createElement)("p", { className: "imqb-status-title" }, unbindResult.message)), unbindResult.ok ? (0, react.createElement)("button", {
				className: "imqb-ghost",
				onClick: recheck
			}, "刷新状态") : (0, react.createElement)("button", {
				className: "imqb-ghost",
				onClick: () => {
					setUnbindResult(null);
				}
			}, "返回")));
			if (editing) return (0, react.createElement)("div", { className: "imqb-status" }, (0, react.createElement)("div", { className: "imqb-status-row" }, (0, react.createElement)("div", { className: "imqb-status-meta" }, (0, react.createElement)("p", { className: "imqb-status-title" }, "更换凭据")), (0, react.createElement)("button", {
				className: "imqb-ghost",
				onClick: () => {
					setEditing(false);
				}
			}, "返回")), (0, react.createElement)(ManualForm, { initialAppId: appId }));
			return (0, react.createElement)("div", { className: "imqb-status" }, (0, react.createElement)("div", { className: "imqb-status-row" }, (0, react.createElement)(QqBotIcon, { size: 28 }), (0, react.createElement)("div", { className: "imqb-status-meta" }, (0, react.createElement)("p", { className: "imqb-status-title" }, "已绑定"), (0, react.createElement)("p", { className: "imqb-status-sub imqb-mono" }, `AppID ${appId} · 私聊与群聊已接入`))), (0, react.createElement)("div", { className: "imqb-status-actions" }, (0, react.createElement)("button", {
				className: "imqb-btn imqb-btn--primary",
				onClick: () => {
					setEditing(true);
				}
			}, "更换凭据"), (0, react.createElement)("button", {
				className: "imqb-btn imqb-btn--danger",
				onClick: unbind
			}, "解绑")));
		}
		/** 未绑定视图：扫码 / 手动填写切换 */
		function UnboundView({ state }) {
			const [mode, setMode] = (0, react.useState)("qr");
			const refresh = (0, react.useCallback)(() => {
				fetch(BIND_REFRESH_PATH, { method: "POST" }).catch(() => {});
			}, []);
			const [imgFailed, setImgFailed] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				setImgFailed(false);
			}, [state.qrSvg]);
			if (mode === "manual") return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("p", { className: "imqb-title" }, "手动填写凭据"), (0, react.createElement)(ManualForm, {}), (0, react.createElement)("button", {
				className: "imqb-ghost",
				onClick: () => {
					setMode("qr");
				}
			}, "改用扫码绑定"));
			if (state.qrSvg === void 0 || imgFailed) return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("div", { className: "imqb-icon" }, "⚠️"), (0, react.createElement)("p", { className: "imqb-title" }, "二维码暂时无法显示"), (0, react.createElement)("p", { className: "imqb-hint" }, "可重启应用后重试，或任选下面一种方式继续"), (0, react.createElement)("a", {
				href: state.url,
				target: "_blank",
				rel: "noreferrer noopener",
				className: "imqb-link"
			}, "在浏览器中打开链接扫码"), (0, react.createElement)("div", { className: "imqb-row" }, (0, react.createElement)("button", {
				className: "imqb-pill",
				onClick: () => {
					setMode("manual");
				}
			}, "手动填写凭据")));
			return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("img", {
				src: state.qrSvg,
				alt: "QQ 扫码二维码",
				width: 220,
				height: 220,
				className: "imqb-qr",
				onError: () => {
					setImgFailed(true);
				}
			}), (0, react.createElement)("p", { className: "imqb-title" }, "扫码绑定 QQ 机器人"), (0, react.createElement)("p", { className: "imqb-hint" }, "使用手机 QQ 扫描二维码完成绑定"), (0, react.createElement)("a", {
				href: state.url,
				target: "_blank",
				rel: "noreferrer noopener",
				className: "imqb-link"
			}, "二维码显示异常？在浏览器中打开"), (0, react.createElement)("div", { className: "imqb-row" }, (0, react.createElement)("button", {
				className: "imqb-pill",
				onClick: refresh
			}, "刷新二维码"), (0, react.createElement)("button", {
				className: "imqb-pill",
				onClick: () => {
					setMode("manual");
				}
			}, "手动填写")));
		}
		/** 依据宿主相位渲染面板主体（可注入共享轮询结果避免双计时器） */
		function BindPanelBody(props) {
			usePanelStyles();
			const injected = props?.state !== void 0;
			const internal = useBindState(!injected);
			const state = injected ? props.state : internal.state;
			const gone = injected ? props.gone ?? false : internal.gone;
			const recheck = injected ? props.recheck ?? (() => {}) : internal.recheck;
			const [lastQr, setLastQr] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				if (state === null) return;
				if (state.phase === "waiting") {
					if (state.qrSvg !== void 0) setLastQr(state.qrSvg);
				} else if (state.phase === "bound") setLastQr(null);
			}, [state]);
			if (gone) return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("div", { className: "imqb-icon" }, "❔"), (0, react.createElement)("p", { className: "imqb-hint" }, "插件未启用，或当前版本不支持端内配置"));
			if (state === null || state.phase === "starting") return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("p", { className: "imqb-hint" }, "正在获取绑定状态…"));
			if (state.phase === "saving") {
				if (lastQr !== null) return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("div", { className: "imqb-scanned" }, (0, react.createElement)("img", {
					src: lastQr,
					alt: "QQ 扫码二维码",
					width: 220,
					height: 220,
					className: "imqb-scanned-qr"
				}), (0, react.createElement)("div", { className: "imqb-scanned-veil" }, (0, react.createElement)("p", { className: "imqb-scanned-title" }, "✅ 扫码成功"), (0, react.createElement)("p", { className: "imqb-scanned-sub" }, "正在连接机器人，稍候…"))));
				return (0, react.createElement)("div", { className: "imqb-status" }, (0, react.createElement)("div", { className: "imqb-status-row" }, (0, react.createElement)("div", { className: "imqb-status-icon" }, "🎉"), (0, react.createElement)("div", { className: "imqb-status-meta" }, (0, react.createElement)("p", { className: "imqb-status-title" }, "扫码成功"), (0, react.createElement)("p", { className: "imqb-status-sub" }, "凭据已保存，插件正在重载，稍后即可开始对话"))));
			}
			if (state.phase === "failed") return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("div", { className: "imqb-icon" }, "⚠️"), (0, react.createElement)("p", { className: "imqb-title" }, "绑定失败"), (0, react.createElement)("p", { className: "imqb-hint" }, state.reason), (0, react.createElement)("div", { className: "imqb-row" }, (0, react.createElement)("button", {
				className: "imqb-btn imqb-btn--primary",
				onClick: () => {
					window.location.reload();
				}
			}, "重试")));
			if (state.phase === "bound") return (0, react.createElement)(BoundView, {
				appId: state.appId,
				recheck
			});
			return (0, react.createElement)(UnboundView, { state });
		}
		//#endregion
		//#region src/client/config-panel.ts
		/**
		* QQ 机器人配置面板 — 必要配置的 UI 编辑
		*
		* UI 复刻 DSW 通用设置（settings-form 原语）的视觉风格：
		* 左对齐设置列、0.5px 行分隔、label 13px/500、控件右置；
		* Switch 为 36×20 aria-checked 结构（thumb translateX 动画）；
		* 三值选择用分段控件（滑动指示器按段数/索引的 CSS 变量定位）；
		* 保存按钮为 DSW 反色主按钮（label-primary 底 + bg-layer-3 字）。
		*
		* 数据流：GET /qqbot/im-qqbot/config 回显当前生效配置（appSecret
		* 已由宿主剔除）→ 表单编辑 → dirty diff → POST 仅提交变更键 →
		* 宿主白名单 + Schema 校验 → 最小写入 profile patch → HMR 重载生效。
		*
		* 字段策略：只开放用户必要的配置；cwd 只读展示；超时与性能调优
		* 类字段走 profile patch / 环境变量。
		*/
		/** 样式注入标记（幂等） */
		const STYLE_ID = "im-qqbot-config-panel-styles";
		/** DSW 通用设置风格（settings-form / Switch / SegmentedControl 原语复刻） */
		function useConfigPanelStyles() {
			(0, react.useEffect)(() => {
				if (typeof document === "undefined") return;
				if (document.getElementById(STYLE_ID) !== null) return;
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = `
.imqb2-form { display: flex; flex-direction: column; width: 100%; }
.imqb2-group-title {
  padding: 14px 0 2px; font-size: 12px; font-weight: 600; line-height: 18px;
  color: var(--dsw-alias-label-tertiary); text-transform: uppercase; letter-spacing: .04em;
}
.imqb2-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.imqb2-field + .imqb2-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.imqb2-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.imqb2-label {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.imqb2-help { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.imqb2-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
/* Switch（aria-checked 驱动，视觉态与无障碍态同源） */
.imqb2-switch {
  box-sizing: border-box; position: relative; flex: 0 0 auto;
  width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px;
  background: var(--dsw-alias-border-l3); cursor: pointer; font: inherit;
}
.imqb2-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.imqb2-switch:disabled { cursor: default; opacity: 0.5; }
.imqb2-switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.imqb2-switch-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #ffffff);
  transition: transform 120ms ease;
}
.imqb2-switch[aria-checked='true'] .imqb2-switch-thumb {
  background: var(--dsw-alias-label-primary-foreground, #ffffff);
  transform: translateX(16px);
}
/* 输入（官方 fields.input 复刻） */
.imqb2-input {
  box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5;
  color: var(--dsw-alias-label-primary); outline: none;
}
.imqb2-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.imqb2-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.imqb2-textarea { height: auto; min-height: 68px; padding: 8px 12px; resize: vertical; line-height: 1.5; }
/* 分段控件（官方 SegmentedControl 复刻：指示器按段数/索引定位） */
.imqb2-seg {
  position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  gap: 2px; padding: 4px; border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-interactive-bg-hover);
}
.imqb2-seg-indicator {
  position: absolute; top: 4px; left: 4px;
  width: calc((100% - 8px - 2px * (var(--imqb2-seg-count) - 1)) / var(--imqb2-seg-count));
  height: calc(100% - 8px);
  border: 0; border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-soft, 0 1px 3px rgba(0,0,0,.08));
  transform: translateX(calc(var(--imqb2-seg-index) * (100% + 2px)));
  transition: transform 160ms ease;
  pointer-events: none;
}
.imqb2-seg-tab {
  box-sizing: border-box; position: relative; z-index: 1; height: 28px; padding: 0 16px;
  border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px;
  font-weight: 500; white-space: nowrap; cursor: pointer; transition: color 120ms ease;
}
.imqb2-seg-tab:hover, .imqb2-seg-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary); }
.imqb2-seg-tab:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
/* 底栏（官方 SettingsForm.footer 复刻） */
.imqb2-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; }
.imqb2-note { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.imqb2-note--error { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error)); }
.imqb2-note--ok { color: var(--dsw-alias-label-secondary); }
.imqb2-save {
  appearance: none; flex: none; border: 1px solid transparent;
  border-radius: var(--dsw-radius-md, 8px); padding: 5px 14px;
  font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
  background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3);
}
.imqb2-save:disabled { opacity: 0.4; cursor: default; }
.imqb2-save:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
/* cwd 只读行 */
.imqb2-readonly { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; margin: 0; }
/* 连发合并：一行三个小输入，不占纵向空间 */
.imqb2-burst { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.imqb2-burst label { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.imqb2-burst label > span { font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-tertiary); }
.imqb2-burst .imqb2-input { padding: 5px 8px; font-variant-numeric: tabular-nums; }
/* 规则编辑：等宽字体、固定 220px 高、铺满整行 */
.imqb2-rules {
  height: 220px; min-height: 220px; resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
}
.imqb2-counter { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; margin-left: auto; }
.imqb2-counter--over { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error)); }
    `;
				document.head.appendChild(style);
				return () => {
					style.remove();
				};
			}, []);
		}
		/** 开关（官方 Switch 原语结构：aria-checked 驱动视觉态） */
		function Switch({ checked, label, onChange }) {
			return (0, react.createElement)("button", {
				type: "button",
				role: "switch",
				"aria-checked": checked,
				"aria-label": label,
				className: "imqb2-switch",
				onClick: () => {
					onChange(!checked);
				}
			}, (0, react.createElement)("span", { className: "imqb2-switch-thumb" }));
		}
		/** 访问模式分段选择（官方 SegmentedControl 结构：CSS 变量定位滑动指示器） */
		function Segmented({ value, options, onChange, label }) {
			const index = Math.max(0, options.findIndex((o) => o.value === value));
			const trackStyle = {
				"--imqb2-seg-count": options.length,
				"--imqb2-seg-index": index
			};
			return (0, react.createElement)("div", {
				className: "imqb2-seg",
				role: "tablist",
				"aria-label": label,
				style: trackStyle
			}, (0, react.createElement)("span", { className: "imqb2-seg-indicator" }), options.map((o) => (0, react.createElement)("button", {
				key: o.value,
				type: "button",
				role: "tab",
				"aria-selected": o.value === value,
				className: "imqb2-seg-tab",
				onClick: () => {
					onChange(o.value);
				}
			}, o.label)));
		}
		/** 开关行（label 左 + Switch 右 + 可选 help） */
		function SwitchRow({ label, help, checked, onChange }) {
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("div", { className: "imqb2-head" }, (0, react.createElement)("span", { className: "imqb2-label" }, label), (0, react.createElement)(Switch, {
				checked,
				label,
				onChange
			})), help === void 0 ? null : (0, react.createElement)("p", { className: "imqb2-help" }, help));
		}
		/** 连发合并参数：一行三个小输入，不占纵向空间（窗口/等待按秒显示，存毫秒） */
		function BurstRow({ windowMs, maxMs, maxCount, onChange }) {
			const cell = (label, key, value, min, max, step, scale) => (0, react.createElement)("label", {
				key
			}, (0, react.createElement)("span", null, label), (0, react.createElement)("input", {
				className: "imqb2-input",
				type: "number",
				min,
				max,
				step,
				value: String(Math.round(value / scale * 100) / 100),
				onChange: (event) => {
					const raw = Number(event.currentTarget.value);
					if (!Number.isFinite(raw)) return;
					onChange(key, Math.round(raw * scale));
				}
			}));
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("span", { className: "imqb2-label" }, "连发合并"), (0, react.createElement)("div", { className: "imqb2-burst" }, cell("安静窗口(秒)", "burstWindowMs", windowMs, 0, 30, 0.5, 1000), cell("最长等待(秒)", "maxBurstMs", maxMs, 1, 180, 1, 1000), cell("最多条数", "maxBurstCount", maxCount, 1, 50, 1, 1)), (0, react.createElement)("p", { className: "imqb2-hint" }, "连着发的几句会合成一条投进去；安静这么久没新消息才算说完。窗口填 0 就是每条立刻投"));
		}
		/** 文本行（label 上 + 输入下，与官方 fields 布局一致） */
		function FieldRow({ label, help, value, placeholder, onChange }) {
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("span", { className: "imqb2-label" }, label), (0, react.createElement)("input", {
				className: "imqb2-input",
				value,
				placeholder,
				spellCheck: false,
				onChange: (event) => {
					onChange(event.currentTarget.value);
				}
			}), help === void 0 ? null : (0, react.createElement)("p", { className: "imqb2-hint" }, help));
		}
		/** 数字行：带 min/max 夹值，超过边界就退回原值（不弹错） */
		function NumRow({ label, help, value, min, max, step, onChange }) {
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("span", { className: "imqb2-label" }, label), (0, react.createElement)("input", {
				className: "imqb2-input",
				type: "number",
				min,
				max,
				step: step ?? 1,
				value: String(value),
				onChange: (event) => {
					const raw = Number(event.currentTarget.value);
					if (!Number.isFinite(raw)) return;
					onChange(Math.min(max, Math.max(min, Math.round(raw))));
				}
			}), help === void 0 ? null : (0, react.createElement)("p", { className: "imqb2-hint" }, help));
		}
		/** 下拉行（options 为空时退回文本输入，宿主目录读不到也能用） */
		function SelectRow({ label, help, value, options, placeholder, onChange }) {
			if (!Array.isArray(options) || options.length === 0) {
				return (0, react.createElement)(FieldRow, {
					label,
					help,
					value,
					placeholder,
					onChange
				});
			}
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("span", { className: "imqb2-label" }, label), (0, react.createElement)("select", {
				className: "imqb2-input",
				value: value ?? "",
				onChange: (event) => {
					onChange(event.currentTarget.value);
				}
			}, options.map((option) => (0, react.createElement)("option", {
				key: option.value,
				value: option.value
			}, option.label))), help === void 0 ? null : (0, react.createElement)("p", { className: "imqb2-hint" }, help));
		}
		/** 模型下拉：按 provider 分组，值是 `provider|model`，空串表示跟随宿主默认 */
		function ModelSelectRow({ label, help, value, providers, placeholder, onChange }) {
			if (!Array.isArray(providers) || providers.length === 0) {
				return (0, react.createElement)(FieldRow, {
					label,
					help,
					value,
					placeholder,
					onChange
				});
			}
			const children = [(0, react.createElement)("option", {
				key: "",
				value: ""
			}, "继承宿主默认")];
			const values = new Set([""]);
			for (const provider of providers) {
				const models = Array.isArray(provider.models) ? provider.models : [];
				if (models.length === 0) continue;
				const options = models.map((model) => {
					const key = `${provider.id}|${model.id}`;
					values.add(key);
					return (0, react.createElement)("option", {
						key,
						value: key
					}, model.name ?? model.id);
				});
				children.push((0, react.createElement)("optgroup", {
					key: provider.id,
					label: provider.name ?? provider.id
				}, options));
			}
			if (value && !values.has(value)) {
				// 目录里暂时没有当前值（换过 provider 或目录还在加载）也要显示出来。
				const parts = String(value).split("|");
				children.push((0, react.createElement)("option", {
					key: value,
					value
				}, parts[1] || parts[0]));
			}
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("span", { className: "imqb2-label" }, label), (0, react.createElement)("select", {
				className: "imqb2-input",
				value: value ?? "",
				onChange: (event) => {
					onChange(event.currentTarget.value);
				}
			}, children), help === void 0 ? null : (0, react.createElement)("p", { className: "imqb2-hint" }, help));
		}
		/** 多行文本行 */
		function AreaRow({ label, help, value, rows, onChange }) {
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("span", { className: "imqb2-label" }, label), (0, react.createElement)("textarea", {
				className: "imqb2-input imqb2-textarea",
				value,
				rows: rows ?? 3,
				onChange: (event) => {
					onChange(event.currentTarget.value);
				}
			}), help === void 0 ? null : (0, react.createElement)("p", { className: "imqb2-hint" }, help));
		}
		/** 访问模式分段选择行 */
		function SegmentedRow({ label, help, value, options, onChange }) {
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("div", { className: "imqb2-head" }, (0, react.createElement)("span", { className: "imqb2-label" }, label), (0, react.createElement)(Segmented, {
				value,
				options,
				onChange,
				label
			})), help === void 0 ? null : (0, react.createElement)("p", { className: "imqb2-hint" }, help));
		}
		const MODE_OPTIONS = [
			{
				value: "open",
				label: "所有人"
			},
			{
				value: "allowlist",
				label: "白名单"
			},
			{
				value: "disabled",
				label: "禁用"
			}
		];
		/** 深比较（表单值与初始回显值的 dirty 判断） */
		function shallowEqual(a, b) {
			return JSON.stringify(a) === JSON.stringify(b);
		}
		/**
		* 配置面板主体。
		*
		* 保存仅提交变更键（服务端按白名单合并），保存成功后提示
		* HMR 重载语义（进行中的机器人会话将重置）。
		*/
		function QQBotConfigBody(props) {
			useConfigPanelStyles();
			const [initial, setInitial] = (0, react.useState)(null);
			const [form, setForm] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [result, setResult] = (0, react.useState)(null);
			const [loadError, setLoadError] = (0, react.useState)(null);
			// Provider / Model / Preset 下拉的目录；拿不到就退回文本输入。
			const [catalog, setCatalog] = (0, react.useState)(null);
			// 人设 / 画像（各自独立文件，单独保存，不跟配置表单一起提交）
			const [persona, setPersona] = (0, react.useState)(null);
			const [personaText, setPersonaText] = (0, react.useState)("");
			const [portraitText, setPortraitText] = (0, react.useState)("");
			const [extraNote, setExtraNote] = (0, react.useState)(null);
			// 规则（在 QQ 里怎么回话）：与配置表单分开保存，清空 + 保存 = 恢复默认
			const [rules, setRules] = (0, react.useState)(null);
			const [rulesText, setRulesText] = (0, react.useState)("");
			const [rulesBusy, setRulesBusy] = (0, react.useState)(false);
			const bindPhase = props?.bindPhase;
			(0, react.useEffect)(() => {
				let stopped = false;
				fetch(BIND_PERSONA_PATH, { cache: "no-store" }).then(async (res) => {
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return await res.json();
				}).then((body) => {
					if (stopped) return;
					setPersona(body);
					setPersonaText(String(body?.text ?? ""));
				}).catch(() => { });
				fetch(BIND_PORTRAIT_PATH, { cache: "no-store" }).then(async (res) => {
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return await res.json();
				}).then((body) => {
					if (!stopped) setPortraitText(String(body?.text ?? ""));
				}).catch(() => { });
				return () => {
					stopped = true;
				};
			}, [bindPhase]);
			(0, react.useEffect)(() => {
				let stopped = false;
				fetch(BIND_RULES_PATH, { cache: "no-store" }).then(async (res) => {
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return await res.json();
				}).then((body) => {
					if (stopped) return;
					setRules(body);
					setRulesText(String(body?.text ?? ""));
				}).catch(() => { });
				return () => {
					stopped = true;
				};
			}, [bindPhase]);
			const postJson = async (path, payload) => {
				const res = await fetch(path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload)
				});
				const body = await res.json().catch(() => ({}));
				if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
				return body;
			};
			const savePersona = async () => {
				try {
					const body = await postJson(BIND_PERSONA_PATH, { text: personaText });
					setPersona(body);
					setPersonaText(String(body?.text ?? ""));
					setExtraNote({ ok: true, text: "人设已保存，下一轮生效" });
				}
				catch (err) {
					setExtraNote({ ok: false, text: `保存人设失败：${err instanceof Error ? err.message : String(err)}` });
				}
			};
			const savePortrait = async () => {
				try {
					await postJson(BIND_PORTRAIT_PATH, { text: portraitText });
					setExtraNote({ ok: true, text: "画像已保存，下一轮生效" });
				}
				catch (err) {
					setExtraNote({ ok: false, text: `保存画像失败：${err instanceof Error ? err.message : String(err)}` });
				}
			};
			const saveRules = async () => {
				setRulesBusy(true);
				try {
					const body = await postJson(BIND_RULES_PATH, { text: rulesText });
					setRules(body);
					setRulesText(String(body?.text ?? ""));
					setExtraNote({ ok: true, text: "规则已保存，下一轮生效" });
				}
				catch (err) {
					setExtraNote({ ok: false, text: `保存规则失败：${err instanceof Error ? err.message : String(err)}` });
				}
				finally {
					setRulesBusy(false);
				}
			};
			const resetRules = async () => {
				setRulesBusy(true);
				try {
					const res = await fetch(BIND_RULES_PATH, { method: "DELETE" });
					const body = await res.json().catch(() => ({}));
					if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
					setRules(body);
					setRulesText(String(body?.text ?? ""));
					setExtraNote({ ok: true, text: "已恢复默认规则" });
				}
				catch (err) {
					setExtraNote({ ok: false, text: `恢复默认失败：${err instanceof Error ? err.message : String(err)}` });
				}
				finally {
					setRulesBusy(false);
				}
			};
			(0, react.useEffect)(() => {
				let stopped = false;
				fetch(BIND_CATALOG_PATH, { cache: "no-store" }).then(async (res) => {
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const body = await res.json();
					if (!stopped) setCatalog(body);
				}).catch(() => {
					if (!stopped) setCatalog({ providers: [], presets: [] });
				});
				return () => {
					stopped = true;
				};
			}, [bindPhase]);
			(0, react.useEffect)(() => {
				let stopped = false;
				fetch(BIND_CONFIG_PATH, { cache: "no-store" }).then(async (res) => {
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const body = await res.json();
					if (stopped) return;
					setInitial(body.config);
					setForm(body.config);
				}).catch((err) => {
					if (!stopped) setLoadError(err instanceof Error ? err.message : String(err));
				});
				return () => {
					stopped = true;
				};
			}, [bindPhase]);
			const patch = (0, react.useCallback)((key, value) => {
				setForm((current) => current === null ? current : {
					...current,
					[key]: value
				});
				setResult(null);
			}, []);
			const patchMany = (0, react.useCallback)((entries) => {
				setForm((current) => current === null ? current : {
					...current,
					...entries
				});
				setResult(null);
			}, []);
			const submit = (0, react.useCallback)((event) => {
				event.preventDefault();
				if (busy || initial === null || form === null) return;
				const changed = {};
				for (const key of Object.keys(form)) if (!shallowEqual(form[key], initial[key])) changed[key] = form[key];
				if (Object.keys(changed).length === 0) return;
				if (changed.access !== void 0) {
					const a = changed.access;
					changed.access = {
						...a,
						c2cAllow: a.c2cAllow.map((s) => s.trim()).filter(Boolean),
						groupAllow: a.groupAllow.map((s) => s.trim()).filter(Boolean)
					};
				}
				setBusy(true);
				fetch(BIND_CONFIG_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(changed)
				}).then(async (res) => {
					const body = await res.json().catch(() => ({}));
					if (res.ok && body.ok === true) {
						setResult({
							ok: true,
							message: body.message ?? "配置已保存，插件将自动重载"
						});
						setInitial(form);
						return;
					}
					setResult({
						ok: false,
						message: body.error ?? `保存失败（HTTP ${res.status}）`
					});
				}).catch((err) => {
					setResult({
						ok: false,
						message: err instanceof Error ? err.message : String(err)
					});
				}).finally(() => {
					setBusy(false);
				});
			}, [
				busy,
				form,
				initial
			]);
			if (loadError !== null) return (0, react.createElement)("p", {
				className: "imqb2-hint",
				style: { padding: "12px 0" }
			}, `配置加载失败：${loadError}`);
			if (initial === null || form === null) return (0, react.createElement)("p", {
				className: "imqb2-hint",
				style: { padding: "12px 0" }
			}, "正在加载配置…");
			const dirty = Object.keys(form).some((key) => !shallowEqual(form[key], initial[key]));
			const access = form.access ?? {
				c2cMode: "open",
				c2cAllow: [],
				groupMode: "open",
				groupAllow: []
			};
			// 下拉目录：还没加载到或宿主没有目录时给空数组，选择行会退回文本输入。
			const providers = Array.isArray(catalog?.providers) ? catalog.providers : [];
			const presets = Array.isArray(catalog?.presets) ? catalog.presets : [];
			// provider 和 model 后端分开存，下拉里压成一个 `provider|model` 的值。
			const modelKey = form.provider || form.model ? `${form.provider ?? ""}|${form.model ?? ""}` : "";
			const presetOptions = presets.length === 0 ? [] : [{ value: "", label: "跟随默认" }].concat(presets.map((preset) => ({
				value: preset.id,
				label: preset.name ?? preset.id
			})));
			if (presetOptions.length > 0 && form.preset && !presetOptions.some((option) => option.value === form.preset)) {
				presetOptions.push({ value: form.preset, label: form.preset });
			}
			// 规则字数：按可见字符计，与宿主 4000 上限同一口径
			const rulesLength = [...rulesText].length;
			return (0, react.createElement)("form", {
				className: "imqb2-form",
				onSubmit: submit
			}, (0, react.createElement)("div", { className: "imqb2-group-title" }, "服务范围"), (0, react.createElement)(SegmentedRow, {
				label: "私聊",
				value: access.c2cMode,
				options: MODE_OPTIONS,
				onChange: (v) => {
					patch("access", {
						...access,
						c2cMode: v
					});
				}
			}), access.c2cMode === "allowlist" ? (0, react.createElement)(AreaRow, {
				label: "私聊白名单",
				help: "请输入用户 openid，多个请换行输入",
				rows: 3,
				value: access.c2cAllow.join("\n"),
				onChange: (v) => {
					patch("access", {
						...access,
						c2cAllow: v.split("\n").map((s) => s.trim())
					});
				}
			}) : null, (0, react.createElement)(SegmentedRow, {
				label: "群聊",
				value: access.groupMode,
				options: MODE_OPTIONS,
				onChange: (v) => {
					patch("access", {
						...access,
						groupMode: v
					});
				}
			}), access.groupMode === "allowlist" ? (0, react.createElement)(AreaRow, {
				label: "群聊白名单",
				help: "请输入群 openid，多个请换行输入",
				rows: 3,
				value: access.groupAllow.join("\n"),
				onChange: (v) => {
					patch("access", {
						...access,
						groupAllow: v.split("\n").map((s) => s.trim())
					});
				}
			}) : null, (0, react.createElement)("div", { className: "imqb2-group-title" }, "基础设置"), (0, react.createElement)(SwitchRow, {
				label: "群聊仅回复 @机器人的消息",
				checked: form.requireMention ?? true,
				help: "开启后，机器人仅可回复 @机器人的群聊消息",
				onChange: (v) => {
					patch("requireMention", v);
				}
			}), (0, react.createElement)(SwitchRow, {
				label: "允许不出声",
				checked: form.allowSilence ?? true,
				help: "开着时它可以判断这一轮没必要接（对方只是顺手一句、话还没说完），用 qq_skip 安静过去",
				onChange: (v) => {
					patch("allowSilence", v);
				}
			}), (0, react.createElement)(SwitchRow, {
				label: "流式输出",
				checked: form.streaming ?? true,
				help: "回复内容分段实时推送到聊天",
				onChange: (v) => {
					patch("streaming", v);
				}
			}), (0, react.createElement)(SwitchRow, {
				label: "干活时插话",
				checked: form.midTurnSteer ?? true,
				help: "正在跑的时候对方又发来消息：开启会立刻插进当前步骤，关掉则等这一轮结束再处理",
				onChange: (v) => {
					patch("midTurnSteer", v);
				}
			}), (0, react.createElement)(BurstRow, {
				windowMs: form.burstWindowMs ?? 2500,
				maxMs: form.maxBurstMs ?? 12000,
				maxCount: form.maxBurstCount ?? 6,
				onChange: (key, value) => {
					patch(key, value);
				}
			}), (0, react.createElement)(SwitchRow, {
				label: "重启自检",
				checked: form.resumeOnBoot ?? true,
				help: "宿主重启后给模型一个内部事件，让它自己检查上一轮有没有没做完、没回的事；不会自动往 QQ 发消息",
				onChange: (v) => {
					patch("resumeOnBoot", v);
				}
			}), (0, react.createElement)("div", { className: "imqb2-group-title" }, "模型"), (0, react.createElement)(ModelSelectRow, {
				label: "模型",
				help: "一个下拉选完：按 provider 分组列出模型；留空跟随宿主默认",
				value: modelKey,
				providers,
				placeholder: "留空继承宿主默认",
				onChange: (v) => {
					if (v === "") {
						patchMany({ provider: "", model: "" });
						return;
					}
					const cut = v.indexOf("|");
					patchMany(cut < 0 ? { provider: v, model: "" } : {
						provider: v.slice(0, cut),
						model: v.slice(cut + 1)
					});
				}
			}), (0, react.createElement)(SelectRow, {
				label: "Preset",
				help: "决定这套 QQ 会话用什么人设和工具集；跟随默认就是 bundle 里配的那个",
				value: form.preset ?? "",
				options: presetOptions,
				placeholder: "Agent preset id",
				onChange: (v) => {
					patch("preset", v);
				}
			}), (0, react.createElement)("div", { className: "imqb2-group-title" }, "人设与画像"), (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("div", { className: "imqb2-head" }, (0, react.createElement)("span", { className: "imqb2-label" }, "人设"), (0, react.createElement)("span", { className: "imqb2-hint" }, persona === null ? "加载中…" : persona.custom ? "自定义" : "默认")), (0, react.createElement)("textarea", {
				className: "imqb2-input imqb2-textarea",
				rows: 8,
				value: personaText,
				spellCheck: false,
				onChange: (event) => setPersonaText(event.currentTarget.value)
			}), (0, react.createElement)("p", { className: "imqb2-hint" }, `人设文件：${persona?.file ?? "~/.dsh/dsh-qqbot-plus/persona.md"}`), (0, react.createElement)("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } }, (0, react.createElement)("button", {
				type: "button",
				className: "imqb2-save",
				onClick: () => {
					void savePersona();
				}
			}, "保存人设"), (0, react.createElement)("button", {
				type: "button",
				className: "imqb2-save",
				style: { background: "transparent", color: "var(--dsw-alias-label-primary)", borderColor: "var(--dsw-alias-border-l2)" },
				onClick: () => setPersonaText(String(persona?.defaultText ?? ""))
			}, "恢复默认"))), (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("span", { className: "imqb2-label" }, "画像"), (0, react.createElement)("textarea", {
				className: "imqb2-input imqb2-textarea",
				rows: 4,
				value: portraitText,
				spellCheck: false,
				onChange: (event) => setPortraitText(event.currentTarget.value)
			}), (0, react.createElement)("p", { className: "imqb2-hint" }, "常驻在系统提示里，描述对方是谁；留空就不注入。"), (0, react.createElement)("div", { style: { display: "flex", gap: "8px" } }, (0, react.createElement)("button", {
				type: "button",
				className: "imqb2-save",
				onClick: () => {
					void savePortrait();
				}
			}, "保存画像"))),
			(0, react.createElement)("div", { className: "imqb2-group-title" }, "规则"), (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("div", { className: "imqb2-head" }, (0, react.createElement)("span", { className: "imqb2-label" }, "在 QQ 里怎么回话"), rules === null ? null : rules.custom === false ? (0, react.createElement)("span", { className: "imqb2-hint" }, "默认") : null), (0, react.createElement)("textarea", {
				className: "imqb2-input imqb2-textarea imqb2-rules",
				value: rulesText,
				spellCheck: false,
				onChange: (event) => setRulesText(event.currentTarget.value)
			}), (0, react.createElement)("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } }, (0, react.createElement)("button", {
				type: "button",
				className: "imqb2-save",
				disabled: rulesBusy,
				onClick: () => {
					void saveRules();
				}
			}, rulesBusy ? "正在保存…" : "保存"), (0, react.createElement)("button", {
				type: "button",
				className: "imqb2-save",
				style: {
					background: "transparent",
					color: "var(--dsw-alias-label-primary)",
					borderColor: "var(--dsw-alias-border-l2)"
				},
				disabled: rulesBusy,
				onClick: () => {
					void resetRules();
				}
			}, "恢复默认"), (0, react.createElement)("span", { className: rulesLength > 4000 ? "imqb2-counter imqb2-counter--over" : "imqb2-counter" }, `${rulesLength}/4000`)), (0, react.createElement)("p", { className: "imqb2-hint" }, `规则文件：${rules?.file ?? "~/.dsh/dsh-qqbot-plus/rules.md"}；清空后保存等同恢复默认`)), extraNote === null ? null : (0, react.createElement)("p", { className: `imqb2-note${extraNote.ok ? " imqb2-note--ok" : " imqb2-note--error"}` }, (extraNote.ok ? "" : "⚠️ ") + extraNote.text), form.cwd !== void 0 ? (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("div", { className: "imqb2-head" }, (0, react.createElement)("span", { className: "imqb2-label" }, "Agent 工作目录"), (0, react.createElement)("span", { className: "imqb2-hint" }, "只读")), (0, react.createElement)("p", { className: "imqb2-readonly" }, form.cwd)) : null, (0, react.createElement)("div", { className: "imqb2-footer" }, result !== null ? (0, react.createElement)("p", { className: `imqb2-note${result.ok ? " imqb2-note--ok" : " imqb2-note--error"}` }, (result.ok ? "" : "⚠️ ") + result.message) : dirty ? (0, react.createElement)("p", { className: "imqb2-note" }, "保存后插件将重载，进行中的机器人会话将重置") : (0, react.createElement)("p", { className: "imqb2-note" }), (0, react.createElement)("button", {
				className: "imqb2-save",
				type: "submit",
				disabled: busy || !dirty
			}, busy ? "正在保存…" : "保存")));
		}
		// 人味分组挂在 QQ 面板里的第二个页签：不再单独占一个设置分区。
		let humanlikeTab = null;
		const TAB_STYLE = {
			display: "flex",
			gap: "4px",
			marginBottom: "14px",
			borderBottom: "1px solid var(--dsw-alias-border-l2)"
		};
		const TAB_ITEM_STYLE = {
			appearance: "none",
			border: "none",
			background: "transparent",
			padding: "6px 12px",
			cursor: "pointer",
			font: "inherit",
			color: "var(--dsw-alias-label-secondary)",
			borderBottom: "2px solid transparent",
			marginBottom: "-1px"
		};
		const TAB_ITEM_ACTIVE_STYLE = {
			...TAB_ITEM_STYLE,
			color: "var(--dsw-alias-label-primary)",
			borderBottom: "2px solid var(--dsw-alias-brand-primary, #4c8dff)"
		};
		/** QQ 设置页：机器人配置 / 人味，两块共用一页。 */
		function ConfigPanel(props) {
			const [tab, setTab] = (0, react.useState)("bot");
			const tabRow = (0, react.createElement)("div", { className: "imqb2-tabs", style: TAB_STYLE }, [
				["bot", "机器人"],
				["humanlike", "人味"]
			].map(([id, label]) => (0, react.createElement)("button", {
				key: id,
				type: "button",
				style: tab === id ? TAB_ITEM_ACTIVE_STYLE : TAB_ITEM_STYLE,
				onClick: () => {
					setTab(id);
				}
			}, label)));
			let body;
			if (tab === "humanlike") {
				body = humanlikeTab === null
					? (0, react.createElement)("p", { className: "imqb2-hint" }, "人味面板还没挂上，刷新页面再试")
					: (0, react.createElement)(humanlikeTab, props);
			} else {
				body = (0, react.createElement)(QQBotConfigBody, props);
			}
			return (0, react.createElement)("div", { className: "imqb2-stack" }, tabRow, body);
		}
		//#endregion
		//#region src/client/index.ts
		const name = "im-qqbot-client";
		const inject = [
			"slots",
			"locale",
			"sidebarRight",
			"sidebarRightTabs"
		];
		/** 侧栏 Tab 类型（ui-sidebar-right 契约的局部投影） */
		const TAB_KIND = "qqbot-bind";
		/** 席位注册 key（Tab 类型 id，席位按其分发；只需全局唯一，与包名解耦） */
		const TAB_ID = "im-qqbot/bind";
		/** 本插件包名（插件详情页按其匹配来源包，只在对应详情页渲染操作按钮） */
		const PACKAGE_NAME = "dsh-qqbot-plus";
		/** 主面板 id（layout.selectPanel 导航目标；keyed main 席位按其分发） */
		const IM_MAIN_PANEL_ID = "im-qqbot";
		/** 绑定入口图标（QQ 机器人，跟随主题图标色变量） */
		function BindGuideIcon() {
			return (0, react.createElement)("svg", {
				width: 24,
				height: 24,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": true
			}, (0, react.createElement)("path", {
				d: "M9.50039 11.1504C9.96983 11.1504 10.3504 11.5309 10.3504 12.0004V14.0004C10.3504 14.4698 9.96983 14.8504 9.50039 14.8504C9.03095 14.8504 8.65039 14.4698 8.65039 14.0004V12.0004C8.65039 11.5309 9.03095 11.1504 9.50039 11.1504Z",
				fill: "var(------icon_primary, #1A1A1A)"
			}), (0, react.createElement)("path", {
				d: "M14.5004 11.1504C14.9698 11.1504 15.3504 11.5309 15.3504 12.0004V14.0004C15.3504 14.4698 14.9698 14.8504 14.5004 14.8504C14.0309 14.8504 13.6504 14.4698 13.6504 14.0004V12.0004C13.6504 11.5309 14.0309 11.1504 14.5004 11.1504Z",
				fill: "var(------icon_primary, #1A1A1A)"
			}), (0, react.createElement)("path", {
				fillRule: "evenodd",
				clipRule: "evenodd",
				d: "M12.8504 5.3109C13.5299 4.99138 14.0004 4.30063 14.0004 3.5C14.0004 2.39543 13.1049 1.5 12.0004 1.5C10.8958 1.5 10.0004 2.39543 10.0004 3.5C10.0004 4.30065 10.4708 4.99141 11.1504 5.31092V6.18851C6.38487 6.61795 2.65039 10.6231 2.65039 15.5004V17.0004C2.65039 19.679 4.82181 21.8504 7.50039 21.8504H16.5004C19.179 21.8504 21.3504 19.679 21.3504 17.0004V15.5004C21.3504 10.6231 17.6159 6.61795 12.8504 6.18851V5.3109ZM12.0004 7.85039C7.77541 7.85039 4.35039 11.2754 4.35039 15.5004V17.0004C4.35039 18.7401 5.76069 20.1504 7.50039 20.1504H16.5004C18.2401 20.1504 19.6504 18.7401 19.6504 17.0004V15.5004C19.6504 11.2754 16.2254 7.85039 12.0004 7.85039Z",
				fill: "var(------icon_primary, #1A1A1A)"
			}));
		}
		/** 设置页栏目：共享一份绑定状态轮询，驱动绑定面板与配置刷新 */
		function QQBotSettingsSection() {
			const { state, gone, recheck } = useBindState();
			return (0, react.createElement)("div", null, (0, react.createElement)(BindPanelBody, {
				state,
				gone,
				recheck
			}), (0, react.createElement)(ConfigPanel, { bindPhase: state?.phase }));
		}
		/** 主面板页面：与设置栏目同一内容，包一层滚动留白容器（plugins.detail.actions 的跳转目标） */
		function QQBotPage() {
			return (0, react.createElement)("div", { className: "imqb-pluginPage" }, (0, react.createElement)("div", { className: "imqb-pluginPageContent" }, (0, react.createElement)(QQBotSettingsSection)));
		}
		/** 左侧栏入口图标（宿主传入 size：展开 18 / 收起 16；currentColor 跟随侧栏配色与选中态） */
		function QqBotSidebarIcon({ size = 16 }) {
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": true
			}, (0, react.createElement)("path", {
				d: QQ_BOT_LOGO_PATH,
				fill: "currentColor"
			}));
		}
		/** 插件详情「设置」按钮：仅在本包的 bundle / 组件行详情页渲染，其他插件不显示 */
		function OpenQqBotAction({ subject, packageName, onOpen }) {
			if (subject?.kind !== "bundle" && subject?.kind !== "row") return null;
			if (subject.pkg?.name !== packageName) return null;
			if (subject.kind === "row" && subject.row?.moduleName !== packageName) return null;
			return (0, react.createElement)("button", {
				type: "button",
				className: "imqb-pluginOpen",
				onClick: onOpen
			}, "设置");
		}
		function apply(ctx) {
			installPanelStyles();
			const tabs = ctx.sidebarRightTabs;
			const right = ctx.sidebarRight;
			const slots = ctx.slots;
			const disposers = [];
			if (slots !== void 0) disposers.push(slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "qqbot",
				order: 7,
				label: "QQ 机器人"
			}, QQBotSettingsSection)));
			if (tabs !== void 0 && slots !== void 0) {
				disposers.push(tabs.register({
					id: TAB_ID,
					kind: TAB_KIND,
					title: () => "QQ 机器人绑定",
					guide: [{
						id: "bind",
						order: 90,
						title: () => "QQ 机器人绑定",
						description: () => "扫码或手动填写，绑定 QQ 机器人",
						icon: BindGuideIcon
					}]
				}));
				disposers.push(slots.inject("sidebar.right.pane.tab", () => slots.register({
					name: "sidebar.right.pane.tab",
					key: TAB_ID
				}, BindPanelBody)));
				disposers.push(watchAndPrompt(right));
			}
			const ctxInject = ctx.inject;
			if (typeof ctxInject === "function") ctxInject.call(ctx, ["layout"], (pageCtx) => {
				const pageSlots = pageCtx.slots;
				const layout = pageCtx.layout;
				if (pageSlots === void 0 || layout === void 0) return void 0;
				const stopMain = pageSlots.inject("main", () => pageSlots.register({
					name: "main",
					key: IM_MAIN_PANEL_ID
				}, QQBotPage));
				const stopActions = pageSlots.inject("plugins.detail.actions", () => pageSlots.register({
					name: "plugins.detail.actions",
					id: "im-qqbot-open",
					order: 20,
					inject: () => ({
						packageName: PACKAGE_NAME,
						onOpen: () => layout.selectPanel(IM_MAIN_PANEL_ID)
					})
				}, OpenQqBotAction));
				const stopSidebar = pageSlots.inject("sidebar.panellist", () => pageSlots.register({
					name: "sidebar.panellist",
					id: IM_MAIN_PANEL_ID,
					order: 10,
					label: "QQ 机器人"
				}, QqBotSidebarIcon));
				return () => {
					stopActions();
					stopSidebar();
					stopMain();
				};
			});
			try {
				mountHumanlikeSettings(ctx);
			} catch (err) {
				console.warn("im-qqbot: 人味设置分区挂载失败", err);
			}
			ctx.effect(() => () => {
				for (const dispose of disposers.reverse()) dispose();
			}, "im-qqbot-client.binding");
		}
		/**
		* 轮询绑定状态：待绑定时自动打开绑定页。
		*
		* - 页面隐藏时降频轮询（可见时立即恢复节拍）
		* - 404（已绑定/未安装）时退避到 30s，保持低成本常驻探测
		* - 每次页面加载至多打开一次（用户手动关闭后不打扰）；
		*   打开失败（如启动早期 Session surface 尚未挂载）不消费机会，
		*   由下一轮轮询（3s）自动重试
		*/
		function watchAndPrompt(right) {
			let stopped = false;
			let opened = right === void 0;
			let timer;
			const schedule = (ms) => {
				timer = setTimeout(() => {
					tick();
				}, ms);
			};
			const tick = async () => {
				if (stopped) return;
				if (typeof document !== "undefined" && document.visibilityState === "hidden") {
					schedule(5e3);
					return;
				}
				try {
					const res = await fetch(BIND_STATE_PATH, { cache: "no-store" });
					if (res.ok) {
						if ((await res.json()).phase === "waiting" && !opened && right !== void 0) try {
							right.openTab(TAB_KIND);
							opened = true;
						} catch (err) {
							console.error("[im-qqbot] 打开绑定页失败，稍后重试", err);
						}
						schedule(3e3);
						return;
					}
					schedule(3e4);
					return;
				} catch {}
				schedule(1e4);
			};
			tick();
			return () => {
				stopped = true;
				if (timer !== void 0) clearTimeout(timer);
			};
		}
		//#endregion
// ── 人味设置分区（2026-11-20 从 dsh-humanlike 并进来，同一个模块里的一个函数） ──
// 宿主的 __ModuleLoader__ 只认插件包那一个模块 id，同一个文件里第二次 load() 的注册不会被挂载，
// 设置页因此看不到人味。
/**
 * 人味 —— 设置窗口里的分区。
 *
 * 数据全部走本插件自己的同源接口 /qqbot/im-qqbot/humanlike（见 lib/humanlike/settings-api.js），
 * 真相源是 ~/.dsh/dsh-qqbot-plus/humanlike/settings.json。改完服务端会把工具实例与前缀段
 * 一起重建，所以面板上不写「重启生效」。
 *
 * 手写 ModuleLoader bundle，除 react 之外没有依赖。
 */
function mountHumanlikeSettings (parentCtx) {
  const React = react
    const { useCallback, useEffect, useMemo, useState } = React
    const h = React.createElement

    const NS = 'settings.humanlike'
    const API = '/qqbot/im-qqbot/humanlike'
    const RULES_TAB = '__rules__'

    const DICT = {
      zh: {
        nav: '人味',
        title: '人味',
        loading: '正在读取…',
        loadFailed: '读不到插件后端',
        loadFailedHint: '如果插件刚装好，重启一次 DeepSeek Harness 让它加载新的设置接口。',
        retry: '重试',
        save: '保存这一组',
        saving: '保存中…',
        saved: '已保存',
        reset: '恢复默认',
        resetting: '恢复中…',
        resetAll: '全部恢复默认',
        unsaved: '有改动没保存',
        noChange: '没有改动',
        footnote: '存档位置',
        rulesCard: '规则',
        rulesHint: '这段文本随每一轮对话一起送给模型，约束它怎么用「人味」这套工具。改完下一轮生效。',
        rulesDefaultBadge: '默认',
        rulesSave: '保存规则',
        rulesSaving: '保存中…',
        rulesSaved: '已保存 · 下一轮生效',
        rulesReset: '恢复默认',
        rulesResetting: '恢复中…',
        rulesResetDone: '已恢复默认',
        rulesResetConfirm: '恢复默认会丢掉你改过的内容，确定吗？',
        rulesPlaceholder: '在这里写规则…',
        rulesCount: '{n} 字',
        rulesSaveFailed: '保存失败',
      },
      en: {
        nav: 'Humanlike',
        title: 'Humanlike',
        loading: 'Loading…',
        loadFailed: 'Cannot reach the plugin backend',
        loadFailedHint: 'If the plugin was just installed, restart DeepSeek Harness once so the settings API loads.',
        retry: 'Retry',
        save: 'Save this group',
        saving: 'Saving…',
        saved: 'Saved',
        reset: 'Restore defaults',
        resetting: 'Restoring…',
        resetAll: 'Restore all defaults',
        unsaved: 'Unsaved changes',
        noChange: 'No changes',
        footnote: 'Stored at',
        rulesCard: 'Rules',
        rulesHint: 'This text is sent with every turn to tell the model how to use the humanlike tools. Edits apply on the next turn.',
        rulesDefaultBadge: 'Default',
        rulesSave: 'Save rules',
        rulesSaving: 'Saving…',
        rulesSaved: 'Saved · takes effect next turn',
        rulesReset: 'Restore defaults',
        rulesResetting: 'Restoring…',
        rulesResetDone: 'Defaults restored',
        rulesResetConfirm: 'Restoring defaults discards your edits. Continue?',
        rulesPlaceholder: 'Write the rules here…',
        rulesCount: '{n} chars',
        rulesSaveFailed: 'Could not save',
      },
    }

    const inject = ['slots', 'locale']

    const CSS = `
      .hl_root { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 12px; }
      .hl_head { display: flex; flex-direction: column; gap: 4px; }
      .hl_h1 { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, currentColor); }
      .hl_sub { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, color-mix(in srgb, currentColor 62%, transparent)); }
      .hl_tabs { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 3px; border-radius: 9px;
        background: var(--dsw-alias-bg-layer-2, color-mix(in srgb, currentColor 6%, transparent)); width: max-content; max-width: 100%; }
      .hl_tab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, inherit);
        font: inherit; font-size: 12.5px; padding: 5px 12px; border-radius: 7px; cursor: pointer; }
      .hl_tab:hover { color: var(--dsw-alias-label-primary, inherit); }
      .hl_tab[data-active='true'] { background: var(--dsw-alias-bg-layer-1, transparent);
        color: var(--dsw-alias-label-primary, inherit); box-shadow: 0 .5px 2px rgba(0,0,0,.08); }
      .hl_card { border: .5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.24));
        border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; background: var(--dsw-alias-bg-layer-1, transparent); }
      .hl_cardhead { display: flex; flex-direction: column; gap: 2px; }
      .hl_cardtitle { font-size: 13px; font-weight: 600; }
      .hl_carddesc { font-size: 12px; color: var(--dsw-alias-label-secondary, color-mix(in srgb, currentColor 62%, transparent)); }
      .hl_row { display: flex; align-items: flex-start; gap: 12px; }
      .hl_label { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .hl_labeltext { font-size: 12px; }
      .hl_hint { font-size: 11px; color: var(--dsw-alias-label-secondary, color-mix(in srgb, currentColor 55%, transparent)); }
      .hl_field { flex: 0 0 40%; display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
      .hl_switch { position: relative; width: 36px; height: 20px; flex: 0 0 auto; padding: 0; border: 0; cursor: pointer;
        border-radius: 999px; background: color-mix(in srgb, currentColor 22%, transparent);
        transition: background-color .18s; }
      .hl_switch i { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
        background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .18s; }
      .hl_switch[data-on='true'] { background: var(--dsw-alias-state-success-primary, #3b82f6); }
      .hl_switch[data-on='true'] i { transform: translateX(16px); }
      .hl_switch[disabled] { opacity: .5; cursor: default; }
      @media (prefers-reduced-motion: reduce) { .hl_switch, .hl_switch i { transition: none; } }
      .hl_input, .hl_area { width: 100%; font: inherit; font-size: 12px; padding: 5px 8px; border-radius: 7px;
        border: .5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
        background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; }
      .hl_area { min-height: 56px; resize: vertical; }
      .hl_suffix { font-size: 11px; opacity: .7; white-space: nowrap; }
      .hl_bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .hl_btn { font-size: 12px; padding: 5px 12px; border-radius: 7px; cursor: pointer;
        border: .5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background: transparent; color: inherit; }
      .hl_btn[data-primary='true'] { background: var(--dsw-alias-interactive-bg-hover, rgba(90,140,255,.18));
        border-color: var(--dsw-alias-border-l3, rgba(90,140,255,.45)); }
      .hl_btn[disabled] { opacity: .45; cursor: default; }
      .hl_note { font-size: 11px; }
      .hl_note[data-kind='ok'] { color: var(--dsw-alias-state-success-primary, #2f8f5b); }
      .hl_note[data-kind='err'] { color: var(--dsw-alias-state-error-primary, #c0392b); }
      .hl_rulesarea { display: block; width: 100%; min-height: 160px; resize: vertical; font: inherit; font-size: 12px;
        line-height: 1.6; padding: 9px 11px; border-radius: 8px; color: inherit;
        border: .5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
        background: var(--dsw-alias-bg-layer-2, transparent); }
      .hl_rulesarea:focus { outline: none; border-color: var(--dsw-alias-border-l3, rgba(90,140,255,.45)); }
      .hl_rulesbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .hl_rulesmeta { margin-left: auto; font-size: 11px; font-variant-numeric: tabular-nums;
        color: var(--dsw-alias-label-secondary, color-mix(in srgb, currentColor 55%, transparent)); }
      .hl_foot { font-size: 11px; color: var(--dsw-alias-label-secondary, color-mix(in srgb, currentColor 50%, transparent)); word-break: break-all; }
    `

    async function callJson(url, init) {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        ...init,
      })
      const text = await response.text()
      let payload = null
      try {
        payload = text === '' ? null : JSON.parse(text)
      } catch {
        throw new Error(text.slice(0, 200) || `HTTP ${response.status}`)
      }
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`)
      }
      return payload
    }

    /** 把服务端给的值转成输入框里的字符串。 */
    const asText = (value) => (value === undefined || value === null ? '' : String(value))

    /** 开关：跟 B 站那几个插件一个样，36×20 的滑块，不用系统 checkbox。 */
    function Switch({ checked, disabled, label, onChange }) {
      return h('button', {
        type: 'button',
        className: 'hl_switch',
        role: 'switch',
        'aria-checked': checked === true ? 'true' : 'false',
        'aria-label': label,
        'data-on': checked === true ? 'true' : 'false',
        disabled: disabled === true,
        onClick: () => onChange?.(checked !== true),
      }, h('i'))
    }

    function Field({ item, value, onChange }) {
      const disabled = item.type === 'boolean' ? false : false
      if (item.type === 'boolean') {
        return h('div', { className: 'hl_row' },
          h('div', { className: 'hl_label' },
            h('span', { className: 'hl_labeltext' }, item.title),
            item.description ? h('span', { className: 'hl_hint' }, item.description) : null),
          h('div', { className: 'hl_field' },
            h(Switch, {
              checked: value === true,
              disabled,
              label: item.title,
              onChange: (next) => onChange(next),
            })))
      }
      if (item.type === 'string' && (item.key === 'favoredSay' || item.key === 'lossHarshNote')) {
        return h('div', { className: 'hl_row' },
          h('div', { className: 'hl_label' },
            h('span', { className: 'hl_labeltext' }, item.title),
            item.description ? h('span', { className: 'hl_hint' }, item.description) : null),
          h('div', { className: 'hl_field' },
            h('textarea', {
              className: 'hl_area',
              value: asText(value),
              spellCheck: false,
              onChange: (event) => onChange(event.target.value),
              'aria-label': item.title,
            })))
      }
      if (item.type === 'string') {
        return h('div', { className: 'hl_row' },
          h('div', { className: 'hl_label' },
            h('span', { className: 'hl_labeltext' }, item.title),
            item.description ? h('span', { className: 'hl_hint' }, item.description) : null),
          h('div', { className: 'hl_field' },
            h('input', {
              className: 'hl_input',
              type: 'text',
              value: asText(value),
              onChange: (event) => onChange(event.target.value),
              'aria-label': item.title,
            })))
      }
      const isNumber = item.type === 'number' || item.type === 'integer'
      return h('div', { className: 'hl_row' },
        h('div', { className: 'hl_label' },
          h('span', { className: 'hl_labeltext' }, item.title),
          item.description ? h('span', { className: 'hl_hint' }, item.description) : null),
        h('div', { className: 'hl_field' },
          h('input', {
            className: 'hl_input',
            type: 'number',
            value: asText(value),
            min: item.min,
            max: item.max,
            step: item.type === 'integer' ? 1 : 'any',
            onChange: (event) => onChange(event.target.value),
            'aria-label': item.title,
          }),
          item.suffix ? h('span', { className: 'hl_suffix' }, item.suffix) : null))
    }

    /** 「规则」卡：一整段文本，跟 B站 那个规则卡同一套读写（GET / POST / DELETE /rules）。 */
    function RulesCard({ t }) {
      const [state, setState] = useState({ text: '', defaults: '', isDefault: true, file: '' })
      const [text, setText] = useState('')
      const [busy, setBusy] = useState(null)
      const [note, setNote] = useState(null)
      const [loaded, setLoaded] = useState(false)

      const load = useCallback(async () => {
        try {
          const payload = await callJson(API + '/rules', { method: 'GET' })
          setState({
            text: String(payload?.text ?? ''),
            defaults: String(payload?.defaults ?? ''),
            isDefault: payload?.isDefault !== false,
            file: String(payload?.file ?? ''),
          })
          setText(String(payload?.text ?? ''))
          setLoaded(true)
        } catch (err) {
          setNote({ kind: 'err', text: String(err?.message ?? err) })
          setLoaded(true)
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const dirty = text !== state.text

      const save = async () => {
        setBusy('save')
        try {
          const payload = await callJson(API + '/rules', {
            method: 'POST',
            body: JSON.stringify({ text }),
          })
          setState((cur) => ({ ...cur, text: String(payload?.text ?? ''), isDefault: payload?.isDefault === true }))
          setText(String(payload?.text ?? ''))
          setNote({ kind: 'ok', text: t('rulesSaved') })
        } catch (err) {
          setNote({ kind: 'err', text: t('rulesSaveFailed') + '：' + String(err?.message ?? err) })
        } finally {
          setBusy(null)
        }
      }

      const reset = async () => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm(t('rulesResetConfirm'))) return
        setBusy('reset')
        try {
          const payload = await callJson(API + '/rules', { method: 'DELETE' })
          setState((cur) => ({ ...cur, text: String(payload?.text ?? ''), isDefault: true }))
          setText(String(payload?.text ?? ''))
          setNote({ kind: 'ok', text: t('rulesResetDone') })
        } catch (err) {
          setNote({ kind: 'err', text: t('rulesSaveFailed') + '：' + String(err?.message ?? err) })
        } finally {
          setBusy(null)
        }
      }

      return h('div', { className: 'hl_card' },
        h('div', { className: 'hl_cardhead' },
          h('span', { className: 'hl_cardtitle' },
            t('rulesCard'),
            state.isDefault ? h('span', { className: 'hl_hint' }, ' · ' + t('rulesDefaultBadge')) : null),
          h('span', { className: 'hl_carddesc' }, t('rulesHint'))),
        h('textarea', {
          className: 'hl_rulesarea',
          value: text,
          spellCheck: false,
          placeholder: t('rulesPlaceholder'),
          'aria-label': t('rulesCard'),
          onChange: (event) => { setNote(null); setText(event.target.value) },
        }),
        h('div', { className: 'hl_rulesbar' },
          h('button', {
            type: 'button',
            className: 'hl_btn',
            'data-primary': 'true',
            disabled: busy !== null || !dirty,
            onClick: () => { void save() },
          }, busy === 'save' ? t('rulesSaving') : t('rulesSave')),
          h('button', {
            type: 'button',
            className: 'hl_btn',
            disabled: busy !== null,
            onClick: () => { void reset() },
          }, busy === 'reset' ? t('rulesResetting') : t('rulesReset')),
          note !== null && note.text !== ''
            ? h('span', { className: 'hl_note', 'data-kind': note.kind === 'err' ? 'err' : 'ok' }, note.text)
            : null,
          h('span', { className: 'hl_rulesmeta' }, t('rulesCount').replace('{n}', String(text.length)))))
    }

    function HumanlikeSection(props) {
      const t = props.t
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [activeGroup, setActiveGroup] = useState(null)
      const [draft, setDraft] = useState({})
      const [busy, setBusy] = useState(null)
      const [note, setNote] = useState(null)

      const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
          const payload = await callJson(API + '/settings', { method: 'GET' })
          setData(payload)
          setDraft({})
          setActiveGroup((current) => current ?? payload.groups?.[0]?.id ?? null)
        } catch (err) {
          setError(err)
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const groups = data?.groups ?? []
      const group = useMemo(
        () => groups.find((entry) => entry.id === activeGroup) ?? null,
        [groups, activeGroup],
      )

      const pending = useMemo(() => {
        const out = {}
        for (const g of groups) {
          const patch = draft[g.id]
          if (patch === undefined) continue
          const changed = {}
          for (const item of g.keys) {
            if (!(item.key in patch)) continue
            if (String(patch[item.key]) !== String(item.value)) changed[item.key] = patch[item.key]
          }
          if (Object.keys(changed).length) out[g.id] = changed
        }
        return out
      }, [draft, groups])

      const setField = (groupId, item, value) => {
        setNote(null)
        setDraft((current) => ({
          ...current,
          [groupId]: { ...(current[groupId] ?? {}), [item.key]: value },
        }))
      }

      const valueOf = (item) => {
        const patch = draft[group?.id ?? ''] ?? {}
        return item.key in patch ? patch[item.key] : item.value
      }

      const saveGroup = async () => {
        if (!group) return
        const patch = pending[group.id] ?? {}
        if (!Object.keys(patch).length) {
          setNote({ kind: 'info', text: t('noChange') })
          return
        }
        setBusy('save')
        try {
          const payload = await callJson(API + '/settings', {
            method: 'POST',
            body: JSON.stringify({ group: group.id, patch }),
          })
          setData(payload)
          setDraft((current) => {
            const next = { ...current }
            delete next[group.id]
            return next
          })
          setNote({ kind: 'ok', text: t('saved') })
        } catch (err) {
          setNote({ kind: 'err', text: String(err?.message ?? err) })
        } finally {
          setBusy(null)
        }
      }

      const resetGroup = async (all) => {
        setBusy('reset')
        try {
          const payload = await callJson(API + '/reset', {
            method: 'POST',
            body: JSON.stringify(all ? {} : { group: group?.id }),
          })
          setData(payload)
          setDraft({})
          setNote({ kind: 'ok', text: t('saved') })
        } catch (err) {
          setNote({ kind: 'err', text: String(err?.message ?? err) })
        } finally {
          setBusy(null)
        }
      }

      if (loading && data === null) {
        return h('div', { className: 'hl_root' }, h('p', { className: 'hl_sub' }, t('loading')))
      }

      if (error !== null && data === null) {
        return h('div', { className: 'hl_root' },
          h('div', { className: 'hl_head' }, h('h2', { className: 'hl_h1' }, t('title'))),
          h('p', { className: 'hl_note', 'data-kind': 'err' }, t('loadFailed') + '：' + String(error?.message ?? error)),
          h('p', { className: 'hl_sub' }, t('loadFailedHint')),
          h('div', { className: 'hl_bar' },
            h('button', { type: 'button', className: 'hl_btn', 'data-primary': 'true', onClick: () => { void load() } }, t('retry'))))
      }

      const dirtyCount = Object.values(pending).reduce((sum, patch) => sum + Object.keys(patch).length, 0)

      return h('div', { className: 'hl_root' },
        h('div', { className: 'hl_tabs' },
          groups.map((g) => h('button', {
            key: g.id,
            type: 'button',
            className: 'hl_tab',
            'data-active': String(g.id === activeGroup),
            onClick: () => { setActiveGroup(g.id); setNote(null) },
          }, g.title)),
          h('button', {
            key: RULES_TAB,
            type: 'button',
            className: 'hl_tab',
            'data-active': String(activeGroup === RULES_TAB),
            onClick: () => { setActiveGroup(RULES_TAB); setNote(null) },
          }, t('rulesCard'))),
        group !== null
          ? h('div', { className: 'hl_card' },
              h('div', { className: 'hl_cardhead' },
                h('span', { className: 'hl_cardtitle' }, group.title),
                group.description ? h('span', { className: 'hl_carddesc' }, group.description) : null),
              group.keys.map((item) => h(Field, {
                key: item.key,
                item,
                value: valueOf(item),
                onChange: (value) => setField(group.id, item, value),
              })),
              h('div', { className: 'hl_bar' },
                h('button', {
                  type: 'button',
                  className: 'hl_btn',
                  'data-primary': 'true',
                  disabled: busy !== null,
                  onClick: () => { void saveGroup() },
                }, busy === 'save' ? t('saving') : t('save')),
                h('button', {
                  type: 'button',
                  className: 'hl_btn',
                  disabled: busy !== null,
                  onClick: () => { void resetGroup(false) },
                }, busy === 'reset' ? t('resetting') : t('reset')),
                h('button', {
                  type: 'button',
                  className: 'hl_btn',
                  disabled: busy !== null,
                  onClick: () => { void resetGroup(true) },
                }, t('resetAll')),
                dirtyCount ? h('span', { className: 'hl_note', 'data-kind': 'info' }, t('unsaved')) : null,
                note !== null && note.text !== ''
                  ? h('span', { className: 'hl_note', 'data-kind': note.kind === 'err' ? 'err' : 'ok' }, note.text)
                  : null))
          : null,
        activeGroup === RULES_TAB ? h(RulesCard, { t }) : null,
        h('p', { className: 'hl_foot' }, t('footnote') + '：' + String(data?.file ?? '—')))
    }

    function apply(ctx) {
      const locale = ctx.locale
      if (locale !== void 0 && typeof locale.register === 'function') {
        try {
          ctx.effect(() => locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-qqbot-humanlike: dictionaries')
        } catch { /* 词典注册失败就退回中文表 */ }
      }

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-qqbot-humanlike')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { try { style.remove() } catch { /* already detached */ } }
      }, 'dsh-qqbot-humanlike: styles')

      const t = locale !== void 0 && typeof locale.bind === 'function'
        ? locale.bind(NS)
        : (key) => DICT.zh[key] ?? DICT.en[key] ?? key

      // 并进 QQ 设置页的第二个页签，不再单独注册 settings.section。
      humanlikeTab = (props) => h(HumanlikeSection, { ...props, t })
    }

  apply(parentCtx)
}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
