// 运行：bun test
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import reminder, {
	ENTRY_TYPE,
	InputQueue,
	MESSAGE_TYPE,
	ReminderCounter,
	injectReminders,
	isUserTyped,
	loadReminderText,
} from "./rules.ts";

const WAKE = "\u2063AUTO: hidden wake-up message";

describe("计数", () => {
	test("第 1 条提醒，之后每 5 条一次", () => {
		const counter = new ReminderCounter();
		const due = Array.from({ length: 12 }, () => counter.next());
		expect(due.map((d, i) => (d ? i + 1 : 0)).filter(Boolean)).toEqual([1, 6, 11]);
	});

	test("压缩后从头重新数", () => {
		const counter = new ReminderCounter();
		counter.next(); // 1：提醒
		counter.next(); // 2
		counter.next(); // 3
		counter.compacted();
		const due = Array.from({ length: 6 }, () => counter.next());
		expect(due).toEqual([false, false, false, false, true, false]);
	});

	test("按记录恢复后接着数", () => {
		const counter = new ReminderCounter();
		counter.replay([
			{ kind: "message", due: true, anchor: 1, text: "x" },
			{ kind: "message", due: false },
			{ kind: "message", due: false },
		]);
		// 已数到第 3 条，第 4、5 条不提醒，第 6 条提醒。
		expect([counter.next(), counter.next(), counter.next()]).toEqual([false, false, true]);
	});
});

describe("分辨用户自己打的字", () => {
	test("终端输入算", () => expect(isUserTyped("好的", "interactive")).toBe(true));
	test("扩展发的不算", () => expect(isUserTyped("好的", "extension")).toBe(false));
	test("RPC 不算", () => expect(isUserTyped("好的", "rpc")).toBe(false));
	test("开头带隐藏标记的不算", () => expect(isUserTyped(WAKE, "interactive")).toBe(false));
});

describe("输入和消息对上", () => {
	test("按顺序对上，唤醒不算", () => {
		const q = new InputQueue();
		q.push("你好", true);
		q.push(WAKE, false);
		expect(q.take("你好")).toBe(true);
		expect(q.take(WAKE)).toBe(false);
	});

	test("技能展开和图片说明也能对上", () => {
		const q = new InputQueue();
		q.push("/afk 我去吃饭", true);
		q.push("看图", true);
		expect(q.take('<skill name="afk">...</skill>\n我去吃饭')).toBe(true);
		expect(q.take("看图\n\n[image resized]")).toBe(true);
	});

	test("被拦下的输入不会错位", () => {
		const q = new InputQueue();
		q.push("被别的扩展拦下了", true);
		q.push(WAKE, false);
		expect(q.take(WAKE)).toBe(false);
		expect(q.take("对不上的消息")).toBe(false);
	});
});

describe("插入", () => {
	const msgs = [
		{ role: "compactionSummary", timestamp: 1, summary: "s" },
		{ role: "user", timestamp: 2, content: "a" },
		{ role: "assistant", timestamp: 3, content: [] },
		{ role: "user", timestamp: 4, content: "b" },
	];

	test("锚点后面和压缩摘要后面各插一条", () => {
		const out = injectReminders(msgs, new Map([[4, "规矩"]]), "压缩后规矩");
		expect(out.map((m) => m.role)).toEqual(["compactionSummary", "custom", "user", "assistant", "user", "custom"]);
		expect((out[5] as unknown as { content: string }).content).toContain("规矩");
		expect((out[5] as unknown as { customType: string }).customType).toBe(MESSAGE_TYPE);
		expect(msgs).toHaveLength(4);
	});

	test("没有要插的就原样返回", () => {
		expect(injectReminders(msgs, new Map(), undefined)).toBe(msgs);
	});
});

// 用假的 pi 把事件串起来跑一遍。
function fakePi() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const branch: Array<{ type: string; customType?: string; data?: unknown }> = [];
	const pi = {
		on(name: string, fn: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data });
		},
	};
	return { pi, handlers, branch };
}

