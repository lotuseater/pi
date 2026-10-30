// Verified, bounded single-splice projection for complete text reads; raw history stays unchanged.
import { createHash } from "node:crypto";
export function createReadSplice(base: string, current: string): string | undefined {
	if (base === current || Buffer.byteLength(base) > 51200 || Buffer.byteLength(current) > 51200) return;
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(base + current)) return;
	const a = base.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const b = current.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	if (a.length > 2000 || b.length > 2000) return;
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	)
		suffix++;
	const patch = JSON.stringify({
		startLine: prefix + 1,
		deleteLineCount: a.length - prefix - suffix,
		insertText: b.slice(prefix, b.length - suffix).join(""),
	});
	// Verify the exact emitted representation, including CRLF, surrogate pairs and final LF.
	const decoded = JSON.parse(patch) as { startLine: number; deleteLineCount: number; insertText: string };
	const rebuilt =
		a.slice(0, decoded.startLine - 1).join("") +
		decoded.insertText +
		a.slice(decoded.startLine - 1 + decoded.deleteLineCount).join("");
	if (
		rebuilt !== current ||
		createHash("sha256").update(rebuilt).digest("hex") !== createHash("sha256").update(current).digest("hex")
	)
		return;
	return patch;
}
export function formatReadSplice(
	base: string,
	current: string,
	identity: string,
	baseSnapshotId: string,
	observation: number,
): string | undefined {
	const patch = createReadSplice(base, current);
	if (!patch) return;
	const hash = (text: string) => createHash("sha256").update(text).digest("hex");
	const result = `[Pi read delta v1: NEWER complete file observation ${observation}; path=${JSON.stringify(identity)}; range=entire file. Exact full base snapshot ${baseSnapshotId} is included earlier in this request. Base SHA256=${hash(base)}; current SHA256=${hash(current)}. Apply this ONE line splice to that full base, never to another delta. startLine is 1-indexed; deleteLineCount counts LF-delimited base lines including their original line endings; insertText is an exact JSON string (decode escapes once). Zero deletions inserts before startLine. All unchanged lines remain from base. Use force=true to resend full current text.]\n${patch}`;
	// Conservative profitability gate includes the whole instruction, not just edit bytes.
	if (Buffer.byteLength(JSON.stringify(result)) + 512 >= Buffer.byteLength(JSON.stringify(current)) * 0.8) return;
	return result;
}
