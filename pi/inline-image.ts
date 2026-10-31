// 回复正文里的图片：把单独成行的 ![说明](路径 "w=100 center") 换成终端内联图，
// 点图打开原图。图片在本机读取，不进模型上下文。
//
// 只处理独占一行、路径是绝对路径或 ~ 开头的本地图片；代码块里的不动；流式输出时不渲染。
// 写法：title 里可写 w=列数（默认按图片原始大小，不超过可用宽度和屏幕高度的 85%）、center（居中）。
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import { t, replyLang } from "../core/i18n.ts";
import { Image, allocateImageId, getCapabilities, getCellDimensions, getImageDimensions, hyperlink, renderImage } from "@earendil-works/pi-tui";
import { pngBands } from "./png-bands.ts";

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

function renderOne(alt: string, rawPath: string, title: string | undefined, avail: number, lang: "en" | "zh"): string | null {
	const path = expand(rawPath);
	if (!path.startsWith("/")) return null;
	const mime = MIME[extname(path).toLowerCase()];
	if (!mime) return null;
	const link = `[${alt || basename(path)}](${pathToFileURL(path).href})`;
	if (!existsSync(path)) return `> [!WARNING]\n> ${t("Image not found", lang)}${lang === "zh" ? "：" : ": "}\`${rawPath}\``;
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
	if (imgIdx === 0 && getCapabilities().images === "kitty") {
		const bands = bandStrips(key, data, mime, rows, cols);
		if (bands) return bands.map((l) => codeSpan(pad + l + hot)).join("\n\n");
		const strips = kittyStrips(lines[0], data, mime, rows);
		// 后面各条把链接格子写在前面、退回光标再放图：pi 往上翻时会把「紧挨屏幕顶上的那行图」
		// 按整张图重新裁一遍，它认的是图片转义码后面的第一个分号；条里没有分号，pi 就不会误裁它们。
		if (strips) return strips.map((l, k) => codeSpan(k === 0 ? pad + l + hot : pad + hot + `\x1b[${cols}D` + l)).join("\n\n");
	}
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

// 分条显示：Markdown 里每段图片行之间必有一个空行，所以一条占两行（自己那行加下面的空行）。
//
// PNG：切成每条一张的小图，每条自带自己那段的数据，哪条先进屏幕就先显示哪条；
// pi 按每张小图登记的尺寸裁剪、缓存和回收。
const bandCache = new Map<string, string[] | null>();
function bandStrips(key: string, data: string, mime: string, rows: number, cols: number): string[] | null {
	if (mime !== "image/png" || rows < 3) return null;
	if (bandCache.has(key)) return bandCache.get(key)!;
	const lines = cutBands(data, mime, rows, cols);
	bandCache.set(key, lines);
	if (bandCache.size > 30) bandCache.delete(bandCache.keys().next().value!);
	return lines;
}

function cutBands(data: string, mime: string, rows: number, cols: number): string[] | null {
	const dim = getImageDimensions(data, mime);
	if (!dim) return null;
	const cuts: number[] = [];
	for (let k = 0; 2 * k < rows; k++) cuts.push(Math.floor((dim.heightPx * 2 * k) / rows));
	const pngs = pngBands(Buffer.from(data, "base64"), cuts);
	if (!pngs) return null;
	const lines: string[] = [];
	for (let k = 0; k < pngs.length; k++) {
		const r = Math.min(2, rows - 2 * k);
		// renderImage 登记这张小图的真实像素尺寸和行数，pi 靠它裁剪和缓存；列数统一改成整张图的列数。
		const out = renderImage(pngs[k].toString("base64"), { widthPx: dim.widthPx, heightPx: pngs[k].readUInt32BE(20) }, {
			maxWidthCells: cols,
			maxHeightCells: r,
			imageId: allocateImageId(),
			moveCursor: false,
		});
		if (!out || out.rows !== r) return null;
		lines.push(out.sequence.replace(/^(\x1b_G[^;]*?),c=\d+/, `$1,c=${cols}`));
	}
	return lines;
}

// 其他格式（JPG、GIF、WebP）：第一条带整张图的数据，后面每条用 a=p 放同一张图的下一段
// （按源图像素裁），整张图只传一次。缺点是第一条没进过屏幕时数据还没发，下面各条画不出来。
function kittyStrips(first: string, data: string, mime: string, rows: number): string[] | null {
	const m = /^\x1b_G([^;]*);/.exec(first);
	const id = m && /(?:^|,)i=(\d+)/.exec(m[1])?.[1];
	const cols = m && /(?:^|,)c=(\d+)/.exec(m[1])?.[1];
	const dim = getImageDimensions(data, mime);
	if (!m || !id || !cols || !dim || rows < 3) return null;
	const H = dim.heightPx;
	const band = (k: number) => {
		const r = Math.min(2, rows - 2 * k);
		const y = Math.floor((H * 2 * k) / rows);
		return { y, h: Math.max(1, Math.floor((H * (2 * k + r)) / rows) - y), r };
	};
	const b0 = band(0);
	const head = "\x1b_G" + m[1].split(",").filter((c) => !/^[yhr]=/.test(c)).concat("y=0", `h=${b0.h}`, `r=${b0.r}`).join(",") + ";";
	const out = [head + first.slice(m[0].length)];
	for (let k = 1; 2 * k < rows; k++) {
		const b = band(k);
		out.push(`\x1b_Ga=p,i=${id},p=${k + 1},y=${b.y},h=${b.h},c=${cols},r=${b.r},C=1,q=2\x1b\\`);
	}
	return out;
}

export function renderInlineImages(markdown: string, context: MarkdownTransformContext): string {
	if (context.messageType !== "assistant" || context.isStreaming || !markdown.includes("![")) return markdown;
	const lang = replyLang(markdown);
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
		const rendered = m ? renderOne(m[1], m[2], m[3], context.availableWidth, lang) : null;
		out.push(rendered === null ? line : "\n" + rendered + "\n");
	}
	return out.join("\n");
}
