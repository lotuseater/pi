/** Local control extension, derived from Tools/pi-task-extension.ts (base SHA256 4b281a1e39c992017c73c7949867ebff5156f04073855acc69a5f2c3d31f4146). Versioned in this private fork; original header follows. */
/**
 * pi-task-extension.ts: the control channel of a pi-task session.
 *
 * pi-task starts pi with `-e` pointing at this file and PI_TASK_DIR set to the
 * session's state directory. pi-task commands write items to queue/; this
 * extension hands them to pi in order and records what pi does in log.jsonl
 * (events) and state.json (a live snapshot). A message handed to pi moves to
 * sent/ until it shows up in the conversation, so a crash loses none: the next
 * start queues sent/ again. Without PI_TASK_DIR the extension does nothing.
 *
 * Queue items are JSON files named by sequence number, with ts, when pi-task queued them:
 *   {kind: "message", seq, text, deliver?: "steer" | "followUp", first?}
 *   {kind: "compact", seq, text?}     compact when idle, text = focus
 *   {kind: "control", seq, model?: "provider/id", thinking?}
 *   {kind: "interrupt", seq}          abort the run, like Esc, and drop the messages queued before it
 *   {kind: "stop", seq}               drop queued messages, abort, quit pi
 * Messages and compactions go out in order; controls, interrupts and stops at once.
 *
 * The cap on sessions in use: a message that would start a run on idle pi, and a compaction,
 * first need one of the Qwen slots that `pi-task _slot` hands out, first come first served
 * across every session on the PC (pi-task cap). Until then they wait in the queue. Messages
 * to pi at work go in at once. The slot goes back when pi is idle again and when pi quits.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as PiRuntime from "@earendil-works/pi-coding-agent";

// Capture the SDK actually loaded in THIS process once, before any selector change.
const loadedRuntime = (PiRuntime as unknown as { RUNTIME_IDENTITY?: { sourceRevision?: string } }).RUNTIME_IDENTITY;
const runtimeVersion = typeof PiRuntime.VERSION === "string" ? PiRuntime.VERSION : null;
const runtimeSource = typeof loadedRuntime?.sourceRevision === "string" && /^[a-f0-9]{40}$/.test(loadedRuntime.sourceRevision) ? loadedRuntime.sourceRevision : null;
function selfIdentity(): { start: string | null; boot_id: string | null } {
	try {
		const stat = fs.readFileSync("/proc/self/stat", "utf8");
		const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
		const boot_id = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		return { start: /^\d+$/.test(start) ? start : null, boot_id: boot_id || null };
	} catch { return { start: null, boot_id: null }; }
}
const processIdentity = Object.freeze(selfIdentity());

const DIR = process.env.PI_TASK_DIR;
const NAME = process.env.PI_TASK_NAME || (DIR ? path.basename(DIR) : "");
const TICK_MS = 250;
const START_TIMEOUT_MS = 30_000; // a prompt that has started no run by then failed
const HOLD_TIMEOUT_MS = 30_000; // an interrupt that never settles stops holding the queue then
const PROTOCOL = 2; // pi-task's EXT_PROTOCOL: 2 waits for a Qwen slot; pi-task restarts an idle pi below it
const SLOT_ASK_MS = 5_000; // a waiting session asks again this often, and as soon as the slot table changes
const HOME = DIR ? path.dirname(path.dirname(DIR)) : ""; // pi-task's state folder, which holds the slot table
const SLOTS = path.join(HOME, "slots.json");

type Item = {
	seq: number;
	kind: string;
	text?: string;
	deliver?: "steer" | "followUp";
	first?: boolean;
	model?: string;
	thinking?: string;
	ts?: number;
	file: string;
};

type Waiting = { seq: number; since: number; position: number | null; in_use: number | null; cap: number | null; gen: number; at: number; error?: string };

/** pi-task's slot table generation, which changes when a slot or a place in line frees up; -1 if unreadable. */
function slotGen(): number {
	try {
		return Number(JSON.parse(fs.readFileSync(SLOTS, "utf8")).gen) || 0;
	} catch {
		return -1;
	}
}

/** Run `pi-task _slot ARGS...` and return its JSON answer; throws when it fails. */
function slotCall(args: string[]): any {
	const cli = process.env.PI_TASK_CLI || "pi-task";
	const python = process.env.PI_TASK_PYTHON;
	const r = spawnSync(python || cli, [...(python ? [cli] : []), "_slot", ...args], {
		encoding: "utf8",
		timeout: 20_000,
		env: { ...process.env, PI_TASK_HOME: HOME },
	});
	if (r.error) throw r.error;
	if (r.status !== 0) throw new Error(`pi-task _slot ${args[0]} exited ${r.status}: ${(r.stderr || "").trim()}`);
	return JSON.parse(r.stdout);
}

