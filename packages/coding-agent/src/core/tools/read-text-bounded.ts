import { open } from "node:fs/promises";
import { DEFAULT_MAX_BYTES, truncateHead, type TruncationResult } from "./truncate.ts";

/** Scan the complete file for exact totals, retaining only enough text for truncateHead. */
export async function readTextBounded(
	filePath: string,
	startLine: number,
	limit: number | undefined,
	signal?: AbortSignal,
): Promise<{
	totalFileLines: number;
	firstLineBytes: number;
	userLimitedLines: number | undefined;
	truncation: TruncationResult;
}> {
	// Two extra code units distinguish a full first line followed by another line
	// from a final newline. UTF-8 decoding is identical to Buffer.toString(), even
	// for malformed sequences straddling chunks. CR is deliberately unchanged.
	const prefixLimit = DEFAULT_MAX_BYTES + 2;
	const parts: string[] = [];
	let prefixLength = 0;
	let line = 0;
	let totalBytes = 0;
	let firstLineBytes = 0;
	let lastLineBytes = 0;
	const endLine = limit === undefined ? Infinity : startLine + limit;
	const append = (text: string) => {
		if (prefixLength < prefixLimit) {
			const part = text.slice(0, prefixLimit - prefixLength);
			parts.push(part);
			prefixLength += part.length;
		}
	};
	const file = await open(filePath, "r");
	try {
		const { size } = await file.stat();
		async function* chunks() {
			// Delegate Node's oversized-file error (and any concurrent shrink) to
			// the original read operation instead of silently accepting new inputs.
			if (size > 0x7fffffff) {
				yield (await file.readFile()).toString("utf8");
				return;
			}
			// Like readFile on a known-size regular file, exclude bytes appended
			// after this descriptor's stat. Empty/virtual files still read to EOF.
			if (signal?.aborted) throw new Error("Operation aborted");
			const stream = file.createReadStream({
				encoding: "utf8",
				highWaterMark: 64 * 1024,
				autoClose: false,
				end: size > 0 ? size - 1 : undefined,
				signal,
			});
			try {
				yield* stream;
			} finally {
				stream.destroy();
			}
		}
		for await (const chunk of chunks()) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const text = chunk as string;
			let from = 0;
			while (from < text.length) {
				const newline = text.indexOf("\n", from);
				const to = newline < 0 ? text.length : newline;
				if (line >= startLine && line < endLine) {
					const segment = text.slice(from, to);
					const bytes = Buffer.byteLength(segment, "utf8");
					totalBytes += bytes;
					lastLineBytes += bytes;
					if (line === startLine) firstLineBytes += bytes;
					append(segment);
					if (newline >= 0 && line + 1 < endLine) {
						totalBytes++;
						append("\n");
						lastLineBytes = 0;
					}
				}
				if (newline < 0) break;
				line++;
				from = newline + 1;
			}
		}
	} finally {
		await file.close();
	}
	if (signal?.aborted) throw new Error("Operation aborted");
	const totalFileLines = line + 1;
	const selectedLines = Math.max(0, Math.min(endLine, totalFileLines) - startLine);
	const totalLines = selectedLines - (selectedLines > 0 && lastLineBytes === 0 ? 1 : 0);
	const truncation = truncateHead(parts.join(""));
	truncation.totalBytes = totalBytes;
	truncation.totalLines = totalLines;
	return {
		totalFileLines,
		firstLineBytes,
		userLimitedLines: limit === undefined ? undefined : Math.min(endLine, totalFileLines) - startLine,
		truncation,
	};
}
