# Smart Routing

Smart routing is the path from a client model string to a real upstream request. DurinDoor resolves the requested model, selects credentials, translates the request when formats differ, streams the upstream response back to the client, and records usage.

## Routing Pipeline

```text
Client request
  -> API route under /v1
  -> model or combo resolution
  -> provider and credential selection
  -> request normalization
  -> format translation
  -> upstream provider call
  -> stream translation
  -> usage extraction and logging
```

The chat pipeline is implemented across `src/sse` and `open-sse`. Other API families use the same provider and credential concepts but have endpoint-specific handlers.

## Model Resolution

DurinDoor accepts several model string types:

| Model string type | Example | Resolution |
| --- | --- | --- |
| Provider model | `openai/gpt-4.1` | Provider ID plus upstream model. |
| Provider alias model | `cc/claude-sonnet` | Alias resolved through the provider registry. |
| Compatible node model | `openai-compatible-lab/model-name` | Custom provider node plus upstream model. |
| Model alias | `daily-coder` | User-defined alias mapped to another model. |
| Combo name | `coding-default` | Ordered fallback chain. |

Use `/v1/models` or the dashboard model selector to confirm the exact values available in a running instance.

## Provider Selection

After resolving the model, DurinDoor identifies the target provider and service kind. The service kind matters because not every provider supports every endpoint.

Common service kinds:

- `llm` for chat, messages, and responses.
- `embedding` for `/v1/embeddings`.
- `image` for image generation or editing.
- `tts` for speech generation.
- `stt` for transcription and translation.
- `webSearch` for `/v1/search`.
- `webFetch` for `/v1/web/fetch`.

## Credential Selection

If a provider has multiple connections, DurinDoor selects an available connection and avoids accounts that are temporarily locked, expired, or excluded by the current fallback attempt. Provider-specific code can refresh credentials when the upstream supports refresh.

Account-wide locks apply to every model until expiry, even when the connection also carries an expired model-specific lock.

For round-robin providers, behavior depends on whether a stable client session id is present:

- When the client supplies a session id (via `x-session-id`, `session-id`, `session_id`, `x-amp-thread-id`, or embedded body fields), DurinDoor pins that session to the first available account and keeps routing to the same account until it becomes unavailable or the in-memory affinity entry expires (default session TTL). This is the "session-sticky" round-robin path.
- Requests without a session id continue to use the request-count round-robin governed by `stickyRoundRobinLimit` (default 3 consecutive uses on the same account before rotating).
- For Kiro specifically, the request-scoped `x-client-request-id` header is intentionally ignored for account affinity so that per-request IDs do not break stickiness. Other scopes still allow `x-client-request-id` as a session hint.
- A session whose pinned account is excluded or locked falls back to the next available account and re-anchors there for that session.

Generated connection sessions and assistant-anchored conversation sessions are also bounded in memory. Reads refresh their recency, so reaching the 1,000-connection or 5,000-conversation safety cap evicts the least-recently-used entry rather than rotating an active session and losing its warm prompt cache.

Two per-request headers tune account selection:

- `x-connection-id` accepts either one connection id (a hard pin: the request fails rather than rotating if that account is unavailable) or a comma-separated list (a candidate pool: selection still round-robins within the pool, and a member failure rotates to the next pool member; if no pool member is available the request fails rather than falling back outside the pool).
- `x-session-affinity-ttl` overrides the session-affinity TTL for that request. A bare number is seconds (`600`), explicit units are honored (`500ms`, `30s`, `10m`, `1h`), and `off`/`none`/`disabled`/`0` disables affinity so the request re-balances immediately. Missing or malformed values keep the default. Expiry stays sliding: an active session keeps refreshing its entry.

### CodeBuddy CN token budget

CodeBuddy CN throttles an account once its trailing 24-hour token total approaches roughly 2×10⁸ tokens. Two mechanisms keep traffic inside that ceiling:

- **Rolling-24h balancing.** New round-robin sessions prefer the account with the lowest `promptTokens + completionTokens` over the trailing 24 hours (from `usageHistory`), falling back to `lastUsedAt`/`priority` on ties or read failure. This uses a rolling window rather than a calendar day so a midnight rollover cannot reset a still-hot account.
- **Per-request budget.** The `x-connection-token-budget` header (bare counts or `k`/`m`/`b` suffixes, e.g. `180m` or `180000000`) drops any account at or above that trailing-24h total from the candidate pool. If every account in scope reaches the budget, selection returns a 503 `allRateLimited` rather than routing to a throttled account. The budget applies to CodeBuddy CN only; without the header there is no budget.

### Allowance strategies (CodeBuddy CN)

