# pi-r4-coder

A minimal pi extension that adds the **R4 Coder** ([r4.codes](https://r4.codes)) model provider via an OpenAI-compatible API.

R4 Coder serves coding-agent models (Kimi K3, DeepSeek V4.1 Flash, GLM 5.3, Grok 4.7, …) from a single `https://api.r4.codes/v1` endpoint that speaks OpenAI Chat Completions, OpenAI Responses and Anthropic Messages.

## Features

- **Dynamic model discovery** — joins `GET /v1/models` (IDs, context, effort tiers, base prices) with `GET /v1/models/info` (output limits, input modalities, effective prices) by `id` / `slug`.
- **Temporary discounts** — uses server-resolved `pricing_effective`, including off-peak rates and limited-time promotions. Before an R4 prompt or tool-loop turn, refreshes prices older than 60 seconds or past a known `window_ends_at`. No idle polling or local timetable interpreter.
- **Disk cache** — both catalogs are cached in `~/.pi/agent/cache/pi-r4-coder/models.json`. Offline starts preserve model capabilities but use base prices once the effective-price snapshot expires. Old-format caches are replaced after the next successful refresh.
- **Static seed fallback** — a bundled model snapshot is used when neither cache nor API is available.
- **Never blocks startup** — the provider registers immediately; the live refresh happens in the background. R4 turns await a pending or due refresh, bounded by a 10-second HTTP timeout. Failed refreshes retain the last valid catalog and retry no more than once a minute.

## Files

- `index.ts` — registers the `r4` provider and model list.
- `test.ts` — unit tests + integration checks (`/models`, chat, streaming, tools, reasoning effort, vision).

## Install

```bash
pi install git:github.com/ZoRDoK/pi-r4-coder
```

## API key

Supported sources (in priority order):

1. `R4_API_KEY` environment variable
2. `~/.pi/agent/auth.json` → `r4.key`

Example `auth.json` fragment:

```json
{
	"r4": {
		"type": "api_key",
		"key": "coder_..."
	}
}
```

Get a key at [r4.codes/dashboard/api-keys](https://r4.codes/dashboard/api-keys).

## Usage

In pi:

```text
/model r4/deepseek-v4.1-flash
```

Thinking levels map directly to R4 effort tiers (`minimal` … `max`); `off` maps to R4's `none`. For models whose `/v1/models` entry omits or misstates the tiers (currently `grok-4.7`), a small built-in table applies the tiers the model actually accepts (low…xhigh, no `off`).

## Run tests

```bash
git clone https://github.com/ZoRDoK/pi-r4-coder.git
cd pi-r4-coder

# Unit tests (no API calls)
node --experimental-strip-types --no-warnings test.ts

# All tests, including live API (uses R4_API_KEY or auth.json)
node --experimental-strip-types --no-warnings test.ts --all
```

## Secret scan (gitleaks)

```bash
cd pi-r4-coder
gitleaks dir . --config .gitleaks.toml
```

## Notes

- Upstream docs: [r4.codes/docs](https://r4.codes/docs)
- Both catalog endpoints use the same authentication sources (`R4_API_KEY` env var or `auth.json`).
- Effort tiers come from `effort.tiers`; the built-in table only covers models where that field is missing or wrong (`grok-4.7`).
- `maxTokens` comes from `max_output_tokens`, capped by the context window. Image support comes from `input_modalities`, not a hardcoded live-model allowlist.
- Pi's cost display is an estimate, not the R4 billing ledger: timetable changes can lag by up to the 60-second cache lifetime; during API outages, expired effective prices fall back to base rates. Previously recorded usage costs are not recalculated.

## License

MIT
