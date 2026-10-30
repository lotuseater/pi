import { createReadStream } from "node:fs";

/** Only the requested numeric keys are retained; length bounds context near EOF. */
export interface GrepContextLines {
	length: number;
	[index: number]: string | undefined;
}

/**
 * Read LF-delimited lines, removing CR as the grep renderer does.
 * Lone CR must not change ripgrep line numbers; cap after CR removal.
 * Memory is one stream chunk plus the requested lines, each capped at maxChars+1
 * so truncateLine can still distinguish an exact-width line from a longer one.
 */
export async function readGrepContextLines(
	filePath: string,
	centers: readonly number[],
	radius: number,
	maxChars: number,
	signal?: AbortSignal,
): Promise<GrepContextLines> {
	signal?.throwIfAborted();
	const ranges = centers
		.map((center) => ({ start: Math.max(1, center - radius), end: center + radius }))
		.sort((a, b) => a.start - b.start);
	const merged: { start: number; end: number }[] = [];
	for (const range of ranges) {
		const previous = merged[merged.length - 1];
		if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
		else merged.push({ ...range });
	}
	const lines: GrepContextLines = { length: 0 };
	if (!merged.length) return lines;
	const lastWanted = merged[merged.length - 1].end;
	let lineNumber = 1;
	let rangeIndex = 0;
	let prefix = "";
	const delimiter = /\n/g;
	const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024, signal });
	try {
		for await (const chunk of stream) {
			signal?.throwIfAborted();
			let position = 0;
			while (position < chunk.length) {
				while (rangeIndex < merged.length && lineNumber > merged[rangeIndex].end) rangeIndex++;
				const wanted = rangeIndex < merged.length && lineNumber >= merged[rangeIndex].start;
				delimiter.lastIndex = position;
				const end = delimiter.exec(chunk)?.index ?? chunk.length;
				if (wanted && prefix.length <= maxChars) {
					const sanitized = chunk.slice(position, end).replace(/\r/g, "");
					prefix += sanitized.slice(0, maxChars + 1 - prefix.length);
				}
				if (end === chunk.length) break;
				if (wanted) lines[lineNumber - 1] = Buffer.from(prefix, "utf16le").toString("utf16le");
				prefix = "";
				lineNumber++;
				lines.length = lineNumber - 1;
				if (lineNumber > lastWanted) return lines;
				position = end + 1;
			}
		}
		while (rangeIndex < merged.length && lineNumber > merged[rangeIndex].end) rangeIndex++;
		if (rangeIndex < merged.length && lineNumber >= merged[rangeIndex].start) {
			lines[lineNumber - 1] = Buffer.from(prefix, "utf16le").toString("utf16le");
		}
		lines.length = lineNumber;
		return lines;
	} finally {
		stream.destroy();
	}
}
