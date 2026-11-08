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

Three per-request headers tune account selection:

- `x-connection-id` accepts either one connection id (a hard pin: the request fails rather than rotating if that account is unavailable) or a comma-separated list (a candidate pool: selection still round-robins within the pool, and a member failure rotates to the next pool member; if no pool member is available the request fails rather than falling back outside the pool).
- `x-session-affinity-ttl` overrides the session-affinity TTL for that request. A bare number is seconds (`600`), explicit units are honored (`500ms`, `30s`, `10m`, `1h`), and `off`/`none`/`disabled`/`0` disables affinity so the request re-balances immediately. Missing or malformed values keep the default. Expiry stays sliding: an active session keeps refreshing its entry.
- `x-account-strategy` overrides the stored `fallbackStrategy` for one request without changing any dashboard setting. `bonus-first` selects the round-robin variant described below; any other value (including blank) is ignored and the configured strategy stays in effect. A hard `x-connection-id` pin still outranks it.

### CodeBuddy CN token budget

CodeBuddy CN throttles an account once its trailing 24-hour token total approaches roughly 2×10⁸ tokens. Two mechanisms keep traffic inside that ceiling:

- **Rolling-24h balancing.** New round-robin sessions prefer the account with the lowest `promptTokens + completionTokens` over the trailing 24 hours (from `usageHistory`), falling back to `lastUsedAt`/`priority` on ties or read failure. This uses a rolling window rather than a calendar day so a midnight rollover cannot reset a still-hot account.
- **Per-request budget.** The `x-connection-token-budget` header (bare counts or `k`/`m`/`b` suffixes, e.g. `180m` or `180000000`) drops any account at or above that trailing-24h total from the candidate pool. If every account in scope reaches the budget, selection returns a 503 `allRateLimited` rather than routing to a throttled account. The budget applies to CodeBuddy CN only; without the header there is no budget.

### CodeBuddy CN bonus-first rotation

CodeBuddy CN accounts can hold one-shot *bonus* credit packs alongside the recurring refill allowance. A bonus pack never replenishes: whatever is left when its `CycleEndTime` arrives is lost, while a refill allowance simply refreshes. `bonus-first` therefore spends the soonest-expiring bonus credits first instead of spreading traffic evenly across accounts.

Select it per request with `x-account-strategy: bonus-first`, or persist it for a provider with `providerStrategies[<provider>].fallbackStrategy = "bonus-first"` (settings only — no dashboard control).

An account normally holds **many** bonus packs, often several expiring on the same day, so the strategy ranks by expiring *budget* rather than by a single pack:

- Packs are grouped by the calendar day of their own `resetAt` (the date prefix of the provider's ISO timestamp). This is a grouping between packs, **not** a local "today", so no timezone is involved and a pack expiring months out sorts exactly where it belongs.
- An account's ranking key is its earliest expiry day; the credit total for that day is the **sum** of the packs expiring on it. Summing is required because each pack carries its own capacity, so a per-pack `ratio` is not comparable across packs.
- An earlier expiry day always wins, whatever the amounts are. Within one day, credits descending sets the **rotation order**, and requests advance through it one account at a time (`A→B→C→A…`), so the largest budget is drained first without pinning every request to it.

Selection rules, applied after every hard filter (exclusions, locks, `x-connection-token-budget`, quota gates, routing floors) has already run:

- A *usable* bonus pool is a quota window with `recurring: false` (the bonus marker CodeBuddy normalization attaches), remaining credits above zero, and a `resetAt` still in the future. Recurring windows are ignored — their `resetAt` is the next refresh, not a loss.
- **The earliest expiry day with any credits left takes all the traffic.** Accounts holding nothing usable (spent, expired, or refill-only) sit behind that cohort, so the rotation moves to the next day's group automatically once today's packs are drained: the cohort simply becomes the accounts still holding the soonest expiring credits, and every request lands there until those are gone too. With a single such account it receives every request.
- When **no** account in the candidate pool holds a usable bonus pool at all, nothing can lapse and the credit rotation has no ordering to apply, so the strategy degrades to the normal round-robin order (rolling-24h token total, then `lastUsedAt`, then `priority`).
- **Crossing a day boundary cuts session affinity.** A pinned session keeps its account only while that account's earliest expiry day is still the earliest across the candidate pool. Once another account holds credits expiring on an earlier day, the session follows the rotation — otherwise those credits would lapse while the session sat on an account with nothing urgent. When no candidate holds any expiring budget there is nothing to lose, so affinity is kept.
- **Expiry tie precision is one second.** Accounts with equal credit totals are ordered by the exact instant, compared as epoch milliseconds, but a difference of at most `QUOTA_SELECTION_DEFAULTS.bonusExpiryTieMs` (1000 ms) counts as a tie, precisely because provider reset timestamps arrive at whole-second granularity. Sub-second clock noise therefore cannot reorder the rotation on every request; a genuine tie keeps the caller's stable order.
- **The turn cursor is `consecutiveUseCount`.** `lastUsedAt` is only millisecond precision, and two picks can share a millisecond, which would stall the cycle on one account. Under `bonus-first` the persisted per-connection counter becomes a monotonic turn cursor shared by the provider's accounts: the account that turned last gets the full cycle, and the next turn falls to whichever follows it in the credit order. Every other strategy still writes `1` there, so `stickyRoundRobinLimit` streak counting is unchanged.
- `bonus-first` keeps no sticky turns: unlike the default round-robin path (`stickyRoundRobinLimit`, default 3), each request advances the rotation instead of repeating one account for a streak.
- Fail-open: stale or missing observations, an unreadable quota profile, or a provider with no expiring pools at all produce exactly the pre-existing round-robin (or fill-first, when no round-robin strategy is configured) result.

Two limits are inherent to the upstream data:

- **Pack selection is the provider's.** An account that holds several packs may satisfy a request from any of them; the router ranks accounts, it cannot choose which pack inside one account is debited.
- **Snapshots are at most `PROVIDER_QUOTA_DEFAULTS.freshnessMs` (60 s) old**, and credit pools have no atomic debit. Concurrent requests still rotate (the turn cursor advances per selection, not per snapshot), but the credit totals they rotate on are up to a minute stale, so an account whose pack has just run dry can still be offered one more request before the next refresh removes it.

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
