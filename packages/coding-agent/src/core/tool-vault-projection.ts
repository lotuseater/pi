/**
 * Outgoing-context projection that replaces old, archived read-only tool output with a
 * retrieval reference.
 *
 * The vault holds the exact bytes; this file decides what may be hidden. Eligibility is
 * deterministic and conservative: only successful, text-only results of builtin read, grep,
 * find, ls and bash tools, with reliable provenance, and only when the recall tool
 * is actually available to the model. Every refusal, error and uncertainty leaves the full text
 * in the request, and raw session history is never rewritten.
 *
 * It runs on the conversation before `convertToLlm`, so it sees the same messages the session
 * stores and works whether or not the exact-reference projection is enabled: that layer dedupes
 * results inside one request, this layer retires results that have aged out of the conversation.
 * The message list may hold coding-agent custom roles, which simply never match a tool result.
 */

import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { canonicalToolMetadata, type ReadOnlySnapshot } from "./context-references.ts";
import { sliceVaultBytes, sliceVaultText, type ToolVault, type VaultLookup } from "./tool-vault.ts";
import { compactShellOutput, type ShellSnapshot } from "./tools/shell-output.ts";

/** Name of the local tool the model uses to read archived bytes back. */
export const TOOL_VAULT_RECALL_TOOL_NAME = "recall_tool_output";

/** Only these builtin tools produce archivable results, and only with their own metadata. */
const ARCHIVABLE_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);

/** Detail keys those tools are known to write. Any other key means custom metadata: no archiving. */
const KNOWN_DETAIL_KEYS = new Set([
	"piReadOnlySnapshot",
	"piToolVaultRecord",
	"piShellSnapshot",
	"fullOutputPath",
	"truncation",
	"matchLimitReached",
	"linesTruncated",
	"resultLimitReached",
	"entryLimitReached",
]);

/** Tool calls kept while scanning, so an old result whose call aged out simply stays full. */
const MAX_PAIRED_CALLS = 512;

/** Argument echoes are bounded so a long search pattern cannot outgrow the reference it replaces. */
const MAX_ARGUMENTS_ECHO_BYTES = 512;

export interface VaultProjectionOptions {
	vault: ToolVault;
	/** The model must be able to call the recall tool, otherwise nothing is hidden. */
	recallAvailable: boolean;
	/** The recall tool must at least be reachable in this session, otherwise nothing is archived. */
	archiveAllowed: boolean;
	/** Session id recorded in each record for provenance. */
	sessionId: string;
}

/** A message as the projection reads it: only the tool-result fields, everything else is copied through. */
type ResultMessage = Message & { role: "toolResult" };

interface Provenance {
	tool: string;
	toolCallId: string;
	arguments: unknown;
	snapshot: unknown;
	metadata: unknown;
}