const now = () => Date.now() / 1000;

function textOf(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	return (content || [])
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text)
		.join("\n");
}

function summary(args: any): string {
	for (const key of ["command", "path", "file_path", "pattern", "url", "query"]) {
		if (args?.[key]) return String(args[key]);
	}
	return JSON.stringify(args ?? {});
}

function short(text: string, n = 300): string {
	const one = text.split(/\s+/).join(" ").trim();
	return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

export default function (pi: ExtensionAPI) {
	if (!DIR) return;
	const queueDir = path.join(DIR, "queue");
	const sentDir = path.join(DIR, "sent");
	const logPath = path.join(DIR, "log.jsonl");
	const statePath = path.join(DIR, "state.json");

	let ctx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let watcher: fs.FSWatcher | undefined;
	let ticking = false;
	let busy = false; // an agent run is active: agent_start until agent_settled
	let compacting = false;
	let compactSeq: number | undefined; // the queued compaction that runs now
	let compactLogged = false;
	let starting: { seq: number; at: number } | undefined; // a prompt that has started no run yet
	let holdUntil = 0; // after an interrupt, deliver nothing until the run settles or this time passes
	let stopping = false;
	const pending: { seq: number; text: string; file: string }[] = []; // handed to pi, not yet in the conversation
	let last = { text: "", stop: "", error: "" }; // the last answer, kept across runs for status
	let run = { stop: "", error: "" }; // how the current run's last assistant message ended
	let activity = "";
	let activityAt = 0;
	let startedAt = 0; // when this pi's session started; every snapshot carries it
	let tokens = { input: 0, output: 0, cacheRead: 0, total: 0, cost: 0 };
	let error = "";
	let slot = false; // this session holds a Qwen slot
	let waiting: Waiting | undefined; // the item that waits for a slot, and the last answer to its ask
	let askAt = 0; // when a waiting session asks again
	let asked = false; // this tick wanted a slot

	function log(ev: string, data: Record<string, unknown> = {}) {
		try {
			fs.appendFileSync(logPath, `${JSON.stringify({ ev, ts: now(), ...data })}\n`);
		} catch {
			// The state directory is gone (pi-task rm): nothing to record.
		}
	}

	function save(extra: Record<string, unknown> = {}) {
		const usage = ctx?.getContextUsage();
		const state = {
			pid: process.pid,
			runtime_identity: {
				schema: 1, version: runtimeVersion, source_revision: runtimeSource,
				pid: process.pid, start: processIdentity.start, boot_id: processIdentity.boot_id,
				session_id: ctx?.sessionManager.getSessionId(),
			},
			name: NAME,
			session_id: ctx?.sessionManager.getSessionId(),
			session_file: ctx?.sessionManager.getSessionFile(),
			cwd: ctx?.cwd,
			provider: ctx?.model?.provider,
			model: ctx?.model?.id,
			thinking: pi.getThinkingLevel(),
			busy,
			compacting,
			ext: PROTOCOL,
			slot,
			waiting: waiting ?? null,
			starting: starting?.seq ?? null,
			pending: pending.map((p) => p.seq),
			ctx: usage?.tokens ?? null,
			ctx_window: usage?.contextWindow ?? null,
			tokens,
			last_text: short(last.text, 2000),
			last_stop: last.stop,
			error,
			activity,
			activity_at: activityAt,
			started: startedAt || null,
			updated: now(),
			...extra,
		};
		try {
			const tmp = `${statePath}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`);
			fs.renameSync(tmp, statePath);
		} catch {
			// As in log().
		}
	}

	function items(dir: string): Item[] {
		let names: string[];
		try {
			names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
		} catch {
			return [];
		}
		const out: Item[] = [];
		for (const n of names) {
			try {
				const item = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
				out.push({ ...item, file: n });
			} catch {
				// Removed meanwhile, or not ours.
			}
		}
		return out.sort((a, b) => (a.first ? 0 : 1) - (b.first ? 0 : 1) || a.seq - b.seq);
	}

	function remove(dir: string, file: string) {
		try {
			fs.unlinkSync(path.join(dir, file));
		} catch {
			// Gone already.
		}
	}

	function idle(): boolean {
		return !!ctx && ctx.isIdle() && !busy && !compacting && !starting;
	}

	/** Messages that pi will no longer deliver: log them as dropped and forget them. */
	function drop(reason: string, also: Item[] = []) {
		const seqs = [...pending.map((p) => p.seq), ...also.filter((i) => i.kind === "message" || i.kind === "compact").map((i) => i.seq)];
		const texts = pending.map((p) => p.text);
		for (const p of pending) remove(sentDir, p.file);
		for (const i of also) remove(queueDir, i.file);
		pending.length = 0;
		if (starting && seqs.includes(starting.seq)) starting = undefined;
		if (seqs.length) log("dropped", { seqs, reason });
		// Esc in the TUI puts queued messages back in the editor. Ours are dropped, so take them out again.
		if (texts.length && ctx?.mode === "tui") {
			const joined = texts.join("\n\n");
			const editor = ctx.ui.getEditorText();
			if (editor === joined) ctx.ui.setEditorText("");
			else if (editor.startsWith(`${joined}\n\n`)) ctx.ui.setEditorText(editor.slice(joined.length + 2));
		}
	}

	async function control(item: Item) {
		const done: Record<string, unknown> = { seq: item.seq, what: item.kind };
		try {
			if (item.model) {
				const slash = item.model.indexOf("/");
				const provider = slash > 0 ? item.model.slice(0, slash) : ctx?.model?.provider || "";
				const id = slash > 0 ? item.model.slice(slash + 1) : item.model;
				const model = ctx?.modelRegistry.find(provider, id);
				if (!model) throw new Error(`pi knows no model ${provider}/${id}`);
				if (!(await pi.setModel(model))) throw new Error(`no credentials for provider ${provider}`);
			}
			if (item.thinking) pi.setThinkingLevel(item.thinking as any);
			log("control", { ...done, ok: true, model: `${ctx?.model?.provider}/${ctx?.model?.id}`, thinking: pi.getThinkingLevel() });
		} catch (e) {
			log("control", { ...done, ok: false, error: e instanceof Error ? e.message : String(e) });
		}
	}

	function interrupt(item: Item, queued: Item[]) {
		const running = !!ctx && (!ctx.isIdle() || busy || !!starting);
		if (running) {
			holdUntil = Date.now() + HOLD_TIMEOUT_MS;
			ctx!.abort();
		}
		// What was queued before the interrupt goes too, as a message that waits for a slot.
		drop("interrupted", queued.filter((i) => (i.kind === "message" || i.kind === "compact") && i.seq < item.seq));
		log("control", { seq: item.seq, what: "interrupt", ok: true, running });
	}

	function stop(item: Item, queued: Item[]) {
		stopping = true;
		drop("stopped", queued.filter((i) => i.kind === "message" || i.kind === "compact"));
		if (ctx && !ctx.isIdle()) ctx.abort();
		log("control", { seq: item.seq, what: "stop", ok: true });
		save();
		ctx?.shutdown();
	}

	function compact(item: Item) {
		compacting = true;
		compactSeq = item.seq;
		compactLogged = false;
		log("compacting", { seq: item.seq, reason: "manual" });
		const finish = (ok: boolean, data: Record<string, unknown>) => {
			if (!compactLogged) log(ok ? "compacted" : "compact_failed", { seq: item.seq, ...data });
			compacting = false;
			compactSeq = undefined;
			save();
			void tick();
		};
		ctx!.compact({
			customInstructions: item.text || undefined,
			onComplete: (r: any) => finish(true, { pre: r?.tokensBefore ?? null, post: ctx?.getContextUsage()?.tokens ?? null }),
			onError: (e: Error) => finish(false, { error: e.message }),
		});
	}

	/**
	 * True when `item` may start a run or a compaction now: this session holds a Qwen slot or gets
	 * one. Else the item waits in the queue, and the session asks again every SLOT_ASK_MS and as
	 * soon as the slot table changes.
	 */
	function gate(item: Item): boolean {
		asked = true;
		if (slot) return true;
		const since = item.ts ?? now();
		if (waiting && waiting.since === since && Date.now() < askAt && slotGen() === waiting.gen) return false;
		askAt = Date.now() + SLOT_ASK_MS;
		const why = item.kind === "compact" ? "compact" : "run";
		const at = waiting && waiting.since === since ? waiting.at : now();
		let r: any;
		try {
			r = slotCall(["ask", NAME, String(process.pid), String(since), why]);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (waiting?.error !== msg) log("slot_error", { seq: item.seq, error: msg });
			waiting = { seq: item.seq, since, position: null, in_use: null, cap: null, gen: slotGen(), at, error: msg };
			return false;
		}
		if (r.granted) {
			log("slot", { seq: item.seq, why, waited: now() - at, in_use: r.in_use, cap: r.cap });
			slot = true;
			waiting = undefined;
			return true;
		}
		if (!waiting || waiting.since !== since || waiting.error) {
			log("waiting", { seq: item.seq, why, in_use: r.in_use, cap: r.cap, position: r.position });
		}
		waiting = { seq: item.seq, since, position: r.position, in_use: r.in_use, cap: r.cap, gen: r.gen, at };
		return false;
	}

	/** Give back the slot, or the place in line. */
	function leave(why: string) {
		const had = slot;
		slot = false;
		waiting = undefined;
		try {
			slotCall(["leave", NAME, String(process.pid)]);
		} catch (e) {
			// pi-task drops a holder whose state.json says it holds no slot.
			log("slot_error", { error: e instanceof Error ? e.message : String(e) });
		}
		if (had) log("slot_free", { why });
	}

	function deliver(item: Item) {
		const fresh = idle();
		// Always name a delivery: pi starts a run when it is idle and queues the message when it is not.
		const how = item.deliver === "followUp" ? "followUp" : "steer";
		pi.sendUserMessage(item.text || "", { deliverAs: how });
		try {
			fs.renameSync(path.join(queueDir, item.file), path.join(sentDir, item.file));
		} catch {
			// pi-task rm or stop --force took it.
		}
		pending.push({ seq: item.seq, text: item.text || "", file: item.file });
		if (fresh) starting = { seq: item.seq, at: Date.now() };
		log("sent", { seq: item.seq, how: fresh ? "prompt" : how });
	}

	async function tick() {
		if (!ctx || ticking || stopping) return;
		ticking = true;
		try {
			if (starting && Date.now() - starting.at > START_TIMEOUT_MS) {
				const seq = starting.seq;
				starting = undefined;
				const lost = pending.findIndex((p) => p.seq === seq);
				if (lost >= 0) {
					remove(sentDir, pending[lost].file);
					pending.splice(lost, 1);
				}
				error = "pi started no run for the message; see the pi-task window";
				log("failed", { seqs: [seq], error });
			}
			if (holdUntil && Date.now() > holdUntil) holdUntil = 0;
			asked = false;
			let queued = items(queueDir);
			let dropped = false;
			for (const item of queued) {
				if (item.kind === "control") {
					remove(queueDir, item.file);
					await control(item);
				} else if (item.kind === "interrupt") {
					remove(queueDir, item.file);
					interrupt(item, queued);
					dropped = true;
				} else if (item.kind === "stop") {
					remove(queueDir, item.file);
					stop(item, queued.filter((i) => i !== item));
					return;
				}
			}
			if (dropped) queued = items(queueDir);
			for (const item of queued) {
				if (item.kind !== "message" && item.kind !== "compact") continue;
				// Hold the rest in order while pi compacts, starts a run, or settles an interrupt.
				if (compacting || starting || holdUntil) break;
				if (item.kind === "compact") {
					if (!idle() || !gate(item)) break;
					remove(queueDir, item.file);
					compact(item);
					break;
				}
				// A message to idle pi starts a run, which needs a slot; one to pi at work goes in at once.
				if (idle() && !gate(item)) break;
				deliver(item);
				if (starting) break; // the next one goes in once the run has started
			}
			if (waiting && !asked) leave("nothing waits");
			if (slot && idle() && !pending.length) leave("idle");
		} catch (e) {
			log("ext_error", { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
		} finally {
			ticking = false;
			save();
		}
	}

	pi.on("session_start", async (event, c) => {
		ctx = c;
		stopping = false;
		slot = false;
		waiting = undefined;
		fs.mkdirSync(queueDir, { recursive: true });
		fs.mkdirSync(sentDir, { recursive: true });
		// Messages a previous pi took but never put in the conversation go out again.
		const resent = items(sentDir);
		for (const i of resent) {
			try {
				fs.renameSync(path.join(sentDir, i.file), path.join(queueDir, i.file));
			} catch {
				// Gone.
			}
		}
		tokens = { input: 0, output: 0, cacheRead: 0, total: 0, cost: 0 };
		for (const e of c.sessionManager.getEntries() as any[]) {
			const u = e?.type === "message" && e.message?.role === "assistant" ? e.message.usage : undefined;
			if (u) {
				tokens.input += u.input || 0;
				tokens.output += u.output || 0;
				tokens.cacheRead += u.cacheRead || 0;
				tokens.total += u.totalTokens || 0;
				tokens.cost += u.cost?.total || 0;
			}
		}
		log("start", {
			pid: process.pid,
			reason: event.reason,
			session_file: c.sessionManager.getSessionFile(),
			session_id: c.sessionManager.getSessionId(),
			model: `${c.model?.provider}/${c.model?.id}`,
			thinking: pi.getThinkingLevel(),
			resent: resent.map((i) => i.seq),
		});
		startedAt = now();
		save({ cut: null, stopped: null });
		try {
			watcher = fs.watch(queueDir, () => void tick());
		} catch {
			// The timer below still polls.
		}
		timer = setInterval(() => void tick(), TICK_MS);
		void tick();
	});

	pi.on("session_shutdown", async (event) => {
		if (timer) clearInterval(timer);
		watcher?.close();
		timer = undefined;
		watcher = undefined;
		if (slot || waiting) leave(event.reason === "quit" ? "pi quits" : event.reason); // a new runtime asks again
		if (event.reason !== "quit") return; // /new, /resume, /fork or /reload: a new runtime takes over
		const cut =
			busy || compacting || pending.length
				? { turn: busy, compacting, pending: pending.map((p) => p.seq) }
				: null;
		log("shutdown", { reason: event.reason, stopping, cut });
		save({ stopped: now(), cut, busy: false, compacting: false });
		ctx = undefined;
	});

	pi.on("agent_start", async (_e, c) => {
		ctx = c;
		busy = true;
		starting = undefined;
		error = "";
		run = { stop: "", error: "" };
		log("run_start");
		save();
	});

	pi.on("message_end", async (event, c) => {
		ctx = c;
		const m: any = event.message;
		if (m?.role === "user") {
			const text = textOf(m);
			let i = pending.findIndex((p) => p.text === text);
			if (i < 0) i = pending.findIndex((p) => p.text.trim() && text.includes(p.text.trim()));
			if (i >= 0) {
				const [p] = pending.splice(i, 1);
				remove(sentDir, p.file);
				if (starting?.seq === p.seq) starting = undefined;
				log("read", { seq: p.seq });
			}
		} else if (m?.role === "assistant") {
			const text = textOf(m);
			const u = m.usage || {};
			tokens.input += u.input || 0;
			tokens.output += u.output || 0;
			tokens.cacheRead += u.cacheRead || 0;
			tokens.total += u.totalTokens || 0;
			tokens.cost += u.cost?.total || 0;
			if (text.trim()) last.text = text;
			last.stop = run.stop = m.stopReason;
			last.error = run.error = m.errorMessage || "";
			if (m.stopReason === "error") error = m.errorMessage || "the model returned an error";
			log("assistant", {
				text,
				stop: m.stopReason,
				error: m.errorMessage || null,
				model: `${m.provider}/${m.model}`,
				usage: { input: u.input || 0, output: u.output || 0, total: u.totalTokens || 0 },
			});
		}
		save();
	});

	pi.on("tool_execution_start", async (event) => {
		if (event.parentToolCallId) return;
		activity = `${event.toolName}: ${short(summary(event.args), 160)}`;
		activityAt = now();
		log("tool", { name: event.toolName, summary: short(summary(event.args), 300) });
		save();
	});

	pi.on("agent_settled", async (event, c) => {
		ctx = c;
		busy = false;
		holdUntil = 0;
		activity = "";
		if (event.aborted) error = ""; // an interrupt, or Esc in the window, is no error
		const usage = c.getContextUsage();
		log("idle", { aborted: event.aborted, ctx: usage?.tokens ?? null, stop: run.stop, error: run.stop === "error" ? run.error : null });
		save();
		void tick();
	});

	pi.on("session_before_compact", async (event) => {
		compacting = true;
		compactLogged = false;
		if (compactSeq === undefined) log("compacting", { seq: null, reason: event.reason }); // compact() logged ours
		save();
	});

	pi.on("session_compact", async (event, c) => {
		ctx = c;
		log("compacted", {
			seq: compactSeq ?? null,
			reason: event.reason,
			pre: (event.compactionEntry as any)?.tokensBefore ?? null,
			post: c.getContextUsage()?.tokens ?? null,
		});
		compactLogged = compactSeq !== undefined;
		if (compactSeq === undefined) compacting = false;
		save();
	});

	pi.on("session_compact_failed", async (event) => {
		log("compact_failed", { seq: compactSeq ?? null, reason: event.reason, error: event.errorMessage ?? (event.aborted ? "aborted" : null) });
		compactLogged = compactSeq !== undefined;
		if (compactSeq === undefined) compacting = false;
		save();
	});

	pi.on("model_select", async (_e, c) => {
		ctx = c;
		save();
	});

	pi.on("thinking_level_select", async () => save());
}
