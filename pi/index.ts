// agent-visual 的 pi 扩展入口：
//   - mermaid.ts：用 core/core.ts 画 mermaid 块（和 Claude Code 插件同一套渲染）；
//   - inline-image.ts：回复里单独一行的 ![说明](/绝对路径.png) 换成终端内联图，点图打开原图；
//   - rules.ts：把 rules.md（加上个人、项目的提醒文件）周期性地只给模型看。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import mermaid, { renderMermaid } from "./mermaid.ts";
import { renderInlineImages } from "./inline-image.ts";
import rules from "./rules.ts";

export default function (pi: ExtensionAPI): void {
	mermaid(pi);
	rules(pi);
	// 每个扩展只有一个 markdownTransformer 槽位：先画图，再换图片。
	pi.registerMarkdownTransformer((md, ctx) => renderInlineImages(renderMermaid(md, ctx), ctx));
}