interface PairedCall {
	name: string;
	arguments: Record<string, unknown>;
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Provenance of an archivable result, or undefined when that result must stay full. A missing
 * snapshot marker, an error, a non-text block, custom metadata or an unpaired call all refuse.
 */
function archivableProvenance(
	message: ResultMessage,
	calls: Map<string, PairedCall>,
	digest: string,
	bytes: number,
): Provenance | undefined {
	if (message.role !== "toolResult" || message.isError) return undefined;
	if (!ARCHIVABLE_TOOLS.has(message.toolName)) return undefined;
	if (message.content.length !== 1 || message.content[0].type !== "text") return undefined;
	const details = message.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	// A result that already carries a projection marker is the output of another context layer.
	if (
		(details as { piContextProjection?: unknown; piToolVaultRecord?: unknown }).piContextProjection !== undefined ||
		(details as { piToolVaultRecord?: unknown }).piToolVaultRecord !== undefined
	)
		return undefined;
	for (const key of Reflect.ownKeys(details)) {
		if (typeof key !== "string" || !KNOWN_DETAIL_KEYS.has(key)) return undefined;
	}
	const call = calls.get(message.toolCallId);
	if (!call || call.name !== message.toolName || call.arguments.force === true) return undefined;
	const args = call.arguments;
	let snapshot: ReadOnlySnapshot | ShellSnapshot;
	if (message.toolName === "bash") {
		const shell = (details as { piShellSnapshot?: ShellSnapshot }).piShellSnapshot;
		if (
			!shell ||
			shell.version !== 1 ||
			shell.tool !== "bash" ||
			shell.exitCode !== 0 ||
			shell.complete !== true ||
			typeof shell.cwd !== "string" ||
			typeof shell.command !== "string" ||
			typeof args.command !== "string" ||
			shell.requestedCommand !== args.command ||
			!Number.isFinite(shell.wallTimeSeconds) ||
			shell.wallTimeSeconds < 0 ||
			shell.sha256 !== digest ||
			shell.bytes !== bytes
		)
			return undefined;
		snapshot = shell;
	} else {
		const read = (details as { piReadOnlySnapshot?: ReadOnlySnapshot }).piReadOnlySnapshot;
		if (
			!read ||
			typeof read !== "object" ||
			read.tool !== message.toolName ||
			typeof read.identity !== "string" ||
			(read.version !== 1 && read.version !== 2)
		)
			return undefined;
		snapshot = read;
	}
	const metadata: Record<string, unknown> = Object.create(null);
	for (const [key, value] of Object.entries(details)) {
		if (key === "piReadOnlySnapshot" || key === "piShellSnapshot" || key === "piToolVaultRecord") continue;
		metadata[key] = value;
	}
	return {
		tool: message.toolName,
		toolCallId: message.toolCallId,
		arguments: canonicalToolMetadata(args),
		snapshot: canonicalToolMetadata(snapshot),
		metadata: canonicalToolMetadata(metadata),
	};
}

/**
 * Calls paired to results, keyed by call id. A call from an assistant message that errored, was
 * aborted or is pending is not trusted, so its result is never hidden.
 */
function collectCalls(messages: readonly { role: string }[]): Map<string, PairedCall> {
	const calls = new Map<string, PairedCall>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		// Only the stop reason and content blocks are read from an assistant message.
		const assistant = message as unknown as Extract<Message, { role: "assistant" }>;
		if (assistant.stopReason !== "stop" && assistant.stopReason !== "toolUse") continue;
		for (const block of assistant.content) {
			if (block.type !== "toolCall" || !ARCHIVABLE_TOOLS.has(block.name)) continue;
			if (!block.arguments || typeof block.arguments !== "object" || Array.isArray(block.arguments)) continue;
			calls.set(block.id, { name: block.name, arguments: block.arguments as Record<string, unknown> });
			while (calls.size > MAX_PAIRED_CALLS) calls.delete(calls.keys().next().value as string);
		}
	}
	return calls;
}

/**
 * Per index: how many tool results and how many answered user turns come later. Answered means a
 * user message that an assistant message follows, which is what makes a turn complete. Custom
 * coding-agent roles are not counted as user turns, which only ever keeps a result full longer.
 */
function measureAge(messages: readonly { role: string }[]): {
	laterResults: number[];
	laterTurns: number[];
	laterAssistantTurns: number[];
} {
	const laterResults = new Array<number>(messages.length).fill(0);
	const laterTurns = new Array<number>(messages.length).fill(0);
	const laterAssistantTurns = new Array<number>(messages.length).fill(0);
	let results = 0;
	let turns = 0;
	let assistantTurns = 0;
	const resultIds = new Set<string>();
	let answered = false;
	for (let index = messages.length - 1; index >= 0; index--) {
		laterResults[index] = results;
		laterTurns[index] = turns;
		laterAssistantTurns[index] = assistantTurns;
		const message = messages[index];
		if (message.role === "toolResult") {
			results++;
			resultIds.add((message as ResultMessage).toolCallId);
		}
		if (message.role === "assistant") {
			const assistant = message as Extract<Message, { role: "assistant" }>;
			if (assistant.stopReason === "stop" || assistant.stopReason === "toolUse") {
				const complete = assistant.content.every((block) => block.type !== "toolCall" || resultIds.has(block.id));
				if (complete) {
					assistantTurns++;
					answered = true;
				}
			}
		}
		if (message.role === "user") {
			if (answered) turns++;
			answered = false;
		}
	}
	return { laterResults, laterTurns, laterAssistantTurns };
}

