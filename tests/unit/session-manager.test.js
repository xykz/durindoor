// A2: locks resolveSessionId priority/stickiness (codex/kiro/antigravity centralization).
import { describe, it, expect, beforeEach } from "vitest";
import { resolveClientSessionId, resolveSessionId, deriveSessionId, clearSessionStore, parseSessionAffinityTtl } from "../../open-sse/utils/sessionManager.js";

// Assistant text must reach ASSISTANT_MIN_LEN (80) to use assistant anchor; else first user message.
const longAssistant = "x".repeat(80);
const bodyWithAssistant = { messages: [{ role: "assistant", content: longAssistant }] };
const bodyWithUserOnly = { messages: [{ role: "user", content: "hello from first user message anchor" }] };

const MAX_RUNTIME_SESSIONS = 1000;
const MAX_ASSISTANT_SESSIONS = 5000;

function assistantBody(n) {
  return { messages: [{ role: "assistant", content: `conversation ${n} `.padEnd(80, "x") }] };
}

beforeEach(() => clearSessionStore());

describe("resolveSessionId", () => {
  it("stickiness: same body+connectionId+scope -> same id", () => {
    const opts = { body: bodyWithAssistant, connectionId: "conn1", scope: "codex" };
    expect(resolveSessionId(opts)).toBe(resolveSessionId(opts));
  });

  it("different connectionId -> different id", () => {
    const a = resolveSessionId({ body: bodyWithAssistant, connectionId: "connA", scope: "codex" });
    const b = resolveSessionId({ body: bodyWithAssistant, connectionId: "connB", scope: "codex" });
    expect(a).not.toBe(b);
  });

  it("different scope -> different id", () => {
    const a = resolveSessionId({ body: bodyWithAssistant, connectionId: "conn1", scope: "codex" });
    const b = resolveSessionId({ body: bodyWithAssistant, connectionId: "conn1", scope: "kiro" });
    expect(a).not.toBe(b);
  });

  it("first user message anchor when assistant text below cap", () => {
    const opts = { body: bodyWithUserOnly, connectionId: "conn1", scope: "codex" };
    expect(resolveSessionId(opts)).toBe(resolveSessionId(opts));
  });

  it("assistant anchor wins once assistant text reaches cap", () => {
    const shortAssistant = { messages: [{ role: "user", content: "same user" }, { role: "assistant", content: "y".repeat(80) }] };
    const a = resolveSessionId({ body: shortAssistant, connectionId: "conn1", scope: "codex" });
    const b = resolveSessionId({ body: shortAssistant, connectionId: "conn1", scope: "codex" });
    expect(a).toBe(b);
  });

  it("fallback: empty body+no header+no workspaceId -> deriveSessionId(connectionId)", () => {
    const got = resolveSessionId({ body: {}, connectionId: "connFallback" });
    expect(got).toBe(deriveSessionId("connFallback"));
  });

  it("client override: x-session-id header wins, skips later steps", () => {
    const got = resolveSessionId({
      headers: { "x-session-id": "client-sess-123" },
      body: bodyWithAssistant,
      connectionId: "conn1",
      workspaceId: "ws1",
      scope: "codex",
    });
    expect(got).toBe("client-sess-123");
  });

  it("does not use request-scoped x-client-request-id for provider account affinity in Kiro scope", () => {
    const got = resolveClientSessionId({
      headers: { "x-client-request-id": "req-1" },
      body: bodyWithUserOnly,
      scope: "kiro",
    });

    expect(got).toBeNull();
  });

  it("keeps x-client-request-id as a client session hint outside Kiro scope", () => {
    const got = resolveClientSessionId({
      headers: { "x-client-request-id": "req-1" },
      body: bodyWithUserOnly,
      scope: "openai",
    });

    expect(got).toBe("req-1");
  });

  it("workspaceId path: empty body + workspaceId set -> normalized workspaceId", () => {
    const got = resolveSessionId({ body: {}, connectionId: "conn1", workspaceId: "ws-abc" });
    expect(got).toBe("ws-abc");
  });
});

describe("session store eviction", () => {
  it("evicts the least-recently-used connection at the 1,000-entry cap", () => {
    const hotId = deriveSessionId("conn-0");
    const lruId = deriveSessionId("conn-1");
    for (let i = 2; i < MAX_RUNTIME_SESSIONS; i++) deriveSessionId(`conn-${i}`);

    expect(deriveSessionId("conn-0")).toBe(hotId);
    deriveSessionId("conn-new");

    expect(deriveSessionId("conn-0")).toBe(hotId);
    expect(deriveSessionId("conn-1")).not.toBe(lruId);
  });

  it("evicts the least-recently-used assistant conversation at the 5,000-entry cap", () => {
    const idFor = (n) => resolveSessionId({ body: assistantBody(n), connectionId: "conn", scope: "codex" });
    const hotId = idFor(0);
    const lruId = idFor(1);
    for (let i = 2; i < MAX_ASSISTANT_SESSIONS; i++) idFor(i);

    expect(idFor(0)).toBe(hotId);
    idFor(MAX_ASSISTANT_SESSIONS);

    expect(idFor(0)).toBe(hotId);
    expect(idFor(1)).not.toBe(lruId);
  });
});

describe("parseSessionAffinityTtl", () => {
  it("returns null for blank or malformed values so the global default applies", () => {
    expect(parseSessionAffinityTtl(undefined)).toBeNull();
    expect(parseSessionAffinityTtl(null)).toBeNull();
    expect(parseSessionAffinityTtl("")).toBeNull();
    expect(parseSessionAffinityTtl("   ")).toBeNull();
    expect(parseSessionAffinityTtl("soon")).toBeNull();
    expect(parseSessionAffinityTtl("-5")).toBeNull();
  });

  it("maps off-like values to zero", () => {
    for (const value of ["off", "none", "disabled", "false", "0", "OFF", " Off "]) {
      expect(parseSessionAffinityTtl(value)).toBe(0);
    }
  });

  it("treats a bare number as seconds", () => {
    expect(parseSessionAffinityTtl("600")).toBe(600_000);
    expect(parseSessionAffinityTtl(600)).toBe(600_000);
  });

  it("honors explicit units", () => {
    expect(parseSessionAffinityTtl("500ms")).toBe(500);
    expect(parseSessionAffinityTtl("30s")).toBe(30_000);
    expect(parseSessionAffinityTtl("10m")).toBe(600_000);
    expect(parseSessionAffinityTtl("1h")).toBe(3_600_000);
  });

  it("caps an oversized TTL at one day", () => {
    expect(parseSessionAffinityTtl("100h")).toBe(24 * 60 * 60 * 1000);
  });
});
