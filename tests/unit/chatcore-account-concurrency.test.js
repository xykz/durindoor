import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";
import { getGateStats, _resetGates } from "../../open-sse/services/concurrencyGate.js";

const { executeMock, executorState, trackPendingRequest, finishActiveSession } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  executorState: { noAuth: true },
  trackPendingRequest: vi.fn(() => "req-1"),
  finishActiveSession: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", async () => {
  const context = await import("../../open-sse/services/providerAttemptContext.js");
  return {
    getExecutor: () => ({
      noAuth: executorState.noAuth,
      execute: (options) => context.runQuotaBearingProviderRequest(
        () => context.runProviderAttemptDispatch(() => executeMock(options)),
      ),
    }),
  };
});

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest,
  finishActiveSession,
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function ollamaSuccess() {
  return {
    response: new Response(JSON.stringify({
      model: "llama3",
      created_at: "2026-07-10T12:00:00.000Z",
      message: { role: "assistant", content: "ok" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 2,
      eval_count: 1,
    }), { status: 200, headers: { "content-type": "application/json" } }),
    url: "http://localhost:11434/api/chat",
    headers: {},
    transformedBody: null,
    terminalProvenance: "upstream",
  };
}

/**
 * The slot is released when the response body finishes, not when the handler
 * promise resolves, so occupancy assertions must read the gate while the
 * executor is still pending and drain the body before checking release.
 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function drain(result) {
  if (result?.response?.body) {
    try { await result.response.text(); } catch { /* body already consumed */ }
  }
  // trackDone runs from the stream/non-stream finally blocks.
  await new Promise((done) => setTimeout(done, 20));
}

function args(overrides = {}) {
  return {
    body: { model: "llama3", stream: false, messages: [{ role: "user", content: "hello" }] },
    modelInfo: { provider: "codebuddy-cn", model: "llama3" },
    credentials: { apiKey: "token", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "conn-a",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  executorState.noAuth = true;
  _resetGates();
  executeMock.mockResolvedValue(ollamaSuccess());
});

describe("chatCore account-level concurrency gate", () => {
  it("holds and releases a slot under the composite account key", async () => {
    const gate = deferred();
    executeMock.mockImplementation(async () => {
      await gate.promise;
      return ollamaSuccess();
    });

    const inFlight = handleChatCore(args({ accountConcurrencyLimit: 3 }));
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledOnce());

    const stats = getGateStats();
    expect(stats["codebuddy-cn:conn-a"]).toMatchObject({ current: 1 });
    // The provider-wide gate is bypassed when an account cap is supplied.
    expect(stats["codebuddy-cn"]).toBeUndefined();

    gate.resolve();
    const result = await inFlight;
    await drain(result);
    expect(result.success).toBe(true);
    expect(getGateStats()).toEqual({});
  });

  it("uses the provider key when no account cap is supplied", async () => {
    const gate = deferred();
    executeMock.mockImplementation(async () => {
      await gate.promise;
      return ollamaSuccess();
    });

    const inFlight = handleChatCore(args({ providerConcurrencyLimit: { "codebuddy-cn": 2 } }));
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledOnce());

    const stats = getGateStats();
    expect(stats["codebuddy-cn"]).toMatchObject({ current: 1 });
    expect(stats["codebuddy-cn:conn-a"]).toBeUndefined();

    gate.resolve();
    const result = await inFlight;
    await drain(result);
    expect(getGateStats()).toEqual({});
  });

  it("does not gate at all when neither limit is configured", async () => {
    const result = await handleChatCore(args());
    await drain(result);
    expect(result.success).toBe(true);
    expect(getGateStats()).toEqual({});
  });

  it("supersedes a configured provider limit with the account cap", async () => {
    const gate = deferred();
    executeMock.mockImplementation(async () => {
      await gate.promise;
      return ollamaSuccess();
    });

    const inFlight = handleChatCore(args({
      accountConcurrencyLimit: 3,
      providerConcurrencyLimit: { "codebuddy-cn": 1 }
    }));
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledOnce());

    // Only the account key exists, so the settings' cap of 1 cannot clamp the
    // pool; the account semaphore admits its own three slots.
    expect(getGateStats()["codebuddy-cn:conn-a"]).toMatchObject({ current: 1 });
    expect(getGateStats()["codebuddy-cn"]).toBeUndefined();

    gate.resolve();
    await drain(await inFlight);
  });

  it("serializes a second request on the same account at the configured cap", async () => {
    const first = deferred();
    const second = deferred();
    let call = 0;
    executeMock.mockImplementation(async () => {
      call += 1;
      await (call === 1 ? first.promise : second.promise);
      return ollamaSuccess();
    });

    const a = handleChatCore(args({ accountConcurrencyLimit: 1 }));
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1));

    const b = handleChatCore(args({ accountConcurrencyLimit: 1 }));
    // The single slot is held, so the second request cannot reach the executor.
    await new Promise((done) => setTimeout(done, 40));
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(getGateStats()["codebuddy-cn:conn-a"]).toMatchObject({ current: 1, queued: 1 });

    // Draining the first body is what releases its slot, which hands the gate
    // to the queued request; without it the second request can never dispatch.
    first.resolve();
    await drain(await a);
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledTimes(2));

    second.resolve();
    await drain(await b);
    expect(getGateStats()).toEqual({});
  });

  it("gives two accounts independent slots for the same provider", async () => {
    const first = deferred();
    const second = deferred();
    let call = 0;
    executeMock.mockImplementation(async () => {
      call += 1;
      await (call === 1 ? first.promise : second.promise);
      return ollamaSuccess();
    });

    const a = handleChatCore(args({ accountConcurrencyLimit: 1, connectionId: "conn-a" }));
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1));
    const b = handleChatCore(args({ accountConcurrencyLimit: 1, connectionId: "conn-b" }));

    // conn-b owns a separate semaphore, so it dispatches while conn-a is busy.
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledTimes(2));
    expect(getGateStats()["codebuddy-cn:conn-a"]).toMatchObject({ current: 1 });
    expect(getGateStats()["codebuddy-cn:conn-b"]).toMatchObject({ current: 1 });

    first.resolve();
    second.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    await drain(ra);
    await drain(rb);
    expect(getGateStats()).toEqual({});
  });

  it("falls back to credentials.connectionId when the option is absent", async () => {
    const gate = deferred();
    executeMock.mockImplementation(async () => {
      await gate.promise;
      return ollamaSuccess();
    });

    const inFlight = handleChatCore(args({
      accountConcurrencyLimit: 2,
      connectionId: undefined,
      credentials: { apiKey: "token", connectionId: "conn-from-creds", providerSpecificData: {} }
    }));
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledOnce());
    expect(getGateStats()["codebuddy-cn:conn-from-creds"]).toMatchObject({ current: 1 });

    gate.resolve();
    await drain(await inFlight);
    expect(getGateStats()).toEqual({});
  });
});
