/**
 * Local vault for exact copies of old read-only tool outputs.
 *
 * A record is one immutable JSON file holding the original text, its SHA256 and the
 * tool/call provenance that produced it. Records are written and fsynced before any
 * outgoing-context reference replaces the text, so a reference always names bytes that
 * already survive on disk. Nothing is evicted or overwritten: at quota, or on any
 * storage uncertainty, the caller keeps the full text and nothing is hidden.
 */

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** Ancestor stores searched by one recall miss. */
const MAX_LINEAGE_HOPS = 8;
/** A record is JSON wrapped around the text; this is the wrapper allowance over maxRecordBytes. */
const RECORD_WRAPPER_BYTES = 64 * 1024;
const STORE_KEY_PATTERN = /^[a-f0-9]{24}$/;
/** Ceiling for store slots in one root, so the slot recount stays a short directory listing. */
const MAX_STORE_SLOTS = 256;
/** Per-store quota file. A store without a readable one is not written to or read from. */
const STORE_META_FILE = "quota.json";
const RECORD_ID_PATTERN = /^[a-f0-9]{64}$/;

/** Vault settings as they can appear in settings.json, all optional. */
export interface ToolVaultSettings {
	/** Hide archived tool output in outgoing context. Opt-in: default false. */
	enabled?: boolean;
	/** Replace sufficiently old outputs with retrieval references. Default true. */
	retireOldResults?: boolean;
	/** Compact repetitive successful shell output before it ages. Default false. */
	compactShellOutput?: boolean;
	/** Vault root directory. Default: <agentDir>/tool-vault. */
	dir?: string;
	/** Smallest tool result, in bytes, that may be archived. */
	minBytes?: number;
	/** Most recent tool results that always stay full. */
	keepRecentResults?: number;
	/** Completed assistant/tool rounds that must follow a result. Default two. */
	minAssistantTurnsOld?: number;
	/** Completed user turns that must follow a result before it may be archived. */
	minUserTurnsOld?: number;
	/** Largest single record, in bytes. */
	maxRecordBytes?: number;
	/** Bytes one session store may hold, including the JSON wrapper. */
	maxSessionBytes?: number;
	/** Records one session store may hold. */
	maxRecords?: number;
	/** Root budget used to bound store admission; concurrent writers may overshoot a session budget. */
	rootBytes?: number;
	/** Largest recall answer, in bytes. Bigger records need line ranges. */
	maxRecallBytes?: number;
	/** Largest session header examined while resolving lineage. */
	maxHeaderBytes?: number;
}

/** Resolved vault configuration. Every value is a usable, clamped integer. */
export interface ToolVaultConfig {
	enabled: boolean;
	retireOldResults: boolean;
	compactShellOutput: boolean;
	dir: string;
	minBytes: number;
	keepRecentResults: number;
	minAssistantTurnsOld: number;
	minUserTurnsOld: number;
	maxRecordBytes: number;
	maxSessionBytes: number;
	maxRecords: number;
	rootBytes: number;
	maxRecallBytes: number;
	maxHeaderBytes: number;
	/** Maximum admitted stores under rootBytes; not a hard aggregate byte cap during concurrent writes. */
	maxStores: number;
}

/** Conservative defaults: opt-in, little hidden, small bounded stores. */
export const TOOL_VAULT_DEFAULTS = {
	enabled: false,
	retireOldResults: true,
	compactShellOutput: false,
	minBytes: 8 * 1024,
	keepRecentResults: 10,
	minAssistantTurnsOld: 2,
	minUserTurnsOld: 0,
	maxRecordBytes: 1024 * 1024,
	maxSessionBytes: 32 * 1024 * 1024,
	maxRecords: 2048,
	rootBytes: 256 * 1024 * 1024,
	maxRecallBytes: 256 * 1024,
	maxHeaderBytes: 64 * 1024,
} as const;

function integer(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return fallback;
	return value;
}

