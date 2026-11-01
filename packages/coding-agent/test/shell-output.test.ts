import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { type BashToolDetails, createBashTool } from "../src/core/tools/bash.ts";
import { createPowerShellTool } from "../src/core/tools/powershell.ts";
import { compactShellOutput } from "../src/core/tools/shell-output.ts";

describe("compactShellOutput", () => {
	it("collapses consecutive exact repeated lines with an explicit count", () => {
		const line = "compiled source with all checks passing\n";
		const result = compactShellOutput(line.repeat(20));
		expect(result).toEqual({
			text: `${line}[... 19 repeated lines omitted ...]\n`,
			omittedLines: 19,
			omittedProgressUpdates: 0,
		});
	});

	it("retains unique warnings and separated repeated runs in order", () => {
		const line = "compiled source with all checks passing\n";
		const input = `${line.repeat(20)}warning: first diagnostic\n${line.repeat(10)}warning: final diagnostic\n`;
		const result = compactShellOutput(input);
		expect(result?.text).toBe(
			`${line}[... 19 repeated lines omitted ...]\nwarning: first diagnostic\n${line}[... 9 repeated lines omitted ...]\nwarning: final diagnostic\n`,
		);
		expect(result?.omittedLines).toBe(28);
	});

	it("retains the last carriage-return frame and newline-delimited diagnostics", () => {
		const result = compactShellOutput("warning: keep this\nprogress 10%\rprogress 50%\rprogress 100%\ndone\n");
		expect(result).toEqual({
			text: "warning: keep this\nprogress 100%\ndone\n",
			omittedLines: 0,
			omittedProgressUpdates: 2,
		});
	});

	it("does not mistake CRLF line endings for progress updates", () => {
		expect(compactShellOutput("first\r\nsecond\r\nthird\r\n")).toBeUndefined();
		const line = "a repeated Windows line with enough detail\r\n";
		expect(compactShellOutput(line.repeat(10))).toEqual({
			text: `${line}[... 9 repeated lines omitted ...]\r\n`,
			omittedLines: 9,
			omittedProgressUpdates: 0,
		});
	});

	it("handles progress followed by CRLF and a trailing cursor return", () => {
		expect(compactShellOutput("10%\r20%\r100%\r\n")).toEqual({
			text: "100%\r\n",
			omittedLines: 0,
			omittedProgressUpdates: 2,
		});
		expect(compactShellOutput("10%\r20%\r100%\r")?.text).toBe("100%");
		expect(compactShellOutput("single frame\r")).toBeUndefined();
	});

	it("preserves mixed warnings, unknown frames, changed templates, and invalid or resetting percentages", () => {
		for (const input of [
			"warning: important\rok\n",
			"progress 10%\rwarning: important\rprogress 100%\n",
			"processing\rfinished\n",
			"files 10%\rtests 50%\n",
			"step 10% (1%)\rstep 20% (2%)\n",
			"-10%\r100%\n",
			"10%\r120%\n",
			"100%\r10%\n",
		]) {
			expect(compactShellOutput(input)).toBeUndefined();
		}
	});

	it("preserves Unicode and compares UTF-8 sizes", () => {
		const line = "Перевірено збірку 🛠 без помилок\n";
		const result = compactShellOutput(`${line.repeat(10)}попередження: зберегти\n`);
		expect(result?.text).toBe(`${line}[... 9 repeated lines omitted ...]\nпопередження: зберегти\n`);
		expect(result?.omittedLines).toBe(9);
	});

	it("passes through empty, short, unique, binary, and nonconsecutive repeated output", () => {
		for (const input of ["", "ok\n", "x\nx\n", "a\nb\na\n", "a\0\na\0\n".repeat(30), "a\x01\n".repeat(30)]) {
			expect(compactShellOutput(input)).toBeUndefined();
		}
	});

	it("retains nonmatching whitespace and an unterminated final line", () => {
		const line = "a sufficiently long repeated diagnostic\n";
		const result = compactShellOutput(`${line.repeat(10)} same\nsame\nsame \nfinal`);
		expect(result?.text.endsWith(" same\nsame\nsame \nfinal")).toBe(true);
	});

	it("counts progress only within retained lines when whole lines are omitted", () => {
		const line = "processing the first large item 10%\rprocessing the first large item 100%\n";
		const result = compactShellOutput(line.repeat(10));
		expect(result).toEqual({
			text: "processing the first large item 100%\n[... 9 repeated lines omitted ...]\n",
			omittedLines: 9,
			omittedProgressUpdates: 1,
		});
	});

	it("can collapse duplicate whole lines while retaining unknown CR frames verbatim", () => {
		const line = "processing the first large item\rfinished processing the first large item\n";
		expect(compactShellOutput(line.repeat(10))).toEqual({
			text: `${line}[... 9 repeated lines omitted ...]\n`,
			omittedLines: 9,
			omittedProgressUpdates: 0,
		});
	});
});

