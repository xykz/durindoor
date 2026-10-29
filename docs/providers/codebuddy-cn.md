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
**2.177.0** — the release with the highest npm download volume, and therefore the
shape the gateway sees most often. The single source is
`open-sse/providers/codebuddyCli.js`.

### Mirrored

| Surface | Value | Source |
| --- | --- | --- |
| `User-Agent` | `CLI/<v> CodeBuddy/<v>` | CLI `buildUserAgent()` |
| `X-IDE-Version` | `<v>` | CLI `CliClientInfoProvider` (falls back to its own package version) |
| `X-Product` | `SaaS` | `product.json` `deploymentType` |
| `X-IDE-Type` / `X-IDE-Name` | `CLI` | CLI client-info provider |
| `X-Conversation-ID` | gateway session id, re-shaped to a dashed UUIDv7 | CLI session id |
| `X-Conversation-Request-ID`, `X-Root-Request-ID` | one per-attempt UUIDv7 (32 hex), identical in both headers | CLI per-prompt id |
| `X-Conversation-Message-ID` | one per-attempt UUIDv7 (32 hex) | CLI message id |
| `X-Request-ID` | the same 32-hex message id | CLI `X-Request-ID` |
| `X-Agent-Intent` | `craft` | CLI default session mode |
| `X-Agent-Runtime` | `other` | CLI default with no runtime metadata |
| `X-Agent-Type` | `main` | CLI default with no team/parent context |
| `X-Agent-Purpose` | `conversation` | CLI `AgentPurpose.Conversation` default |
| `X-Private-Data` | `false` | CLI `resolveModelOptimizationEnabled()` for a non-enterprise account |
| `x-codebuddy-request` | `1` | Present on a captured CLI chat request, despite appearing only at daemon call sites in the bundle |
| `x-requested-with` | `XMLHttpRequest` | Same — present on a captured chat request |
| `Accept` | `application/json` | OpenAI SDK `buildHeaders()`; the CLI streams via the body, not this header |
| `X-Stainless-Lang` / `-Package-Version` / `-OS` / `-Arch` / `-Runtime` / `-Runtime-Version` / `-Retry-Count` | `js`, `6.25.0`, mapped `process.platform`/`process.arch`, `node`, `process.version`, `0` | OpenAI SDK `getPlatformHeaders()`; the CLI's adapter never strips them |
| `cache_retention` (body) | `long`, or `short` via env | CLI `resolveCacheRetention()` |
| `verbosity` (body) | `high`, only when reasoning was requested | CLI model-settings interceptor (`text.verbosity`) |
| `reasoning_summary` (body) | `auto`, only when reasoning was requested | CLI `injectReasoningSummaryIfNeeded()` |
| `stream_options.include_usage` | `true` whenever `stream` is true | CLI openai body |
| `extra_vars.harnessMetadata` (body) | JSON string, `{schemaVersion:1, harnessVersion, stepIndex:0, contextWindowId, agent:{depth:0}}` | CLI `buildHarnessMetadata()` |
| `extra_vars.initiator` (body) | `user` | CLI `classifyUserMessageMarkers()` for a turn ending in an ordinary user message |
| `stream` | always `true` | CodeBuddy requirement, not CLI parity |

There is deliberately **no** `X-Stainless-Timeout`. The SDK would emit one for a
client with a timeout, but a captured 2.177.0 request does not carry it.

### How this table was derived

Two live chat requests from `@tencent-ai/codebuddy-code` 2.177.0 — one for
`default-model`, one for `glm-5.2` — were captured against a local stub upstream
rather than inferred from the bundle. That distinction matters: the CLI assembles
headers across three layers (the fetch adapter, a custom-header provider, and the
axios interceptor chain), so a source read reproduces only the first layer. A
source-only pass produced four wrong conclusions here — it dropped
`x-codebuddy-request` and `x-requested-with`, left `X-Conversation-Request-ID`
empty, and added a `X-Stainless-Timeout` that the CLI never sends. All four were
corrected against the capture. Re-do a capture, not a read, before changing any
row above.