/**
 * Merge settings with the PI_TOOL_VAULT and PI_TOOL_VAULT_DIR environment overrides into one
 * clamped configuration. PI_TOOL_VAULT=0 disables the vault even when settings enable it, which
 * is the explicit full-context fallback; PI_TOOL_VAULT=1 enables it without touching settings.
 */
export function resolveToolVaultConfig(
	settings: ToolVaultSettings | undefined,
	env: NodeJS.ProcessEnv = process.env,
	agentDir?: string,
): ToolVaultConfig {
	const flag = env.PI_TOOL_VAULT?.trim().toLowerCase();
	const enabled = flag === "0" || flag === "off" ? false : flag === "1" || flag === "on" ? true : !!settings?.enabled;
	const dir = env.PI_TOOL_VAULT_DIR?.trim() || settings?.dir?.trim() || join(agentDir ?? ".", "tool-vault");
	const maxRecordBytes = integer(
		settings?.maxRecordBytes,
		TOOL_VAULT_DEFAULTS.maxRecordBytes,
		16 * 1024,
		16 * 1024 * 1024,
	);
	const maxSessionBytes = integer(
		settings?.maxSessionBytes,
		TOOL_VAULT_DEFAULTS.maxSessionBytes,
		maxRecordBytes,
		1024 * 1024 * 1024,
	);
	const rootBytes = integer(
		settings?.rootBytes,
		TOOL_VAULT_DEFAULTS.rootBytes,
		maxSessionBytes,
		16 * 1024 * 1024 * 1024,
	);
	return {
		enabled,
		retireOldResults: settings?.retireOldResults !== false,
		compactShellOutput: settings?.compactShellOutput === true,
		dir: resolve(dir),
		minBytes: integer(settings?.minBytes, TOOL_VAULT_DEFAULTS.minBytes, 1024, maxRecordBytes),
		keepRecentResults: integer(settings?.keepRecentResults, TOOL_VAULT_DEFAULTS.keepRecentResults, 1, 1000),
		minAssistantTurnsOld: integer(settings?.minAssistantTurnsOld, TOOL_VAULT_DEFAULTS.minAssistantTurnsOld, 0, 1000),
		minUserTurnsOld: integer(settings?.minUserTurnsOld, TOOL_VAULT_DEFAULTS.minUserTurnsOld, 0, 1000),
		maxRecordBytes,
		maxSessionBytes,
		maxRecords: integer(settings?.maxRecords, TOOL_VAULT_DEFAULTS.maxRecords, 1, 100_000),
		rootBytes,
		maxRecallBytes: integer(settings?.maxRecallBytes, TOOL_VAULT_DEFAULTS.maxRecallBytes, 1024, maxRecordBytes),
		maxHeaderBytes: integer(settings?.maxHeaderBytes, TOOL_VAULT_DEFAULTS.maxHeaderBytes, 1024, 4 * 1024 * 1024),
		// Bound store admission; per-store concurrent writes have the documented quota overshoot.
		maxStores: Math.min(MAX_STORE_SLOTS, Math.max(1, Math.floor(rootBytes / maxSessionBytes))),
	};
}

/** The immutable on-disk record. `text` is the exact bytes the tool returned. */
export interface VaultRecord {
	version: 1;
	id: string;
	store: string;
	session: string;
	tool: string;
	toolCallId: string;
	arguments: unknown;
	snapshot: unknown;
	metadata: unknown;
	sha256: string;
	bytes: number;
	storedAt: string;
	text: string;
}

export type VaultPutResult =
	| { ok: true; id: string; created: boolean }
	| {
			ok: false;
			reason: "disabled" | "no-store" | "record-cap" | "session-quota" | "record-too-large" | "io-error";
			detail: string;
	  };

export type VaultLookup =
	| { ok: true; record: VaultRecord; fromStore: string }
	| {
			ok: false;
			reason: "no-vault" | "invalid-id" | "not-found" | "unsafe-path" | "oversize" | "unreadable" | "corrupt";
	  };

