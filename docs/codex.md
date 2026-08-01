# Codex Responses gateway

The gateway exposes the protocol Codex expects while retaining the existing
Chat Completions and Gemini-native routes.

| Route | Purpose |
| --- | --- |
| `GET /v1/models` | Authenticated Codex model catalog |
| `POST /v1/responses` | Authenticated streaming or non-streaming Responses API |
| `POST /v1/chat/completions` | Existing OpenAI-compatible Gemini route |
| `POST /v1beta/models/:modelAndMethod` | Existing Gemini-native route |

The Codex catalog contains:

- `gemini-3.6-flash`: stable default, 1,048,576-token context, reasoning
  `minimal` through `high`, default `medium`.
- `gemini-3.1-pro-preview-customtools`: optional preview for more difficult
  custom-tool work, reasoning `low` through `high`, default `high`. Its quality,
  quota, and availability may fluctuate.

## Production configuration

Set these variables in Railway:

```dotenv
RESPONSES_STATE_SECRET=<32 random bytes encoded as 64 hex characters or base64>
GEMINI_INTERACTIONS_PATH=/v1beta/interactions
GOOGLE_STREAM_IDLE_TIMEOUT_MS=300000
```

Generate the state secret without placing it in source control:

```bash
openssl rand -hex 32
```

`RESPONSES_STATE_SECRET` encrypts Gemini thought signatures and generated tool
steps with AES-256-GCM. The compressed, versioned envelope is bound to the
authenticated client ID and returned as `reasoning.encrypted_content`. The
gateway always sends `store: false` to Gemini so a later turn can use any ready
key in the pool.

Before rollout:

1. Rotate any proxy credential that has appeared in a tracked file.
2. Restart the service so the `source: "env-proxy"` client is reconciled to the
   new `PROXY_API_KEY`.
3. Verify the new credential succeeds and the exact old credential returns
   `401`.
4. Add `RESPONSES_STATE_SECRET`.
5. Reconcile the expected Gemini key count before bounded live validation.

Do not rewrite or force-push repository history to handle an already exposed
client credential. Rotation and revocation are the safe fix.

## Local Codex profiles

Codex loads a named profile from `$CODEX_HOME/<profile>.config.toml`. A profile
for the default model looks like this:

```toml
model = "gemini-3.6-flash"
model_provider = "gemini_pool"
model_reasoning_effort = "medium"
model_reasoning_summary = "auto"

[model_providers.gemini_pool]
name = "Artoody Gemini Pool"
base_url = "https://fallback-production.up.railway.app/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 300000
supports_websockets = false

[model_providers.gemini_pool.auth]
command = "/usr/bin/security"
args = ["find-generic-password", "-s", "artoody-fallback-codex", "-a", "codex", "-w"]
timeout_ms = 5000
refresh_interval_ms = 0
```

Store the dedicated client credential in macOS Keychain, never in the TOML:

```bash
/usr/bin/security add-generic-password -U \
  -s artoody-fallback-codex \
  -a codex \
  -w
```

Create `gemini-pool-pro.config.toml` by changing only the model to
`gemini-3.1-pro-preview-customtools` and reasoning effort to `high`.

Run either profile with:

```bash
codex --profile gemini-pool
codex --profile gemini-pool-pro
```

Provider retries are deliberately zero. The gateway owns safe, pre-stream key
rotation and Codex must not replay a partially delivered response. WebSocket
transport is disabled.

## Translation boundaries

Supported inputs include text and base64 data-URI images. The gateway never
fetches a user-supplied remote image URL. Audio, file inputs, and unsupported
hosted tools return explicit `400` errors.

Supported tools include Responses functions, namespace functions, free-form
custom tools, and `web_search`. Namespace tool names are flattened into safe
Gemini names and restored on the way back to Codex. Custom tools use a single
string `input` parameter. Google Search results become Responses web-search
lifecycle items and URL citation annotations.

Stateful Responses options (`store: true`, `background: true`, and
`previous_response_id`) are rejected. Stateless encrypted reasoning replay is
the supported multi-turn mechanism.

## Verification

Run:

```bash
npm test
npm run test:integration
npm run test:codex
npm run stress
```

`test:codex` uses the installed Codex CLI against a local mock gateway. It
checks warning-free model-catalog parsing, streaming text, encrypted multi-turn
state, a custom edit, and a shell verification in a disposable repository.

The deterministic stress runner checks:

- 1,700 healthy requests at concurrency 50 with an exactly even 17-key starting
  distribution.
- 1,000 mixed requests at concurrency 50 with retryable failures, fragmented
  SSE, tool calls, cooldowns, and partial-stream failures.
- p95 gateway overhead and event-loop lag below 100 ms.
- RSS growth below 100 MiB.
- no credential or state-envelope leakage in its report.

Real-key validation must remain bounded to 12 jobs at concurrency 3: ten Flash
jobs and two optional Pro smoke jobs. Treat a pool-wide Pro quota failure as an
upstream quota limitation; Flash is the required acceptance path.

## Operational limitation

Cooldown and round-robin state is in memory. Run one application instance.
Multiple instances require distributed coordination such as Redis, which is
outside this implementation.

After merge and deployment, verify health, the model catalog, Flash streaming,
one edit/test tool loop, old-key `401`, and existing Chat Completions and
Gemini-native smoke requests. Do not load-test Railway production.
