/**
 * R4 Coder Provider for pi
 *
 * OpenAI-compatible provider at https://api.r4.codes/v1 (https://r4.codes).
 * No custom streaming needed — delegates to built-in openai-completions.
 *
 * Features:
 * - Dynamic model discovery from GET /v1/models (pricing, context, effort tiers)
 * - Disk cache of the live model list (~/.pi/agent/cache/pi-r4-coder/models.json),
 *   so a fresh catalog survives restarts and offline starts
 * - Static seed fallback when neither cache nor API is available
 * - Fetch timeout (10s), never blocks pi startup
 *
 * Usage:
 *   # pi install git:github.com/ZoRDoK/pi-r4-coder
 *   # Set R4_API_KEY env var, or add key to ~/.pi/agent/auth.json as "r4"
 *   # Then /model r4/<model-id>
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

const PROVIDER_ID = "r4";
const BASE_URL = "https://api.r4.codes/v1";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_DIR = path.join(os.homedir(), ".pi", "agent", "cache", "pi-r4-coder");
const CACHE_FILE = path.join(CACHE_DIR, "models.json");
const AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");

// =============================================================================
// Vision-supporting models (confirmed via live image tests; the /models
// endpoint does not expose modality metadata yet)
// =============================================================================

const VISION_MODELS = new Set(["kimi-k3"]);

// =============================================================================
// Thinking levels
// =============================================================================

const PI_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Map pi thinking levels onto the model's effort tiers. R4 effort tiers use
 * pi's own level names, so the mapping is identity for supported tiers and
 * `null` (hidden in the UI) for missing ones. `off` maps to R4's "none".
 */
function effortMap(tiers: string[]): ProviderModelConfig["thinkingLevelMap"] {
	const supported = new Set(tiers);
	const map: NonNullable<ProviderModelConfig["thinkingLevelMap"]> = { off: "none" };
	for (const level of PI_EFFORT_LEVELS) {
		map[level] = supported.has(level) ? level : null;
	}
	return map;
}

const ALL_TIERS_MAP = effortMap(["minimal", "low", "medium", "high", "xhigh", "max"]);

// =============================================================================
// Static seed models — snapshot of GET /v1/models, used when neither the disk
// cache nor the API is available
// =============================================================================