The conversation id is anchored on the gateway's own session id, so consecutive
turns of one client session keep the same id. The CLI sends its session UUIDv7
verbatim; a non-UUIDv7 seed (a client-supplied id of any shape, or DurinDoor's
generated `uuid + timestamp` string) is hashed into a stable UUIDv7-shaped value,
because the gateway expects the CLI's shape and validates that nibble pattern on
conversation request ids. Request ids are minted per attempt; the CLI reuses one
message id across its retries, which is a deliberate, accepted difference.

`X-Conversation-Request-ID` and `X-Root-Request-ID` carry the *same* value — the
CLI's per-prompt `conversationRequestId`, which the capture showed as
`01a1862111327a898de142708d9f4f5a` while `X-Request-ID` was
`01a1862112127fae94693612b8643bdd`. They are therefore derived separately from the
message id, not from it. DurinDoor has no subagent or compaction pipeline, so the
per-prompt id doubles as the root id.

### Deliberately not mirrored

| Header / field | Why |
| --- | --- |
| `X-Userinfo`, `X-User-Id`, `X-Enterprise-Id`, `X-Auth-Method`, `X-Id-Source` | These are authenticated identity assertions derived from the CLI's own login session. DurinDoor does not store those fields, and synthesizing them would mean presenting a fabricated identity to the upstream. A capture of an unauthenticated CLI shows `X-User-Id: anonymous`, which confirms the value comes from the login state rather than being a constant. |
| `X-Domain`, `X-Tenant-Id`, `X-Department-Info` | The CLI emits these only under `CODEBUDDY_INTERNET_ENVIRONMENT=ioa` (internal deployments). Public SaaS traffic does not carry them. |
| `X-Skip-Auth-Interceptor`, `traceparent`, `b3`, `X-B3-*`, `X-Trace-ID`, `baggage` | Telemetry and gateway plumbing with no functional effect on chat. The CLI mints them from an OpenTelemetry span; there is nothing to mirror without a trace context. |
| `prompt_cache_retention`, `store` | Belong to the CLI's second request path (the OpenAI Agents SDK one). On `chat/completions` the CLI uses `cache_retention` instead and leaves these unset. |
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

### Version history

The fingerprint has moved twice. Recorded here so a future bump can tell an
intentional difference from a stale one.

| CLI release | What it contributes | Notes |
| --- | --- | --- |
| **2.108.1** (2026-06-18) | The six original identity headers — `X-Conversation-ID`, `X-Conversation-Request-ID`, `X-Conversation-Message-ID`, `X-Request-ID`, `X-Agent-Intent`, `X-IDE-Version` — plus the `CLI/<v> CodeBuddy/<v>` UA shape. | No `X-Agent-Runtime`, no `X-Agent-Type`, no `cache_retention` (the constants and the resolver do not exist in this release). This is the version v3.18.0 hardcoded, and it was already stale when it was written. |
| **2.172.1** (2026-10-21) | Adds `X-Agent-Runtime`, `X-Agent-Type` and the `cache_retention` body field (`resolveCacheRetention()` + `CODEBUDDY_DISABLE_PROMPT_CACHING_1H`). | First alignment target. Everything above except the Stainless headers and `verbosity` was already mirrored here. |
| **2.177.0** (2026-10-26) | Current target. Adds the bundled `openai@6.25.0` Stainless request headers and `X-Stainless-Timeout`. | Chosen because it is the most-downloaded release. `X-IDE-Version` resolves through `CliClientInfoProvider` to the package version, so it is `2.177.0`, not `0.0.0`. |

Two invariants held across all three releases and are worth re-checking on a
future bump: the CLI streams via `stream:true` in the body rather than an
`Accept: text/event-stream` header, and its compatibility rule chain is skipped
entirely for the product gateway host — so `SdkFieldCleanupRule` never deletes
the `reasoning_summary` / `verbosity` the CLI itself just added.

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
