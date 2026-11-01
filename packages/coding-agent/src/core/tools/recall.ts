/**
 * The `recall_tool_output` tool: returns the exact bytes of one archived tool result from this
 * session's local vault. Ids are validated before any path is built, a record is verified against
 * its own SHA256 before anything is returned, and every failure says what is missing instead of
 * approximating the historical content.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ToolVault } from "../tool-vault.ts";
import { formatRecallResult, TOOL_VAULT_RECALL_TOOL_NAME } from "../tool-vault-projection.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const recallSchema = Type.Object({
	id: Type.String({
		description: "Vault record id from a [Pi vault record ...] reference: 64 lowercase hex characters",
		pattern: "^[a-f0-9]{64}$",
	}),
	offset: Type.Optional(Type.Number({ description: "First archived line to return (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of archived lines to return" })),
	byteOffset: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "Zero-based UTF-8 byte offset for paging a very long line; omit offset and limit when using this",
		}),
	),
});

export type RecallToolInput = Static<typeof recallSchema>;

export interface RecallToolOptions {
	/** Vault the tool reads. It is session-scoped, so another session's records are unreachable. */
	vault: ToolVault;
}

export interface RecallToolDetails {
	piVaultRecall?: { id: string; sha256: string; store: string; bytes: number };
}

export const recallToolSystemPromptContribution = {
	snippet: "Recall the exact archived text of an old tool result",
	guidelines: [
		"Use recall_tool_output with the id from a [Pi vault record ...] reference when you need archived read, grep, find, ls or bash output.",
		"Use offset and limit for line ranges, or byteOffset for a very long line; a fresh tool call reports current state, not historical evidence.",
	],
} as const;

/** Build the recall tool definition. Without a vault there is no definition, so nothing is hidden. */
export function createRecallToolDefinition(
	cwd: string,
	options: RecallToolOptions,
): ToolDefinition<typeof recallSchema, RecallToolDetails | undefined> {
	const vault = options.vault;
	return {
		name: TOOL_VAULT_RECALL_TOOL_NAME,
		defaultActive: false,
		label: "recall",
		description: `Return the exact archived text of one old tool result from this session's local vault. Pass the 64-character id from a "[Pi vault record ...]" reference; optional offset and limit select line ranges (1-indexed lines, capped per call). Archived text is historical evidence: it does not reflect current files, and a missing record is reported instead of guessed. Working directory: ${cwd}`,
		promptSnippet: recallToolSystemPromptContribution.snippet,
		promptGuidelines: [...recallToolSystemPromptContribution.guidelines],
		parameters: recallSchema,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const id = typeof params.id === "string" ? params.id : "";
			const lookup = vault.lookup(id);
			const answer = formatRecallResult(
				lookup,
				id,
				{ offset: params.offset, limit: params.limit, byteOffset: params.byteOffset },
				vault.config.maxRecallBytes,
			);
			if (signal?.aborted) throw new Error("Operation aborted");
			if (answer.isError)
				return {
					content: [{ type: "text" as const, text: answer.text }],
					details: undefined,
					isError: true,
				};
			const found = lookup.ok ? lookup : undefined;
			return {
				content: [{ type: "text" as const, text: answer.text }],
				details: found
					? {
							piVaultRecall: {
								id: found.record.id,
								sha256: found.record.sha256,
								store: found.fromStore,
								bytes: found.record.bytes,
							},
						}
					: undefined,
			};
		},
	};
}

/** Recall tool as an AgentTool, for callers that assemble their own tool list. */
export function createRecallTool(cwd: string, options: RecallToolOptions): AgentTool {
	return wrapToolDefinition(createRecallToolDefinition(cwd, options));
}
