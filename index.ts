/**
 * R4 Coder Provider for pi
 *
 * OpenAI-compatible provider at https://api.r4.codes/v1 (https://r4.codes).
 * No custom streaming needed — delegates to built-in openai-completions.
 *
 * Features:
 * - Dynamic discovery from /v1/models and /v1/models/info
 * - Current effective prices refreshed before R4 turns (60s cache)
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
// ponytail: sample server-resolved prices for 60s instead of interpreting its timetable.
const REFRESH_INTERVAL_MS = 60_000;
const CACHE_VERSION = 2;
const CACHE_DIR = path.join(os.homedir(), ".pi", "agent", "cache", "pi-r4-coder");
const CACHE_FILE = path.join(CACHE_DIR, "models.json");
const AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");

// =============================================================================
// Thinking levels
// =============================================================================

const PI_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Map pi thinking levels onto the model's effort tiers. R4 effort tiers use
 * pi's own level names, so the mapping is identity for supported tiers and
 * `null` (hidden in the UI) for missing ones. `off` maps to R4's "none" unless
 * the model cannot disable reasoning at all.
 */
function effortMap(tiers: string[], off: "none" | null = "none"): ProviderModelConfig["thinkingLevelMap"] {
	const supported = new Set(tiers);
	const map: NonNullable<ProviderModelConfig["thinkingLevelMap"]> = { off };
	for (const level of PI_EFFORT_LEVELS) {
		map[level] = supported.has(level) ? level : null;
	}
	return map;
}

