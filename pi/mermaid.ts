// pi 适配：用仓库的平台无关 core（core/core.ts）画回复里的 mermaid 块，和 Claude Code 插件出同一张图。
// 要配合 settings 里 "markdown": { "mermaid": "off" } 关掉 pi 自带渲染：自带的先跑，会把它能画的先换成另一套样子。
import * as core from "../core/core.ts";
import type { ExtensionAPI, MarkdownTransformContext } from "@earendil-works/pi-coding-agent";

type Role = "border" | "text" | "edge" | "edgeLabel" | "title" | "none";
type Span = { text: string; role?: Role; cls?: Role };
let theme: { fg(color: string, s: string): string; bold(s: string): string } | null = null;

function codeSpan(line: string): string {
	const content = line || "\u00a0";
	const run = Math.max(0, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length));
	const fence = "`".repeat(run + 1);
	const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return fence + pad + content + pad + fence;
}

function paint(span: Span): string {
	const role = span.role ?? span.cls ?? "none";
	if (!theme) return span.text;
	switch (role) {
		case "border": return theme.fg("borderMuted", span.text);
		case "text": return theme.fg("text", span.text);
		case "edge": return theme.fg("accent", span.text);
		case "edgeLabel": return theme.fg("muted", span.text);
		case "title": return theme.fg("accent", theme.bold(span.text));
		default: return span.text;
	}
}

export function renderMermaid(markdown: string, context: MarkdownTransformContext): string {
	if (context.messageType === "assistant-thinking" || context.isStreaming || !markdown.includes("mermaid")) return markdown;
	const diagrams = core.findDiagrams(markdown).filter((d) => d.closed);
	if (diagrams.length === 0) return markdown;
	const cols = Math.max(20, context.availableWidth - 2);
	const lang = core.replyLang(markdown);
	return core
		.segments(markdown, diagrams)
		.map((part) => {
			if ("text" in part) return part.text;
			const f = core.fit(part.diagram.source, cols, { lang });
			const rows = (f.art.styled as Span[][]).map((row) => codeSpan(row.map(paint).join("")));
			// 没画出来的原因放在源码框上面，图再长也一眼看得到。
			if (f.kind === "box" && f.note) rows.unshift(codeSpan(theme ? theme.fg("warning", f.note) : f.note));
			return "\n" + rows.join("  \n") + "\n";
		})
		.join("");
}

export default function mermaid(pi: ExtensionAPI): void {
	pi.on("session_start", (_e, ctx) => {
		theme = ctx.ui.theme as never;
	});
}
