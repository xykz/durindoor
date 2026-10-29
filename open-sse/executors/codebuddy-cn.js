import { DefaultExecutor } from "./default.js";
import { OPENAI_BLOCK, ROLE } from "../translator/schema/index.js";
import { isString } from "../../src/shared/utils/typeChecks.js";
import {
  CODEBUDDY_SDK_PACKAGE_VERSION,
  codebuddyCliAlignmentEnabled,
  codebuddyCliVersion,
  codebuddyConversationId,
  codebuddyIdentityHeaders,
  codebuddyRequestId,
  codebuddyStainlessArch,
  codebuddyStainlessOs,
  codebuddyTraceContext,
  codebuddyTraceHeaders,
  codebuddyUserAgent,
} from "../providers/codebuddyCli.js";

const DEFAULT_SYSTEM_PROMPT_MAX_LEN = 2000;
const NEUTRAL_PROMPT = "You are a helpful AI assistant that helps with software engineering tasks.";
const AGENT_PATTERN = /you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|anxthxropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|you are an? (?:ai )?(?:coding |code )?agent|cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)|claude.?code.+issues|give feedback.+claude.?code|you are .{0,30}(?:powerful )?ai agent|orchestration capabilities|OhMyOpenCode|<agent-identity>|<Role>|<Behavior_Instructions>/i;

/**
 * Resolve decolua/9router#3342's configurable length rule. Zero disables only
 * length matching; invalid values retain the 2,000-character safety default.
 * RTK caveman/ponytail injection adds roughly 1.7-1.9k characters to the system
 * message; codebuddy-cn operators using RTK should raise this limit or set 0.
 */
function systemPromptMaxLen() {
  const raw = process.env.CODEBUDDY_SYSTEM_PROMPT_MAX_LEN?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_SYSTEM_PROMPT_MAX_LEN;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : DEFAULT_SYSTEM_PROMPT_MAX_LEN;
}

function flattenText(content) {
  if (isString(content)) return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => isString(block?.text) ? block.text : "").join("\n");
}

/**
 * CodeBuddyExecutor — talks to https://copilot.tencent.com/v2/chat/completions.
 *
 * After the superclass normalizes a request, decolua/9router#3342 replaces
 * rejected coding-agent system identities or prompts over the configured limit.
 * CodeBuddy also rejects non-stream chat requests (HTTP 400, code 11101), so
 * every request is forced to stream; 9router re-aggregates SSE for JSON clients.
 */
