/**
 * 传输层
 *
 * 协议对接：QQ 消息入站 / 出站 / Markdown 切分。
 */
export { handleInbound, disposeInbound } from "./inbound.js";
export { createOutboundHandler } from "./outbound.js";
export { OutboundBuffer } from "./outbound-buffer.js";
export { chunkMarkdownText } from "./chunker.js";
//# sourceMappingURL=index.js.map