The `x-account-strategy` header selects an allowance-driven ordering instead of the default rotation. It is honoured **only** for `codebuddy-cn`; on any other provider the header is ignored and routing is unchanged. There is no dashboard setting — the choice is per request.

| Value | What it orders by |
| --- | --- |
| `least-used` | The account that has spent the least of its reported allowance goes first. |
| `use-before-expiry` | Whatever allowance is left is spent before it is lost, soonest loss first. |

Both read the persisted per-account quota snapshots (`docs/features/quota-tracking.md`), not the trailing-24h token totals that drive the default rotation. An account's position comes from its **fullest** window rather than an average, because the upstream refuses once any single pool is empty — the tightest pool is what the account can still serve.

`least-used` orders known-with-room accounts by share spent, then accounts with no reading at all, then those running low, then those already spent or cooling. An unread account is never treated as an unused one: that is how a paid balance gets drained while a subscription pool nobody read sits idle.

`use-before-expiry` orders every account that still holds allowance by when that allowance is lost, then the accounts that report no expiry, then empty or cooling ones. Within the same expiry, the account with more room goes first: both packs are lost at the same moment, so the amount wasted is whatever is left unspent, and sending traffic to the account about to run dry only causes a mid-request refusal. This deliberately departs from magpie's free-before-paid partitioning — that shape exists to keep a *group* from spending money, whereas here the goal is to burn a single provider's expiring allowance.

A window whose reset time has passed counts as renewed rather than as unknown, so a stale reading can still rank an account instead of dropping it out of the plan.

While an allowance strategy is in force, the round-robin sticky count, the 24h token totals, and the quota score ranking are all bypassed — the plan decides the order itself. They return as soon as the header is absent.

A conversation keeps its account for as long as its turn is open, and is re-planned at every new turn. A turn stays open across tool round-trips (a user message carrying only tool results does not start a new one) and closes when the user speaks again. This keeps one task on one warm prompt cache without letting a long session pin an account past its allowance. The turn is derived from the request body, so no extra header is needed. An explicit `x-connection-id` pin still wins over the plan.

Allowance readings are kept warm by a background whole-pool refresh: while requests are being routed, at most one read per provider is in flight, a provider is re-read at most once per `poolRefreshIntervalMs` (60s), and reads run sequentially rather than in parallel. The refresh happens *after* the current request has been routed and no request ever waits for it; an idle gateway makes no upstream calls. A 402 or 429 refusal re-reads that account immediately, because a refusal is the freshest evidence that the reading used for ranking was wrong.

## Request Translation

Client tools do not all speak the same format. DurinDoor translates between OpenAI, Anthropic Claude, Gemini, OpenAI Responses, Kiro, Cursor, CommandCode, Ollama, Vertex, and other supported shapes.

Important rules:

- OpenAI-compatible requests are the common entry point for most tools.
- Some direct translator routes preserve provider-specific fields better than a generic bridge.
- Tool calls, image blocks, reasoning fields, and audio content are the highest-risk fields during translation.
- Provider-specific unsupported parameters may be stripped or normalized before the upstream call.

## Response Translation

For streaming requests, DurinDoor reads provider chunks and emits client-compatible chunks. For non-streaming requests, it normalizes the final JSON response. Client streaming intent is tracked separately from upstream streaming capability: if a provider must be called without streaming, DurinDoor can still return client-facing SSE by converting the provider's final JSON response into chat completion chunks.

The response layer is responsible for:

- Preserving stream order.
- Mapping finish reasons.
- Normalizing usage data when available.
- Handling provider-specific stream formats.
- Retaining non-empty generated-image deltas in OpenAI-compatible streams while filtering empty deltas.
- Returning errors in a client-compatible shape.

## Failure Handling

DurinDoor distinguishes between transient and terminal failures where possible.

| Failure class | Typical response |
| --- | --- |
| Missing credentials | Return an authentication or configuration error. |
| Expired OAuth token | Attempt refresh, then retry if refresh succeeds. |
| Account quota or rate limit | Lock the connection or model temporarily and try another connection or combo member. |
| Provider outage | Try fallback when configured. |
| Unsupported parameter | Normalize or return a clear provider error. |
| Client request error | Return the error without retrying unrelated providers. |

## Smart Routing vs Combos

Smart routing applies to every request. Combos are a user-defined fallback feature inside smart routing.

```text
Smart routing: model string -> provider -> credentials -> translation -> upstream
Combo routing: combo name -> model 1 -> model 2 -> model 3
```

Use a direct provider model when you want explicit control. Use a combo when client tools should keep one stable model name while DurinDoor handles fallback.
