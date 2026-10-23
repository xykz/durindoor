import { DefaultExecutor } from "./default.js";
import { OPENAI_BLOCK, ROLE } from "../translator/schema/index.js";
import { isString } from "../../src/shared/utils/typeChecks.js";
import {
  codebuddyCacheRetention,
  codebuddyCliAlignmentEnabled,
  codebuddyCliVersion,
  codebuddyConversationId,
  codebuddyRequestId,
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
    transformed.stream = true;

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

    // The official CLI stamps every chat request with a cache retention mode,
    // latching "long" unless CODEBUDDY_DISABLE_PROMPT_CACHING_1H is set. An
    // explicit client value always wins. See providers/codebuddyCli.js.
    if (codebuddyCliAlignmentEnabled() && transformed.cache_retention === undefined) {
      transformed.cache_retention = codebuddyCacheRetention();
    }
    return transformed;
  }

  /**
   * Mirror the conversation/request identity headers the official CLI attaches
   * to every chat request (observed against @tencent-ai/codebuddy-code 2.172.1).
   *
   * The CLI derives these from its session object; DurinDoor has no session, so
   * the conversation id is derived from the gateway's own session id and the
   * request ids are minted per attempt. Headers the CLI sends from authenticated
   * identity state (X-Userinfo, X-Enterprise-Id, X-Auth-Method, X-Id-Source) are
   * intentionally NOT synthesized — see docs/providers/codebuddy-cn.md.
   */
  buildHeaders(credentials = {}, stream = true, requestContext = null) {
    const headers = super.buildHeaders(credentials, stream);
    if (!requestContext || !codebuddyCliAlignmentEnabled()) return headers;

    const seed = requestContext.sessionId || credentials?.connectionId || null;
    if (!seed) return headers; // nothing to anchor a conversation on

    const messageId = codebuddyRequestId();
    headers["User-Agent"] = codebuddyUserAgent();
    headers["X-IDE-Version"] = codebuddyCliVersion();
    headers["X-Conversation-ID"] = codebuddyConversationId(seed);
    // The CLI reuses one message id for the request/message pair and a
    // dash-stripped uuid for X-Request-ID.
    headers["X-Conversation-Request-ID"] = messageId;
    headers["X-Conversation-Message-ID"] = messageId;
    headers["X-Request-ID"] = messageId;
    // CLI defaults when the session carries no mode/team/parent metadata.
    headers["X-Agent-Intent"] = "craft";
    headers["X-Agent-Runtime"] = "other";
    headers["X-Agent-Type"] = "main";
    return headers;
  }
}

export default CodeBuddyExecutor;
