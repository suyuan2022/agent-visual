// 周期提醒：按用户自己发的消息计数，把一段提醒文字只给模型看、不在界面上显示。
//
// 提醒什么时候出现：
//   - 会话里用户的第 1 条消息旁边一次，之后每 5 条一次（第 1、6、11……条）；
//   - 上下文压缩后，紧跟在压缩摘要后面一次，并从头重新数 5 条。
// 只数用户在终端里打的字（input 事件 source === "interactive"）。扩展用 sendUserMessage 发的消息
// （source === "extension"）、扩展发的 custom 消息、以及开头带 U+2063（不可见分隔符，
// 自动注入消息常用它做隐藏标记，比如别的工具自动发来的消息）的输入都不算。
//
// 提醒原文不写在代码里，按顺序拼起来：
//   - 仓库根的 rules.md：画图和贴图的规矩，Claude Code 插件注入的也是这一份；
//   - 个人：~/.pi/agent/reminder.md（可用环境变量 PI_REMINDER_FILE 换路径），可选；
//   - 项目：<当前目录>/.pi/reminder.md，可选。
//
// 怎么插进去：Pi 在模型忙时收到的消息会排队，排队的消息不经过 before_agent_start，也没法在旁边
// 单独排一条隐藏消息（默认一次只送一条，模型会先对着一条孤零零的提醒回一轮）。所以这里不往会话里
// 写消息，而是在每次请求模型前（context 事件）按会话里记下的锚点，把提醒临时插到对应那条用户消息
// 后面。锚点和当时的提醒原文记成一条不进上下文的 custom 条目（pi.appendEntry），每次插的位置和内容
// 都一样，不破坏提示缓存；事后查会话文件里的这些条目，就能核对提醒在哪几条消息旁出现过。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ENTRY_TYPE = "agent-visual.rules";
export const MESSAGE_TYPE = "agent-visual.rules";
export const RULES_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "rules.md");
export const EVERY = 5;
const HIDDEN_MARK = "\u2063";

/** 会话里记下的条目：每条用户消息一条；到点的带上锚点时间戳和提醒原文。 */
export type ReminderEntry =
	| { kind: "message"; due: false }
	| { kind: "message"; due: true; anchor: number; text: string }
	| { kind: "compaction"; text: string };

/** 计数器：距上一次提醒之后数了几条用户消息。 */
export class ReminderCounter {
	private reminded = false;
	private since = 0;

	/** 来了一条用户消息，返回这一条旁边要不要提醒。 */
	next(): boolean {
		this.since += 1;
		if (!this.reminded || this.since >= EVERY) {
			this.reminded = true;
			this.since = 0;
			return true;
		}
		return false;
	}

	/** 上下文压缩后已经补过一次提醒，从头重新数。 */
	compacted(): void {
		this.reminded = true;
		this.since = 0;
	}

	/** 按会话里记下的条目恢复计数（/reload、/resume、切分支之后）。 */
	replay(entries: ReminderEntry[]): void {
		this.reminded = false;
		this.since = 0;
		for (const entry of entries) {
			if (entry.kind === "compaction" || entry.due) {
				this.reminded = true;
				this.since = 0;
			} else {
				this.since += 1;
			}
		}
	}
}

/** 这条输入算不算用户自己发的消息。 */
export function isUserTyped(text: string, source: string): boolean {
	return source === "interactive" && !text.startsWith(HIDDEN_MARK);
}

type AnyMessage = { role: string; timestamp?: number; content?: unknown };

function reminderMessage(text: string, timestamp: number): AnyMessage & Record<string, unknown> {
	return {
		role: "custom",
		customType: MESSAGE_TYPE,
		content: `<system-reminder>\n${text}\n</system-reminder>`,
		display: false,
		timestamp,
	};
}

/**
 * 在发给模型的消息里插提醒：锚点那条用户消息后面各插一条；有压缩摘要时，摘要后面插一条。
 * 不改传入的数组，返回新数组；什么都不用插时原样返回。
 */
export function injectReminders<M extends AnyMessage>(
	messages: M[],
	anchors: Map<number, string>,
	compactionText: string | undefined,
): M[] {
	let changed = false;
	const out: M[] = [];
	for (const message of messages) {
		out.push(message);
		const ts = message.timestamp ?? 0;
		if (message.role === "user" && anchors.has(ts)) {
			out.push(reminderMessage(anchors.get(ts)!, ts) as unknown as M);
			changed = true;
		} else if (message.role === "compactionSummary" && compactionText) {
			out.push(reminderMessage(compactionText, ts) as unknown as M);
			changed = true;
		}
	}
	return changed ? out : messages;
}

