/**
 * Wiring checks: the vault may hide tool output only at the real outgoing request path, only while
 * the recall tool is active, and must keep raw session history and byte-exact retrieval intact
 * across a restart. A scripted in-process provider replaces the model, so nothing reaches a network.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentTools,
	type Model,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { TOOL_VAULT_RECALL_TOOL_NAME } from "../src/core/tool-vault-projection.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const API = "anthropic-messages" as Api;
const REFERENCE = /\[Pi vault record ([a-f0-9]{64})\]/;
/** A 13 KiB read result: above the test archive floor, and unmistakable in a request. */
const FIXTURE = Array.from({ length: 300 }, (_, n) => `fixture line ${n}: the quick brown fox jumps over ${n}`).join(
	"\n",
);
const LINES = FIXTURE.split("\n");

/** One scripted model answer, possibly looking at the request that produced it. */
type Response = AssistantMessage | ((request: string) => AssistantMessage);

let tempDir: string;
let cwd: string;
let agentDir: string;
let vaultDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(realpathSync(tmpdir()), "pi-vault-session-"));
	cwd = join(tempDir, "project");
	agentDir = join(tempDir, "agent");
	vaultDir = join(tempDir, "vault");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(cwd, "big.txt"), FIXTURE);
	writeFileSync(join(cwd, "small.txt"), "small fixture\n");
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

