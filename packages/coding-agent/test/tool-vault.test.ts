/**
 * Synthetic checks for the local tool-output vault: exact storage, deterministic eligibility,
 * bounded disk use, safe failure, and recall of the archived bytes. No provider is involved.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
	chmodSync,
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VaultLookup, VaultPutResult } from "../src/core/tool-vault.ts";
import {
	openToolVault,
	resolveToolVaultConfig,
	sliceVaultBytes,
	sliceVaultText,
	storeKeyOf,
	TOOL_VAULT_DEFAULTS,
	type ToolVault,
	toolVaultIdentity,
	type VaultCandidate,
} from "../src/core/tool-vault.ts";
import {
	formatRecallResult,
	TOOL_VAULT_RECALL_TOOL_NAME,
	vaultReadOnlyResults,
} from "../src/core/tool-vault-projection.ts";

const FAST = { minBytes: 2048, keepRecentResults: 2, minUserTurnsOld: 1 };
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(realpathSync(tmpdir()), "pi-tool-vault-"));
});

afterEach(() => {
	// Read-only directories and files are part of some cases; make the tree deletable again.
	chmodTree(dir);
	rmSync(dir, { recursive: true, force: true });
});

function chmodTree(root: string): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	try {
		chmodSync(root, 0o700);
	} catch {
		/* unreadable root: rmSync will report it */
	}
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) chmodTree(path);
		else
			try {
				chmodSync(path, 0o600);
			} catch {
				/* unreadable file: nothing to restore */
			}
	}
}

function configAt(vaultDir: string, overrides: Parameters<typeof resolveToolVaultConfig>[0] = {}) {
	return resolveToolVaultConfig({ enabled: true, dir: vaultDir, ...FAST, ...overrides }, {}, vaultDir);
}

function vaultAt(vaultDir: string, identity = "id:session-one", overrides = {}): ToolVault {
	const config = configAt(vaultDir, overrides);
	return openToolVault({ config, identity: () => identity });
}

function candidate(overrides: Partial<VaultCandidate> = {}): VaultCandidate {
	return {
		session: "session-one",
		tool: "read",
		toolCallId: "call-1",
		arguments: { path: "big.txt" },
		snapshot: { version: 1, tool: "read", identity: "/synthetic/big.txt" },
		metadata: {},
		text: "line one\n".repeat(2000),
		...overrides,
	};
}

function textOf(message: Message | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	const block = message.content[0];
	return block && block.type === "text" ? block.text : "";
}

/** Details of a tool result, narrowed out of the message union. */
function detailsOf(message: Message | undefined): Record<string, JsonValue> | undefined {
	// The fixture writes plain JSON details, so reading them back as JSON is exact here.
	return message?.role === "toolResult" ? (message.details as Record<string, JsonValue> | undefined) : undefined;
}

/** A copy of a tool result with extra detail keys, for projection-marker tests. */
function withDetails(message: Message, extra: Record<string, JsonValue>): Message {
	if (message.role !== "toolResult") throw new Error("expected a tool result");
	return { ...message, details: { ...((message.details ?? {}) as Record<string, JsonValue>), ...extra } };
}

/** The refusal reason of a put, or a test failure when the write actually succeeded. */
function putRefusal(result: VaultPutResult): string {
	if (result.ok) throw new Error("expected the vault to refuse the write");
	return result.reason;
}

/** The id of a stored record, or a test failure when the write was refused. */
function putId(result: VaultPutResult): string {
	if (!result.ok) throw new Error(`expected a stored record, got ${result.reason}: ${result.detail}`);
	return result.id;
}

/** The refusal reason of a lookup, or a test failure when the lookup returned a record. */
function lookupRefusal(result: VaultLookup): string {
	if (result.ok) throw new Error("expected the lookup to fail");
	return result.reason;
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let callSeq = 0;

/** A tool-call/result pair as the builtin tools leave it, with optional rule-breaking details. */
function pair(
	text: string,
	options: {
		tool?: string;
		args?: Record<string, JsonValue>;
		details?: Record<string, JsonValue>;
		snapshot?: Record<string, JsonValue> | null;
		error?: boolean;
		blocks?: unknown[];
		assistantStop?: string;
	} = {},
): Message[] {
	const tool = options.tool ?? "read";
	const id = `call-${++callSeq}`;
	const details: Record<string, JsonValue> = { ...(options.details ?? {}) };
	if (options.snapshot !== null)
		details.piReadOnlySnapshot = options.snapshot ?? { version: 1, tool, identity: `/synthetic/${tool}` };
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: tool, arguments: options.args ?? { path: "big.txt" } }],
			stopReason: (options.assistantStop ?? "toolUse") as "toolUse",
			api: "faux",
			provider: "faux",
			model: "faux",
			usage,
			timestamp: 0,
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: tool,
			isError: options.error ?? false,
			// Some cases deliberately put a non-text block in a tool result, which the type forbids.
			content: (options.blocks ?? [{ type: "text", text }]) as unknown as Extract<
				Message,
				{ role: "toolResult" }
			>["content"],
			details,
			timestamp: 0,
		},
	];
}

function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as Message;
}

function say(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		api: "faux",
		provider: "faux",
		model: "faux",
		usage,
		timestamp: 0,
	} as Message;
}

function shellPair(text: string): Message[] {
	return pair(text, {
		tool: "bash",
		args: { command: "test-command" },
		snapshot: null,
		details: {
			piShellSnapshot: {
				version: 1,
				tool: "bash",
				cwd: "/synthetic",
				command: "test-command",
				requestedCommand: "test-command",
				exitCode: 0,
				wallTimeSeconds: 1,
				complete: true,
				sha256: createHash("sha256").update(text, "utf8").digest("hex"),
				bytes: Buffer.byteLength(text, "utf8"),
			},
		},
	});
}

/**
 * A conversation where `result` has aged: three later tool results and two answered user turns.
 * The filler results are small, so only the result under test can reach the archive floor.
 */
function aged(result: Message[], laterResults = 3): Message[] {
	return [
		user("inspect the fixture"),
		...result,
		say("noted"),
		...Array.from({ length: laterResults }, () => pair("small filler", { tool: "ls" })).flat(),
		user("first follow-up"),
		say("answer one"),
		user("second follow-up"),
		say("answer two"),
	];
}

function project(messages: Message[], vault: ToolVault, recallAvailable = true, archiveAllowed = true): Message[] {
	return vaultReadOnlyResults(messages, { vault, recallAvailable, archiveAllowed, sessionId: "session-one" });
}

