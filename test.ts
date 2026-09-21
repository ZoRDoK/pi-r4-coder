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

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mock } from "node:test";
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

function makeMockPi(capture: CapturedRegistration[], hooks = new Map<string, () => Promise<void>>()) {
	return {
		registerProvider(provider: string, config: unknown) {
			capture.push({ provider, config: structuredClone(config) as Record<string, unknown> });
		},
		on(event: string, handler: (event: object, ctx: { model: { provider: string } }) => Promise<void>) {
			hooks.set(event, () => handler({}, { model: { provider: "r4" } }));
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
			{
				// R4 ships no effort tiers for grok-4.7, despite it being a reasoning model.
				id: "grok-4.7",
				display_name: "Grok 4.7",
				context_window: 500000,
				pricing: {
					input_per_m_tokens: "2.0000",
					output_per_m_tokens: "6.0000",
					cache_read_per_m_tokens: "0.5000",
					cache_creation_per_m_tokens: "0.0000",
				},
			},
		],
	};
}

function modelInfoFixture() {
	return {
		// Deliberately reversed: /models uses id, /models/info uses slug.
		models: [
			{
				slug: "qwen3.8-27b",
				max_output_tokens: 131072,
				input_modalities: ["text", "image"],
			},
			{
				slug: "deepseek-v4.1-flash",
				max_output_tokens: 393216,
				input_modalities: ["text", "image"],
				pricing_effective: {
					input_per_m_tokens: "0.15",
					output_per_m_tokens: "0.6",
					cache_read_per_m_tokens: "0.003",
					cache_creation_per_m_tokens: "0",
					window_ends_at: null as string | null,
				},
			},
			{
				slug: "grok-4.7",
				max_output_tokens: 32000,
				input_modalities: ["text"],
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
	const authHeaders: Array<string | undefined> = [];
	const previousKey = process.env.R4_API_KEY;
	process.env.R4_API_KEY = "coder_test_fixture";
	globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
		const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
		if (urlStr === "https://api.r4.codes/v1/models" || urlStr === "https://api.r4.codes/v1/models/info") {
			const headers = init?.headers as Record<string, string> | undefined;
			authHeaders.push(headers?.Authorization);
			const body = urlStr.endsWith("/info") ? modelInfoFixture() : liveModelsFixture();
			return new Response(JSON.stringify(body), {
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
		if (previousKey === undefined) delete process.env.R4_API_KEY;
		else process.env.R4_API_KEY = previousKey;
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
		maxTokens: number;
		contextWindow: number;
	}>;
	if (liveModels.length !== 3) throw new Error(`Expected 3 live models, got ${liveModels.length}`);

	const ds = liveModels.find((m) => m.id === "deepseek-v4.1-flash");
	if (!ds) throw new Error("Missing deepseek-v4.1-flash in live models");
	if (ds.name !== "R4: DeepSeek V4.1 Flash") throw new Error(`Bad display name: ${ds.name}`);
	if (!ds.reasoning) throw new Error("deepseek-v4.1-flash should be reasoning");
	if (ds.thinkingLevelMap?.xhigh !== "xhigh") throw new Error("thinkingLevelMap.xhigh should be identity");
	if (ds.thinkingLevelMap?.off !== "none") throw new Error("thinkingLevelMap.off should map to none");
	assert.deepEqual(ds.cost, { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 });
	assert.equal(ds.maxTokens, 393216);
	assert.equal(ds.contextWindow, 1048576);
	assert.deepEqual(ds.input, ["text", "image"]);

	const qwen = liveModels.find((m) => m.id === "qwen3.8-27b");
	if (!qwen) throw new Error("Missing qwen3.8-27b in live models");
	if (qwen.reasoning) throw new Error("qwen3.8-27b has no effort tiers, should not be reasoning");
	if (qwen.thinkingLevelMap) throw new Error("qwen3.8-27b should have no thinkingLevelMap");
	assert.equal(qwen.maxTokens, 131072);
	assert.deepEqual(qwen.input, ["text", "image"]);
	assert.equal(qwen.cost.output, 3); // No pricing_effective: keep base price.
	assert.equal(qwen.thinkingLevelMap, undefined);

	const grok = liveModels.find((m) => m.id === "grok-4.7");
	if (!grok) throw new Error("Missing grok-4.7 in live models");
	// No effort tiers from R4: the built-in correction table supplies them.
	if (!grok.reasoning) throw new Error("grok-4.7 should be reasoning despite missing effort tiers");
	assert.deepEqual(grok.thinkingLevelMap, { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null });
	assert.equal(grok.maxTokens, 32000);
	assert.deepEqual(grok.input, ["text"]);

	// Cache both raw endpoints so expired discounts can fall back to base prices.
	const cacheRaw = await readFile(cacheFile, "utf8");
	const cache = JSON.parse(cacheRaw);
	assert.equal(cache.version, 2);
	assert.ok(cache.fetchedAt);
	assert.deepEqual(cache.models, liveModelsFixture().data);
	assert.deepEqual(cache.info, modelInfoFixture().models);
	assert.deepEqual(authHeaders, ["Bearer coder_test_fixture", "Bearer coder_test_fixture"]);

	console.log(`  Initial seed: ${initialModels.length} models (static)`);
	console.log(`  Live refresh: ${liveModels.length} models, cache written, auth header sent to both endpoints`);
	await rm(home, { recursive: true, force: true });
	console.log("  PASS");
}

async function testCacheReusedWhenApiDown(): Promise<void> {
	console.log("\n--- [A2] Disk cache is the seed when API is unreachable ---");

	const home = await mkdtemp(path.join(os.tmpdir(), "pi-r4-home-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;

	const cacheDir = path.join(home, ".pi", "agent", "cache", "pi-r4-coder");
	await mkdir(cacheDir, { recursive: true });
	const cache = {
		version: 2,
		fetchedAt: "2026-01-01T00:00:00Z",
		models: liveModelsFixture().data,
		info: modelInfoFixture().models,
	};
	await writeFile(path.join(cacheDir, "models.json"), JSON.stringify(cache), "utf8");

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

	for (const registration of capture) {
		const models = registration.config.models as Array<{ id: string; maxTokens: number; input: string[]; cost: { output: number } }>;
		assert.equal(models.length, 3);
		assert.equal(models[0].id, "deepseek-v4.1-flash");
		assert.equal(models[0].maxTokens, 393216);
		assert.equal(models[0].cost.output, 1.2); // An old discount must not survive offline startup.
		assert.deepEqual(models[0].input, ["text", "image"]);
	}

	console.log("  Seed kept cached capabilities but discarded expired discounts during outage");
	await rm(home, { recursive: true, force: true });
	console.log("  PASS");
}

async function testPriceRefresh(): Promise<void> {
	console.log("\n--- [A3] Refresh prices at expiry, coalesce requests, recover from outages ---");
	const home = await mkdtemp(path.join(os.tmpdir(), "pi-r4-prices-"));
	const previousHome = process.env.HOME;
	const origFetch = globalThis.fetch;
	const capture: CapturedRegistration[] = [];
	const hooks = new Map<string, () => Promise<void>>();
	const info = modelInfoFixture();
	const pricing = info.models[1].pricing_effective!;
	let requests = 0;
	let failure: "none" | "http" | "invalid" | "missing" | "abort" = "none";
	process.env.HOME = home;
	mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-20T12:00:00Z") });
	pricing.window_ends_at = new Date(Date.now() + 10000).toISOString();

	globalThis.fetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
		requests++;
		if (failure === "abort") {
			await sleep(10);
			options?.signal?.throwIfAborted();
		}
		if (String(url).endsWith("/info")) {
			if (failure === "http") return new Response("unavailable", { status: 503 });
			const body = structuredClone(info);
			if (failure === "invalid") body.models[1].max_output_tokens = 0;
			if (failure === "missing") body.models.pop();
			return Response.json(body);
		}
		return Response.json(liveModelsFixture());
	}) as typeof fetch;

	const latestModel = (): { cost: { input: number; output: number }; maxTokens: number; input: string[] } => {
		const models = capture.at(-1)!.config.models as Array<{ cost: { input: number; output: number }; maxTokens: number; input: string[] }>;
		return models[0];
	};

	try {
		const mod = await import(`./index.ts?prices=${Date.now()}`);
		await mod.default(makeMockPi(capture, hooks));
		await hooks.get("before_agent_start")!();
		assert.equal(requests, 2);
		assert.equal(latestModel().cost.output, 0.6);

		mock.timers.tick(9999);
		await hooks.get("turn_end")!();
		assert.equal(requests, 2);

		// A known promotion boundary refreshes before the normal 60s TTL.
		mock.timers.tick(1);
		Object.assign(pricing, liveModelsFixture().data[0].pricing, { window_ends_at: null });
		await hooks.get("turn_end")!();
		assert.equal(requests, 4);
		assert.equal(latestModel().cost.output, 1.2);

		// Time-based tiers have no window_ends_at. Refresh them on the next turn after 60s.
		mock.timers.tick(60000);
		pricing.input_per_m_tokens = "0";
		pricing.output_per_m_tokens = "0";
		await Promise.all([hooks.get("before_agent_start")!(), hooks.get("turn_end")!()]);
		assert.equal(requests, 6);
		assert.equal(latestModel().cost.input, 0);
		assert.equal(latestModel().cost.output, 0);

		const cachePath = path.join(home, ".pi", "agent", "cache", "pi-r4-coder", "models.json");
		const goodCache = await readFile(cachePath, "utf8");
		for (const mode of ["http", "invalid", "missing"] as const) {
			failure = mode;
			mock.timers.tick(60000);
			await hooks.get("turn_end")!();
			assert.equal(latestModel().cost.output, 1.2);
			assert.equal(latestModel().maxTokens, 393216);
			assert.deepEqual(latestModel().input, ["text", "image"]);
			assert.equal(await readFile(cachePath, "utf8"), goodCache);
			const beforeRetry: number = requests;
			await hooks.get("turn_end")!();
			assert.equal(requests, beforeRetry); // No request storm while the API is down.
		}

		failure = "none";
		mock.timers.tick(60000);
		pricing.output_per_m_tokens = "0.3";
		await hooks.get("turn_end")!();
		assert.equal(latestModel().cost.output, 0.3);

		// Even a successful but stale server snapshot must not cause a fetch on every event.
		mock.timers.tick(60000);
		pricing.window_ends_at = new Date(Date.now() - 1).toISOString();
		await hooks.get("turn_end")!();
		assert.equal(latestModel().cost.output, 1.2);
		const beforeExpiredRetry: number = requests;
		await hooks.get("turn_end")!();
		assert.equal(requests, beforeExpiredRetry);

		// A fresh cached discount may expire before a failed startup refresh can retry.
		const restartCache = JSON.parse(await readFile(cachePath, "utf8"));
		restartCache.fetchedAt = new Date().toISOString();
		restartCache.info[1].pricing_effective.window_ends_at = new Date(Date.now() + 10000).toISOString();
		await writeFile(cachePath, JSON.stringify(restartCache), "utf8");
		failure = "http";
		const restartCapture: CapturedRegistration[] = [];
		const restartHooks = new Map<string, () => Promise<void>>();
		try {
			await mod.default(makeMockPi(restartCapture, restartHooks));
			await restartHooks.get("before_agent_start")!();
			const beforeExpiry: number = requests;
			const fresh = restartCapture.at(-1)!.config.models as Array<{ cost: { output: number } }>;
			assert.equal(fresh[0].cost.output, 0.3);
			mock.timers.tick(10000);
			await restartHooks.get("before_agent_start")!();
			assert.equal(requests, beforeExpiry);
			const expired = restartCapture.at(-1)!.config.models as Array<{ cost: { output: number } }>;
			assert.equal(expired[0].cost.output, 1.2);
		} finally {
			await restartHooks.get("session_shutdown")?.();
		}

		failure = "abort";
		mock.timers.tick(60000);
		const registrations = capture.length;
		const refreshing = hooks.get("turn_end")!();
		await hooks.get("session_shutdown")!();
		await refreshing;
		assert.equal(capture.length, registrations); // No stale provider registration after shutdown.
	} finally {
		await hooks.get("session_shutdown")?.();
		mock.timers.reset();
		globalThis.fetch = origFetch;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	}
	console.log("  PASS");
}

async function testLegacyCache(): Promise<void> {
	console.log("\n--- [A4] Old cache cannot restore incorrect limits or disable images ---");
	const home = await mkdtemp(path.join(os.tmpdir(), "pi-r4-legacy-"));
	const previousHome = process.env.HOME;
	const origFetch = globalThis.fetch;
	const capture: CapturedRegistration[] = [];
	const hooks = new Map<string, () => Promise<void>>();
	const cacheDir = path.join(home, ".pi", "agent", "cache", "pi-r4-coder");
	await mkdir(cacheDir, { recursive: true });
	const oldCache = { fetchedAt: new Date().toISOString(), models: [{ id: "grok-4.7", contextWindow: 500000, maxTokens: 500000 }] };
	await writeFile(path.join(cacheDir, "models.json"), JSON.stringify(oldCache), "utf8");
	process.env.HOME = home;
	globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;

	try {
		const mod = await import(`./index.ts?legacy=${Date.now()}`);
		await mod.default(makeMockPi(capture, hooks));
		await hooks.get("before_agent_start")!();
		const models = capture.at(-1)!.config.models as Array<{ id: string; maxTokens: number; input: string[]; thinkingLevelMap?: Record<string, string | null> }>;
		assert.equal(models.length, 10);
		assert.equal(models.find((m) => m.id === "grok-4.7")?.maxTokens, 32000);
		assert.equal(models.find((m) => m.id === "grok-4.7")?.thinkingLevelMap?.xhigh, "xhigh");
		assert.equal(models.find((m) => m.id === "grok-4.7")?.thinkingLevelMap?.off, null);
		assert.equal(models.find((m) => m.id === "kimi-k3")?.maxTokens, 131072);
		assert.equal(models.find((m) => m.id === "step-5-preview")?.maxTokens, 1048576);
		for (const id of ["deepseek-v4.1-flash", "glm-5.3-flash", "qwen3.8-27b", "step-5-preview"]) {
			assert.deepEqual(models.find((m) => m.id === id)?.input, ["text", "image"]);
		}
	} finally {
		await hooks.get("session_shutdown")?.();
		globalThis.fetch = origFetch;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	}
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
		{ name: "price-refresh", fn: testPriceRefresh },
		{ name: "legacy-cache", fn: testLegacyCache },
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
