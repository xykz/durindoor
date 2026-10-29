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
**2.138.0**. The choice is not "newest" but "newest release that needs no
counterfeiting": 2.138.0 is the last widely-used build before upstream switched its
ids from random UUIDv4 to clock-stamped UUIDv7 (2.146.0), so every id this gateway
sends can be produced honestly from randomness. The single source is
`open-sse/providers/codebuddyCli.js`.

### Mirrored

| Surface | Value | Source |
| --- | --- | --- |
| `User-Agent` | `CLI/<v> CodeBuddy/<v>` | CLI `buildUserAgent()` |
| `X-IDE-Version` | `<v>` | CLI `CliClientInfoProvider` (falls back to its own package version) |
| `X-Product` | `SaaS` | `product.json` `deploymentType` |
| `X-IDE-Type` / `X-IDE-Name` | `CLI` | CLI client-info provider |
| `X-Conversation-ID` | gateway session id, hashed to a dotted UUIDv4 (or passed through when already a UUID) | CLI session id |
| `X-Conversation-Request-ID`, `X-Root-Request-ID` | one per-attempt 32-hex trace id, identical in both headers | CLI per-prompt id, which seeds the trace |
| `X-Conversation-Message-ID` | one per-attempt 32-hex UUIDv4 | CLI message id |
| `X-Request-ID` | the same message id | CLI `X-Request-ID` |
| `traceparent` | `00-<traceId>-<spanId>-01` | CLI `injectOtelSpanHeaders()` |
| `b3` | `<traceId>-<spanId>-1-<parentSpanId>` | Same |
| `X-B3-TraceId`, `X-Trace-ID` | the same 32-hex trace id as `X-Conversation-Request-ID` | Same — one value under four names |
| `X-B3-SpanId` / `X-B3-ParentSpanId` | per-attempt random 16-hex ids | Same |
| `X-B3-Sampled` | `1` | Same; the model-call span uses the default sampler |
| `X-Agent-Intent` | `craft` | CLI default session mode |
| `X-Agent-Type` | `main` | CLI default with no team/parent context |
| `X-Agent-Purpose` | `conversation` | CLI `AgentPurpose.Conversation` default |
| `X-Private-Data` | `false` for a consumer account, `true` for an enterprise one | CLI `resolveModelOptimizationEnabled()`, disabled for enterprise accounts |
| `X-User-Id` | token `sub` | CLI `runIdentityHeaders()`; see [Identity headers](#identity-headers) |
| `X-Domain` | `iss` host, e.g. `www.codebuddy.cn` | CLI `tryExtractUserIDFromJWTToken()` |
| `X-Enterprise-Id` / `X-Tenant-Id` | only for an `sso-` issuer | CLI `enterpriseHeaders()`; consumer accounts carry neither |
| `X-User-Id` (API-key accounts) | `anonymous_<last 8 of the key>` | CLI API-key storage's `getUserId()` |
| `x-codebuddy-request` | `1` | Present on a captured CLI chat request, despite appearing only at daemon call sites in the bundle |
| `x-requested-with` | `XMLHttpRequest` | Same — present on a captured chat request |
| `Accept` | `application/json` | OpenAI SDK `buildHeaders()`; the CLI streams via the body, not this header |
| `X-Stainless-Lang` / `-Package-Version` / `-OS` / `-Arch` / `-Runtime` / `-Runtime-Version` / `-Retry-Count` | `js`, `6.25.0`, mapped `process.platform`/`process.arch`, `node`, `process.version`, `0` | OpenAI SDK `getPlatformHeaders()`; the CLI's adapter never strips them |
| `verbosity` (body) | `high`, only when reasoning was requested | CLI model-settings interceptor (`text.verbosity`) |
| `reasoning_summary` (body) | `auto`, only when reasoning was requested | CLI `injectReasoningSummaryIfNeeded()` |
| `stream_options.include_usage` | `true` whenever `stream` is true | CLI openai body |
| `stream` | always `true` | CodeBuddy requirement, not CLI parity |

Two body fields that later releases add are deliberately **absent**, because
2.138.0 predates both: `cache_retention` and `extra_vars` with `harnessMetadata`
(both first captured in 2.172.1). Sending them while claiming to be 2.138.0 would
be a newer-client tell.

`verbosity` needs a note because it does *not* travel with the rest of the newer
fields. Captured bodies show it present from 2.108.1 through 2.147.0 — always
alongside `reasoning_effort` and `reasoning_summary`, and never on a request that
asked for no reasoning — then absent from 2.164.0 onward. So on 2.138.0 it belongs
with the reasoning trio, not with the newer additions.

There is deliberately **no** `X-Agent-Runtime` and **no** `baggage`. 2.138.0 sends
neither; `X-Agent-Runtime` first ships in 2.172.1 and `baggage` in 2.164.0.

There is deliberately **no** `X-Stainless-Timeout`. The SDK would emit one for a
client with a timeout, but no captured request carries it.

### How this table was derived

Live chat requests from real `@tencent-ai/codebuddy-code` builds across a dozen
releases (2.108.1 through 2.177.0) were captured against a local stub upstream
rather than inferred from the bundle. That distinction matters: the CLI assembles
headers across three layers (the fetch adapter, a custom-header provider, and the
axios interceptor chain), so a source read reproduces only the first layer. A
source-only pass produced four wrong conclusions here — it dropped
`x-codebuddy-request` and `x-requested-with`, left `X-Conversation-Request-ID`
empty, and added a `X-Stainless-Timeout` that the CLI never sends. All four were
corrected against the capture. It also mis-dated several fields: `x-agent-runtime` is absent from everything
before 2.172.1, `baggage` from everything before 2.164.0, `cache_retention` and
`extra_vars` from the whole 2.108–2.171 range, and `verbosity` from everything
*after* 2.147.0. Re-do a capture, not a read, before changing any row above.

The conversation id is anchored on the gateway's own session id, so consecutive
turns of one client session keep the same id. 2.138.0 sends its session id as an
ordinary UUIDv4, so a seed that is already a UUID is forwarded verbatim and any
other seed is hashed straight to a UUIDv4 — no clock value is embedded. This is the
whole reason 2.138.0 was picked: from 2.146.0 onward the CLI mints UUIDv7, whose
first 48 bits are a real creation timestamp, and a gateway can only imitate that by
inventing a time. Request ids are minted per attempt; the CLI reuses one
message id across its retries, which is a deliberate, accepted difference.

`X-Conversation-Request-ID`, `X-Root-Request-ID`, `X-B3-TraceId` and `X-Trace-ID`
carry the *same* value — 2.138.0 seeds its model-call span's trace id from the
per-prompt id (`el.traceId = eh, el.conversationRequestId = eh`), and the capture
showed all four byte-identical while `X-Request-ID` held the different message id
(`1369a47df2d741448e0152dfc573b573` vs `x-conversation-message-id`). They are
therefore derived separately from the message id, not from it. DurinDoor has no
subagent or compaction pipeline, so the per-prompt id doubles as the root id.

The remaining trace headers are computed from that one trace id plus two random
16-hex span ids, exactly as `injectOtelSpanHeaders()` does. Note that the CLI can
also *adopt* an inbound trace: `createOtelParentContextFromTraceHeaders()` reads
`b3` (or `x-b3-traceid`/`x-trace-id` + `x-b3-spanid` + `x-b3-sampled`), requires
`/^[0-9a-f]{32}$/i` and `/^[0-9a-f]{16}$/i`, and uses it as the parent span.

### Deliberately not mirrored

| Header / field | Why |
| --- | --- |
| `X-Userinfo`, `X-Auth-Method`, `X-Id-Source` | The CLI builds these from login-flow metadata (`auth.method`, `account.idSource`) that a stored OAuth token does not carry. Two captures — one consumer, one enterprise — both lacked all three. |
| `X-Department-Info` | Requires the account's department name, which no token claim carries. Absent from both captures. |
| `X-Skip-Auth-Interceptor`, `traceparent`, `b3`, `X-B3-*`, `X-Trace-ID`, `baggage` | Telemetry and gateway plumbing with no functional effect on chat. The CLI mints them from an OpenTelemetry span; there is nothing to mirror without a trace context. |
| `prompt_cache_retention`, `store` | Belong to the CLI's second request path (the OpenAI Agents SDK one). On `chat/completions` the CLI uses `cache_retention` instead and leaves these unset. |
| System-prompt rewriting | See below — DurinDoor forwards third-party agent prompts by design. |

### Identity headers

`X-User-Id`, `X-Domain`, `X-Enterprise-Id`, `X-Tenant-Id` and `X-Private-Data` **are**
mirrored, derived from the account's access token the same way the CLI derives them
from its own session:

| Header | Source | Consumer account | Enterprise account |
| --- | --- | --- | --- |
| `X-User-Id` | token `sub` | present | present |
| `X-Domain` | `iss` host | `www.codebuddy.cn` | `www.codebuddy.cn` |
| `X-Enterprise-Id`, `X-Tenant-Id` | `iss` last segment when it starts with `sso-` | absent | present, prefix stripped |
| `X-Private-Data` | `resolveModelOptimizationEnabled()` — off for enterprise | `false` | `true` |

This was established by capturing the same CLI build twice: once with a real account
token and once without. The unauthenticated run carried `X-User-Id: anonymous` and no
`X-Domain`; the authenticated run carried the token's `sub` and the issuer host. A
synthetic `sso-` issuer reproduced the enterprise branch, where `X-Private-Data`
flipped to `true` and the tenant/enterprise ids appeared.

A third capture, run with `CODEBUDDY_API_KEY` instead of a token, carried
`X-User-Id: anonymous_12345678` — the key's last eight characters behind the CLI's
`anonymous_` prefix — and still no `X-Domain`. That is the CLI's API-key storage path,
where there are no claims to read.

An unreadable token with no API key emits none of these and keeps the non-enterprise
`X-Private-Data: false` default, so an unidentified caller degrades to the
unauthenticated shape rather than to a wrong identity.

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

The fingerprint has moved several times, mostly backwards. Recorded here so a
future bump can tell an intentional difference from a stale one.

The id-generation cutover is at **2.146.0**: every release up to and including
2.145.0 mints ordinary UUIDv4 for sessions and message ids; 2.146.0 onward mints
UUIDv7, whose first 48 bits are the creation timestamp. Upstream only began
rejecting non-v7 conversation request ids in 2.177.0 (`"conversationRequestId must
be a lowercase UUIDv7 encoded as 32 hexadecimal characters"`; zero occurrences
before it). Mirroring 2.146.0–2.176.x therefore forces a gateway to synthesize a
timestamp it does not have; mirroring 2.177.x additionally forces the id to pass a
shape check patterned on "now".

| CLI release | What it contributes | Notes |
| --- | --- | --- |
| **2.108.1** (2026-06-18) | The six original identity headers — `X-Conversation-ID`, `X-Conversation-Request-ID`, `X-Conversation-Message-ID`, `X-Request-ID`, `X-Agent-Intent`, `X-IDE-Version` — plus the `CLI/<v> CodeBuddy/<v>` UA shape. | No `X-Agent-Runtime`, no `X-Agent-Type`, no `cache_retention` (the constants and the resolver do not exist in this release). This is the version v3.18.0 hardcoded, and it was already stale when it was written. |
| **2.138.0** (2026-08-24) | **Current target.** Adds `X-Agent-Type` and `X-Root-Request-ID` over 2.108.1, plus the seven `b3`/`traceparent`/`X-B3-*`/`X-Trace-ID` headers, which turn out to be present this far back. | Chosen because it is the newest release that still mints UUIDv4 — so DurinDoor never counterfeits a timestamp — while sending every business header the current releases send. A capture matched it 35/35 with zero missing and zero extra headers, and 2.145.0 matches identically. No `baggage`, no `X-Agent-Runtime`. |
| **2.145.0** (2026-09-05) | Last UUIDv4 release. Request surface identical to 2.138.0. | Equivalent target; differs only in its own prompt and tool-ordering content, which is client data, not fingerprint. |
| **2.146.0** (2026-09-06) | First UUIDv7 release. | The cutover. Not a viable target: ids would need an invented timestamp. |
| **2.164.0** (2026-10-09) | Adds `baggage` (`codebuddy.session_id=…,codebuddy.conversation_request_id=…`). **Drops** `verbosity`, `reasoning_effort` and `reasoning_summary` from the captured body. | Still UUIDv7. The reasoning trio returning in 2.172.1 is a separate change from `cache_retention`. |
| **2.172.1** (2026-10-21) | Adds `X-Agent-Runtime`, `cache_retention` (`resolveCacheRetention()` + `CODEBUDDY_DISABLE_PROMPT_CACHING_1H`) and `extra_vars`; the reasoning trio is back in the body (without `verbosity`). | Earlier alignment target; superseded. |
| **2.174.0** (2026-10-23) | Adds `harnessMetadata.contextWindowId` inside `extra_vars`. | First release whose harness metadata points at a context window. |
| **2.177.0** (2026-10-26) | Adds `harnessMetadata.contextWindowId` and validates conversation request ids against a UUIDv7 pattern. | The most-downloaded release, but a worse target precisely because of those two additions. |

Two invariants held across every release and are worth re-checking on a
future bump: the CLI streams via `stream:true` in the body rather than an
`Accept: text/event-stream` header, and its compatibility rule chain is skipped
entirely for the product gateway host — so `SdkFieldCleanupRule` never deletes
the `reasoning_summary` / `verbosity` the CLI itself just added.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `CODEBUDDY_CLI_VERSION` | pinned mirror release | Version used for `User-Agent` and `X-IDE-Version`. |
| `CODEBUDDY_CLI_ALIGNMENT` | unset | `off` disables every mirrored header (including the trace set) — the one-line rollback. |
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