function referenceText(id: string, digest: string, bytes: number, provenance: Provenance, text: string): string {
	const argumentJson = JSON.stringify(provenance.arguments);
	const echo =
		Buffer.byteLength(argumentJson, "utf8") <= MAX_ARGUMENTS_ECHO_BYTES
			? ` arguments=${argumentJson}`
			: " arguments=(too long to echo)";
	return [
		`[Pi vault record ${id}]`,
		`Exact ${provenance.tool} tool output archived locally and still retrievable; it was not deleted or summarized.`,
		`call=${provenance.toolCallId} sha256=${digest} bytes=${bytes} lines=${text.split("\n").length}${echo}`,
		`Retrieve the exact bytes with the ${TOOL_VAULT_RECALL_TOOL_NAME} tool as {"id":"${id}"}; offset and limit select line ranges.`,
		"These archived bytes are the historical evidence. Re-running the tool reports current state, which is different evidence.",
	].join("\n");
}

/**
 * Archive eligible results and replace them with vault references. Bytes are durable before a
 * reference is emitted, so a reference never names something that was not written, and a reference
 * only appears in a request that already declares the recall tool: the request that first archives
 * a result still sends its full text, and the reference follows once the model can read it back.
 * Idempotent, and the digest of a message is computed once per message object.
 */
const digestByMessage = new WeakMap<object, { text: string; digest: string }>();

export function vaultReadOnlyResults<T extends { role: string }>(
	messages: readonly T[],
	options: VaultProjectionOptions,
): T[] {
	const vault = options.vault;
	if (
		!vault.config.enabled ||
		!options.archiveAllowed ||
		(!vault.config.retireOldResults && !vault.config.compactShellOutput)
	)
		return messages as T[];
	const calls = collectCalls(messages);
	const age = measureAge(messages);
	const projected = messages.slice();
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role !== "toolResult") continue;
		const retire =
			vault.config.retireOldResults &&
			age.laterResults[index] >= vault.config.keepRecentResults &&
			age.laterTurns[index] >= vault.config.minUserTurnsOld &&
			age.laterAssistantTurns[index] >= vault.config.minAssistantTurnsOld;
		// Only the tool-result fields are read, and only after the role check above.
		const message = messages[index] as unknown as ResultMessage;
		if (message.isError || !ARCHIVABLE_TOOLS.has(message.toolName)) continue;
		if (!retire && !(vault.config.compactShellOutput && message.toolName === "bash")) continue;
		const block = message.content[0];
		if (message.content.length !== 1 || block.type !== "text" || block.text.includes("\0")) continue;
		const bytes = Buffer.byteLength(block.text, "utf8");
		if (bytes < vault.config.minBytes || bytes > vault.config.maxRecordBytes) continue;
		const cached = digestByMessage.get(message);
		let digest = cached?.text === block.text ? cached.digest : undefined;
		if (digest === undefined) {
			digest = sha256(block.text);
			digestByMessage.set(message, { text: block.text, digest });
		}
		let provenance: Provenance | undefined;
		try {
			provenance = archivableProvenance(message, calls, digest, bytes);
		} catch {
			// Oversize or non-JSON provenance must not turn a context optimization into a failed request.
			continue;
		}
		if (!provenance) continue;
		const compact = retire ? undefined : compactShellOutput(block.text);
		if (!retire && !compact) continue;
		const entry = { session: options.sessionId, ...provenance, text: block.text };
		// A reference may only name durable bytes: derive the id, then write the record when this
		// process has not written it yet. Any refusal keeps the full text in the request.
		const id = vault.recordId(entry);
		if (id === undefined) continue;
		let replacement = referenceText(id, digest, bytes, provenance, block.text);
		if (compact) {
			const shell = provenance.snapshot as ShellSnapshot;
			replacement += `\nShell result: exit=${shell.exitCode} elapsed=${shell.wallTimeSeconds}s; omitted duplicate lines=${compact.omittedLines}, progress updates=${compact.omittedProgressUpdates}.\n${compact.text}`;
		}
		if (Buffer.byteLength(replacement, "utf8") >= bytes) continue;
		if (!vault.isStored(id) && !vault.put(entry).ok) continue;
		// While the recall tool is not declared, the archived bytes stay visible. The next run starts
		// with the tool active (see AgentSession's activation check), and this result is then replaced.
		if (!options.recallAvailable) continue;
		// A cached id is not proof that external cleanup has left readable, uncorrupted bytes.
		// Recheck before every reference so failures fall back to the canonical full result.
		if (!vault.lookup(id).ok) continue;
		projected[index] = {
			...message,
			details: {
				...(message.details as object),
				piToolVaultRecord: { version: 1, id, sha256: digest, projection: compact ? "shell" : "retired" },
			},
			content: [{ type: "text", text: replacement }],
		} as unknown as T; // same message with two fields replaced; T is the caller's message type
	}
	return projected;
}