function references(messages: Message[]): Message[] {
	return messages.filter((m) => m.role === "toolResult" && textOf(m).startsWith("[Pi vault record "));
}

function recordIdOf(message: Message): string {
	const marker = detailsOf(message)?.piToolVaultRecord as { id?: string } | undefined;
	if (!marker?.id) throw new Error("expected a vault record marker");
	return marker.id;
}

function list(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

function storedRecordIds(vaultDir: string): string[] {
	const out: string[] = [];
	for (const store of list(join(vaultDir, "stores"))) {
		for (const name of list(join(vaultDir, "stores", store))) {
			if (/^[a-f0-9]{64}\.json$/.test(name)) out.push(name.slice(0, 64));
		}
	}
	return out.sort();
}

describe("tool vault configuration", () => {
	it("stays off unless settings or the environment ask for it, and PI_TOOL_VAULT=0 wins", () => {
		expect(resolveToolVaultConfig(undefined, {}, dir).enabled).toBe(false);
		expect(resolveToolVaultConfig({ enabled: true }, {}, dir).enabled).toBe(true);
		expect(resolveToolVaultConfig({ enabled: true }, { PI_TOOL_VAULT: "0" }, dir).enabled).toBe(false);
		expect(resolveToolVaultConfig(undefined, { PI_TOOL_VAULT: "1" }, dir).enabled).toBe(true);
		expect(resolveToolVaultConfig(undefined, {}, dir).dir).toBe(join(dir, "tool-vault"));
		expect(resolveToolVaultConfig({ enabled: true }, { PI_TOOL_VAULT_DIR: join(dir, "env-dir") }, dir).dir).toBe(
			join(dir, "env-dir"),
		);
	});

	it("keeps the conservative first-version defaults and clamps junk back to them", () => {
		const defaults = resolveToolVaultConfig({ enabled: true }, {}, dir);
		expect(defaults.minBytes).toBe(8 * 1024);
		expect(defaults.keepRecentResults).toBe(10);
		expect(defaults.minUserTurnsOld).toBe(0);
		expect(defaults.minAssistantTurnsOld).toBe(2);
		expect(defaults.retireOldResults).toBe(true);
		expect(defaults.compactShellOutput).toBe(false);
		expect(defaults.maxRecordBytes).toBe(1024 * 1024);
		expect(defaults.maxSessionBytes).toBe(32 * 1024 * 1024);
		expect(defaults.maxRecallBytes).toBeLessThanOrEqual(defaults.maxRecordBytes);
		const broken = resolveToolVaultConfig(
			{
				enabled: true,
				minBytes: -5,
				keepRecentResults: 0,
				minUserTurnsOld: 1e9,
				maxRecordBytes: 3,
				maxSessionBytes: -1,
				maxRecords: 1e12,
				rootBytes: 0,
				maxRecallBytes: 1e12,
			},
			{},
			dir,
		);
		expect(broken).toMatchObject({
			minBytes: TOOL_VAULT_DEFAULTS.minBytes,
			keepRecentResults: TOOL_VAULT_DEFAULTS.keepRecentResults,
			minUserTurnsOld: TOOL_VAULT_DEFAULTS.minUserTurnsOld,
			maxRecordBytes: TOOL_VAULT_DEFAULTS.maxRecordBytes,
			maxSessionBytes: TOOL_VAULT_DEFAULTS.maxSessionBytes,
			maxRecords: TOOL_VAULT_DEFAULTS.maxRecords,
			rootBytes: TOOL_VAULT_DEFAULTS.rootBytes,
			maxRecallBytes: TOOL_VAULT_DEFAULTS.maxRecallBytes,
		});
	});

	it("bounds the root by store count, one store per rootBytes/maxSessionBytes", () => {
		const mib = 1024 * 1024;
		// Admission claims a store directory atomically, so no spare slot is needed as headroom.
		expect(
			resolveToolVaultConfig({ enabled: true, rootBytes: 40 * mib, maxSessionBytes: 10 * mib }, {}, dir).maxStores,
		).toBe(4);
		expect(
			resolveToolVaultConfig({ enabled: true, rootBytes: 10 * mib, maxSessionBytes: 10 * mib }, {}, dir).maxStores,
		).toBe(1);
		// A root that could hold more stores than the ceiling still admits only the ceiling, so the
		// slot recount on every store open stays a short directory listing.
		expect(
			resolveToolVaultConfig({ enabled: true, rootBytes: 16 * 1024 * mib, maxSessionBytes: 16 * 1024 }, {}, dir)
				.maxStores,
		).toBe(256);
	});
});

describe("vault store", () => {
	it("stores the exact bytes with provenance and a deterministic id, without a second write", () => {
		const vault = vaultAt(dir);
		const first = vault.put(candidate());
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.created).toBe(true);
		const key = vault.storeKey();
		expect(vault.usage().records).toBe(1);
		expect(vault.usage().bytes).toBe(statSync(join(dir, "stores", key!, `${first.id}.json`)).size);
		expect(vault.put(candidate())).toEqual({ ok: true, id: first.id, created: false });
		expect(storedRecordIds(dir)).toEqual([first.id]);
		const reopened = vaultAt(dir);
		expect(reopened.storeKey()).toBe(key);
		expect(reopened.usage()).toEqual({ bytes: vault.usage().bytes, records: 1 });
		const found = reopened.lookup(first.id);
		expect(found.ok).toBe(true);
		if (!found.ok) return;
		expect(found.record.text).toBe(candidate().text);
		expect(found.record.sha256).toBe(createHash("sha256").update(candidate().text, "utf8").digest("hex"));
		expect(found.record.tool).toBe("read");
		expect(found.record.toolCallId).toBe("call-1");
		expect(found.record.arguments).toEqual({ path: "big.txt" });
		expect(found.record.session).toBe("session-one");
		expect(found.fromStore).toBe(key);
	});

	it("keys stores by session so another session cannot read the records", () => {
		const vault = vaultAt(dir);
		const put = vault.put(candidate());
		if (!put.ok) throw new Error("expected a stored record");
		const other = vaultAt(dir, "id:session-two");
		expect(other.storeKey()).not.toBe(vault.storeKey());
		expect(other.lookup(put.id)).toEqual({ ok: false, reason: "not-found" });
		expect(storeKeyOf("x")).toMatch(/^[a-f0-9]{24}$/);
	});

	it("creates the root 0700, the store 0700 and records 0600", () => {
		const vault = vaultAt(dir);
		const put = vault.put(candidate());
		if (!put.ok) throw new Error("expected a stored record");
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "stores")).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "stores", vault.storeKey()!)).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "stores", vault.storeKey()!, `${put.id}.json`)).mode & 0o777).toBe(0o600);
		expect(list(join(dir, "stores", vault.storeKey()!)).sort()).toEqual([`${put.id}.json`, "quota.json"]); // no temp left behind
	});

	it("refuses an oversized record, then stops at the session byte quota and the record count", () => {
		const vault = vaultAt(dir, "id:session-one", { maxRecordBytes: 16 * 1024 });
		expect(putRefusal(vault.put(candidate({ text: "y".repeat(20 * 1024) })))).toBe("record-too-large");
		const tight = vaultAt(dir, "id:quota", { maxSessionBytes: 24 * 1024, maxRecordBytes: 16 * 1024 });
		expect(tight.put(candidate({ text: "a".repeat(9 * 1024), toolCallId: "q1" })).ok).toBe(true);
		expect(tight.put(candidate({ text: "b".repeat(9 * 1024), toolCallId: "q2" })).ok).toBe(true);
		expect(putRefusal(tight.put(candidate({ text: "c".repeat(9 * 1024), toolCallId: "q3" })))).toBe("session-quota");
		expect(tight.usage().records).toBe(2); // the refused record is neither counted nor kept
		// Identical bytes from different invocations keep their exact historical call identities.
		const repeated = vaultAt(dir, "id:repeat");
		const firstCopy = repeated.put(candidate({ toolCallId: "first" }));
		if (!firstCopy.ok) throw new Error("expected a stored record");
		const secondCopy = repeated.put(candidate({ toolCallId: "second" }));
		if (!secondCopy.ok) throw new Error("expected a stored record");
		expect(secondCopy.id).not.toBe(firstCopy.id);
		expect(repeated.lookup(firstCopy.id)).toMatchObject({ ok: true, record: { toolCallId: "first" } });
		expect(repeated.lookup(secondCopy.id)).toMatchObject({ ok: true, record: { toolCallId: "second" } });
		expect(repeated.usage().records).toBe(2);
		expect(repeated.put(candidate({ toolCallId: "ranged", arguments: { path: "big.txt", offset: 20 } })).ok).toBe(
			true,
		);
		expect(repeated.usage().records).toBe(3);
		const counted = vaultAt(dir, "id:count", { maxRecords: 1 });
		expect(counted.put(candidate({ toolCallId: "n1" })).ok).toBe(true);
		expect(putRefusal(counted.put(candidate({ toolCallId: "n2" })))).toBe("record-cap");
	});

	it("admits only the bounded number of session stores into one root", () => {
		const mib = 1024 * 1024;
		const limited = resolveToolVaultConfig({ enabled: true, dir, rootBytes: 2 * mib, maxSessionBytes: mib }, {}, dir);
		expect(limited.maxStores).toBe(2);
		const first = openToolVault({ config: limited, identity: () => "id:first" });
		expect(first.put(candidate()).ok).toBe(true);
		const second = openToolVault({ config: limited, identity: () => "id:second" });
		expect(second.put(candidate()).ok).toBe(true);
		// The third creator claims a directory, sees the root is full, and gives its own empty store back.
		const third = openToolVault({ config: limited, identity: () => "id:third" });
		expect(third.put(candidate())).toMatchObject({ ok: false, reason: "no-store" });
		expect(third.fault()).toMatch(/holds 3 stores, limit 2/);
		expect(first.usage().records).toBe(1);
		expect(second.usage().records).toBe(1);
		// Only admitted stores remain on disk: the refused slot was released, nothing half-written.
		expect(list(join(dir, "stores")).length).toBe(2);
	});

	it("lets two live stores for one session share a directory without losing records", () => {
		const a = vaultAt(dir);
		const b = vaultAt(dir);
		expect(putId(a.put(candidate({ toolCallId: "shared" })))).toBe(putId(b.put(candidate({ toolCallId: "shared" }))));
		expect(a.put(candidate({ toolCallId: "x", text: "x".repeat(4096) })).ok).toBe(true);
		expect(b.put(candidate({ toolCallId: "y", text: "y".repeat(4096) })).ok).toBe(true);
		expect(storedRecordIds(dir).length).toBe(3);
		expect(vaultAt(dir).usage().records).toBe(3);
	});

	it("stops writing after a storage failure instead of half-writing a record", () => {
		const vault = vaultAt(dir);
		const first = vault.put(candidate());
		if (!first.ok) throw new Error("expected a stored record");
		const key = vault.storeKey()!;
		chmodSync(join(dir, "stores", key), 0o500);
		expect(vault.put(candidate({ toolCallId: "after-lock", text: "locked out\n".repeat(400) }))).toMatchObject({
			ok: false,
			reason: "io-error",
		});
		chmodSync(join(dir, "stores", key), 0o700);
		// One fault quarantines the vault for this session: it will not retry into a partial state.
		expect(vault.put(candidate({ toolCallId: "after-fix", text: "written again\n".repeat(400) }))).toMatchObject({
			ok: false,
			reason: "no-store",
		});
		expect(vault.fault()).toMatch(/cannot write/);
		expect(list(join(dir, "stores", key)).sort()).toEqual([`${first.id}.json`, "quota.json"]);
		// A fresh vault over the same directory works again, and the earlier record still verifies.
		const fresh = vaultAt(dir);
		expect(fresh.lookup(first.id).ok).toBe(true);
		expect(fresh.put(candidate({ text: "written after reopen\n".repeat(400) })).ok).toBe(true);
	});

	it("refuses to read a corrupt, edited, version-changed, oversized, unreadable, symlinked or missing record", () => {
		const vault = vaultAt(dir);
		const put = vault.put(candidate());
		if (!put.ok) throw new Error("expected a stored record");
		const path = join(dir, "stores", vault.storeKey()!, `${put.id}.json`);
		const pristine = readFileSync(path, "utf8");
		expect(lookupRefusal(vault.lookup("nope"))).toBe("invalid-id");
		expect(lookupRefusal(vault.lookup("../../etc/passwd"))).toBe("invalid-id");
		expect(lookupRefusal(vaultAt(dir).lookup("f".repeat(64)))).toBe("not-found");
		writeFileSync(path, "{not json");
		expect(lookupRefusal(vault.lookup(put.id))).toBe("corrupt");
		writeFileSync(path, JSON.stringify({ ...JSON.parse(pristine), text: "line one\n".repeat(1999) }));
		expect(lookupRefusal(vault.lookup(put.id))).toBe("corrupt");
		writeFileSync(path, JSON.stringify({ ...JSON.parse(pristine), tool: "bash" }));
		expect(lookupRefusal(vault.lookup(put.id))).toBe("corrupt"); // provenance is bound into the id
		writeFileSync(path, JSON.stringify({ ...JSON.parse(pristine), store: "f".repeat(24) }));
		expect(lookupRefusal(vault.lookup(put.id))).toBe("corrupt");
		writeFileSync(path, "x".repeat(2 * 1024 * 1024));
		expect(lookupRefusal(vault.lookup(put.id))).toBe("oversize");
		writeFileSync(path, pristine);
		expect(vault.lookup(put.id).ok).toBe(true);
		chmodSync(path, 0);
		expect(lookupRefusal(vault.lookup(put.id))).toBe("unreadable");
		chmodSync(path, 0o600);
		rmSync(path);
		symlinkSync(join(dir, "outside-secret.json"), path);
		writeFileSync(join(dir, "outside-secret.json"), "do not read me");
		expect(lookupRefusal(vault.lookup(put.id))).toBe("unsafe-path");
	});

	it("treats a symlinked vault root as unusable rather than following it", () => {
		const real = join(dir, "real-root");
		mkdirSync(real);
		const link = join(dir, "linked-root");
		symlinkSync(real, link);
		const vault = vaultAt(link);
		expect(vault.put(candidate())).toMatchObject({ ok: false, reason: "no-store" });
		expect(vault.fault()).toMatch(/not a real directory|cannot create/);
		expect(list(real)).toEqual([]);
	});

	it("follows session-file lineage so a session extracted from a parent still recalls", () => {
		const sessions = join(dir, "sessions");
		mkdirSync(sessions);
		const parentFile = join(sessions, "parent.jsonl");
		writeFileSync(parentFile, `${JSON.stringify({ type: "header", version: 1, id: "parent-session", cwd: dir })}\n`);
		const childFile = join(sessions, "child.jsonl");
		writeFileSync(
			childFile,
			`${JSON.stringify({ type: "header", version: 1, id: "child-session", cwd: dir, parentSession: parentFile })}\n`,
		);
		const parent = openToolVault({
			config: configAt(dir),
			identity: () => toolVaultIdentity(parentFile, "parent-session"),
		});
		const put = parent.put(candidate({ session: "parent-session" }));
		if (!put.ok) throw new Error("expected a stored record");
		const child = openToolVault({
			config: configAt(dir),
			identity: () => toolVaultIdentity(childFile, "child-session"),
			sessionFile: () => childFile,
		});
		expect(child.lookup(put.id)).toMatchObject({
			ok: true,
			fromStore: storeKeyOf(toolVaultIdentity(parentFile, "parent-session")),
		});
		// An unrelated session file with no parent reaches nothing.
		const aloneFile = join(sessions, "alone.jsonl");
		writeFileSync(aloneFile, `${JSON.stringify({ type: "header", version: 1, id: "alone-session", cwd: dir })}\n`);
		const alone = openToolVault({
			config: configAt(dir),
			identity: () => toolVaultIdentity(aloneFile, "alone-session"),
			sessionFile: () => aloneFile,
		});
		expect(lookupRefusal(alone.lookup(put.id))).toBe("not-found");
	});
});

