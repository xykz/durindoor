# CodeBuddy CN

DurinDoor exposes Tencent's CodeBuddy CN gateway as the `codebuddy-cn` provider
(model prefix `cbcn`). Two auth modes are supported: the browser OAuth polling
flow used by the official plugin/CLI, and a static API key.

CodeBuddy rejects non-streaming chat requests (HTTP 400, `code 11101`), so
`transport.forceStream` is set and DurinDoor re-aggregates the SSE stream for
clients that asked for JSON.

## Authentication

### OAuth (recommended)

The flow mirrors the official CLI's `/v2/plugin/auth/*` endpoints:

1. `POST /v2/plugin/auth/state?platform=CLI` returns `{ state, authUrl }`.
2. The dashboard opens `authUrl`; DurinDoor polls
   `GET /v2/plugin/auth/token?state=<state>` every 5 s.
3. Refresh uses `POST /v2/plugin/auth/token/refresh` with `X-Refresh-Token` and
   `X-Auth-Refresh-Source: plugin`, and an empty `{}` body, matching the CLI.
   A `401`/`403` from the refresh endpoint is treated as unrecoverable: the
   connection is marked for re-auth rather than retried.

### API key

Set the key on the connection. DurinDoor sends it as
`Authorization: Bearer <key>`, the same header shape the CLI uses.

## Models

The registry tracks the CodeBuddy CN catalog; `open-sse/providers/capabilities.js`
carries authoritative per-model context/output limits because the gateway's own
model metadata is not exposed on every endpoint.

| Model | Context | Max output | Notes |
| --- | --- | --- | --- |
| `glm-5.2` | 1,000,000 | 48,000 | |
| `glm-5.1` | 200,000 | 48,000 | |
| `glm-5.0` | 200,000 | 48,000 | |
| `glm-5.0-turbo` | 200,000 | 48,000 | |
| `glm-5v-turbo` | 200,000 | 38,000 | vision |
| `glm-4.7` | 200,000 | 48,000 | |
| `minimax-m3` | 512,000 | 48,000 | vision |
| `minimax-m2.7` | 200,000 | 48,000 | vision |
| `kimi-k2.7` | 256,000 | 32,000 | |
| `kimi-k2.6` | 256,000 | 32,000 | |
| `kimi-k2.5` | 164,000 | 32,000 | |
| `hy3-preview` | 192,000 | 64,000 | vision |
| `deepseek-v4-pro` | 1,000,000 | 50,000 | |
| `deepseek-v4-flash` | 1,000,000 | 50,000 | |
| `deepseek-v3-2-volc` | 96,000 | 32,000 | |

Every model takes reasoning through OpenAI-style `reasoning_effort`, not its
vendor-native thinking shape; `transport.thinkingFormat` is pinned to `openai`
for that reason.

## CLI alignment contract

DurinDoor mirrors the request fingerprint of `@tencent-ai/codebuddy-code` so
traffic is shaped like the vendor's own client. The current mirror target is
**2.172.1**; the single source is `open-sse/providers/codebuddyCli.js`.

### Mirrored

| Surface | Value | Source |
| --- | --- | --- |
| `User-Agent` | `CLI/<v> CodeBuddy/<v>` | CLI `buildUserAgent()` |
| `X-IDE-Version` | `<v>` | CLI client-info provider |
| `X-Product` | `SaaS` | `product.json` `deploymentType` |
| `X-IDE-Type` / `X-IDE-Name` | `CLI` | CLI client-info provider |
| `X-Conversation-ID` | derived from the gateway session id | CLI session id |
| `X-Conversation-Request-ID`, `X-Conversation-Message-ID` | one per-attempt 32-hex id | CLI message id pair |
| `X-Request-ID` | the same 32-hex id | CLI `X-Request-ID` |
| `X-Agent-Intent` | `craft` | CLI default session mode |
| `X-Agent-Runtime` | `other` | CLI default with no runtime metadata |
| `X-Agent-Type` | `main` | CLI default with no team/parent context |
| `cache_retention` (body) | `long`, or `short` via env | CLI `resolveCacheRetention()` |
| `stream_options.include_usage` | `true` when streaming | CLI openai-compatible path |
| `stream` | always `true` | CodeBuddy requirement, not CLI parity |

The conversation id is anchored on the gateway's own session id, so consecutive
turns of one client session keep the same id. A non-UUID seed is hashed into a
stable UUID-shaped value because the upstream expects that shape. Request ids are
minted per attempt; the CLI reuses one message id across its retries, which is a
deliberate, accepted difference.

### Deliberately not mirrored

