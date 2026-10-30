import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";

/** Explicit launch-time opt-in; durable messages and default tool schemas stay unchanged. */
export const CONTEXT_REFERENCES_ENABLED = process.env.PI_CONTEXT_RESULT_REFERENCES === "1";

export type ReadOnlySnapshot =
	| { version: 1; tool: "read" | "grep"; identity: string }
	| { version: 2; tool: "grep"; identity: string; scope: "tool-result"; partial: boolean };

function canonical(
	value: unknown,
	ancestors = new Set<object>(),
	depth = 0,
	budget = { nodes: 65536, bytes: 1024 * 1024 },
): unknown {
	if (--budget.nodes < 0 || depth > 64) throw new Error("Metadata exceeds validation bounds");
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		budget.bytes -= Buffer.byteLength(value, "utf8");
		if (budget.bytes < 0) throw new Error("Metadata exceeds byte bound");
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "object" || ancestors.has(value)) throw new Error("Non-JSON metadata");
	const array = Array.isArray(value);
	const prototype = Object.getPrototypeOf(value);
	if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
		throw new Error("Non-JSON prototype");
	const keys = Reflect.ownKeys(value);
	if (array && keys.length !== value.length + 1) throw new Error("Sparse or extended array");
	ancestors.add(value);
	try {
		const entries = keys
			.filter((key) => !(array && key === "length"))
			.map((key) => {
				const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
				if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor))
					throw new Error("Non-JSON property");
				budget.bytes -= Buffer.byteLength(key, "utf8");
				if (budget.bytes < 0) throw new Error("Metadata exceeds byte bound");
				return [key, canonical(descriptor.value, ancestors, depth + 1, budget)] as const;
			});
		if (array)
			return entries.map((entry, index) => {
				if (entry[0] !== String(index)) throw new Error("Non-JSON array index");
				return entry[1];
			});
		return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	} finally {
		ancestors.delete(value);
	}
}

/**
 * Rebuild from the actual outgoing history on every projection. No file read is
 * skipped. Originals remain in session storage; a first surviving result is full
 * after compaction/branch/reload. Cache eviction only causes extra full outputs.
 */
export function referenceReadOnlyResults(
	messages: Message[],
	options: { maxEntries?: number; maxBytes?: number; minBytes?: number } = {},
): Message[] {
	const maxEntries = options.maxEntries ?? 32;
	const maxBytes = options.maxBytes ?? 1024 * 1024;
	const minBytes = options.minBytes ?? 1024;
	if (
		!Number.isSafeInteger(maxEntries) ||
		maxEntries < 1 ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		!Number.isSafeInteger(minBytes) ||
		minBytes < 1
	)
		return messages;
	// A caller may project an already projected list. Restore full records first;
	// even a surviving reference can then become full if its anchor was removed.
	const originals = messages.map((message) => {
		if (message.role !== "toolResult") return message;
		const details = message.details as
			| { piContextProjection?: { version: number; originalText: string } }
			| undefined;
		if (details?.piContextProjection?.version !== 1 || typeof details.piContextProjection.originalText !== "string")
			return message;
		const { piContextProjection, ...rest } = details;
		return {
			...message,
			details: rest,
			content: [{ type: "text" as const, text: piContextProjection.originalText }],
		};
	});
	const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
	const snapshots = new Map<string, number>();
	let heldBytes = 0;
	return originals.map((message) => {
		if (message.role === "assistant") {
			if (message.stopReason === "aborted" || message.stopReason === "error" || message.stopReason === "pending")
				return message;
			for (const block of message.content) {
				if (block.type !== "toolCall" || (block.name !== "read" && block.name !== "grep")) continue;
				if (!block.arguments || typeof block.arguments !== "object" || Array.isArray(block.arguments)) continue;
				calls.set(block.id, { name: block.name, args: block.arguments });
				while (calls.size > maxEntries) calls.delete(calls.keys().next().value!);
			}
			return message;
		}
		if (message.role !== "toolResult") return message;
		const call = calls.get(message.toolCallId);
		calls.delete(message.toolCallId);
		if (!call || call.name !== message.toolName || call.args.force === true || message.isError) return message;
		const details = message.details as
			| {
					piReadOnlySnapshot?: ReadOnlySnapshot;
					truncation?: { truncated?: boolean };
					linesTruncated?: boolean;
					matchLimitReached?: number;
			  }
			| undefined;
		const snapshot = details?.piReadOnlySnapshot;
		if (!snapshot || snapshot.tool !== call.name || typeof snapshot.identity !== "string") return message;
		const observedResult =
			snapshot.version === 2 &&
			snapshot.tool === "grep" &&
			snapshot.scope === "tool-result" &&
			typeof snapshot.partial === "boolean";
		if (snapshot.version !== 1 && !observedResult) return message;
		if (!observedResult && (details?.truncation?.truncated || details?.linesTruncated || details?.matchLimitReached))
			return message;
		if (message.content.length !== 1 || message.content[0].type !== "text") return message;
		const text = message.content[0].text;
		const bytes = Buffer.byteLength(text, "utf8");
		if (bytes < minBytes || bytes > maxBytes || maxEntries < 1) return message;
		const args = { ...call.args };
		delete args.force;
		let id: string;
		let entryBytes: number;
		try {
			// Bind all material result details, including exact truncation totals/content.
			const rawDetails = message.details ?? {};
			const prototype = Object.getPrototypeOf(rawDetails);
			if (prototype !== Object.prototype && prototype !== null) return message;
			const material: Record<string, unknown> = Object.create(null);
			for (const key of Reflect.ownKeys(rawDetails)) {
				if (key === "piReadOnlySnapshot" || key === "piContextProjection") continue;
				const descriptor = Object.getOwnPropertyDescriptor(rawDetails, key)!;
				if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) return message;
				material[key] = descriptor.value;
			}
			const materialJson = JSON.stringify(canonical(material));
			entryBytes = bytes + Buffer.byteLength(materialJson, "utf8");
			if (entryBytes > maxBytes) return message;
			const identity = [snapshot.tool, snapshot.identity, canonical(args), text];
			// Preserve existing v1 anchors when there is no additional material metadata.
			if (observedResult || Object.keys(material).length > 0)
				identity.push(canonical(snapshot), canonical(material));
			id = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
		} catch {
			// Extension-added non-JSON metadata must cause a full-result fallback.
			return message;
		}
		const resultLabel = observedResult
			? `grep TOOL RESULT${snapshot.partial ? " (observed portion; limits/notices retained)" : ""}`
			: `${snapshot.tool} result`;
		if (snapshots.has(id)) {
			const size = snapshots.get(id)!;
			snapshots.delete(id);
			snapshots.set(id, size);
			return {
				...message,
				details: { ...(message.details as object), piContextProjection: { version: 1, originalText: text } },
				content: [
					{
						type: "text",
						text: `[Unchanged ${observedResult ? "grep TOOL RESULT (search executed again; unobserved content is not asserted unchanged)" : "read-only result"}; full Pi snapshot ${id} is included earlier in this request. Use force=true to resend full text.]`,
					},
				],
			};
		}
		while (snapshots.size >= maxEntries || heldBytes + entryBytes > maxBytes) {
			const oldest = snapshots.keys().next().value!;
			heldBytes -= snapshots.get(oldest)!;
			snapshots.delete(oldest);
		}
		snapshots.set(id, entryBytes);
		heldBytes += entryBytes;
		return {
			...message,
			details: { ...(message.details as object), piContextProjection: { version: 1, originalText: text } },
			content: [{ type: "text", text: `[Pi snapshot ${id}: full ${resultLabel}]\n${text}` }],
		};
	});
}