describe("整条链路", () => {
	const dir = mkdtempSync(join(tmpdir(), "reminder-"));
	const globalFile = join(dir, "global.md");
	const project = join(dir, "project");
	mkdirSync(join(project, ".pi"), { recursive: true });
	// 这组测的是个人、项目文件的拼接和计数，仓库 rules.md 换成不存在的路径。
	process.env.AGENT_VISUAL_RULES = join(dir, "no-rules.md");
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	let env: ReturnType<typeof fakePi>;
	let ts = 0;
	let ctx: { cwd: string; sessionManager: { getBranch(): unknown[] } };
	const emit = (name: string, event: unknown) =>
		(env.handlers.get(name) ?? []).map((fn) => fn(event, ctx)).find((r) => r !== undefined);
	const send = (text: string, source: string) => {
		emit("input", { type: "input", text, source });
		const message = { role: "user", content: [{ type: "text", text }], timestamp: ++ts };
		emit("message_end", { type: "message_end", message });
		return message;
	};

	beforeEach(() => {
		process.env.PI_REMINDER_FILE = globalFile;
		writeFileSync(globalFile, "回复规矩：全用中文");
		writeFileSync(join(project, ".pi", "reminder.md"), "项目规矩");
		env = fakePi();
		ts = 0;
		ctx = { cwd: project, sessionManager: { getBranch: () => env.branch } };
		reminder(env.pi as never);
		emit("session_start", { type: "session_start" });
	});

	test("只按用户消息计数，唤醒不算，全局加项目原文", () => {
		const sent = [];
		for (let i = 0; i < 7; i++) {
			sent.push(send(`第${i + 1}条`, "interactive"));
			sent.push(send(WAKE, "extension"));
		}
		const result = emit("context", { type: "context", messages: sent }) as { messages: Array<{ role: string; content: unknown }> };
		const reminders = result.messages.filter((m) => m.role === "custom");
		expect(reminders).toHaveLength(2);
		expect(String(reminders[0].content)).toContain("回复规矩：全用中文\n\n项目规矩");
		const before = result.messages.map((m, i) => (m.role === "custom" ? result.messages[i - 1] : null)).filter(Boolean);
		expect(before.map((m) => (m as { content: Array<{ text: string }> }).content[0].text)).toEqual(["第1条", "第6条"]);
		const records = env.branch.filter((e) => e.customType === ENTRY_TYPE);
		expect(records).toHaveLength(7);
	});

	test("压缩后摘要后面补一次，重开会话后接着数", () => {
		for (let i = 0; i < 3; i++) send(`第${i + 1}条`, "interactive");
		env.branch.push({ type: "compaction" });
		emit("session_compact", { type: "session_compact" });
		const summary = { role: "compactionSummary", summary: "s", timestamp: ++ts };
		const after = [summary, send("第4条", "interactive")];
		const result = emit("context", { type: "context", messages: after }) as { messages: Array<{ role: string }> };
		expect(result.messages.map((m) => m.role)).toEqual(["compactionSummary", "custom", "user"]);

		// 模拟 /reload：新实例从会话记录恢复。
		const branch = env.branch;
		env = fakePi();
		env.branch.push(...branch);
		reminder(env.pi as never);
		emit("session_start", { type: "session_start" });
		const more = [5, 6, 7, 8].map((n) => send(`第${n}条`, "interactive"));
		const again = emit("context", { type: "context", messages: [summary, ...more] }) as { messages: Array<{ role: string }> };
		// 压缩后数到第 5 条（第 4–8 条里的第 8 条）才再提醒。
		expect(again.messages.map((m) => m.role)).toEqual(["compactionSummary", "custom", "user", "user", "user", "user", "custom"]);
	});

	test("没有原文文件时什么都不做", () => {
		rmSync(globalFile);
		rmSync(join(project, ".pi", "reminder.md"));
		const m = send("你好", "interactive");
		expect(emit("context", { type: "context", messages: [m] })).toBeUndefined();
		expect(env.branch).toHaveLength(0);
		expect(loadReminderText(project)).toBe("");
	});
});