const ALL_TIERS_MAP = effortMap(["minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Effort tiers for models whose `/v1/models` entry is missing or wrong. R4 lists
 * `grok-4.7` without `effort`, but the model accepts low…xhigh and cannot disable
 * reasoning, so `off` is hidden instead of mapping to `none` (it keeps reasoning
 * anyway). Overrides win over the live tiers; drop an entry once R4 publishes the
 * model's tiers itself.
 */
const THINKING_OVERRIDES: Record<string, ProviderModelConfig["thinkingLevelMap"]> = {
	"grok-4.7": effortMap(["low", "medium", "high", "xhigh"], null),
};

// =============================================================================
// Static seed models — snapshot of /models and /models/info, used when neither the disk
// cache nor the API is available
// =============================================================================

const STATIC_MODELS: ProviderModelConfig[] = [
	{ id: "kimi-k3",           name: "R4: Kimi K3",                  reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text", "image"], cost: { input: 3.0,  output: 15.0, cacheRead: 0.3,  cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 131_072 },
	{ id: "deepseek-v4.1-flash", name: "R4: DeepSeek V4.1 Flash",    reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text", "image"], cost: { input: 0.3,  output: 1.2,  cacheRead: 0.006, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 393_216 },
	{ id: "glm-5.3",           name: "R4: GLM 5.3",                  reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text"], cost: { input: 1.4,  output: 4.4,  cacheRead: 0.26, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 131_072 },
	{ id: "glm-5.3-flash",     name: "R4: GLM 5.3 Flash",            reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text", "image"], cost: { input: 0.15, output: 0.5,  cacheRead: 0.03, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 131_072 },
	{ id: "deepseek-v4-pro",   name: "R4: DeepSeek V4 Pro (0813)",   reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text"], cost: { input: 0.44, output: 0.88, cacheRead: 0.044, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 393_216 },
	{ id: "deepseek-v4-flash", name: "R4: DeepSeek V4 Flash (0731)", reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text"], cost: { input: 0.14, output: 0.28, cacheRead: 0.02, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 393_216 },
	{ id: "glm-5.2",           name: "R4: GLM 5.2",                  reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text"], cost: { input: 1.4,  output: 4.4,  cacheRead: 0.26, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 131_072 },
	{ id: "qwen3.8-27b",       name: "R4: Qwen 3.8 27B",             reasoning: false, input: ["text", "image"], cost: { input: 0.4,  output: 3.0,  cacheRead: 0.15, cacheWrite: 0 }, contextWindow: 262_144,   maxTokens: 131_072 },
	{ id: "grok-4.7",          name: "R4: Grok 4.7",                 reasoning: true, thinkingLevelMap: THINKING_OVERRIDES["grok-4.7"], input: ["text"], cost: { input: 2.0,  output: 6.0,  cacheRead: 0.5,  cacheWrite: 0 }, contextWindow: 500_000,   maxTokens: 32_000 },
	{ id: "step-5-preview",    name: "R4: Step 5 Preview",           reasoning: true, thinkingLevelMap: ALL_TIERS_MAP, input: ["text", "image"], cost: { input: 1.0,  output: 2.7,  cacheRead: 0.05, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 1_048_576 },
];

// =============================================================================
// Model fetching
// =============================================================================

interface Pricing {
	input_per_m_tokens: string;
	output_per_m_tokens: string;
	cache_read_per_m_tokens: string;
	cache_creation_per_m_tokens: string;
}

interface RawModel {
	id: string;
	display_name?: string;
	context_window: number;
	effort?: { tiers?: string[] };
	pricing: Pricing;
}

interface ModelInfo {
	slug: string;
	max_output_tokens: number;
	input_modalities: string[];
	pricing_effective?: Pricing & { window_ends_at?: string | null };
}

function mapPricing(pricing: Pricing): ProviderModelConfig["cost"] {
	const fields = ["input_per_m_tokens", "output_per_m_tokens", "cache_read_per_m_tokens", "cache_creation_per_m_tokens"] as const;
	const values = fields.map((field) => {
		const raw = pricing?.[field];
		const value = Number(raw);
		if (typeof raw !== "string" || !raw.trim() || !Number.isFinite(value) || value < 0) {
			throw new Error(`Invalid R4 pricing field: ${field}`);
		}
		return value;
	});
	return { input: values[0], output: values[1], cacheRead: values[2], cacheWrite: values[3] };
}

function mapCatalog(catalog: CacheFile): { models: ProviderModelConfig[]; expiresAt: number } {
	if (catalog.version !== CACHE_VERSION || !Array.isArray(catalog.models) || !catalog.models.length || !Array.isArray(catalog.info)) {
		throw new Error("Invalid R4 catalog");
	}

	const fetchedAt = Date.parse(catalog.fetchedAt);
	if (!Number.isFinite(fetchedAt)) throw new Error("Invalid R4 catalog timestamp");

	const infoById = new Map(catalog.info.map((info) => [info.slug, info]));
	let expiresAt = fetchedAt + REFRESH_INTERVAL_MS;
	for (const info of catalog.info) {
		const end = info.pricing_effective?.window_ends_at;
		if (end != null) {
			const endAt = Date.parse(end);
			if (!Number.isFinite(endAt)) throw new Error(`Invalid R4 price expiry: ${info.slug}`);
			expiresAt = Math.min(expiresAt, endAt);
		}
	}

	const now = Date.now();
	const isFresh = now >= fetchedAt && now < expiresAt;
	const models = catalog.models.map((m): ProviderModelConfig => {
		const info = infoById.get(m.id);
		const tiers = m.effort?.tiers ?? [];
		if (typeof m.id !== "string" || !m.id || !Number.isSafeInteger(m.context_window) || m.context_window <= 0 ||
			!info || !Number.isSafeInteger(info.max_output_tokens) || info.max_output_tokens <= 0 ||
			!Array.isArray(info.input_modalities) || !info.input_modalities.includes("text") ||
			!Array.isArray(tiers) || !tiers.every((tier) => typeof tier === "string")) {
			throw new Error(`Invalid R4 model metadata: ${m.id}`);
		}

		const baseCost = mapPricing(m.pricing);
		const effectiveCost = info.pricing_effective ? mapPricing(info.pricing_effective) : baseCost;
		const override = THINKING_OVERRIDES[m.id];
		const reasoning = override !== undefined || tiers.length > 0;
		return {
			id: m.id,
			name: `R4: ${m.display_name || m.id}`,
			reasoning,
			thinkingLevelMap: override ?? (reasoning ? effortMap(tiers) : undefined),
			input: info.input_modalities.includes("image") ? ["text", "image"] : ["text"],
			cost: isFresh ? effectiveCost : baseCost,
			contextWindow: m.context_window,
			maxTokens: Math.min(info.max_output_tokens, m.context_window),
		};
	});
	return { models, expiresAt };
}

async function fetchModels(signal: AbortSignal): Promise<CacheFile> {
	const apiKey = await resolveApiKey();
	const headers: Record<string, string> = {};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const options = { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) };
	const fetchedAt = new Date().toISOString();
	const responses = await Promise.all([
		fetch(`${BASE_URL}/models`, options),
		fetch(`${BASE_URL}/models/info`, options),
	]);
	for (const response of responses) {
		if (!response.ok) throw new Error(`R4 catalog API returned ${response.status}`);
	}

	const body = await responses[0].json() as { data: RawModel[] };
	const info = await responses[1].json() as { models: ModelInfo[] };
	const catalog = { version: CACHE_VERSION, fetchedAt, models: body.data, info: info.models };
	mapCatalog(catalog);
	return catalog;
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
	version: number;
	fetchedAt: string;
	models: RawModel[];
	info: ModelInfo[];
}

async function loadCache(): Promise<CacheFile | null> {
	try {
		const raw = await readFile(CACHE_FILE, "utf8");
		const parsed = JSON.parse(raw) as CacheFile;
		mapCatalog(parsed);
		return parsed;
	} catch {
		return null; // missing, old-format or invalid cache
	}
}

async function saveCache(cache: CacheFile): Promise<void> {
	try {
		await mkdir(CACHE_DIR, { recursive: true });
		await writeFile(CACHE_FILE, JSON.stringify(cache, null, "\t") + "\n", "utf8");
	} catch (error) {
		console.error("[pi-r4-coder] Failed to write model cache:", error instanceof Error ? error.message : String(error));
	}
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI): Promise<void> {
	let catalog = await loadCache();
	let expiresAt = 0;
	let retryAfter = 0;
	let pending: Promise<void> | undefined;
	const controller = new AbortController();

	function publish(): void {
		const mapped = catalog ? mapCatalog(catalog) : { models: STATIC_MODELS, expiresAt: 0 };
		expiresAt = mapped.expiresAt;
		const config = {
			baseUrl: BASE_URL,
			apiKey: "$R4_API_KEY",
			api: "openai-completions" as const,
			models: mapped.models,
		};
		pi.registerProvider(PROVIDER_ID, config);
	}

	async function update(): Promise<void> {
		try {
			const live = await fetchModels(controller.signal);
			if (controller.signal.aborted) return;
			catalog = live;
			publish();
			const now = Date.now();
			retryAfter = expiresAt <= now ? now + REFRESH_INTERVAL_MS : 0;
			await saveCache(live);
		} catch (error) {
			if (controller.signal.aborted) return;
			retryAfter = Date.now() + REFRESH_INTERVAL_MS;
			// Expired discounts must not survive an outage; retain metadata at base prices.
			publish();
			console.error("[pi-r4-coder] Catalog refresh failed, keeping fallback prices:", error instanceof Error ? error.message : String(error));
		}
	}

	async function refresh(): Promise<void> {
		if (pending) return await pending;
		pending = update();
		try {
			await pending;
		} finally {
			pending = undefined;
		}
	}

	publish();
	void refresh();

	// No idle polling: refresh on R4 use, including tool-loop turns in long sessions.
	const ensureFresh = async (_event: unknown, ctx: { model?: { provider: string } }): Promise<void> => {
		if (ctx.model?.provider !== PROVIDER_ID) return;
		if (pending) return await pending;
		const now = Date.now();
		if (now < expiresAt) return;
		if (now >= retryAfter) await refresh();
		else publish(); // A cached promotion can expire while a failed startup refresh is backing off.
	};
	pi.on("before_agent_start", ensureFresh);
	// Pi snapshots the next model before turn_start, so refresh at the preceding turn_end.
	pi.on("turn_end", ensureFresh);
	pi.on("session_shutdown", async () => {
		controller.abort();
		await pending;
	});
}