function readText(path: string): string {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return "";
	}
}

/** 读全局原文和项目原文，拼成一段；都没有时返回空串。 */
export function loadReminderText(cwd: string): string {
	const rules = readText(process.env.AGENT_VISUAL_RULES || RULES_FILE);
	const personal = readText(process.env.PI_REMINDER_FILE || join(homedir(), ".pi", "agent", "reminder.md"));
	const project = readText(join(cwd, ".pi", "reminder.md"));
	return [rules, personal, project].filter(Boolean).join("\n\n");
}

function userText(message: AnyMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/**
 * 把 input 事件和随后落进会话的用户消息对上：每条输入进队，每条用户消息按顺序取走对得上的那条。
 * 技能和模板会被展开（输入是 /xxx，消息是展开后的全文），图片会在文字后面追加说明，
 * 所以以 / 开头的输入对任何消息都算对上，其余的要求消息以输入原文开头。
 * 对不上的旧输入（比如被别的扩展拦下、没有生成消息）一并丢掉。
 */
export class InputQueue {
	private items: Array<{ text: string; typed: boolean }> = [];

	push(text: string, typed: boolean): void {
		this.items.push({ text, typed });
		if (this.items.length > 50) this.items.shift();
	}

	/** 返回这条用户消息是不是用户自己打的；队列里没有对得上的就当不是。 */
	take(messageText: string): boolean {
		const index = this.items.findIndex(
			(item) => item.text.startsWith("/") || messageText.startsWith(item.text.trim()),
		);
		if (index < 0) return false;
		const [item] = this.items.splice(0, index + 1).slice(-1);
		return item.typed;
	}
}

type BranchEntry = { type: string; customType?: string; data?: unknown };

function readEntries(branch: BranchEntry[]): {
	entries: ReminderEntry[];
	anchors: Map<number, string>;
	compactionText: string | undefined;
} {
	const entries: ReminderEntry[] = [];
	const anchors = new Map<number, string>();
	let compactionText: string | undefined;
	let compactedSinceRecord = false;
	for (const entry of branch) {
		if (entry.type === "compaction") {
			compactedSinceRecord = true;
			compactionText = undefined;
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data as ReminderEntry | undefined;
		if (!data || typeof data !== "object") continue;
		if (data.kind === "compaction") {
			compactionText = data.text;
			compactedSinceRecord = false;
		}
		if (data.kind === "message" && data.due) anchors.set(data.anchor, data.text);
		entries.push(data);
	}
	// 压缩发生在插件装上之前，或者压缩记录没来得及写：摘要后面用当前原文补。
	if (compactedSinceRecord) compactionText = "";
	return { entries, anchors, compactionText };
}

export default function reminder(pi: ExtensionAPI): void {
	const counter = new ReminderCounter();
	const queue = new InputQueue();
	let anchors = new Map<number, string>();
	// undefined：还没压缩过；""：压缩过但没记原文，插入时用当前原文。
	let compactionText: string | undefined;
	let cwd = process.cwd();

	function restore(ctx: { cwd: string; sessionManager: { getBranch(): BranchEntry[] } }): void {
		cwd = ctx.cwd;
		const state = readEntries(ctx.sessionManager.getBranch());
		counter.replay(state.entries);
		anchors = state.anchors;
		compactionText = state.compactionText;
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("input", (event) => {
		queue.push(event.text, isUserTyped(event.text, event.source));
		return { action: "continue" };
	});

	pi.on("message_end", (event) => {
		const message = event.message as AnyMessage;
		if (message.role !== "user") return;
		if (!queue.take(userText(message))) return;
		const text = loadReminderText(cwd);
		if (!text) return;
		if (counter.next() && typeof message.timestamp === "number") {
			anchors.set(message.timestamp, text);
			pi.appendEntry<ReminderEntry>(ENTRY_TYPE, { kind: "message", due: true, anchor: message.timestamp, text });
		} else {
			pi.appendEntry<ReminderEntry>(ENTRY_TYPE, { kind: "message", due: false });
		}
	});

	pi.on("session_compact", () => {
		const text = loadReminderText(cwd);
		if (!text) return;
		counter.compacted();
		compactionText = text;
		pi.appendEntry<ReminderEntry>(ENTRY_TYPE, { kind: "compaction", text });
	});

	pi.on("context", (event) => {
		const tail = compactionText === "" ? loadReminderText(cwd) : compactionText;
		if (anchors.size === 0 && !tail) return;
		const messages = injectReminders(event.messages as AnyMessage[], anchors, tail || undefined);
		if (messages !== (event.messages as AnyMessage[])) return { messages: messages as typeof event.messages };
	});
}