describe("vault projection", () => {
	it("retires verified Bash output during a single autonomous instruction", () => {
		const vault = vaultAt(dir, "id:shell", { keepRecentResults: 10, minUserTurnsOld: 0 });
		const text = "original command result\n".repeat(500);
		const messages = [
			user("continue independently"),
			...shellPair(text),
			...Array.from({ length: 10 }, () => pair("small")).flat(),
		];
		const projected = project(messages, vault);
		expect(references(projected)).toHaveLength(1);
		const ref = references(projected)[0];
		expect(detailsOf(ref)?.piToolVaultRecord).toMatchObject({ projection: "retired" });
		expect(vault.lookup(recordIdOf(ref))).toMatchObject({ ok: true, record: { text, tool: "bash" } });
		expect(textOf(messages[2])).toBe(text);
	});

	it("requires two completed later assistant rounds even when one round has ten results", () => {
		const vault = vaultAt(dir, "id:batch", { keepRecentResults: 10, minUserTurnsOld: 0 });
		const pairs = Array.from({ length: 10 }, () => pair("small"));
		const assistants = pairs.map(([message]) => {
			if (message.role !== "assistant") throw new Error("expected assistant call");
			return message;
		});
		const batch: Message = { ...assistants[0], content: assistants.flatMap((message) => message.content) };
		const messages = [user("inspect"), ...shellPair("body\n".repeat(2000)), batch, ...pairs.map((p) => p[1])];
		expect(references(project(messages, vault))).toHaveLength(0);
		const pending = pair("small");
		expect(references(project([...messages, pending[0]], vault))).toHaveLength(0);
		expect(references(project([...messages, ...pending], vault))).toHaveLength(1);
	});

	it("compacts recent repetitive shell output independently and retains its exact original", () => {
		const vault = vaultAt(dir, "id:compact", { retireOldResults: false, compactShellOutput: true });
		const text = `${"repeat this exact line\n".repeat(1000)}unique warning: preserve me\n`;
		const messages = shellPair(text);
		const full = project(messages, vault, false);
		expect(textOf(full[1])).toBe(text);
		expect(vault.usage().records).toBe(1);
		const projected = project(messages, vault);
		const ref = references(projected)[0];
		expect(detailsOf(ref)?.piToolVaultRecord).toMatchObject({ projection: "shell" });
		expect(textOf(ref)).toContain("unique warning: preserve me");
		expect(textOf(ref)).toContain("exit=0 elapsed=1s");
		expect(textOf(ref)).toContain("omitted duplicate lines=999");
		expect(vault.lookup(recordIdOf(ref))).toMatchObject({ ok: true, record: { text } });
		expect(references(project(aged(pair(text)), vault))).toHaveLength(0);
	});

	it("leaves unverified, altered, failed, small or nonshrinking shell output unchanged", () => {
		const vault = vaultAt(dir, "id:unsafe", { retireOldResults: false, compactShellOutput: true });
		const large = "repeated line\n".repeat(1000);
		const valid = shellPair(large);
		const unsafe: Message[][] = [
			shellPair("small"),
			shellPair(Array.from({ length: 800 }, (_, n) => `unique ${n} payload`).join("\n")),
			pair(large, { tool: "bash" }),
			[valid[0], { ...valid[1], isError: true } as Message],
			[valid[0], { ...valid[1], content: [{ type: "text", text: `${large}changed` }] } as Message],
		];
		const invalidFields: Record<string, JsonValue>[] = [
			{ exitCode: 1 },
			{ complete: false },
			{ requestedCommand: "wrong" },
		];
		for (const field of invalidFields) {
			const snapshot = detailsOf(valid[1])?.piShellSnapshot as Record<string, JsonValue>;
			unsafe.push([valid[0], withDetails(valid[1], { piShellSnapshot: { ...snapshot, ...field } })]);
		}
		for (const messages of unsafe) expect(project(messages, vault)).toEqual(messages);
		expect(vault.usage().records).toBe(0);
		expect(project(valid, vaultAt(dir, "id:off", { retireOldResults: false, compactShellOutput: false }))).toEqual(
			valid,
		);
	});

	it("restores full output when a previously stored record is deleted or corrupted", () => {
		const messages = aged(shellPair("output line\n".repeat(1000)));
		const vault = vaultAt(dir);
		const ref = references(project(messages, vault))[0];
		const path = join(dir, "stores", vault.storeKey()!, `${recordIdOf(ref)}.json`);
		const original = readFileSync(path, "utf8");
		writeFileSync(path, "{broken");
		expect(project(messages, vault)).toEqual(messages);
		writeFileSync(path, original);
		expect(references(project(messages, vault))).toHaveLength(1);
		rmSync(path);
		expect(project(messages, vault)).toEqual(messages);
	});

	it("keeps full output when shell provenance exceeds its validation budget", () => {
		const command = "large command ".repeat(100_000);
		const messages = shellPair("repeated line\n".repeat(1000));
		const assistant = messages[0] as Extract<Message, { role: "assistant" }>;
		const call = assistant.content[0];
		if (call.type !== "toolCall") throw new Error("expected call");
		call.arguments = { command };
		const snapshot = detailsOf(messages[1])?.piShellSnapshot as Record<string, JsonValue>;
		messages[1] = withDetails(messages[1], { piShellSnapshot: { ...snapshot, command, requestedCommand: command } });
		const vault = vaultAt(dir, "id:large-metadata", { retireOldResults: false, compactShellOutput: true });
		expect(project(messages, vault)).toEqual(messages);
		expect(vault.usage().records).toBe(0);
	});

	it("archives without hiding until the recall tool is declared, and writes nothing if it never can be", () => {
		const vault = vaultAt(dir);
		const messages = aged(pair("a".repeat(4096)));
		// A session that can never declare the recall tool must not take records the model cannot read.
		expect(textOf(project(messages, vault, false, false)[2]!)).toBe("a".repeat(4096));
		expect(vault.usage().records).toBe(0);
		expect(storedRecordIds(dir).length).toBe(0);
		// A session where the tool is reachable but not yet declared: bytes are durable, text stays.
		const stored = project(messages, vault, false, true);
		expect(textOf(stored[2]!)).toBe("a".repeat(4096));
		expect(vault.usage().records).toBe(1);
		// Once the tool is declared the same list projects to a reference, and nothing is written twice.
		const hidden = project(messages, vault, true, true);
		expect(textOf(hidden[2]!)).toMatch(/^\[Pi vault record /);
		expect(vault.usage().records).toBe(1);
	});

	it("replaces an aged large result with a reference and returns the exact bytes on recall", () => {
		const vault = vaultAt(dir);
		const original = `HEAD\n${"payload line\n".repeat(1200)}`;
		const messages = aged(pair(original));
		const raw = JSON.stringify(messages);
		const projected = project(messages, vault);
		expect(references(projected).length).toBe(1);
		const hidden = references(projected)[0];
		const reference = textOf(hidden);
		expect(reference).toContain("Exact read tool output archived locally");
		expect(reference).toContain(`bytes=${Buffer.byteLength(original, "utf8")}`);
		expect(reference).toContain(TOOL_VAULT_RECALL_TOOL_NAME);
		expect(reference).toContain(`{"id":"${recordIdOf(hidden)}"}`);
		expect(detailsOf(hidden)).toMatchObject({ piToolVaultRecord: { version: 1 } });
		expect(JSON.stringify(messages)).toBe(raw); // durable history is never rewritten
		const id = recordIdOf(hidden);
		expect(vault.lookup(id)).toMatchObject({ ok: true });
		const answer = formatRecallResult(vault.lookup(id), id, {}, vault.config.maxRecallBytes);
		expect(answer.isError).toBe(false);
		expect(answer.text.endsWith(original)).toBe(true);
		expect(answer.text).toContain(`sha256=${createHash("sha256").update(original, "utf8").digest("hex")}`);
		// Projecting the same history again is byte-identical and writes nothing new.
		const ids = storedRecordIds(dir);
		expect(textOf(project(messages, vault).find((m) => references([m]).length))).toBe(reference);
		expect(storedRecordIds(dir)).toEqual(ids);
	});

	it("is idempotent when an already projected list is projected again", () => {
		const vault = vaultAt(dir);
		const once = project(aged(pair("z".repeat(20 * 1024))), vault);
		expect(project(once, vault).map(textOf)).toEqual(once.map(textOf));
	});

	it("holds the shipped thresholds: recent, young, small and over-large results stay full", () => {
		const strict = openToolVault({
			config: resolveToolVaultConfig({ enabled: true, dir }, {}, dir),
			identity: () => "id:strict",
		});
		const big = "k".repeat(20 * 1024);
		// Aged by three results: inside the shipped keep-recent window.
		expect(references(project(aged(pair(big)), strict))).toEqual([]);
		// Aged past the window: archived by the shipped defaults.
		expect(references(project(aged(pair(big), 12), strict)).length).toBe(1);
		// Too small for the shipped 8 KiB floor, even when old.
		expect(references(project(aged(pair("x".repeat(7 * 1024)), 12), strict))).toEqual([]);
		// Bigger than one record allows, even when old.
		expect(references(project(aged(pair("h".repeat(2 * 1024 * 1024)), 12), strict))).toEqual([]);
		// A single user prompt can run long enough to archive; user follow-ups are not required.
		const oneTurn = [
			...pair(big),
			...Array.from({ length: 12 }, () => pair("small filler", { tool: "ls" })).flat(),
			user("only"),
			say("done"),
		];
		expect(references(project(oneTurn, strict)).length).toBe(1);
	});

	it("leaves forced, failed, non-text, custom-metadata, unpaired and already-projected results full", () => {
		const vault = vaultAt(dir);
		const big = "m".repeat(30 * 1024);
		const bypasses: Message[][] = [
			pair(big, { args: { path: "big.txt", force: true } }),
			pair(big, { error: true }),
			pair(big, { snapshot: null }),
			pair(big, { snapshot: { version: 3, tool: "read", identity: "/synthetic/read" } }),
			pair(big, { snapshot: { version: 1, tool: "grep", identity: "/synthetic/read" } }),
			pair(big, { details: { someExtensionField: true } }),
			pair(big, { details: { piToolVaultRecord: { version: 1, id: "old" } } }),
			pair(big, { tool: "mcp__server__read", snapshot: { version: 1, tool: "mcp__server__read", identity: "/x" } }),
			pair(big, { tool: "bash" }),
			pair(big, {
				blocks: [
					{ type: "text", text: big },
					{ type: "text", text: "extra" },
				],
			}),
			pair(big, { blocks: [{ type: "image", data: "c3ludGhldGlj", mimeType: "image/png" }] }),
			pair(big, { blocks: [{ type: "text", text: `${big}\0binary` }] }),
			pair(big, { assistantStop: "aborted" }),
			pair(big, { assistantStop: "error" }),
			pair(big, { assistantStop: "pending" }),
		];
		for (const bypass of bypasses) {
			const untouched = aged(bypass);
			const projected = project(untouched, vault);
			expect(textOf(projected[2])).toBe(textOf(untouched[2]));
			expect(references(projected)).toEqual([]);
			expect(detailsOf(projected[2])?.piToolVaultRecord).toEqual(detailsOf(bypass[1])?.piToolVaultRecord);
		}
		// A result whose call is absent from the request cannot be verified, so it stays full.
		const orphan = aged(pair(big)).concat(pair(big)[1]!);
		expect(textOf(orphan.at(-1)!)).toBe(big);
		expect(references(project(orphan, vault)).length).toBe(1); // only the paired result archives
		// The reference layer's own output is a projection, not evidence to archive.
		const anchored = aged(pair(big));
		anchored[2] = {
			...anchored[2],
			...withDetails(anchored[2], { piContextProjection: { version: 1, originalText: big } }),
		};
		expect(textOf(project(anchored, vault)[2])).toBe(big);
	});

	it("archives a limited result with its notices and returns those same bytes", () => {
		const vault = vaultAt(dir);
		const limited = `${"body\n".repeat(900)}\n[2000 line limit reached]`;
		const messages = aged(
			pair(limited, { details: { truncation: { truncated: true, content: limited, totalBytes: limited.length } } }),
		);
		const projected = project(messages, vault);
		expect(references(projected).length).toBe(1);
		const answer = formatRecallResult(
			vault.lookup(recordIdOf(projected[2])),
			recordIdOf(projected[2]),
			{},
			vault.config.maxRecallBytes,
		);
		expect(answer.isError).toBe(false);
		expect(answer.text.endsWith(limited)).toBe(true);
		if (!answer.isError) expect(answer.text).toContain("limit reached");
	});

	it("hides nothing while the recall tool is not declared to the model", () => {
		const vault = vaultAt(dir);
		const big = "n".repeat(40 * 1024);
		const messages = aged(pair(big));
		const projected = project(messages, vault, false);
		expect(textOf(projected[2]!)).toBe(big); // the text itself is untouched
		expect(references(projected)).toEqual([]); // and no reference names it
		// The record is already durable, so the next run can hide it the moment the tool is declared.
		expect(storedRecordIds(dir).length).toBe(1);
	});

	it("leaves the text full when the record cannot be made durable", () => {
		const vault = vaultAt(dir);
		const big = "p".repeat(30 * 1024);
		const messages = aged(pair(big));
		const key = vault.storeKey();
		expect(key).toBeDefined(); // the store exists before it is made unwritable
		chmodSync(join(dir, "stores", key!), 0o500); // durable write impossible
		const projected = project(messages, vault);
		chmodSync(join(dir, "stores", key!), 0o700);
		expect(textOf(projected[2])).toBe(big);
		expect(detailsOf(projected[2])?.piToolVaultRecord).toBeUndefined();
	});

	it("never archives the recall answer itself, so retrieved bytes stay in context", () => {
		const vault = vaultAt(dir);
		const big = "r".repeat(60 * 1024);
		const recallResult = {
			role: "toolResult",
			toolCallId: "recall-call",
			toolName: TOOL_VAULT_RECALL_TOOL_NAME,
			isError: false,
			content: [{ type: "text", text: big }],
			details: { piVaultRecall: { id: "f".repeat(64), sha256: "f".repeat(64), store: "s", bytes: big.length } },
			api: "faux",
			provider: "faux",
			model: "faux",
			timestamp: 0,
		} as Message;
		const projected = project(aged(pair(big).concat([recallResult])), vault);
		expect(textOf(projected.find((m) => m.role === "toolResult" && m.toolName === TOOL_VAULT_RECALL_TOOL_NAME))).toBe(
			big,
		);
		expect(references(projected).length).toBe(1); // only the read result archived
	});

	it("explains a missing, invalid or unreachable record without inventing content", () => {
		const vault = vaultAt(dir);
		const put = vault.put(candidate({ text: "SECRET ARCHIVED TEXT\n".repeat(700) }));
		if (!put.ok) throw new Error("expected a stored record");
		const path = join(dir, "stores", vault.storeKey()!, `${put.id}.json`);
		const missing = formatRecallResult(vault.lookup("a".repeat(64)), "a".repeat(64), {}, vault.config.maxRecallBytes);
		expect(missing.isError).toBe(true);
		expect(missing.text).toContain("no record in this session's vault");
		expect(missing.text).not.toContain("SECRET");
		const invalid = formatRecallResult(
			vault.lookup("../etc/passwd"),
			"../etc/passwd",
			{},
			vault.config.maxRecallBytes,
		);
		expect(invalid.isError).toBe(true);
		expect(invalid.text).toContain("nothing was read");
		chmodSync(path, 0);
		const unreachable = formatRecallResult(vault.lookup(put.id), put.id, {}, vault.config.maxRecallBytes);
		chmodSync(path, 0o600);
		expect(unreachable.isError).toBe(true);
		expect(unreachable.text).toContain("cannot be read");
		expect(unreachable.text).not.toContain("SECRET");
		expect(formatRecallResult(vault.lookup(put.id), put.id, {}, vault.config.maxRecallBytes).isError).toBe(false);
	});
});

describe("recall ranges", () => {
	it("retrieves every byte of an oversized Unicode line with explicit byte pages", () => {
		const text = "漢🙂".repeat(2000);
		let offset = 0;
		let restored = "";
		for (;;) {
			const page = sliceVaultBytes(text, offset, 1024);
			if (!page) throw new Error("valid continuation refused");
			restored += page.text;
			if (page.nextByteOffset === undefined) break;
			expect(page.nextByteOffset).toBeGreaterThan(offset);
			offset = page.nextByteOffset;
		}
		expect(restored).toBe(text);
		expect(sliceVaultBytes(text, 1, 1024)).toBeUndefined();
		expect(sliceVaultBytes(text, -1, 1024)).toBeUndefined();
		const vault = vaultAt(dir);
		const id = putId(vault.put(candidate({ text })));
		const first = formatRecallResult(vault.lookup(id), id, {}, 1024);
		expect(first.text).toContain("continue with byteOffset=1022");
		expect(formatRecallResult(vault.lookup(id), id, { byteOffset: 1022 }, 1024).isError).toBe(false);
		expect(formatRecallResult(vault.lookup(id), id, { byteOffset: 1 }, 1024).isError).toBe(true);
		expect(formatRecallResult(vault.lookup(id), id, { byteOffset: 0, offset: 1 }, 1024).isError).toBe(true);
	});
	it("returns whole lines, handles Unicode and caps a single huge line by bytes", () => {
		const text = ["first 🙂 line", "second 漢字 line", "third line", "fourth line"].join("\n");
		expect(sliceVaultText(text, {}, 4096)).toMatchObject({
			text,
			firstLine: 1,
			lastLine: 4,
			totalLines: 4,
			stoppedEarly: false,
		});
		expect(sliceVaultText(text, { offset: 2, limit: 2 }, 4096)).toMatchObject({
			text: "second 漢字 line\nthird line",
			firstLine: 2,
			lastLine: 3,
		});
		const capped = sliceVaultText(text, { offset: 1 }, Buffer.byteLength("first 🙂 line\nsecond 漢字 line", "utf8"));
		expect(capped.text).toBe("first 🙂 line\nsecond 漢字 line");
		expect(capped.stoppedEarly).toBe(true);
		const single = sliceVaultText("漢".repeat(4000), { offset: 1 }, 1000);
		expect(single.stoppedEarly).toBe(true);
		expect(single.text).toBe("漢".repeat(333)); // 333 * 3 bytes fit, 334 do not, and no code point is split
		expect(sliceVaultText("😀".repeat(600), {}, 1000).text).toBe("😀".repeat(250));
		expect(sliceVaultText(text, { offset: 9 }, 4096).text).toBe("");
		expect(sliceVaultText(text, { offset: 1, limit: 0 }, 4096).text).toBe("");
	});

	it("keeps CRLF and an absent final newline byte-exact", () => {
		const crlf = "a\r\nb\r\n";
		expect(sliceVaultText(crlf, {}, 4096).text).toBe(crlf);
		expect(sliceVaultText("a\nb", { offset: 2 }, 4096).text).toBe("b");
	});
});

/**
 * Multi-process checks. Admission and quotas have to hold across processes, not only across vault
 * objects in one process, so each child opens the same root with its own identity and writes.
 */
describe("vault across processes", () => {
	const vaultModule = realpathSync(new URL("../src/core/tool-vault.ts", import.meta.url).pathname);
	const childSource = `
		const [vaultModule, dir, identity, letter, records, recordBytes, maxRecordBytes, maxSessionBytes, rootBytes] =
			process.argv.slice(2);
		process.stderr.write("vault child started\\n");
		const { openToolVault, resolveToolVaultConfig } = await import(vaultModule);
		process.stderr.write("vault module imported\\n");
		const config = resolveToolVaultConfig(
			{
				enabled: true,
				dir,
				minBytes: 1,
				maxRecordBytes: Number(maxRecordBytes),
				maxSessionBytes: Number(maxSessionBytes),
				rootBytes: Number(rootBytes),
				maxRecords: 1000,
			},
			{},
			dir,
		);
		const vault = openToolVault({ config, identity: () => identity });
		const stored = [];
		const refusals = [];
		for (let i = 0; i < Number(records); i++) {
			const text = letter.repeat(1) + String(i) + "\\n" + letter.repeat(Number(recordBytes));
			const result = vault.put({
				session: identity,
				tool: "read",
				toolCallId: identity + "-" + i,
				arguments: { path: identity + "/f" + i },
				snapshot: { version: 1, tool: "read", identity: identity + "/f" + i },
				metadata: {},
				text,
			});
			if (result.ok) stored.push(result.id);
			else refusals.push(result.reason);
		}
		console.log(JSON.stringify({ identity, stored, refusals, fault: vault.fault() ?? null }));
		process.stderr.write("vault child finished\\n");
	`;

	function childScript(): string {
		const path = join(dir, "vault-child.mjs");
		writeFileSync(path, childSource);
		return path;
	}

	function spawnChild(script: string, args: string[]) {
		return new Promise<{ identity: string; stored: string[]; refusals: string[]; fault: string | null }>(
			(resolve, reject) => {
				const logs = mkdtempSync(join(dir, "child-logs-"));
				const stdoutPath = join(logs, "stdout.log");
				const stderrPath = join(logs, "stderr.log");
				let child: ReturnType<typeof spawn>;
				const stdoutFd = openSync(stdoutPath, "wx", 0o600);
				// This module only imports Node built-ins; no workspace alias preload is needed.
				try {
					const stderrFd = openSync(stderrPath, "wx", 0o600);
					try {
						child = spawn(process.execPath, ["--max-old-space-size=128", script, vaultModule, dir, ...args], {
							stdio: ["ignore", stdoutFd, stderrFd],
							timeout: 15_000,
							killSignal: "SIGKILL",
						});
					} finally {
						closeSync(stderrFd);
					}
				} finally {
					closeSync(stdoutFd);
				}
				let settled = false;
				const diagnostics = () =>
					`stderr=${readChildOutput(stderrPath, 1000)}; stdout=${readChildOutput(stdoutPath, 500)}`;
				const fail = (error: Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(deadline);
					reject(error);
				};
				// The parent owns settlement even when a restricted spawn reports exit 0 without
				// running the child, or never delivers close. Native spawn timeout alone is insufficient.
				const deadline = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* blocked process control is reported by the deadline */
					}
					fail(new Error(`vault child exceeded 15 seconds; ${diagnostics()}`));
				}, 15_000);
				child.on("error", fail);
				child.on("close", (code, signal) => {
					if (settled) return;
					if (code !== 0) {
						fail(new Error(`child exit ${code}, signal ${signal}; ${diagnostics()}`));
						return;
					}
					try {
						const out = readChildOutput(stdoutPath, 64 * 1024);
						const parsed: unknown = JSON.parse(out.trim());
						if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
							throw new Error("missing result object");
						const result = parsed as Record<string, unknown>;
						if (
							typeof result.identity !== "string" ||
							!Array.isArray(result.stored) ||
							!result.stored.every((id) => typeof id === "string") ||
							!Array.isArray(result.refusals) ||
							!result.refusals.every((reason) => typeof reason === "string") ||
							(result.fault !== null && typeof result.fault !== "string")
						)
							throw new Error("invalid result fields");
						settled = true;
						clearTimeout(deadline);
						resolve({
							identity: result.identity,
							stored: result.stored,
							refusals: result.refusals,
							fault: result.fault,
						});
					} catch (error) {
						fail(new Error(`child produced no valid result: ${String(error)}; ${diagnostics()}`));
					}
				});
			},
		);
	}

	function readChildOutput(path: string, maxBytes: number): string {
		let fd: number | undefined;
		try {
			fd = openSync(path, "r");
			const bytes = Buffer.alloc(maxBytes);
			const length = readSync(fd, bytes, 0, maxBytes, 0);
			const text = bytes.toString("utf8", 0, length);
			return statSync(path).size > maxBytes ? `${text}\n[child output exceeds ${maxBytes} bytes]` : text;
		} catch (error) {
			return `[cannot read child output: ${String(error)}]`;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}

	function onDiskRecordBytes(vaultDir: string): number {
		let bytes = 0;
		for (const store of list(join(vaultDir, "stores"))) {
			for (const name of list(join(vaultDir, "stores", store))) {
				if (/^[a-f0-9]{64}\.json$/.test(name)) bytes += statSync(join(vaultDir, "stores", store, name)).size;
			}
		}
		return bytes;
	}

	it("never admits more stores than the root allows when six creators start together", async () => {
		const mib = 1024 * 1024;
		const script = childScript();
		const results = await Promise.all(
			Array.from({ length: 6 }, (_, i) =>
				spawnChild(script, [
					`id:race-${i}`,
					String.fromCharCode(97 + i),
					"1",
					"4096",
					String(64 * 1024),
					String(4 * mib),
					String(12 * mib),
				]),
			),
		);
		// At most maxStores = 3 stores exist, and every creator either stored its record or was refused.
		expect(list(join(dir, "stores")).length).toBeLessThanOrEqual(3);
		const stored = results.flatMap((result) => result.stored);
		const refused = results.flatMap((result) => result.refusals);
		expect(stored.length + refused.length).toBe(6);
		expect(new Set(stored).size).toBe(stored.length);
		for (const reason of refused) expect(reason).toBe("no-store");
		// Every stored id is readable and verifies, so a loser never left a half-written store behind.
		for (const id of stored) {
			const found = results.find((result) => result.stored.includes(id));
			if (!found) throw new Error("stored id without a creator");
			const owner = openToolVault({ config: configAt(dir), identity: () => found.identity });
			expect(owner.lookup(id).ok).toBe(true);
		}
		// Refused creators wrote nothing, so the bytes on disk stay inside the root bound.
		expect(onDiskRecordBytes(dir)).toBeLessThanOrEqual(3 * 4 * mib);
	}, 60_000);

	it("keeps the byte quota and record integrity with four writers on one store", async () => {
		const script = childScript();
		const letters = ["a", "b", "c", "d"];
		// Caps at or above the configuration floors: 32 KiB per record, 96 KiB per store.
		const maxRecordBytes = 32 * 1024;
		const maxSessionBytes = 96 * 1024;
		const results = await Promise.all(
			letters.map((letter) =>
				spawnChild(script, [
					"id:shared",
					letter,
					"8",
					"24576",
					String(maxRecordBytes),
					String(maxSessionBytes),
					"67108864",
				]),
			),
		);
		// Demand is 4 x 8 x ~24 KiB, far above the 96 KiB store cap. Writers converge on the disk
		// listing, so the bound is the cap plus at most one record per concurrent writer.
		expect(onDiskRecordBytes(dir)).toBeLessThanOrEqual(maxSessionBytes + letters.length * maxRecordBytes);
		const ids = storedRecordIds(dir);
		expect(results.flatMap((result) => result.stored).length).toBe(ids.length);
		expect(results.some((result) => result.refusals.length > 0)).toBe(true);
		for (const result of results) for (const reason of result.refusals) expect(reason).toBe("session-quota");
		// Every record on disk is readable and SHA256-verified by a fresh vault over the same store.
		const reader = openToolVault({ config: configAt(dir), identity: () => "id:shared" });
		for (const id of ids) expect(reader.lookup(id).ok).toBe(true);
	}, 60_000);

	it("binds the quotas a store was created with, and refuses a store whose quota file is unreadable", () => {
		const created = vaultAt(dir, "id:bound", {
			maxSessionBytes: 40 * 1024,
			maxRecordBytes: 16 * 1024,
			maxRecords: 2,
		});
		expect(created.put(candidate({ text: "z".repeat(9 * 1024), toolCallId: "b1" })).ok).toBe(true);
		// A looser configuration cannot raise the caps this store was created with.
		const looser = vaultAt(dir, "id:bound", {
			maxSessionBytes: 8 * 1024 * 1024,
			maxRecordBytes: 4 * 1024 * 1024,
			maxRecords: 99,
		});
		expect(looser.put(candidate({ text: "y".repeat(9 * 1024), toolCallId: "b2" })).ok).toBe(true);
		expect(putRefusal(looser.put(candidate({ text: "x".repeat(9 * 1024), toolCallId: "b3" })))).toBe("record-cap");
		// Without its quota file the store is not used at all: no writes, and no guess about its caps.
		const storeDir = join(dir, "stores", looser.storeKey()!);
		writeFileSync(join(storeDir, "quota.json"), "{ not json");
		const blind = vaultAt(dir, "id:bound");
		expect(putRefusal(blind.put(candidate({ text: "w".repeat(9 * 1024), toolCallId: "b4" })))).toBe("no-store");
		expect(blind.fault()).toMatch(/quota\.json is missing or unreadable/);
		// The records that were already stored are untouched on disk.
		expect(storedRecordIds(dir).length).toBe(2);
	});
});
