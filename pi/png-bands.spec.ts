// 运行：bun test
import { describe, expect, test } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";
import { kittyPng, pngBands, unfilter } from "./png-bands.ts";

// 造一张 RGB 图，每行轮流用五种滤波编码，这样切口落在任何一行上都可能遇到依赖上一行的滤波。
function makePng(width: number, height: number, channels = 3) {
	const stride = width * channels;
	const rows: Uint8Array[] = [];
	for (let y = 0; y < height; y++) {
		const row = new Uint8Array(stride);
		for (let i = 0; i < stride; i++) row[i] = (y * 31 + i * 7 + ((i * y) % 13)) & 0xff;
		rows.push(row);
	}
	const body: number[] = [];
	for (let y = 0; y < height; y++) {
		const f = y % 5, cur = rows[y], prev = y ? rows[y - 1] : new Uint8Array(stride);
		body.push(f);
		for (let i = 0; i < stride; i++) {
			const a = i >= channels ? cur[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
			const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
			const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
			body.push((cur[i] - pred) & 0xff);
		}
	}
	const chunk = (type: string, data: Uint8Array) => {
		const out = Buffer.alloc(12 + data.length);
		out.writeUInt32BE(data.length, 0);
		out.write(type, 4, "latin1");
		out.set(data, 8);
		return out; // 测试里不校验 CRC，pngBands 也不读它
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = channels === 4 ? 6 : 2;
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(Buffer.from(body))),
		chunk("IEND", new Uint8Array(0)),
	]);
	return { png, rows, stride, channels };
}

// 读回一段：取高度，解压，逐行还原。
function decode(band: Buffer, stride: number, bpp: number) {
	const height = band.readUInt32BE(20);
	let off = 8;
	const idat: Buffer[] = [];
	while (off < band.length) {
		const len = band.readUInt32BE(off);
		if (band.toString("latin1", off + 4, off + 8) === "IDAT") idat.push(band.subarray(off + 8, off + 8 + len));
		off += 12 + len;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const out: Uint8Array[] = [];
	let prev = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		const cur = new Uint8Array(stride);
		expect(unfilter(raw, y * (stride + 1), stride, bpp, prev, cur)).toBe(true);
		out.push(cur);
		prev = cur;
	}
	return out;
}

describe("pngBands", () => {
	test("每段读回来和原图对应的行逐字节相同", () => {
		for (const channels of [3, 4]) {
			const { png, rows, stride } = makePng(17, 41, channels);
			const cuts = [0, 1, 7, 8, 9, 20, 33, 40];
			const bands = pngBands(png, cuts)!;
			expect(bands.length).toBe(cuts.length);
			const back = bands.flatMap((b) => decode(b, stride, channels));
			expect(back.length).toBe(rows.length);
			back.forEach((row, y) => expect([...row]).toEqual([...rows[y]]));
		}
	});

	test("不是 PNG、隔行扫描时返回 null", () => {
		expect(pngBands(Buffer.from("not a png at all, just some bytes here"), [0])).toBeNull();
		const { png } = makePng(4, 4);
		const interlaced = Buffer.from(png);
		interlaced[8 + 8 + 12] = 1; // IHDR 的隔行扫描字节
		expect(pngBands(interlaced, [0, 2])).toBeNull();
	});
});

describe("kittyPng", () => {
	test("把分成几段传的 PNG 接回整张", () => {
		const b64 = makePng(9, 9).png.toString("base64");
		const seq = `\x1b_Ga=T,f=100,q=2,i=7,c=4,r=2,m=1;${b64.slice(0, 40)}\x1b\\\x1b_Gm=1;${b64.slice(40, 80)}\x1b\\\x1b_Gm=0;${b64.slice(80)}\x1b\\`;
		expect(kittyPng(seq)).toBe(b64);
	});

	test("不是 PNG 的传输、只放图不传数据时返回 null", () => {
		expect(kittyPng("\x1b_Ga=T,f=32,s=1,v=1;AAAA\x1b\\")).toBeNull();
		expect(kittyPng("\x1b_Ga=p,i=7,p=2,C=1,q=2\x1b\\")).toBeNull();
	});
});
