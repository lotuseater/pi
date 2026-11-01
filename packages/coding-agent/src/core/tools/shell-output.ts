/** Provenance and reversible, mechanical shortening of successful shell output. */
export interface ShellSnapshot {
	version: 1;
	tool: "bash";
	cwd: string;
	/** Original tool-call argument, before command prefixes and spawn hooks. */
	requestedCommand: string;
	/** Command actually passed to the execution backend. */
	command: string;
	exitCode: 0;
	wallTimeSeconds: number;
	/** SHA-256 and UTF-8 bytes of the exact model-visible result text. */
	sha256: string;
	bytes: number;
	complete: boolean;
}

export interface CompactShellOutput {
	text: string;
	omittedLines: number;
	omittedProgressUpdates: number;
}

/** Collapse exact adjacent lines and same-template percentage updates; retain other text. */
export function compactShellOutput(text: string): CompactShellOutput | undefined {
	if (!text) return undefined;
	// Control sequences can encode binary data or cursor movements other than CR.
	// Their interpretation is outside this mechanical text transformation.
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return undefined;
	}
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const parts: string[] = [];
	let omittedLines = 0;
	let omittedProgressUpdates = 0;
	for (let index = 0; index < lines.length; ) {
		const original = lines[index];
		let end = index + 1;
		while (end < lines.length && lines[end] === original) end++;
		const count = end - index;
		const ending = original.endsWith("\r\n") ? "\r\n" : original.endsWith("\n") ? "\n" : "";
		const body = ending ? original.slice(0, -ending.length) : original;
		// CRLF is a line ending. Bare CR alone does not prove progress: mixed warning
		// or other text must survive unless every frame has the same percentage template.
		const progress = compactProgressFrames(body);
		const progressUpdates = progress?.omitted ?? 0;
		const line = progress ? `${progress.text}${ending}` : original;
		const repeated = `${line}[... ${count - 1} repeated lines omitted ...]${ending}`;
		if (count > 1 && Buffer.byteLength(repeated, "utf8") < Buffer.byteLength(line, "utf8") * count) {
			parts.push(repeated);
			omittedLines += count - 1;
			omittedProgressUpdates += progressUpdates;
		} else {
			parts.push(line.repeat(count));
			omittedProgressUpdates += progressUpdates * count;
		}
		index = end;
	}
	const compacted = parts.join("");
	if (Buffer.byteLength(compacted, "utf8") >= Buffer.byteLength(text, "utf8")) return undefined;
	return { text: compacted, omittedLines, omittedProgressUpdates };
}

function compactProgressFrames(body: string): { text: string; omitted: number } | undefined {
	const frames = body.split("\r").filter((frame) => frame.length > 0);
	if (frames.length < 2) return undefined;
	let prefix: string | undefined;
	let suffix: string | undefined;
	let previous = 0;
	for (const frame of frames) {
		const percentages = [...frame.matchAll(/[+-]?\d+(?:\.\d+)?%/g)];
		if (percentages.length !== 1) return undefined;
		const percentage = percentages[0];
		const value = Number(percentage[0].slice(0, -1));
		if (value < previous || value > 100) return undefined;
		const before = frame.slice(0, percentage.index);
		const after = frame.slice(percentage.index + percentage[0].length);
		if (prefix !== undefined && (before !== prefix || after !== suffix)) return undefined;
		prefix = before;
		suffix = after;
		previous = value;
	}
	return { text: frames[frames.length - 1], omitted: frames.length - 1 };
}