export class CodeBuddyExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-cn");
  }

  transformRequest(model, body, stream, credentials, requestContext = null) {
    const transformed = super.transformRequest(model, body, stream, credentials, requestContext);
    // Forcing stream after the superclass means its `stream===false` branch has
    // already dropped stream_options. The CLI's own body pairs `stream:true` with
    // `stream_options.include_usage`, so restore it here rather than leaving a
    // stream request that never reports usage.
    transformed.stream = true;
    if (!transformed.stream_options) {
      transformed.stream_options = { include_usage: true };
    }

    const maxLen = systemPromptMaxLen();
    if (Array.isArray(transformed.messages)) {
      transformed.messages = transformed.messages.map((message) => {
        if (!message || message.role !== ROLE.SYSTEM) return message;
        const text = flattenText(message.content);
        if (!text) return message;

        const matchedIdentity = AGENT_PATTERN.test(text);
        const matchedLength = maxLen > 0 && text.length > maxLen;
        if (!matchedIdentity && !matchedLength) return message;

        console.warn(
          matchedIdentity ?
          "[codebuddy-cn] system prompt replaced: IDENTITY rule" :
          `[codebuddy-cn] system prompt replaced: LENGTH rule (${text.length} > CODEBUDDY_SYSTEM_PROMPT_MAX_LEN=${maxLen})`
        );
        return {
          ...message,
          content: isString(message.content) ?
          NEUTRAL_PROMPT :
          [{ type: OPENAI_BLOCK.TEXT, text: NEUTRAL_PROMPT }]
        };
      });
    }

    // CodeBuddy only surfaces model reasoning when the request carries the CLI's
    // OpenAI-style params: reasoning_effort + reasoning_summary:"auto". 9router's
    // thinking pipeline sets reasoning_effort only when the client asks, and never
    // sets reasoning_summary — so reasoning never shows. Mirror the CLI here.
    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort; // gateway has no "none" — just omit
    } else if (eff) {
      // Client explicitly asked for reasoning — mirror the CLI's reasoning_summary
      // so CodeBuddy surfaces the model's reasoning.
      transformed.reasoning_summary = "auto";
    }
    // No reasoning requested: leave both unset. Forcing reasoning_effort:"medium"
    // + reasoning_summary on plain requests makes CodeBuddy trip its content
    // filter and return an error (#2071).

    // The CLI's model-settings interceptor writes text.verbosity:"high" whenever
    // thinking is enabled, and a captured 2.138.0 request carried exactly
    // `reasoning_effort:"high"` + `reasoning_summary:"auto"` + `verbosity:"high"`.
    // It is gated on the same condition as reasoning_summary rather than sent
    // unconditionally. (Captures show verbosity present from 2.108.1 through
    // 2.147.0 and gone again by 2.164.0.)
    if (transformed.reasoning_summary && transformed.verbosity === undefined) {
      transformed.verbosity = "high";
    }

    // Two body fields that later releases add are deliberately absent here,
    // because 2.138.0 predates both: `cache_retention` (first captured in
    // 2.172.1) and `extra_vars`/`harnessMetadata` (same release). Sending them
    // while advertising 2.138.0 would be a newer-client tell.
    return transformed;
  }

  /**
   * Mirror the request fingerprint the official CLI attaches to every chat call.
   *
   * The shape below came from capturing live chat requests from real CLI builds
   * rather than from reading the bundle, because the bundle splits header
   * assembly across three layers — the fetch adapter, a custom-header provider
   * and the axios interceptor chain — and a source read misses whatever the later
   * layers add.
   *
   * The CLI derives the identity headers from its session object; DurinDoor has no
   * session, so the conversation id is derived from the gateway's own session id,
   * and the per-prompt ids plus the trace context are minted per attempt. Headers
   * built from login-flow state (X-Userinfo, X-Auth-Method, X-Id-Source,
   * X-Department-Info) are intentionally NOT synthesized — see
   * docs/providers/codebuddy-cn.md.
   */
  buildHeaders(credentials = {}, stream = true, requestContext = null) {
    const headers = super.buildHeaders(credentials, stream);
    const aligned = codebuddyCliAlignmentEnabled();
    // The CLI's bundled openai client hardcodes this and streams through the body,
    // so it never sends the Accept the superclass adds for stream requests.
    if (aligned) headers["Accept"] = "application/json";
    if (!requestContext || !aligned) return headers;

    const seed = requestContext.sessionId || credentials?.connectionId || null;
    if (!seed) return headers; // nothing to anchor a conversation on

    const messageId = codebuddyRequestId();
    // One value, four names. The CLI seeds its model-call span's trace id from
    // the conversation request id and then writes that same value to
    // X-Conversation-Request-ID, X-Root-Request-ID, X-B3-TraceId and X-Trace-ID.
    // A capture of 2.138.0 confirmed all four were byte-identical, so they are
    // minted together here rather than independently.
    const trace = codebuddyTraceContext();
    headers["User-Agent"] = codebuddyUserAgent();
    headers["X-IDE-Version"] = codebuddyCliVersion();
    headers["X-Conversation-ID"] = codebuddyConversationId(seed);
    headers["X-Conversation-Request-ID"] = trace.traceId;
    headers["X-Root-Request-ID"] = trace.traceId;
    headers["X-Conversation-Message-ID"] = messageId;
    headers["X-Request-ID"] = messageId;
    // CLI defaults when the session carries no mode/team/parent metadata: `craft`
    // intent, the conversation purpose every normal turn gets, the top-level
    // agent type, and the private-data flag a non-enterprise account resolves to.
    headers["X-Agent-Intent"] = "craft";
    headers["X-Agent-Type"] = "main";
    headers["X-Agent-Purpose"] = "conversation";
    // A non-enterprise account resolves model optimization on, so the CLI sends
    // "false" here; an enterprise account flips it to "true". Identity headers are
    // derived from the account token and override this default when they can.
    headers["X-Private-Data"] = "false";
    Object.assign(headers, codebuddyIdentityHeaders(credentials?.accessToken, credentials?.apiKey));
    // All seven trace headers come from that one span context. `b3` carries four
    // parts because the CLI always passes a parent span id.
    Object.assign(headers, codebuddyTraceHeaders(trace));

    // The CLI's chat client is the bundled `openai` SDK, whose buildHeaders()
    // stamps these on every request and whose adapter never removes them. There is
    // no X-Stainless-Timeout in a captured request, even though the SDK would emit
    // one for a client with a timeout set, so it is deliberately absent here.
    headers["X-Stainless-Lang"] = "js";
    headers["X-Stainless-Package-Version"] = CODEBUDDY_SDK_PACKAGE_VERSION;
    headers["X-Stainless-OS"] = codebuddyStainlessOs();
    headers["X-Stainless-Arch"] = codebuddyStainlessArch();
    headers["X-Stainless-Runtime"] = "node";
    headers["X-Stainless-Runtime-Version"] = process.version;
    headers["X-Stainless-Retry-Count"] = "0";
    return headers;
  }
}

export default CodeBuddyExecutor;