| Header / field | Why |
| --- | --- |
| `X-Userinfo`, `X-User-Id`, `X-Enterprise-Id`, `X-Auth-Method`, `X-Id-Source` | These are authenticated identity assertions derived from the CLI's own login session. DurinDoor does not store those fields, and synthesizing them would mean presenting a fabricated identity to the upstream. |
| `X-Domain`, `X-Tenant-Id` | The CLI emits these only under `CODEBUDDY_INTERNET_ENVIRONMENT=ioa` (internal deployments). Public SaaS traffic does not carry them. |
| `x-codebuddy-request` | The CLI sends this only on its local daemon endpoints (`/api/v1/info`, `/api/v1/health`), never on chat. The billing/quota fetchers still send it, because that endpoint was historically probed with it. |
| `X-Skip-Auth-Interceptor`, `traceparent`, `b3`, `X-Trace-ID` | Telemetry and gateway plumbing with no functional effect on chat. |
| System-prompt rewriting | See below — DurinDoor forwards third-party agent prompts by design. |

### Deliberate divergences in behavior

**System prompt replacement.** CodeBuddy rejects coding-agent system identities
(decolua/9router#3342). The official CLI never hits this because it sends its own
`cli-agent-prompt`. DurinDoor forwards prompts from Claude Code, Cursor, Cline and
similar tools, so `CodeBuddyExecutor.transformRequest` replaces a system message
that matches a coding-agent identity marker, or that exceeds
`CODEBUDDY_SYSTEM_PROMPT_MAX_LEN` (default 2,000), with a neutral prompt and logs
`[codebuddy-cn] system prompt replaced: ...`. Removing this would reintroduce the
rejection it exists to avoid.

**Reasoning is opt-in.** The CLI defaults `alwaysThinkingEnabled` to on and
therefore stamps `reasoning_summary: "auto"` on reasoning-capable models. DurinDoor
does the opposite: it sets `reasoning_summary` only when the client explicitly
asked for reasoning. Forcing reasoning on plain requests makes CodeBuddy trip its
content filter and return an error (decolua/9router#2071).

**Timeout budget.** The CLI allows 1,200,000 ms for the first token. DurinDoor's
stream/first-chunk budgets are much smaller (`STREAM_FIRST_CHUNK_TIMEOUT_MS`,
default 200,000 ms) so a dead upstream fails fast rather than hanging a client.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `CODEBUDDY_CLI_VERSION` | pinned mirror release | Version used for `User-Agent` and `X-IDE-Version`. |
| `CODEBUDDY_DISABLE_PROMPT_CACHING_1H` | unset | Truthy → `cache_retention: "short"` instead of `"long"`. |
| `CODEBUDDY_CLI_ALIGNMENT` | unset | `off` disables the mirrored headers and `cache_retention` entirely — the one-line rollback. |
| `CODEBUDDY_SYSTEM_PROMPT_MAX_LEN` | `2000` | Prompt length threshold for the replacement rule; `0` disables the length rule only. |

## Usage and quota

The dashboard Usage panel reads `POST /v2/billing/meter/get-user-resource`, which
returns a doubly-wrapped Tencent billing payload (`data.Response.Data.Accounts[]`).
Two credit types are reported separately and must not be merged:

- **Refill / base allowance** — recurring, read from the `Cycle*` fields, labelled
  by cadence (`Monthly` / `Weekly` / `Daily`).
- **Bonus credits** — one-shot, read from the plain `Capacity*` fields, labelled
  `Bonus Pack N` and ordered soonest-expiring first.

Quota-aware selection also enforces a rolling 24-hour token budget per account
(`open-sse/services/quota/providers/codingPlans.js`); when every account is
budget-capped the provider reports `allRateLimited`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `400` with `code 11101` | A non-stream request reached the gateway | DurinDoor forces `stream: true`; check for a proxy rewriting the body. |
| `[codebuddy-cn] system prompt replaced: IDENTITY rule` in logs | The client sent a coding-agent system prompt | Expected. Raise `CODEBUDDY_SYSTEM_PROMPT_MAX_LEN` only affects the length rule. |
| `[codebuddy-cn] system prompt replaced: LENGTH rule` in logs | The system prompt exceeded the limit (RTK caveman/ponytail injection adds ~1.7–1.9k characters) | Raise the limit or set `0`. |
| Plain requests return a content-filter error | Reasoning was forced on a request that did not ask for it | Keep the opt-in behavior; do not add `reasoning_summary` unconditionally (#2071). |
| `401`/`403` that never recovers | Refresh token revoked or expired | Re-run the OAuth flow; refresh failures are treated as unrecoverable by design. |
| Upstream rejects the mirrored headers | Vendor changed its fingerprint validation | Set `CODEBUDDY_CLI_ALIGNMENT=off` to revert, then file an issue. |
