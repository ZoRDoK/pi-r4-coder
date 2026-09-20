/**
 * R4 Coder Provider Tests
 *
 * Two kinds of tests:
 *   A) Extension unit tests — verify the extension factory registers a provider,
 *      refreshes models in the background and maintains the disk cache
 *      (no live API calls).
 *   B) API integration tests — hit the live R4 Coder endpoint (--all flag).
 *
 * Run unit tests:    node --experimental-strip-types --no-warnings test.ts
 * Run all tests:     node --experimental-strip-types --no-warnings test.ts --all
 *
 * API key lookup order:
 *   1) R4_API_KEY env var
 *   2) ~/.pi/agent/auth.json -> r4.key
 *
 * Integration tests (group B) require a valid API key and count as live API usage.
 * They are skipped unless --all is passed. Total ≤ ~6 requests per run.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CapturedRegistration {
	provider: string;
	config: Record<string, unknown>;
}

function makeMockPi(capture: CapturedRegistration[]) {
	return {
		registerProvider(provider: string, config: unknown) {
			capture.push({ provider, config: config as Record<string, unknown> });
		},
	} as Parameters<typeof import("./index.ts").default>[0];
}

function liveModelsFixture() {
	return {
		data: [
			{
				id: "deepseek-v4.1-flash",
				display_name: "DeepSeek V4.1 Flash",
				context_window: 1048576,
				effort: { tiers: ["low", "high", "max", "medium", "xhigh", "minimal"], default: "max" },
				pricing: {
					input_per_m_tokens: "0.3000",
					output_per_m_tokens: "1.2000",
					cache_read_per_m_tokens: "0.0060",
					cache_creation_per_m_tokens: "0.0000",
				},
			},
			{
				id: "qwen3.8-27b",
				display_name: "Qwen 3.8 27B",
				context_window: 262144,
				pricing: {
					input_per_m_tokens: "0.4000",
					output_per_m_tokens: "3.0000",
					cache_read_per_m_tokens: "0.1500",
					cache_creation_per_m_tokens: "0.0000",
				},
			},
		],
	};
}

// ---------------------------------------------------------------------------
// A) Extension factory tests (no live API calls)
// ---------------------------------------------------------------------------

async function testExtensionFactory(): Promise<void> {
	console.log("\n--- [A1] Extension factory registers provider, refreshes live, caches ---");

	const home = await mkdtemp(path.join(os.tmpdir(), "pi-r4-home-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;

	const cacheFile = path.join(home, ".pi", "agent", "cache", "pi-r4-coder", "models.json");

	const origFetch = globalThis.fetch;
	let capturedAuthHeader: string | undefined;
	process.env.R4_API_KEY = "coder_test_fixture";
	globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
		const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
		if (urlStr === "https://api.r4.codes/v1/models") {
			const headers = init?.headers as Record<string, string> | undefined;
			capturedAuthHeader = headers?.Authorization;
			return new Response(JSON.stringify(liveModelsFixture()), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		throw new Error(`Unexpected fetch: ${urlStr}`);
	}) as typeof fetch;

	const capture: CapturedRegistration[] = [];

	try {
		const mod = await import("./index.ts");
		await mod.default(makeMockPi(capture));
		// Let the background refresh complete.
		await sleep(150);
	} finally {
		globalThis.fetch = origFetch;
		delete process.env.R4_API_KEY;
		if (previousHome !== undefined) process.env.HOME = previousHome;
	}

	if (capture.length < 2) throw new Error(`Expected 2 registerProvider calls, got ${capture.length}`);

	const [initial, live] = capture;
	if (initial.provider !== "r4" || live.provider !== "r4") throw new Error(`Expected provider "r4"`);

	const initialModels = initial.config.models as Array<{ id: string }>;
	if (!Array.isArray(initialModels) || initialModels.length < 10) {
		throw new Error(`Expected static seed >= 10 models, got ${initialModels.length}`);
	}
	if (initial.config.api !== "openai-completions") throw new Error("Expected api openai-completions");
	if (initial.config.apiKey !== "$R4_API_KEY") throw new Error("Expected apiKey $R4_API_KEY");
	if (initial.config.baseUrl !== "https://api.r4.codes/v1") throw new Error("Expected baseUrl https://api.r4.codes/v1");

	const liveModels = live.config.models as Array<{
		id: string;
		name: string;
		reasoning: boolean;
		thinkingLevelMap?: Record<string, string | null>;
		cost: { input: number; output: number; cacheRead: number };
		input: string[];
	}>;
	if (liveModels.length !== 2) throw new Error(`Expected 2 live models, got ${liveModels.length}`);

	const ds = liveModels.find((m) => m.id === "deepseek-v4.1-flash");
	if (!ds) throw new Error("Missing deepseek-v4.1-flash in live models");
	if (ds.name !== "R4: DeepSeek V4.1 Flash") throw new Error(`Bad display name: ${ds.name}`);
	if (!ds.reasoning) throw new Error("deepseek-v4.1-flash should be reasoning");
	if (ds.thinkingLevelMap?.xhigh !== "xhigh") throw new Error("thinkingLevelMap.xhigh should be identity");
	if (ds.thinkingLevelMap?.off !== "none") throw new Error("thinkingLevelMap.off should map to none");
	if (ds.cost.input !== 0.3 || ds.cost.output !== 1.2 || ds.cost.cacheRead !== 0.006) throw new Error("Bad cost mapping");

	const qwen = liveModels.find((m) => m.id === "qwen3.8-27b");
	if (!qwen) throw new Error("Missing qwen3.8-27b in live models");
	if (qwen.reasoning) throw new Error("qwen3.8-27b has no effort tiers, should not be reasoning");
	if (qwen.thinkingLevelMap) throw new Error("qwen3.8-27b should have no thinkingLevelMap");

	// Disk cache written with fetchedAt + models.
	const cacheRaw = await readFile(cacheFile, "utf8");
	const cache = JSON.parse(cacheRaw) as { fetchedAt?: string; models?: Array<{ id: string }> };
	if (!cache.fetchedAt) throw new Error("Cache missing fetchedAt");
	if (cache.models?.length !== 2) throw new Error("Cache should hold 2 live models");

	// GET /v1/models requires auth on R4.
	if (capturedAuthHeader !== "Bearer coder_test_fixture") {
		throw new Error(`Expected Authorization header, got ${capturedAuthHeader}`);
	}

	console.log(`  Initial seed: ${initialModels.length} models (static)`);
	console.log(`  Live refresh: ${liveModels.length} models, cache written, auth header sent`);
	console.log("  PASS");
}

async function testCacheReusedWhenApiDown(): Promise<void> {
	console.log("\n--- [A2] Disk cache is the seed when API is unreachable ---");

	const home = await mkdtemp(path.join(os.tmpdir(), "pi-r4-home-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;

	const cacheDir = path.join(home, ".pi", "agent", "cache", "pi-r4-coder");
	await mkdir(cacheDir, { recursive: true });
	const cachedModels = [
		{ id: "cached-model-x", name: "R4: Cached Model X", reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 8192 },
	];
	await writeFile(path.join(cacheDir, "models.json"), JSON.stringify({ fetchedAt: "2026-01-01T00:00:00Z", models: cachedModels }), "utf8");

	const origFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		throw new Error("simulated network outage");
	}) as typeof fetch;

	const capture: CapturedRegistration[] = [];

	try {
		// Query-busted import so the module re-evaluates with the new HOME.
		const mod = await import(`./index.ts?cache-test=${Date.now()}`);
		await mod.default(makeMockPi(capture));
		await sleep(100);
	} finally {
		globalThis.fetch = origFetch;
		if (previousHome !== undefined) process.env.HOME = previousHome;
	}

	if (capture.length !== 1) throw new Error(`Expected exactly 1 registerProvider call, got ${capture.length}`);
	const models = capture[0].config.models as Array<{ id: string }>;
	if (models.length !== 1 || models[0].id !== "cached-model-x") {
		throw new Error("Seed should come from disk cache");
	}

	console.log("  Seed came from disk cache despite API outage");
	console.log("  PASS");
}

// ---------------------------------------------------------------------------
// B) API integration tests
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.r4.codes/v1";

type ModelInfo = {
	id: string;
	context_window: number;
	pricing?: { input_per_m_tokens?: string; output_per_m_tokens?: string };
	effort?: { tiers?: string[] };
};

type DeltaPayload = {
	choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }>;
	usage?: { reasoning_tokens?: number };
	error?: { message?: string };
};

async function resolveApiKey(): Promise<string> {
	if (process.env.R4_API_KEY) return process.env.R4_API_KEY;

	const authPath = path.join(os.homedir(), ".pi/agent/auth.json");
	try {
		const raw = await readFile(authPath, "utf8");
		const parsed = JSON.parse(raw) as Record<string, { key?: string }>;
		const key = parsed.r4?.key;
		if (typeof key === "string" && key.length > 0) return key;
	} catch {
		// fall through
	}

	return "";
}

function pickModel(models: ModelInfo[], preferred: string[]): string {
	for (const id of preferred) {
		if (models.some((m) => m.id === id)) return id;
	}
	if (models.length === 0) throw new Error("No models available");
	return models[0].id;
}

async function* readSseDataLines(response: Response): AsyncGenerator<string> {
	if (!response.body) throw new Error("Streaming response has no body");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });

		buffer = buffer.replace(/\r\n/g, "\n");

		let separatorIndex = buffer.indexOf("\n\n");
		while (separatorIndex !== -1) {
			const block = buffer.slice(0, separatorIndex);
			buffer = buffer.slice(separatorIndex + 2);

			const dataLines = block
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart());

			if (dataLines.length > 0) {
				yield dataLines.join("\n");
			}

			separatorIndex = buffer.indexOf("\n\n");
		}

		if (done) break;
	}

	const tail = buffer.trim();
	if (tail.length > 0) {
		const dataLines = tail
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart());
		if (dataLines.length > 0) {
			yield dataLines.join("\n");
		}
	}
}

async function testListModels(apiKey: string): Promise<ModelInfo[]> {
	console.log("\n--- [B1] GET /v1/models ---");
	const res = await fetch(`${BASE_URL}/models`, {
		signal: AbortSignal.timeout(30_000),
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);

	const data = (await res.json()) as { data: ModelInfo[] };
	console.log(`  Got ${data.data.length} models`);
	if (data.data.length === 0) throw new Error("Empty model list");

	for (const m of data.data) {
		if (!m.id) throw new Error("Model missing id");
		if (!m.context_window || m.context_window < 1024) throw new Error(`Model ${m.id}: bad context_window`);
		if (m.pricing?.input_per_m_tokens == null) throw new Error(`Model ${m.id}: missing pricing.input_per_m_tokens`);
		if (m.pricing?.output_per_m_tokens == null) throw new Error(`Model ${m.id}: missing pricing.output_per_m_tokens`);
	}

	console.log("  PASS");
	return data.data;
}

async function testNonStreaming(apiKey: string, models: ModelInfo[]): Promise<void> {
	console.log("\n--- [B2] POST /chat/completions (non-streaming) ---");

	const modelId = pickModel(models, ["deepseek-v4.1-flash"]);
	console.log(`  Model: ${modelId}`);

	const res = await fetch(`${BASE_URL}/chat/completions`, {
		signal: AbortSignal.timeout(60_000),
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: modelId,
			messages: [{ role: "user", content: "Say hello in one short sentence." }],
			max_tokens: 256,
			temperature: 0,
		}),
	});

	if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);

	const data = (await res.json()) as {
		choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
		usage?: { total_tokens?: number };
	};

	const message = data.choices?.[0]?.message;
	const text = (message?.content ?? "").trim();
	if (!text) throw new Error("Empty response content");
	if (!data.usage?.total_tokens || data.usage.total_tokens < 1) throw new Error("Missing usage.total_tokens");

	console.log(`  Response: "${text.slice(0, 80)}"`);
	console.log("  PASS");
}

async function testStreaming(apiKey: string, models: ModelInfo[]): Promise<void> {
	console.log("\n--- [B3] POST /chat/completions (streaming) ---");

	const modelId = pickModel(models, ["deepseek-v4.1-flash"]);
	console.log(`  Model: ${modelId}`);

	const res = await fetch(`${BASE_URL}/chat/completions`, {
		signal: AbortSignal.timeout(60_000),
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: modelId,
			messages: [{ role: "user", content: "Count from 1 to 3." }],
			max_tokens: 512,
			temperature: 0,
			stream: true,
		}),
	});

	if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);

	let fullText = "";
	let chunks = 0;

	for await (const payload of readSseDataLines(res)) {
		if (payload === "[DONE]") continue;

		const parsed = JSON.parse(payload) as DeltaPayload;
		if (parsed.error) throw new Error(`Stream error: ${parsed.error.message ?? "unknown"}`);

		const delta = parsed.choices?.[0]?.delta;
		if (delta?.content) {
			fullText += delta.content;
			chunks++;
		}
	}

	console.log(`  Chunks: ${chunks}, Text: "${fullText.trim().slice(0, 80)}"`);
	if (chunks < 1) throw new Error("No streaming chunks received");
	if (!fullText.trim()) throw new Error("Streaming output empty");

	console.log("  PASS");
}

async function testToolCalling(apiKey: string, models: ModelInfo[]): Promise<void> {
	console.log("\n--- [B4] Tool calling ---");

	const modelId = pickModel(models, ["deepseek-v4.1-flash"]);
	console.log(`  Model: ${modelId}`);

	const res = await fetch(`${BASE_URL}/chat/completions`, {
		signal: AbortSignal.timeout(60_000),
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: modelId,
			messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
			max_tokens: 1024,
			tools: [
				{
					type: "function",
					function: {
						name: "get_weather",
						description: "Get current weather for a city",
						parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
					},
				},
			],
			tool_choice: "auto",
		}),
	});

	if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);

	const data = (await res.json()) as {
		choices?: Array<{
			finish_reason?: string;
			message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
		}>;
	};

	const choice = data.choices?.[0];
	const call = choice?.message?.tool_calls?.[0];

	console.log(`  finish_reason: ${choice?.finish_reason}, function: ${call?.function?.name}`);
	if (choice?.finish_reason !== "tool_calls" && !call) throw new Error("Expected a tool call");
	if (call?.function?.name !== "get_weather") throw new Error(`Expected get_weather, got ${call?.function?.name}`);

	console.log("  PASS");
}

async function testReasoningEffort(apiKey: string, models: ModelInfo[]): Promise<void> {
	console.log("\n--- [B5] Reasoning (reasoning_effort=max) ---");

	const modelId = pickModel(models, ["deepseek-v4.1-flash"]);
	console.log(`  Model: ${modelId}`);

	const res = await fetch(`${BASE_URL}/chat/completions`, {
		signal: AbortSignal.timeout(60_000),
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: modelId,
			messages: [{ role: "user", content: "What is 2+2? Answer with just the number." }],
			max_tokens: 4096,
			reasoning_effort: "max",
		}),
	});

	if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);

	const data = (await res.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
		usage?: { reasoning_tokens?: number };
	};

	const text = data.choices?.[0]?.message?.content?.trim() ?? "";
	const reasoningTokens = data.usage?.reasoning_tokens ?? 0;

	console.log(`  Answer: "${text.slice(0, 40)}", reasoning_tokens: ${reasoningTokens}`);
	if (!text) throw new Error("Empty answer");
	if (reasoningTokens < 1) throw new Error("Expected reasoning_tokens > 0 for effort=max");

	console.log("  PASS");
}

async function testVision(apiKey: string, models: ModelInfo[]): Promise<void> {
	console.log("\n--- [B6] Vision (kimi-k3) ---");

	if (!models.some((m) => m.id === "kimi-k3")) {
		console.log("  SKIP (kimi-k3 not in catalog)");
		return;
	}

	// 1x1 transparent PNG.
	const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

	const res = await fetch(`${BASE_URL}/chat/completions`, {
		signal: AbortSignal.timeout(60_000),
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "kimi-k3",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Describe this image in one word." },
						{ type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
					],
				},
			],
			max_tokens: 100,
		}),
	});

	if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);

	const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
	const text = data.choices?.[0]?.message?.content?.trim() ?? "";

	console.log(`  Answer: "${text.slice(0, 60)}"`);
	if (!text) throw new Error("Empty vision answer");

	console.log("  PASS");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const runAll = process.argv.includes("--all");

	console.log(`R4 Coder Tests — ${BASE_URL}`);

	type TestEntry = { name: string; fn: () => Promise<void> };

	// Group A — unit tests (no live API needed)
	const groupA: TestEntry[] = [
		{ name: "extension-factory", fn: testExtensionFactory },
		{ name: "cache-reuse", fn: testCacheReusedWhenApiDown },
	];

	// Group B — live API integration (only with --all flag)
	let groupB: TestEntry[] = [];
	if (runAll) {
		const apiKey = await resolveApiKey();
		if (!apiKey) {
			console.error("Missing API key: set R4_API_KEY or add r4.key to ~/.pi/agent/auth.json");
			process.exit(1);
		}

		const models = await testListModels(apiKey);
		groupB = [
			{ name: "non-streaming", fn: () => testNonStreaming(apiKey, models) },
			{ name: "streaming", fn: () => testStreaming(apiKey, models) },
			{ name: "tool-calling", fn: () => testToolCalling(apiKey, models) },
			{ name: "reasoning-effort", fn: () => testReasoningEffort(apiKey, models) },
			{ name: "vision", fn: () => testVision(apiKey, models) },
		];
	} else {
		console.log("\n(Skip group B — live API tests. Pass --all to run.)");
	}

	const allTests = [...groupA, ...groupB];
	let passed = 0;
	let failed = 0;

	for (const { name, fn } of allTests) {
		try {
			await fn();
			passed++;
		} catch (error) {
			console.error(`  FAIL [${name}]:`, error);
			failed++;
		}
	}

	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
