# pi-r4-coder

A minimal pi extension that adds the **R4 Coder** ([r4.codes](https://r4.codes)) model provider via an OpenAI-compatible API.

R4 Coder serves coding-agent models (Kimi K3, DeepSeek V4.1 Flash, GLM 5.3, Grok 4.6, …) from a single `https://api.r4.codes/v1` endpoint that speaks OpenAI Chat Completions, OpenAI Responses and Anthropic Messages.

## Features

- **Dynamic model discovery** — model list, pricing, context windows and reasoning-effort tiers are pulled live from `GET /v1/models` at startup.
- **Disk cache** — the live catalog is cached in `~/.pi/agent/cache/pi-r4-coder/models.json`, so restarts (and offline starts) start from the last known good list instead of a stale snapshot.
- **Static seed fallback** — a bundled model snapshot is used when neither cache nor API is available.
- **Never blocks startup** — the provider registers immediately; the live refresh happens in the background.

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

Thinking levels map directly to R4 effort tiers (`minimal` … `max`); `off` maps to R4's `none`.

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
- `GET /v1/models` requires authentication on R4; the extension resolves the key from the same sources (`R4_API_KEY` env var or `auth.json`) for the background refresh.
- `maxTokens` defaults to the model's full context window because R4 does not publish a separate output cap.

## License

MIT
