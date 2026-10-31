// 把一张 PNG 横着切成几段，每段是一张独立的 PNG。不把像素解成 RGBA：解压后每行保留原来的
// 滤波字节，只改写每段的第一行（它的滤波可能引用上一行，而上一行已经不在这段里）。
// 不处理的（不是 PNG、隔行扫描、数据坏了）返回 null，由调用方退回原来的画法。
import { deflateSync, inflateSync } from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

let crcTable: Uint32Array | undefined;
function crc32(buf: Uint8Array): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "latin1");
	out.set(data, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

/** cuts：每段起始的像素行，从小到大，第一个是 0。 */
export function pngBands(png: Buffer, cuts: number[]): Buffer[] | null {
	if (png.length < 33 || !png.subarray(0, 8).equals(SIG)) return null;
	let ihdr: Buffer | undefined;
	const extra: Buffer[] = [];
	const idat: Buffer[] = [];
	for (let off = 8; off + 12 <= png.length; ) {
		const len = png.readUInt32BE(off);
		const type = png.toString("latin1", off + 4, off + 8);
		const data = png.subarray(off + 8, off + 8 + len);
		if (type === "IHDR") ihdr = Buffer.from(data);
		else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		else if (idat.length === 0) extra.push(png.subarray(off, off + 12 + len)); // PLTE、tRNS、sRGB、iCCP 等原样带上
		off += 12 + len;
	}
	if (!ihdr || idat.length === 0) return null;
	const width = ihdr.readUInt32BE(0);
	const height = ihdr.readUInt32BE(4);
	const depth = ihdr[8];
	const channels = CHANNELS[ihdr[9]];
	if (!channels || ihdr[12] !== 0) return null; // 隔行扫描的行不连续
	const stride = Math.ceil((width * channels * depth) / 8);
	const bpp = Math.max(1, Math.ceil((channels * depth) / 8));
	let raw: Buffer;
	try {
		raw = inflateSync(Buffer.concat(idat));
	} catch {
		return null;
	}
	const line = stride + 1;
	if (raw.length < line * height) return null;
	// 每段第一行要还原成原始字节。滤波是 None 或 Sub 的行不依赖上一行，所以从它往上最近的
	// 这种行开始还原就够了，不用从整张图的第一行算起。
	const firstRows = new Map<number, Uint8Array>();
	for (const y0 of cuts) {
		if (y0 <= 0 || y0 >= height) continue;
		let s = y0;
		while (s > 0 && raw[s * line] > 1) s--;
		let prev = new Uint8Array(stride);
		let cur = new Uint8Array(stride);
		for (let y = s; y <= y0; y++) {
			if (!unfilter(raw, y * line, stride, bpp, prev, cur)) return null;
			[prev, cur] = [cur, prev];
		}
		firstRows.set(y0, prev);
	}
	const sig = Buffer.from(SIG);
	const iend = chunk("IEND", new Uint8Array(0));
	const bounds = [...cuts.filter((y) => y < height), height];
	const out: Buffer[] = [];
	for (let k = 0; k + 1 < bounds.length; k++) {
		const y0 = bounds[k], y1 = bounds[k + 1];
		if (y1 <= y0) return null;
		const body = Buffer.from(raw.subarray(y0 * line, y1 * line));
		const first = firstRows.get(y0);
		if (first) {
			body[0] = 0; // 第一行单独成立：滤波 None，写原始字节
			body.set(first, 1);
		}
		const h = Buffer.from(ihdr);
		h.writeUInt32BE(y1 - y0, 4);
		out.push(Buffer.concat([sig, chunk("IHDR", h), ...extra, chunk("IDAT", deflateSync(body)), iend]));
	}
	return out;
}

/** 把 raw[at] 处的一行（开头是滤波字节）还原成原始字节写进 cur；prev 是上一行的原始字节。 */
export function unfilter(raw: Buffer, at: number, stride: number, bpp: number, prev: Uint8Array, cur: Uint8Array): boolean {
	const f = raw[at];
	const x = raw.subarray(at + 1, at + 1 + stride);
	switch (f) {
		case 0:
			cur.set(x);
			return true;
		case 1:
			for (let i = 0; i < stride; i++) cur[i] = (x[i] + (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
			return true;
		case 2:
			for (let i = 0; i < stride; i++) cur[i] = (x[i] + prev[i]) & 0xff;
			return true;
		case 3:
			for (let i = 0; i < stride; i++) cur[i] = (x[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 0xff;
			return true;
		case 4:
			for (let i = 0; i < stride; i++) {
				const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
				const pa = b > c ? b - c : c - b, pb = a > c ? a - c : c - a, pc0 = a + b - c - c;
				const pc = pc0 < 0 ? -pc0 : pc0;
				cur[i] = (x[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
			}
			return true;
		default:
			return false;
	}
}