const STATIC_MODELS: ProviderModelConfig[] = [
	{ id: "kimi-k3",           name: "R4: Kimi K3",                  reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text", "image"], cost: { input: 3.0,  output: 15.0, cacheRead: 0.3,  cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 1_048_576 },
	{ id: "deepseek-v4.1-flash", name: "R4: DeepSeek V4.1 Flash",    reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text"], cost: { input: 0.3,  output: 1.2,  cacheRead: 0.006, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 1_048_576 },
	{ id: "glm-5.3",           name: "R4: GLM 5.3",                  reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text"], cost: { input: 1.4,  output: 4.4,  cacheRead: 0.26, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 1_048_576 },
	{ id: "glm-5.3-flash",     name: "R4: GLM 5.3 Flash",            reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text"], cost: { input: 0.15, output: 0.5,  cacheRead: 0.03, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 1_048_576 },
	{ id: "deepseek-v4-pro",   name: "R4: DeepSeek V4 Pro (0813)",   reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text"], cost: { input: 0.44, output: 0.88, cacheRead: 0.044, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 1_048_576 },
	{ id: "deepseek-v4-flash", name: "R4: DeepSeek V4 Flash (0731)", reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text"], cost: { input: 0.14, output: 0.28, cacheRead: 0.02, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 1_048_576 },
	{ id: "glm-5.2",           name: "R4: GLM 5.2",                  reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text"], cost: { input: 1.4,  output: 4.4,  cacheRead: 0.26, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 1_048_576 },
	{ id: "qwen3.8-27b",       name: "R4: Qwen 3.8 27B",             reasoning: false, input: ["text"], cost: { input: 0.4,  output: 3.0,  cacheRead: 0.15, cacheWrite: 0 }, contextWindow: 262_144,   maxTokens: 262_144 },
	{ id: "grok-4.6",          name: "R4: Grok 4.6",                 reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text"], cost: { input: 2.0,  output: 6.0,  cacheRead: 0.5,  cacheWrite: 0 }, contextWindow: 500_000,   maxTokens: 500_000 },
	{ id: "step-5-preview",    name: "R4: Step 5 Preview",           reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text"], cost: { input: 1.0,  output: 2.7,  cacheRead: 0.05, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 1_048_576 },
];

// =============================================================================
// Model fetching
// =============================================================================

interface RawModel {
	id: string;
	display_name?: string;
	context_window: number;
	effort?: { tiers?: string[] };
	pricing?: {
		input_per_m_tokens?: string;
		output_per_m_tokens?: string;
		cache_read_per_m_tokens?: string;
		cache_creation_per_m_tokens?: string;
	};
}

function mapModel(m: RawModel): ProviderModelConfig {
	const tiers = m.effort?.tiers ?? [];
	const reasoning = tiers.length > 0;
	return {
		id: m.id,
		name: `R4: ${m.display_name || m.id}`,
		reasoning,
		thinkingLevelMap: reasoning ? effortMap(tiers) : undefined,
		input: VISION_MODELS.has(m.id) ? ["text", "image"] : ["text"],
		cost: {
			input: parseFloat(m.pricing?.input_per_m_tokens ?? "") || 0,
			output: parseFloat(m.pricing?.output_per_m_tokens ?? "") || 0,
			cacheRead: parseFloat(m.pricing?.cache_read_per_m_tokens ?? "") || 0,
			cacheWrite: parseFloat(m.pricing?.cache_creation_per_m_tokens ?? "") || 0,
		},
		contextWindow: m.context_window,
		// R4 does not publish a separate output cap; the server accepts requests
		// up to the full context window.
		maxTokens: m.context_window,
	};
}

async function fetchModels(): Promise<ProviderModelConfig[]> {
	// GET /v1/models requires authentication on R4 (unlike some OpenAI-compatible
	// providers). Resolve the key the same way pi resolves it for requests.
	const apiKey = await resolveApiKey();
	const headers: Record<string, string> = {};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const res = await fetch(`${BASE_URL}/models`, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		headers,
	});
	if (!res.ok) throw new Error(`API returned ${res.status}`);

	const body = (await res.json()) as { data?: RawModel[] };
	if (!body.data || !Array.isArray(body.data) || body.data.length === 0) {
		throw new Error("API returned empty model list");
	}

	return body.data.map(mapModel);
}

async function resolveApiKey(): Promise<string | undefined> {
	if (process.env.R4_API_KEY) return process.env.R4_API_KEY;
	try {
		const raw = await readFile(AUTH_FILE, "utf8");
		const parsed = JSON.parse(raw) as Record<string, { key?: string }>;
		const key = parsed[PROVIDER_ID]?.key;
		if (typeof key === "string" && key.length > 0) return key;
	} catch {
		// no auth.json — fall through
	}
	return undefined;
}

// =============================================================================
// Disk cache
// =============================================================================

interface CacheFile {
	fetchedAt: string;
	models: ProviderModelConfig[];
}

function isValidModelList(value: unknown): value is ProviderModelConfig[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(m) =>
				m !== null &&
				typeof m === "object" &&
				typeof (m as ProviderModelConfig).id === "string" &&
				typeof (m as ProviderModelConfig).contextWindow === "number",
		)
	);
}

async function loadCache(): Promise<ProviderModelConfig[] | null> {
	try {
		const raw = await readFile(CACHE_FILE, "utf8");
		const parsed = JSON.parse(raw) as CacheFile;
		return isValidModelList(parsed?.models) ? parsed.models : null;
	} catch {
		return null; // missing, unreadable or corrupt cache
	}
}

async function saveCache(models: ProviderModelConfig[]): Promise<void> {
	try {
		await mkdir(CACHE_DIR, { recursive: true });
		const cache: CacheFile = { fetchedAt: new Date().toISOString(), models };
		await writeFile(CACHE_FILE, JSON.stringify(cache, null, "\t") + "\n", "utf8");
	} catch (error) {
		console.error("[pi-r4-coder] Failed to write model cache:", error instanceof Error ? error.message : String(error));
	}
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
	// Reading the local cache is fast; use it as the seed so pi never blocks.
	const cached = await loadCache();
	const seed = cached ?? STATIC_MODELS;
	const seedSource = cached ? "disk cache" : "static seed";

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: BASE_URL,
		apiKey: "$R4_API_KEY",
		api: "openai-completions",
		models: seed,
	});

	console.log(`[pi-r4-coder] Registered provider "${PROVIDER_ID}" with ${seed.length} models (${seedSource})`);

	// Fetch live models in background; replace and cache when ready.
	fetchModels()
		.then(async (liveModels) => {
			pi.registerProvider(PROVIDER_ID, {
				baseUrl: BASE_URL,
				apiKey: "$R4_API_KEY",
				api: "openai-completions",
				models: liveModels,
			});
			await saveCache(liveModels);
			console.log(`[pi-r4-coder] Updated provider with ${liveModels.length} live models from API (cached)`);
		})
		.catch((error) => {
			console.error(`[pi-r4-coder] Background fetch failed, keeping ${seedSource} models:`, error instanceof Error ? error.message : String(error));
		});
}