/** Format a recall answer or the exact reason nothing was returned. Never invents content. */
export function formatRecallResult(
	lookup: VaultLookup,
	id: string,
	range: { offset?: number; limit?: number; byteOffset?: number },
	maxRecallBytes: number,
): { text: string; isError: boolean } {
	if (!lookup.ok) return { text: refusalText(id, lookup.reason), isError: true };
	const record = lookup.record;
	if (range.byteOffset !== undefined) {
		if (range.offset !== undefined || range.limit !== undefined) {
			return {
				text: "Use byteOffset alone, or offset and limit for lines; do not combine byte and line ranges.",
				isError: true,
			};
		}
		const page = sliceVaultBytes(record.text, range.byteOffset, maxRecallBytes);
		if (!page)
			return {
				text: "byteOffset must be an integer within the archived UTF-8 text, at a character boundary.",
				isError: true,
			};
		const next = page.nextByteOffset === undefined ? "end of record" : `nextByteOffset=${page.nextByteOffset}`;
		return {
			text: `[Pi vault recall ${record.id}]\nsha256=${record.sha256} bytes=${record.bytes} tool=${record.tool} call=${record.toolCallId}\nbyteOffset=${range.byteOffset} returnedBytes=${Buffer.byteLength(page.text, "utf8")} ${next}\nExact archived bytes. A fresh tool call would report current state instead.\n${page.text}`,
			isError: false,
		};
	}
	const slice = sliceVaultText(record.text, range, maxRecallBytes);
	const rangeLabel =
		slice.lastLine >= slice.firstLine
			? `lines=${slice.firstLine}-${slice.lastLine} of ${slice.totalLines}`
			: `lines=(none)`;
	const header = [
		`[Pi vault recall ${record.id}]`,
		`sha256=${record.sha256} bytes=${record.bytes} tool=${record.tool} call=${record.toolCallId} stored=${record.storedAt}`,
		`arguments=${JSON.stringify(record.arguments)} ${rangeLabel}${
			slice.stoppedEarly
				? slice.nextByteOffset === undefined
					? ` (recall offset=${slice.lastLine + 1} for more lines)`
					: ` (partial line; continue with byteOffset=${slice.nextByteOffset}, omitting offset and limit)`
				: ""
		}`,
		"Exact archived bytes. A fresh tool call would report current state instead.",
	].join("\n");
	return { text: `${header}\n${slice.text}`, isError: false };
}

const REFUSALS: Record<string, string> = {
	"invalid-id": "is not a 64-character lowercase hex vault record id, so nothing was read",
	"not-found":
		"has no record in this session's vault: it may belong to another session, or that output was never archived. No historical bytes are available",
	corrupt: "exists but failed SHA256 verification, so its content cannot be trusted or returned",
	oversize: "is larger than the vault allows for one record, so it is not returned",
	unreadable: "cannot be read from disk, so nothing was returned",
	"unsafe-path": "is not a readable regular record, so nothing was read",
	"no-vault": "cannot be read: the tool vault is disabled or has no store for this session",
};

function refusalText(id: string, reason: string): string {
	return `Vault record ${id} ${REFUSALS[reason] ?? "is unavailable"}. Nothing was invented; re-run the original tool only if current state is what you need.`;
}