/** A candidate archived result, supplied by the projection. */
export interface VaultCandidate {
	session: string;
	tool: string;
	toolCallId: string;
	arguments: unknown;
	snapshot: unknown;
	metadata: unknown;
	text: string;
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Vault identity for a session. The session file is the identity while persisting, so a resume
 * of the same file and an in-session branch reuse the same store; the id covers in-memory use.
 */
export function toolVaultIdentity(sessionFile: string | undefined, sessionId: string): string {
	return sessionFile ? `file:${resolve(sessionFile)}` : `id:${sessionId}`;
}

/** Store key for an identity. Hex only, so it can never carry path syntax. */
export function storeKeyOf(identity: string): string {
	return sha256(`pi-tool-vault-store-v1\0${identity}`).slice(0, 24);
}

/**
 * Deterministic record id: stable across requests, restarts and repeated projections. It addresses
 * the exact bytes together with how they were produced, so two identical results of the same call
 * share one record while a different range, pattern or limit is a different record. The producing
 * call id is part of the identity: identical bytes from another invocation remain a distinct event.
 */
export function vaultRecordId(storeKey: string, candidate: VaultCandidate): string {
	return sha256(
		JSON.stringify([
			"pi-tool-vault-v1",
			storeKey,
			candidate.session,
			candidate.tool,
			candidate.toolCallId,
			candidate.arguments,
			candidate.snapshot,
			candidate.metadata,
			sha256(candidate.text),
		]),
	);
}

/** A directory the vault may use: lstat, so a symlink or a file in its place is refused. */
function isRealDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function fsyncDirectory(dir: string): void {
	if (process.platform === "win32") return; // No portable O_DIRECTORY; the record itself is fsynced.
	let fd: number | undefined;
	try {
		fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
		fsyncSync(fd);
	} catch {
		// Best effort: the record is durable and the rename is atomic.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Read the first line of a session file, bounded, for parent-session lineage only. */
function readHeadLine(path: string, maxBytes: number): string | undefined {
	let fd: number | undefined;
	try {
		const size = lstatSync(path).size;
		fd = openSync(path, constants.O_RDONLY);
		const length = Math.min(maxBytes, size);
		const buffer = Buffer.allocUnsafe(length);
		let read = 0;
		while (read < length) {
			const got = readSync(fd, buffer, read, length - read, read);
			if (got <= 0) break;
			read += got;
		}
		const head = buffer.toString("utf8", 0, read);
		const newline = head.indexOf("\n");
		return newline < 0 ? head : head.slice(0, newline);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Store keys of the session files this one descends from, oldest last, cycle-safe and bounded. */
function lineageKeys(sessionFile: string | undefined, maxHeaderBytes: number): string[] {
	const keys: string[] = [];
	const seen = new Set<string>();
	let file = sessionFile ? resolve(sessionFile) : undefined;
	while (file && keys.length < MAX_LINEAGE_HOPS && !seen.has(file)) {
		seen.add(file);
		const line = readHeadLine(file, maxHeaderBytes);
		if (line === undefined) break;
		let header: { id?: unknown; parentSession?: unknown };
		try {
			header = JSON.parse(line);
		} catch {
			break;
		}
		if (typeof header !== "object" || header === null || Array.isArray(header)) break;
		if (typeof header.id !== "string") break;
		const parent = typeof header.parentSession === "string" ? resolve(header.parentSession) : undefined;
		if (!parent || seen.has(parent)) break;
		keys.push(storeKeyOf(toolVaultIdentity(parent, header.id)));
		file = parent;
	}
	return keys;
}

interface StoreHandle {
	key: string;
	dir: string;
	ids: Set<string>;
	bytes: number;
	/** Caps bound in this store's quota file, tightened by this process's settings. */
	caps: { maxRecordBytes: number; maxSessionBytes: number; maxRecords: number };
	/** Bytes counted at the last full listing, used to notice another process writing here. */
	scannedBytes: number;
}

/** A session-scoped vault store with its in-memory id set and byte accounting. */
export interface ToolVault {
	config: ToolVaultConfig;
	/** Store key in use, or undefined while the vault cannot store anything. */
	storeKey(): string | undefined;
	/** Deterministic record id for a candidate, or undefined when no store is available. */
	recordId(candidate: VaultCandidate): string | undefined;
	/** Whether this process knows the record is present, without a file system call. */
	isStored(id: string): boolean;
	/** Write the record if it is not already there. Refusals are the caller's signal to keep the text. */
	put(candidate: VaultCandidate): VaultPutResult;
	lookup(id: string): VaultLookup;
	/** Bytes and records held by the current store. */
	usage(): { bytes: number; records: number };
	/**
	 * Whether this session's store already holds at least one record. Looks without creating:
	 * a session that never archived anything claims no store slot. Sticky once true.
	 */
	hasStoredRecords(): boolean;
	/** Why archiving stopped, if it did. */
	fault(): string | undefined;
}

/**
 * Open the vault facade for one session. Nothing touches the disk until the first store or
 * recall; the store itself opens once per session identity.
 */
export function openToolVault(options: {
	config: ToolVaultConfig;
	/** Current vault identity from toolVaultIdentity(), re-read per request so branches apply. */
	identity: () => string | undefined;
	/** Session file of the current session, used only to find ancestor stores on a recall miss. */
	sessionFile?: () => string | undefined;
}): ToolVault {
	const config = options.config;
	const storesDir = join(config.dir, "stores");
	let rootFault: string | undefined;
	let ioFault: string | undefined;
	let open: StoreHandle | undefined;
	let openFor: string | undefined;
	// Records are never evicted, so once this session's store has one, it keeps having one.
	let storedSeen = false;

	function ensureStoresDir(): boolean {
		if (rootFault) return false;
		if (existsSync(storesDir)) {
			if (!isRealDirectory(storesDir)) rootFault = `${storesDir} is not a real directory`;
			return !rootFault;
		}
		try {
			if (existsSync(config.dir) && !isRealDirectory(config.dir)) {
				rootFault = `${config.dir} is not a real directory`;
				return false;
			}
			mkdirSync(config.dir, { mode: 0o700, recursive: true });
			if (!isRealDirectory(config.dir)) {
				rootFault = `${config.dir} is not a real directory`;
				return false;
			}
			if (!existsSync(storesDir)) mkdirSync(storesDir, { mode: 0o700 });
			if (!isRealDirectory(storesDir)) rootFault = `${storesDir} is not a real directory`;
			return !rootFault;
		} catch (error) {
			rootFault = `cannot create ${storesDir}: ${(error as Error).message}`;
			return false;
		}
	}

	function openStore(identity: string): StoreHandle | undefined {
		if (open && openFor === identity) return open;
		open = undefined;
		openFor = identity;
		if (!ensureStoresDir()) return undefined;
		const key = storeKeyOf(identity);
		const dir = join(storesDir, key);
		let fresh = false;
		if (!existsSync(dir)) {
			// mkdir is the atomic claim: exactly one process wins it, and the winner binds the quotas.
			try {
				mkdirSync(dir, { mode: 0o700 });
				fresh = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					rootFault = `cannot create ${dir}: ${(error as Error).message}`;
					return undefined;
				}
			}
			if (fresh && !writeStoreQuota(dir)) return undefined;
			// Counting after claiming bounds store admission across processes: a creator that
			// sees more stores than allowed removes its own empty store and keeps the full text instead.
			if (fresh && !admitOwnStore(dir)) return undefined;
		}
		if (!isRealDirectory(dir)) {
			rootFault = `${dir} is not a real directory`;
			return undefined;
		}
		// A store carries the quotas its first writer bound. Check the strictest caps against this
		// process's accounting; concurrent writers can add records between recounts and writes.
		const caps = readStoreQuota(dir);
		if (!caps) {
			rootFault = `${join(dir, STORE_META_FILE)} is missing or unreadable, so this store is not used`;
			return undefined;
		}
		// One flat listing per store open: bounded by maxRecords entries, never recursive, never per request.
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch (error) {
			rootFault = `cannot list ${dir}: ${(error as Error).message}`;
			return undefined;
		}
		const ids = new Set<string>();
		let bytes = 0;
		for (const name of names) {
			if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
			try {
				bytes += lstatSync(join(dir, name)).size;
			} catch {
				continue; // A record that vanished between listing and stat is simply not indexed.
			}
			ids.add(name.slice(0, 64));
		}
		open = { key, dir, ids, bytes, caps, scannedBytes: bytes };
		if (fresh) fsyncDirectory(storesDir);
		return open;
	}

	/**
	 * Re-read the store listing when another process may have moved its total by a record's worth.
	 * One flat listing per maxRecordBytes written bounds recount work. This is best-effort quota
	 * accounting, not a cross-process lock: concurrent writers can overshoot the configured caps.
	 */
	function rereadIfDrifted(handle: StoreHandle): void {
		if (handle.scannedBytes + handle.caps.maxRecordBytes >= handle.bytes) return;
		let names: string[];
		try {
			names = readdirSync(handle.dir);
		} catch (error) {
			ioFault = `cannot list ${handle.dir}: ${(error as Error).message}`;
			return;
		}
		let bytes = 0;
		for (const name of names) {
			if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
			try {
				bytes += lstatSync(join(handle.dir, name)).size;
			} catch {
				continue;
			}
			handle.ids.add(name.slice(0, 64));
		}
		handle.bytes = bytes;
		handle.scannedBytes = bytes;
	}

	/** Admission control for the global root, run right after this process claimed a store directory. */
	function admitOwnStore(dir: string): boolean {
		let names: string[];
		try {
			names = readdirSync(storesDir);
		} catch (error) {
			rootFault = `cannot list ${storesDir}: ${(error as Error).message}`;
			return false;
		}
		const known = names.filter((name) => STORE_KEY_PATTERN.test(name)).length;
		if (known <= config.maxStores) return true;
		// Over the limit: give back the store this process just claimed, while it holds no records.
		// A directory that already holds records belongs to an admitted store and is never removed.
		try {
			const names = readdirSync(dir);
			if (names.some((name) => name !== STORE_META_FILE)) return false;
			if (names.includes(STORE_META_FILE)) unlinkSync(join(dir, STORE_META_FILE));
			rmdirSync(dir);
			fsyncDirectory(storesDir);
		} catch (error) {
			rootFault = `cannot release the store slot ${dir}: ${(error as Error).message}`;
			return false;
		}
		rootFault = `vault root holds ${known} stores, limit ${config.maxStores}`;
		return false;
	}

	/** Bind the quotas of a new store so every writer of that directory agrees on one cap. */
	function writeStoreQuota(dir: string): boolean {
		const payload = JSON.stringify({
			version: 1,
			maxRecordBytes: config.maxRecordBytes,
			maxSessionBytes: config.maxSessionBytes,
			maxRecords: config.maxRecords,
		});
		try {
			const path = join(dir, STORE_META_FILE);
			const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
			try {
				writeFileSync(fd, payload);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			fsyncDirectory(dir);
			return true;
		} catch (error) {
			rootFault = `cannot bind quotas in ${dir}: ${(error as Error).message}`;
			return false;
		}
	}

	/** The store's caps, tightened by this process's own caps. Undefined means: do not use the store. */
	function readStoreQuota(
		dir: string,
	): { maxRecordBytes: number; maxSessionBytes: number; maxRecords: number } | undefined {
		let raw: string;
		try {
			const stats = lstatSync(join(dir, STORE_META_FILE));
			if (!stats.isFile() || stats.size > 4096) return undefined;
			raw = readFileSync(join(dir, STORE_META_FILE), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
			// A store from before quotas existed: refuse to use it rather than guess its caps.
			return undefined;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return undefined;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const quota = parsed as Record<string, unknown>;
		const number = (key: string, floor: number) =>
			typeof quota[key] === "number" && Number.isSafeInteger(quota[key]) && (quota[key] as number) >= floor
				? (quota[key] as number)
				: undefined;
		if (quota.version !== 1) return undefined;
		const maxRecordBytes = number("maxRecordBytes", 1);
		const maxSessionBytes = number("maxSessionBytes", 1);
		const maxRecords = number("maxRecords", 1);
		if (!maxRecordBytes || !maxSessionBytes || !maxRecords) return undefined;
		return {
			maxRecordBytes: Math.min(maxRecordBytes, config.maxRecordBytes),
			maxSessionBytes: Math.min(maxSessionBytes, config.maxSessionBytes),
			maxRecords: Math.min(maxRecords, config.maxRecords),
		};
	}

	function store(): StoreHandle | undefined {
		if (!config.enabled || ioFault) return undefined;
		const identity = options.identity();
		if (!identity) return undefined;
		return openStore(identity);
	}

	function readRecord(handle: StoreHandle, id: string): VaultLookup {
		const path = join(handle.dir, `${id}.json`);
		if (!existsSync(path)) return { ok: false, reason: "not-found" };
		let stats: Stats;
		try {
			stats = lstatSync(path);
		} catch {
			return { ok: false, reason: "unsafe-path" };
		}
		// lstat: a symlink is not a regular file, so a planted link never gets read.
		if (!stats.isFile()) return { ok: false, reason: "unsafe-path" };
		if (stats.size > handle.caps.maxRecordBytes + RECORD_WRAPPER_BYTES) return { ok: false, reason: "oversize" };
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch (error) {
			// An unreadable file is a different fact from a file whose bytes do not check out.
			return { ok: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not-found" : "unreadable" };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { ok: false, reason: "corrupt" };
		}
		const record = validateRecord(parsed, handle, id);
		return record ? { ok: true, record, fromStore: handle.key } : { ok: false, reason: "corrupt" };
	}

	return {
		config,
		storeKey: () => store()?.key,
		recordId: (candidate) => {
			const handle = store();
			return handle ? vaultRecordId(handle.key, candidate) : undefined;
		},
		isStored: (id) => !!store() && RECORD_ID_PATTERN.test(id) && !!open?.ids.has(id),
		usage: () => {
			const handle = store();
			return { bytes: handle?.bytes ?? 0, records: handle?.ids.size ?? 0 };
		},
		hasStoredRecords: () => {
			if (storedSeen) return true;
			const identity = config.enabled ? options.identity() : undefined;
			if (!identity) return false;
			// Never create a store here: an unreadable or absent store simply means nothing is archived.
			const dir = join(storesDir, storeKeyOf(identity));
			if (!isRealDirectory(dir)) return false;
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch {
				return false;
			}
			storedSeen = names.some((name) => RECORD_ID_PATTERN.test(name.slice(0, 64)) && name.endsWith(".json"));
			return storedSeen;
		},
		fault: () => ioFault ?? rootFault,
		put: (candidate) => {
			if (!config.enabled) return { ok: false, reason: "disabled", detail: "tool vault is disabled" };
			const handle = store();
			if (!handle)
				return {
					ok: false,
					reason: "no-store",
					detail: ioFault ?? rootFault ?? "no session identity for this vault",
				};
			const bytes = Buffer.byteLength(candidate.text, "utf8");
			if (bytes > handle.caps.maxRecordBytes)
				return {
					ok: false,
					reason: "record-too-large",
					detail: `${bytes} bytes exceed ${handle.caps.maxRecordBytes}`,
				};
			// Another process may write to this same store, so quota is checked against a listing that
			// is at most one record stale rather than against this process's own counter.
			rereadIfDrifted(handle);
			if (handle.ids.size >= handle.caps.maxRecords)
				return { ok: false, reason: "record-cap", detail: `${handle.ids.size} records at cap` };
			const id = vaultRecordId(handle.key, candidate);
			const record: VaultRecord = {
				version: 1,
				id,
				store: handle.key,
				session: candidate.session,
				tool: candidate.tool,
				toolCallId: candidate.toolCallId,
				arguments: candidate.arguments,
				snapshot: candidate.snapshot,
				metadata: candidate.metadata,
				sha256: sha256(candidate.text),
				bytes,
				storedAt: new Date().toISOString(),
				text: candidate.text,
			};
			const payload = JSON.stringify(record);
			const payloadBytes = Buffer.byteLength(payload, "utf8");
			if (!handle.ids.has(id) && handle.bytes + payloadBytes > handle.caps.maxSessionBytes)
				return {
					ok: false,
					reason: "session-quota",
					detail: `${handle.bytes} + ${payloadBytes} bytes exceed ${handle.caps.maxSessionBytes}`,
				};
			const path = join(handle.dir, `${id}.json`);
			if (existsSync(path)) {
				// Same id means identical bytes; adopt the record another writer created.
				if (!handle.ids.has(id)) {
					try {
						handle.bytes += lstatSync(path).size;
					} catch {
						/* recounted at the next open */
					}
					handle.ids.add(id);
				}
				return { ok: true, id, created: false };
			}
			const temp = join(handle.dir, `.${id}.json.${process.pid}.${handle.ids.size}`);
			let fd: number | undefined;
			try {
				fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
				writeFileSync(fd, payload);
				fsyncSync(fd);
				closeSync(fd);
				fd = undefined;
				renameSync(temp, path);
				fsyncDirectory(handle.dir);
				handle.ids.add(id);
				handle.bytes += payloadBytes;
				return { ok: true, id, created: true };
			} catch (error) {
				if (fd !== undefined)
					try {
						closeSync(fd);
					} catch {
						/* the temp file is removed below */
					}
				try {
					if (existsSync(temp)) unlinkSync(temp);
				} catch {
					/* another writer owns that name */
				}
				ioFault = `cannot write ${path}: ${(error as Error).message}`;
				return { ok: false, reason: "io-error", detail: ioFault };
			}
		},
		lookup: (id) => {
			if (!config.enabled) return { ok: false, reason: "no-vault" };
			if (!RECORD_ID_PATTERN.test(id)) return { ok: false, reason: "invalid-id" };
			const handle = store();
			if (!handle) return { ok: false, reason: "no-vault" };
			const own = readRecord(handle, id);
			if (own.ok) return own;
			if (own.reason !== "not-found") return own;
			// Only a miss costs a lineage walk: session files this one descends from.
			for (const key of lineageKeys(options.sessionFile?.(), config.maxHeaderBytes)) {
				if (key === handle.key) continue;
				const dir = join(storesDir, key);
				if (!isRealDirectory(dir)) continue;
				// An ancestor store carries its own caps; without a readable quota file it is not trusted.
				const caps = readStoreQuota(dir);
				if (!caps) continue;
				const found = readRecord({ key, dir, ids: new Set(), bytes: 0, caps, scannedBytes: 0 }, id);
				if (!found.ok && found.reason !== "not-found") return found;
				if (found.ok) return found;
			}
			return { ok: false, reason: "not-found" };
		},
	};
}

function validateRecord(parsed: unknown, handle: StoreHandle, id: string): VaultRecord | undefined {
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Partial<VaultRecord>;
	if (
		record.version !== 1 ||
		record.id !== id ||
		record.store !== handle.key ||
		typeof record.session !== "string" ||
		typeof record.tool !== "string" ||
		typeof record.toolCallId !== "string" ||
		typeof record.storedAt !== "string" ||
		typeof record.text !== "string" ||
		typeof record.sha256 !== "string" ||
		!RECORD_ID_PATTERN.test(record.sha256) ||
		!Number.isSafeInteger(record.bytes)
	)
		return undefined;
	if (record.bytes !== Buffer.byteLength(record.text, "utf8")) return undefined;
	// The id binds the store and provenance, so re-deriving it catches rewritten provenance too.
	if (record.sha256 !== sha256(record.text)) return undefined;
	// The id binds the store and the provenance, so re-deriving it catches rewritten provenance too.
	const provenance: VaultCandidate = {
		session: record.session,
		tool: record.tool,
		toolCallId: record.toolCallId,
		arguments: record.arguments,
		snapshot: record.snapshot,
		metadata: record.metadata,
		text: record.text,
	};
	if (record.id !== vaultRecordId(handle.key, provenance)) return undefined;
	return record as VaultRecord;
}

/** Whole-line slice of stored text on a 1-based range, capped by bytes. */
export function sliceVaultText(
	text: string,
	range: { offset?: number; limit?: number },
	maxBytes: number,
): {
	text: string;
	firstLine: number;
	lastLine: number;
	totalLines: number;
	stoppedEarly: boolean;
	nextByteOffset?: number;
} {
	const lines = text.split("\n");
	const totalLines = lines.length;
	const first = Math.max(1, Math.floor(range.offset ?? 1));
	const requested = range.limit === undefined ? totalLines : Math.max(0, Math.floor(range.limit));
	if (first > totalLines || requested === 0)
		return { text: "", firstLine: first, lastLine: first - 1, totalLines, stoppedEarly: false };
	let kept = 0;
	let bytes = 0;
	for (let index = first - 1; index < first - 1 + requested && index < totalLines; index++) {
		const cost = Buffer.byteLength(lines[index], "utf8") + (kept > 0 ? 1 : 0);
		if (bytes + cost > maxBytes) break;
		bytes += cost;
		kept++;
	}
	const last = first + kept - 1;
	const stoppedEarly = last < Math.min(totalLines, first - 1 + requested);
	if (kept === 0) {
		// A single line larger than the byte cap must still be reachable, so cut it by bytes.
		const before = Buffer.byteLength(lines.slice(0, first - 1).join("\n"), "utf8") + (first > 1 ? 1 : 0);
		let cut = Buffer.from(text, "utf8").subarray(before, before + maxBytes);
		// A byte cut can split a code point, so back off until the tail is a whole character.
		while (cut.length > 0 && incompleteTail(cut)) cut = cut.subarray(0, cut.length - 1);
		return {
			text: decode(cut),
			firstLine: first,
			lastLine: first - 1,
			totalLines,
			stoppedEarly: true,
			nextByteOffset: before + cut.length,
		};
	}
	return {
		text: lines.slice(first - 1, last).join("\n"),
		firstLine: first,
		lastLine: last,
		totalLines,
		stoppedEarly,
	};
}

/** Exact bounded byte page, refusing offsets inside a UTF-8 character instead of silently skipping bytes. */
export function sliceVaultBytes(
	text: string,
	byteOffset: number,
	maxBytes: number,
): { text: string; nextByteOffset?: number } | undefined {
	const bytes = Buffer.from(text, "utf8");
	if (
		!Number.isSafeInteger(byteOffset) ||
		byteOffset < 0 ||
		byteOffset > bytes.length ||
		(byteOffset < bytes.length && (bytes[byteOffset] & 0xc0) === 0x80)
	)
		return undefined;
	let cut = bytes.subarray(byteOffset, byteOffset + maxBytes);
	while (cut.length > 0 && incompleteTail(cut)) cut = cut.subarray(0, cut.length - 1);
	const next = byteOffset + cut.length;
	return { text: decode(cut), ...(next < bytes.length ? { nextByteOffset: next } : {}) };
}

const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/** Decode bytes that are known to end on a code-point boundary. */
function decode(bytes: Buffer): string {
	return strictDecoder.decode(bytes);
}

/** Whether the buffer ends inside a UTF-8 sequence, which is what decoding would fail on. */
function incompleteTail(bytes: Buffer): boolean {
	try {
		strictDecoder.decode(bytes);
		return false;
	} catch {
		return true;
	}
}