function model(): Model<Api> {
	return {
		id: "vault-model",
		name: "Vault Model",
		api: API,
		provider: "vault-provider",
		baseUrl: "https://vault.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

/** A session whose provider is a scripted queue, capturing the serialized messages of each request. */
async function open(options: {
	settings?: Settings;
	tools?: string[];
	useDefaultTools?: boolean;
	sessionManager?: SessionManager;
	responses: Response[];
}) {
	const requested = model();
	const settings: Settings = {
		retry: { enabled: false },
		toolVault: { enabled: true, dir: vaultDir, minBytes: 2048, keepRecentResults: 1, minUserTurnsOld: 1 },
		...(options.settings ?? {}),
	};
	const settingsManager = SettingsManager.inMemory(settings);
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	await authStorage.modify(requested.provider, async () => ({ type: "api_key", key: "test-api-key" }));
	const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
	const queue = [...options.responses];
	const requests: string[] = [];
	/** Resolve declarations from the actual provider-visible transcript, not merely active tools. */
	const requestTools: string[][] = [];
	modelRegistry.registerProvider(requested.provider, {
		api: requested.api,
		streamSimple: (_model, context) => {
			const request = (context.messages ?? []).map((message) => JSON.stringify(message)).join("\n");
			requests.push(request);
			requestTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
			const next = queue.shift();
			const stream = createAssistantMessageEventStream();
			stream.end(typeof next === "function" ? next(request) : (next ?? assistant("nothing scripted")));
			return stream;
		},
	});
	const created = await createAgentSession({
		cwd,
		agentDir,
		model: requested,
		modelRuntime: getModelRuntime(modelRegistry),
		settingsManager,
		sessionManager: options.sessionManager ?? SessionManager.create(cwd, join(tempDir, "sessions")),
		tools: options.useDefaultTools ? undefined : (options.tools ?? ["read", TOOL_VAULT_RECALL_TOOL_NAME]),
	});
	const { session } = created;
	return {
		session,
		requests,
		requestTools,
		finish: () => {
			session.dispose();
			modelRegistry.unregisterProvider(requested.provider);
		},
	};
}

function assistant(text: string): AssistantMessage {
	return fauxAssistantMessage(text) as AssistantMessage;
}

const readBig = () =>
	fauxAssistantMessage([fauxToolCall("read", { path: join(cwd, "big.txt") }, { id: "call-big" })]) as AssistantMessage;
const readSmall = () =>
	fauxAssistantMessage([
		fauxToolCall("read", { path: join(cwd, "small.txt") }, { id: "call-small" }),
	]) as AssistantMessage;

/**
 * Requests: 0 read big.txt, 1 read small.txt, 2 the answer, 3 the second prompt, 4 the third,
 * 5 the fourth. The first result is age enough to archive from request 4, and request 4 is also the
 * request that writes the record; from request 5 on the recall tool is declared, so that request
 * carries the reference instead of the text.
 */
async function readThenAge(handle: Awaited<ReturnType<typeof open>>, prompts = 4) {
	await handle.session.prompt("read the fixture");
	for (const text of ["what did you see", "keep going", "and now"].slice(0, prompts - 1)) {
		await handle.session.prompt(text);
	}
}

function toolResultText(handle: Awaited<ReturnType<typeof open>>, toolName: string): string {
	const result = handle.session.messages.findLast(
		(message) => message.role === "toolResult" && (message as { toolName?: string }).toolName === toolName,
	) as { content?: { type: string; text?: string }[] } | undefined;
	return (result?.content ?? []).map((block) => block.text ?? "").join("");
}

describe("tool vault in a real session", () => {
	it("activates recall and retires Bash output within one autonomous prompt", async () => {
		const handle = await open({
			useDefaultTools: true,
			settings: { toolVault: { enabled: true, dir: vaultDir } },
			responses: [
				fauxAssistantMessage([
					fauxToolCall("bash", { command: "cat big.txt" }, { id: "bash-big" }),
				]) as AssistantMessage,
				...Array.from(
					{ length: 12 },
					(_, n) =>
						fauxAssistantMessage([
							fauxToolCall("read", { path: join(cwd, "small.txt") }, { id: `small-${n}` }),
						]) as AssistantMessage,
				),
				assistant("finished autonomous work"),
			],
		});
		try {
			expect(handle.session.getActiveToolNames()).not.toContain(TOOL_VAULT_RECALL_TOOL_NAME);
			await handle.session.prompt("inspect the command output, then continue independently");
			expect(handle.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
			expect(handle.requests.slice(0, 12).every((request) => !REFERENCE.test(request))).toBe(true);
			expect(handle.requests[12]).toMatch(REFERENCE);
			expect(handle.requestTools[12]).toContain(TOOL_VAULT_RECALL_TOOL_NAME);
			expect(handle.requests[12]).not.toContain("the quick brown fox jumps over 299");
			expect(toolResultText(handle, "bash")).toBe(FIXTURE);
			handle.requests.forEach((request, index) => {
				if (REFERENCE.test(request)) expect(handle.requestTools[index]).toContain(TOOL_VAULT_RECALL_TOOL_NAME);
			});
		} finally {
			handle.finish();
		}
	});

	it("compacts recent shell results with retirement disabled and keeps canonical output for compaction", async () => {
		const repeated = `${"repeating output line\n".repeat(600)}warning: retain this line\n`;
		writeFileSync(join(cwd, "repeat.txt"), repeated);
		const handle = await open({
			useDefaultTools: true,
			settings: { toolVault: { enabled: true, dir: vaultDir, retireOldResults: false, compactShellOutput: true } },
			responses: [
				fauxAssistantMessage([
					fauxToolCall("bash", { command: "cat repeat.txt" }, { id: "repeat" }),
				]) as AssistantMessage,
				readSmall,
				assistant("done"),
			],
		});
		try {
			await handle.session.prompt("inspect the shell result and then the small file");
			expect(handle.requests[1]).not.toMatch(REFERENCE);
			expect(handle.requests[2]).toContain("omitted duplicate lines=599");
			expect(handle.requests[2]).toContain("warning: retain this line");
			expect(handle.requestTools[2]).toContain(TOOL_VAULT_RECALL_TOOL_NAME);
			expect(toolResultText(handle, "bash")).toBe(repeated);
			const projection = handle.session.sessionManager.buildSessionProjection();
			const canonical = projection.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "bash",
			);
			expect(JSON.stringify(canonical)).toContain("repeating output line");
			expect(JSON.stringify(canonical)).not.toContain("piToolVaultRecord");
		} finally {
			handle.finish();
		}
	});

	it("moves an aged read out of the outgoing request and recalls the exact bytes", async () => {
		const handle = await open({
			responses: [
				readBig,
				readSmall,
				assistant("two reads"),
				assistant("a summary"),
				assistant("still full"),
				(request) => {
					const id = REFERENCE.exec(request)?.[1];
					if (!id) throw new Error("the aged request must carry a vault reference");
					return fauxAssistantMessage([
						fauxToolCall(TOOL_VAULT_RECALL_TOOL_NAME, { id }, { id: "call-recall" }),
					]) as AssistantMessage;
				},
				assistant("recalled it"),
			],
		});
		try {
			// The second prompt's request is old enough to archive, so that is where the record is written.
			await readThenAge(handle, 3);
			// While the result is recent or its turn unanswered, it is sent in full.
			expect(handle.requests[1]).toContain("the quick brown fox jumps over 128");
			expect(handle.requests[2]).not.toMatch(REFERENCE);
			// The request that first archives the result still sends its text, and does not declare the
			// recall tool either: the model gets the tool together with the first reference to it.
			expect(handle.requests[3]).toContain("the quick brown fox jumps over 299");
			expect(handle.requests[3]).not.toMatch(REFERENCE);
			expect(handle.session.getActiveToolNames()).toContain(TOOL_VAULT_RECALL_TOOL_NAME);
			expect(handle.requests[4]).not.toContain("the quick brown fox jumps over 299"); // aged out entirely
			expect(handle.requests[4]).toContain("small fixture"); // the newer result stays in full
			expect(handle.requests[4]).toMatch(REFERENCE);

			// The next run asks for the archived bytes and gets them back into context.
			await handle.session.prompt("and now");
			const answer = toolResultText(handle, TOOL_VAULT_RECALL_TOOL_NAME);
			expect(answer).toContain(FIXTURE); // byte-exact retrieval
			expect(answer).toContain("[Pi vault recall ");
			expect(handle.requests[6]).toContain("fixture line 128"); // retrieved text stays in context
			// Every request that carries a reference must also declare the tool that can read it back.
			expect(
				handle.requestTools.every((names) => names.includes("read")),
				"tool capture must work",
			).toBe(true);
			let referenceRequests = 0;
			handle.requests.forEach((request, index) => {
				const ids = [...request.matchAll(new RegExp(REFERENCE.source, "g"))].map((match) => match[1]);
				if (ids.length === 0) return;
				referenceRequests++;
				expect(handle.requestTools[index], `request ${index} hides text without a recall tool`).toContain(
					TOOL_VAULT_RECALL_TOOL_NAME,
				);
			});
			expect(referenceRequests, "the trace must actually have carried references").toBeGreaterThan(0);
			// Raw session history stays canonical.
			const file = handle.session.sessionManager.getSessionFile();
			expect(file).toBeTruthy();
			expect(readFileSync(file!, "utf8")).toContain("the quick brown fox jumps over 128");
		} finally {
			handle.finish();
		}
	});

	it("is off by default, sending full text and declaring no recall tool", async () => {
		const handle = await open({
			settings: { toolVault: undefined },
			tools: ["read"],
			responses: [
				readBig,
				readSmall,
				assistant("two reads"),
				assistant("a summary"),
				assistant("done"),
				assistant("still done"),
			],
		});
		try {
			await readThenAge(handle, 4);
			expect(handle.requests[5]).toContain("the quick brown fox jumps over 128");
			expect(handle.requests[5]).not.toMatch(REFERENCE);
			expect(handle.session.getActiveToolNames()).not.toContain(TOOL_VAULT_RECALL_TOOL_NAME);
			expect(handle.requests.join("\n")).not.toMatch(REFERENCE);
			expect(existsSync(vaultDir)).toBe(false);
		} finally {
			handle.finish();
		}
	});

	it("hides nothing when the recall tool is excluded from the loadout", async () => {
		const handle = await open({
			tools: ["read"],
			responses: [
				readBig,
				readSmall,
				assistant("two reads"),
				assistant("a summary"),
				assistant("done"),
				assistant("still done"),
			],
		});
		try {
			await readThenAge(handle, 4);
			expect(handle.session.getActiveToolNames()).not.toContain(TOOL_VAULT_RECALL_TOOL_NAME);
			expect(handle.requests[5]).toContain("the quick brown fox jumps over 128");
			expect(handle.requests[5]).not.toMatch(REFERENCE);
			// Refusing to hide also means not writing records the model could never read back.
			expect(existsSync(vaultDir)).toBe(false);
		} finally {
			handle.finish();
		}
	});

	it("keeps originals when a context transform removes the actual recall declaration", async () => {
		const handle = await open({
			responses: [
				readBig,
				readSmall,
				assistant("read"),
				assistant("aged"),
				assistant("still full"),
				assistant("done"),
			],
		});
		const previous = handle.session.agent.transformContext;
		handle.session.agent.transformContext = async (messages, signal) => {
			const transformed = previous ? await previous(messages, signal) : messages;
			return transformed.map((message) =>
				message.role === "system"
					? {
							...message,
							toolsAdded: message.toolsAdded?.filter((tool) => tool.name !== TOOL_VAULT_RECALL_TOOL_NAME),
						}
					: message,
			);
		};
		try {
			await readThenAge(handle, 4);
			expect(handle.session.getActiveToolNames()).toContain(TOOL_VAULT_RECALL_TOOL_NAME);
			expect(handle.requestTools[5]).not.toContain(TOOL_VAULT_RECALL_TOOL_NAME);
			expect(handle.requests[5]).toContain("the quick brown fox jumps over 299");
			expect(handle.requests.join("\n")).not.toMatch(REFERENCE);
		} finally {
			handle.finish();
		}
	});

	it("PI_TOOL_VAULT=0 keeps the full context even when settings enable the vault", async () => {
		vi.stubEnv("PI_TOOL_VAULT", "0");
		const handle = await open({
			tools: ["read"],
			responses: [readBig, readSmall, assistant("two reads"), assistant("a summary"), assistant("done")],
		});
		try {
			await readThenAge(handle, 4);
			expect(handle.requests[5]).toContain("the quick brown fox jumps over 128");
			expect(handle.session.getActiveToolNames()).not.toContain(TOOL_VAULT_RECALL_TOOL_NAME);
		} finally {
			handle.finish();
		}
	});

	it("survives a restart: the same session file resolves its records and recalls a range", async () => {
		const first = await open({
			responses: [
				readBig,
				readSmall,
				assistant("two reads"),
				assistant("a summary"),
				assistant("no tool needed"),
				assistant("still no tool needed"),
			],
		});
		let sessionFile: string | undefined;
		let references: string[] = [];
		try {
			await readThenAge(first, 4);
			sessionFile = first.session.sessionManager.getSessionFile();
			references = [...first.requests[5].matchAll(new RegExp(REFERENCE.source, "g"))].map((match) => match[1]);
			expect(references.length).toBe(1);
		} finally {
			first.finish();
		}
		const reopened = await open({
			sessionManager: SessionManager.open(sessionFile!, join(tempDir, "sessions")),
			responses: [
				(request) => {
					const id = REFERENCE.exec(request)?.[1];
					// The same record id after a restart: the store followed the session file.
					if (!id || id !== references[0]) throw new Error(`expected record ${references[0]}, got ${id}`);
					return fauxAssistantMessage([
						fauxToolCall(TOOL_VAULT_RECALL_TOOL_NAME, { id, offset: 2, limit: 3 }, { id: "call-recall" }),
					]) as AssistantMessage;
				},
				assistant("done"),
			],
		});
		try {
			await reopened.session.prompt("recall the archived range");
			const answer = toolResultText(reopened, TOOL_VAULT_RECALL_TOOL_NAME);
			expect(answer).toContain(LINES[1]);
			expect(answer).toContain(LINES[3]);
			expect(answer).not.toContain(LINES[0]);
			expect(answer).not.toContain(LINES[4]);
			expect(answer).toContain("lines=2-4 of 300");
		} finally {
			reopened.finish();
		}
	});
});