describe("Bash shell provenance", () => {
	it("records exact text, resolved command and cwd without changing visible or programmatic output", async () => {
		const raw = "перевірка 🛠\n".repeat(12);
		let executedCommand: string | undefined;
		let executedCwd: string | undefined;
		let updateText: string | undefined;
		const tool = createBashTool("/initial", {
			commandPrefix: "prefix",
			spawnHook: (context) => ({ ...context, command: `${context.command}\nhook`, cwd: "/resolved" }),
			operations: {
				exec: async (command, cwd, { onData }) => {
					executedCommand = command;
					executedCwd = cwd;
					onData(Buffer.from(raw));
					return { exitCode: 0 };
				},
			},
		});
		const result = await tool.execute("snapshot", { command: "requested" }, undefined, (update) => {
			updateText = update.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		});
		const details = result.details as BashToolDetails;
		expect(result.content).toEqual([{ type: "text", text: raw }]);
		expect(updateText).toBe(raw);
		expect(executedCommand).toBe("prefix\nrequested\nhook");
		expect(executedCwd).toBe("/resolved");
		expect(details.piShellSnapshot).toEqual({
			version: 1,
			tool: "bash",
			cwd: "/resolved",
			requestedCommand: "requested",
			command: executedCommand,
			exitCode: 0,
			wallTimeSeconds: expect.any(Number),
			sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
			bytes: Buffer.byteLength(raw, "utf8"),
			complete: true,
		});
		expect(result.structuredContent).toEqual({
			output: raw,
			truncated: false,
			exit_code: 0,
			wall_time_seconds: details.piShellSnapshot?.wallTimeSeconds,
		});
	});

	it("hashes the existing empty-output placeholder while preserving structured empty output", async () => {
		const tool = createBashTool("/unused", { operations: { exec: async () => ({ exitCode: 0 }) } });
		const result = await tool.execute("empty", { command: "empty" });
		expect(result.content).toEqual([{ type: "text", text: "(no output)" }]);
		expect((result.details as BashToolDetails).piShellSnapshot?.sha256).toBe(
			createHash("sha256").update("(no output)").digest("hex"),
		);
		expect(result.structuredContent).toMatchObject({ output: "", truncated: false, exit_code: 0 });
	});

	it("marks truncated model output incomplete while preserving full structured output and its file", async () => {
		const raw = "a line of raw output\n".repeat(2100);
		const tool = createBashTool("/unused", {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from(raw));
					return { exitCode: 0 };
				},
			},
		});
		const result = await tool.execute("truncated", { command: "large" });
		const details = result.details as BashToolDetails;
		try {
			const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			expect(details.piShellSnapshot?.complete).toBe(false);
			expect(details.piShellSnapshot?.sha256).toBe(createHash("sha256").update(text).digest("hex"));
			expect(details.piShellSnapshot?.bytes).toBe(Buffer.byteLength(text));
			expect(details.truncation?.truncated).toBe(true);
			expect(result.structuredContent).toMatchObject({ output: raw, truncated: false, exit_code: 0 });
			expect(await readFile(details.fullOutputPath!, "utf8")).toBe(raw);
		} finally {
			if (details.fullOutputPath) await rm(details.fullOutputPath);
		}
	});

	it("does not stamp failed results or change failure diagnostics and structured content", async () => {
		const tool = createBashTool("/unused", {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("warning\nfailure detail\n"));
					return { exitCode: 7 };
				},
			},
		});
		const result = await tool.execute("failed", { command: "fails" });
		expect(result.content).toEqual([
			{ type: "text", text: "warning\nfailure detail\n\n\nCommand exited with code 7" },
		]);
		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			output: "warning\nfailure detail\n",
			truncated: false,
			exit_code: 7,
		});
	});

	it.each([
		["aborted", "Command aborted"],
		["timeout:2", "Command timed out after 2 seconds"],
	])("preserves %s errors", async (failure, status) => {
		const tool = createBashTool("/unused", {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("partial output"));
					throw new Error(failure);
				},
			},
		});
		await expect(tool.execute("interrupted", { command: "interrupted" })).rejects.toThrow(
			`partial output\n\n${status}`,
		);
	});

	it("does not label another shell's output as builtin Bash", async () => {
		const tool = createPowerShellTool("/unused", { operations: { exec: async () => ({ exitCode: 0 }) } });
		const result = await tool.execute("powershell", { command: "Write-Output" });
		expect(result.details).toBeUndefined();
	});
});
