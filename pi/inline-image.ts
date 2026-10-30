// 回复正文里的图片：把单独成行的 ![说明](路径 "w=100 center") 换成终端内联图，
// 图下附一行可点击的「打开原图」链接。图片在本机读取，不进模型上下文。
//
// 只处理独占一行、路径是绝对路径或 ~ 开头的本地图片；代码块里的不动；流式输出时不渲染。
// 写法：title 里可写 w=列数（默认按图片原始大小，不超过可用宽度和屏幕高度的 85%）、center（居中）。
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import { Image, getCapabilities, getCellDimensions, getImageDimensions, hyperlink } from "@earendil-works/pi-tui";

export const MAX_HEIGHT_RATIO = 0.85;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const LINE_RE = /^\s*!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

const theme = { fallbackColor: (s: string) => s };
// 同一张图、同一宽度复用一个 Image：kitty 下保持同一个图片 ID，重绘不反复上传。
const cache = new Map<string, Image>();

function expand(p: string): string {
	return p.startsWith("~/") ? homedir() + p.slice(1) : p.startsWith("file://") ? decodeURI(p.slice(7)) : p;
}

function codeSpan(content: string): string {
	return "`" + (content || "\u00a0") + "`";
}

export function parseOptions(title = ""): { width?: number; center: boolean } {
	const w = /(?:^|\s)w=(\d+)/.exec(title);
	return { width: w ? Number(w[1]) : undefined, center: /(?:^|\s)center(?:\s|$)/.test(title) };
}

function renderOne(alt: string, rawPath: string, title: string | undefined, avail: number): string | null {
	const path = expand(rawPath);
	if (!path.startsWith("/")) return null;
	const mime = MIME[extname(path).toLowerCase()];
	if (!mime) return null;
	const link = `[Open image${alt ? ": " + alt : ""}](${pathToFileURL(path).href})`;
	if (!existsSync(path)) return `> [!WARNING]\n> Image not found: \`${rawPath}\``;
	if (!getCapabilities().images) return link;
	const opt = parseOptions(title);
	// 默认按图片本身的像素大小显示：小图不放大，大图最多铺满可用宽度、高度不超过屏幕的 85%。
	// 写了 w= 就按 w= 来（仍不超过可用宽度）。
	const mtime = statSync(path).mtimeMs;
	const data = readFileSync(path).toString("base64");
	const maxWidth = Math.max(10, avail - 2);
	const maxHeight = Math.max(8, Math.floor((process.stdout.rows || 50) * MAX_HEIGHT_RATIO));
	let width: number;
	if (opt.width) width = Math.max(10, Math.min(opt.width, maxWidth));
	else {
		const dim = getImageDimensions(data, mime);
		const cell = getCellDimensions();
		const natural = dim ? Math.ceil(dim.widthPx / cell.widthPx) : maxWidth;
		width = Math.max(10, Math.min(natural, maxWidth));
	}
	const key = `${path}|${mtime}|${width}|${maxHeight}`;
	let img = cache.get(key);
	if (!img) {
		img = new Image(data, mime, theme, { maxWidthCells: width, maxHeightCells: maxHeight });
		cache.set(key, img);
		if (cache.size > 30) cache.delete(cache.keys().next().value!);
	}
	const lines = img.render(width + 2);
	const url = pathToFileURL(path).href;
	const imgIdx = lines.findIndex((l) => l.includes("\x1b_G") || l.includes("\x1b]1337;"));
	if (imgIdx < 0) return lines.map((l) => codeSpan(l)).join("  \n") + "\n\n" + link;
	// 实际列数：kitty 转义码里的 c=；拿不到就用目标宽度。
	const cols = Number(/[,;]c=(\d+)/.exec(lines[imgIdx])?.[1] ?? width);
	const pad = opt.center ? "\u00a0".repeat(Math.max(0, Math.floor((avail - cols) / 2))) : "";
	// 点图打开原图：图片覆盖的每个格子都放一个指向原图的 OSC 8 链接（不换行空格），
	// pi 全屏模式按点击位置取该格的链接并用系统默认程序打开。
	const hot = hyperlink("\u00a0".repeat(cols), url);
	const rows = lines.length;
	// Markdown 会把图片转义码和同段的占位行并成一行，图只剩一行高；所以图片行单独成段，
	// 占位行另成一段，两段之间的空行也占一行（不带链接，点不中的只有这一行）。
	const filler = Array.from({ length: Math.max(0, rows - 2) }, () => codeSpan(pad + hot)).join("  \n");
	let body: string;
	if (imgIdx === 0) {
		// kitty：C=1 画完光标不动，后面的链接格子正好叠在图的第一行上。
		const img = codeSpan(pad + lines[0] + hot);
		body = [img, filler].filter(Boolean).join("\n\n");
	} else {
		body = [filler, codeSpan(pad + lines[imgIdx])].filter(Boolean).join("\n\n");
	}
	return body;
}

export function renderInlineImages(markdown: string, context: MarkdownTransformContext): string {
	if (context.messageType !== "assistant" || context.isStreaming || !markdown.includes("![")) return markdown;
	const out: string[] = [];
	let fence: string | null = null;
	for (const line of markdown.split("\n")) {
		const f = FENCE_RE.exec(line);
		if (f) {
			if (fence === null) fence = f[1][0];
			else if (f[1][0] === fence) fence = null;
			out.push(line);
			continue;
		}
		const m = fence === null ? LINE_RE.exec(line) : null;
		const rendered = m ? renderOne(m[1], m[2], m[3], context.availableWidth) : null;
		out.push(rendered === null ? line : "\n" + rendered + "\n");
	}
	return out.join("\n");
}
