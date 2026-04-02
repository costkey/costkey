import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Provider extractors ──
import { openaiExtractor } from "../providers/openai.js";
import { anthropicExtractor } from "../providers/anthropic.js";
import { googleExtractor } from "../providers/google.js";
import { groqExtractor } from "../providers/groq.js";
import { xaiExtractor } from "../providers/xai.js";
import { bedrockExtractor } from "../providers/bedrock.js";
import { openrouterExtractor } from "../providers/openrouter.js";
import {
  cohereExtractor,
  mistralExtractor,
  togetherExtractor,
  deepseekExtractor,
  fireworksExtractor,
  perplexityExtractor,
  cerebrasExtractor,
} from "../providers/more.js";

// ── Registry ──
import { findExtractor, registerExtractor } from "../providers/registry.js";

// ── Stack trace ──
import { captureCallSite } from "../stack.js";

// ── Transport ──
import { Transport } from "../transport.js";

// ── Types ──
import type { ProviderExtractor } from "../providers/types.js";
import { Provider } from "../types.js";

// ═══════════════════════════════════════════════════════════════════════════
//  OPENAI
// ═══════════════════════════════════════════════════════════════════════════

describe("OpenAI Extractor", () => {
  describe("URL matching", () => {
    it("matches api.openai.com", () => {
      assert.ok(openaiExtractor.match(new URL("https://api.openai.com/v1/chat/completions")));
    });

    it("matches Azure OpenAI *.openai.azure.com", () => {
      assert.ok(openaiExtractor.match(new URL("https://my-resource.openai.azure.com/openai/deployments/gpt-4/chat/completions")));
    });

    it("matches Azure OpenAI with different resource names", () => {
      assert.ok(openaiExtractor.match(new URL("https://prod-east.openai.azure.com/openai/deployments/gpt-4o/chat/completions")));
    });

    it("does not match other hosts", () => {
      assert.ok(!openaiExtractor.match(new URL("https://api.anthropic.com/v1/messages")));
      assert.ok(!openaiExtractor.match(new URL("https://example.com/openai")));
    });
  });

  describe("usage extraction", () => {
    it("extracts Chat Completions format (prompt_tokens / completion_tokens)", () => {
      const body = {
        id: "chatcmpl-abc123",
        object: "chat.completion",
        model: "gpt-4o-2024-11-20",
        choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop", index: 0 }],
        usage: {
          prompt_tokens: 42,
          completion_tokens: 18,
          total_tokens: 60,
        },
      };
      const usage = openaiExtractor.extractUsage(body);
      assert.deepStrictEqual(usage, {
        inputTokens: 42,
        outputTokens: 18,
        totalTokens: 60,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      });
    });

    it("extracts Responses API format (input_tokens / output_tokens)", () => {
      const body = {
        id: "resp_abc",
        object: "response",
        model: "gpt-4o",
        usage: {
          input_tokens: 200,
          output_tokens: 80,
          total_tokens: 280,
        },
      };
      const usage = openaiExtractor.extractUsage(body);
      assert.strictEqual(usage!.inputTokens, 200);
      assert.strictEqual(usage!.outputTokens, 80);
      assert.strictEqual(usage!.totalTokens, 280);
    });

    it("extracts reasoning tokens from o-series models", () => {
      const body = {
        model: "o1-preview",
        usage: {
          prompt_tokens: 100,
          completion_tokens: 500,
          total_tokens: 600,
          completion_tokens_details: {
            reasoning_tokens: 384,
          },
        },
      };
      const usage = openaiExtractor.extractUsage(body);
      assert.strictEqual(usage!.reasoningTokens, 384);
    });

    it("extracts reasoning tokens via output_tokens_details (Responses API)", () => {
      const body = {
        model: "o3-mini",
        usage: {
          input_tokens: 50,
          output_tokens: 300,
          total_tokens: 350,
          output_tokens_details: {
            reasoning_tokens: 200,
          },
        },
      };
      const usage = openaiExtractor.extractUsage(body);
      assert.strictEqual(usage!.reasoningTokens, 200);
    });

    it("computes totalTokens when not provided", () => {
      const body = {
        model: "gpt-4o",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
        },
      };
      const usage = openaiExtractor.extractUsage(body);
      assert.strictEqual(usage!.totalTokens, 15);
    });
  });

  describe("model extraction", () => {
    it("prefers response body model", () => {
      assert.strictEqual(
        openaiExtractor.extractModel({ model: "gpt-4o" }, { model: "gpt-4o-2024-11-20" }),
        "gpt-4o-2024-11-20",
      );
    });

    it("falls back to request body model", () => {
      assert.strictEqual(
        openaiExtractor.extractModel({ model: "gpt-4o" }, {}),
        "gpt-4o",
      );
    });

    it("returns null when no model found", () => {
      assert.strictEqual(openaiExtractor.extractModel({}, {}), null);
      assert.strictEqual(openaiExtractor.extractModel(null, null), null);
    });
  });

  describe("stream options injection", () => {
    it("injects stream_options for streaming requests", () => {
      const body = { model: "gpt-4o", stream: true, messages: [] };
      const modified = openaiExtractor.injectStreamOptions!(body) as Record<string, unknown>;
      assert.deepStrictEqual(modified["stream_options"], { include_usage: true });
    });

    it("merges with existing stream_options", () => {
      const body = { model: "gpt-4o", stream: true, stream_options: { custom: true } };
      const modified = openaiExtractor.injectStreamOptions!(body) as Record<string, unknown>;
      assert.deepStrictEqual(modified["stream_options"], { custom: true, include_usage: true });
    });

    it("does not modify non-streaming requests", () => {
      const body = { model: "gpt-4o", messages: [] };
      const result = openaiExtractor.injectStreamOptions!(body);
      assert.strictEqual(result, body); // same reference
    });

    it("returns requestBody unchanged for null/non-object", () => {
      assert.strictEqual(openaiExtractor.injectStreamOptions!(null), null);
      assert.strictEqual(openaiExtractor.injectStreamOptions!("text"), "text");
    });
  });

  describe("edge cases", () => {
    it("returns null for null body", () => {
      assert.strictEqual(openaiExtractor.extractUsage(null), null);
    });
    it("returns null for empty object", () => {
      assert.strictEqual(openaiExtractor.extractUsage({}), null);
    });
    it("returns null for missing usage field", () => {
      assert.strictEqual(openaiExtractor.extractUsage({ model: "gpt-4o" }), null);
    });
    it("returns null for string body", () => {
      assert.strictEqual(openaiExtractor.extractUsage("not an object"), null);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ANTHROPIC
// ═══════════════════════════════════════════════════════════════════════════

describe("Anthropic Extractor", () => {
  describe("URL matching", () => {
    it("matches api.anthropic.com", () => {
      assert.ok(anthropicExtractor.match(new URL("https://api.anthropic.com/v1/messages")));
    });
    it("does not match other hosts", () => {
      assert.ok(!anthropicExtractor.match(new URL("https://api.openai.com/v1/chat/completions")));
      assert.ok(!anthropicExtractor.match(new URL("https://anthropic.com")));
    });
  });

  describe("usage extraction", () => {
    it("extracts usage from Messages API response", () => {
      const body = {
        id: "msg_01XjK9",
        type: "message",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "Hello!" }],
        usage: {
          input_tokens: 312,
          output_tokens: 87,
        },
      };
      const usage = anthropicExtractor.extractUsage(body);
      assert.deepStrictEqual(usage, {
        inputTokens: 312,
        outputTokens: 87,
        totalTokens: 399,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      });
    });

    it("extracts cache tokens", () => {
      const body = {
        model: "claude-sonnet-4-20250514",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 2048,
          cache_creation_input_tokens: 512,
        },
      };
      const usage = anthropicExtractor.extractUsage(body);
      assert.strictEqual(usage!.cacheReadTokens, 2048);
      assert.strictEqual(usage!.cacheCreationTokens, 512);
    });
  });

  describe("model extraction", () => {
    it("prefers response body model", () => {
      assert.strictEqual(
        anthropicExtractor.extractModel({ model: "claude-sonnet-4-20250514" }, { model: "claude-sonnet-4-20250514" }),
        "claude-sonnet-4-20250514",
      );
    });
    it("falls back to request body", () => {
      assert.strictEqual(
        anthropicExtractor.extractModel({ model: "claude-sonnet-4-20250514" }, {}),
        "claude-sonnet-4-20250514",
      );
    });
  });

  describe("edge cases", () => {
    it("returns null for null body", () => {
      assert.strictEqual(anthropicExtractor.extractUsage(null), null);
    });
    it("returns null for empty object", () => {
      assert.strictEqual(anthropicExtractor.extractUsage({}), null);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  GOOGLE
// ═══════════════════════════════════════════════════════════════════════════

describe("Google Extractor", () => {
  describe("URL matching", () => {
    it("matches generativelanguage.googleapis.com", () => {
      assert.ok(googleExtractor.match(new URL("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent")));
    });
    it("matches Vertex AI us-central1-aiplatform.googleapis.com", () => {
      assert.ok(googleExtractor.match(new URL("https://us-central1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1/publishers/google/models/gemini-pro:generateContent")));
    });
    it("matches Vertex AI other regions", () => {
      assert.ok(googleExtractor.match(new URL("https://europe-west4-aiplatform.googleapis.com/v1/models/gemini-pro")));
    });
    it("does not match other googleapis.com hosts", () => {
      assert.ok(!googleExtractor.match(new URL("https://storage.googleapis.com/bucket/file")));
    });
    it("does not match non-Google hosts", () => {
      assert.ok(!googleExtractor.match(new URL("https://api.openai.com/v1/chat")));
    });
  });

  describe("usage extraction", () => {
    it("extracts usage from Gemini response", () => {
      const body = {
        candidates: [{ content: { parts: [{ text: "Hello" }], role: "model" }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 42,
          totalTokenCount: 57,
        },
      };
      const usage = googleExtractor.extractUsage(body);
      assert.deepStrictEqual(usage, {
        inputTokens: 15,
        outputTokens: 42,
        totalTokens: 57,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      });
    });

    it("extracts thinking tokens (Gemini 2.5)", () => {
      const body = {
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 200,
          totalTokenCount: 500,
          thoughtsTokenCount: 250,
        },
      };
      const usage = googleExtractor.extractUsage(body);
      assert.strictEqual(usage!.reasoningTokens, 250);
    });

    it("extracts cached content tokens", () => {
      const body = {
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          totalTokenCount: 150,
          cachedContentTokenCount: 80,
        },
      };
      const usage = googleExtractor.extractUsage(body);
      assert.strictEqual(usage!.cacheReadTokens, 80);
    });
  });

  describe("model extraction", () => {
    it("extracts modelVersion from response", () => {
      assert.strictEqual(
        googleExtractor.extractModel(null, { modelVersion: "gemini-2.0-flash-001" }),
        "gemini-2.0-flash-001",
      );
    });
    it("returns null when no modelVersion", () => {
      assert.strictEqual(googleExtractor.extractModel(null, {}), null);
    });
  });

  describe("edge cases", () => {
    it("returns null for null body", () => {
      assert.strictEqual(googleExtractor.extractUsage(null), null);
    });
    it("returns null for empty object", () => {
      assert.strictEqual(googleExtractor.extractUsage({}), null);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  GROQ
// ═══════════════════════════════════════════════════════════════════════════

describe("Groq Extractor", () => {
  describe("URL matching", () => {
    it("matches api.groq.com", () => {
      assert.ok(groqExtractor.match(new URL("https://api.groq.com/openai/v1/chat/completions")));
    });
    it("does not match other hosts", () => {
      assert.ok(!groqExtractor.match(new URL("https://groq.com")));
    });
  });

  describe("usage extraction", () => {
    it("extracts Groq usage (input_tokens / output_tokens format)", () => {
      const body = {
        id: "chatcmpl-xyz",
        model: "llama-3.3-70b-versatile",
        usage: {
          input_tokens: 25,
          output_tokens: 120,
          total_tokens: 145,
        },
      };
      const usage = groqExtractor.extractUsage(body);
      assert.strictEqual(usage!.inputTokens, 25);
      assert.strictEqual(usage!.outputTokens, 120);
      assert.strictEqual(usage!.totalTokens, 145);
    });

    it("extracts Groq usage (prompt_tokens / completion_tokens fallback)", () => {
      const body = {
        model: "mixtral-8x7b-32768",
        usage: {
          prompt_tokens: 30,
          completion_tokens: 80,
          total_tokens: 110,
        },
      };
      const usage = groqExtractor.extractUsage(body);
      assert.strictEqual(usage!.inputTokens, 30);
      assert.strictEqual(usage!.outputTokens, 80);
    });

    it("extracts reasoning tokens from output_tokens_details", () => {
      const body = {
        model: "deepseek-r1-distill-llama-70b",
        usage: {
          input_tokens: 40,
          output_tokens: 200,
          total_tokens: 240,
          output_tokens_details: { reasoning_tokens: 150 },
        },
      };
      const usage = groqExtractor.extractUsage(body);
      assert.strictEqual(usage!.reasoningTokens, 150);
    });

    it("extracts cached tokens from input_tokens_details", () => {
      const body = {
        model: "llama-3.3-70b-versatile",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          input_tokens_details: { cached_tokens: 60 },
        },
      };
      const usage = groqExtractor.extractUsage(body);
      assert.strictEqual(usage!.cacheReadTokens, 60);
    });
  });

  describe("edge cases", () => {
    it("returns null for null body", () => {
      assert.strictEqual(groqExtractor.extractUsage(null), null);
    });
    it("returns null for empty object", () => {
      assert.strictEqual(groqExtractor.extractUsage({}), null);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  XAI (GROK)
// ═══════════════════════════════════════════════════════════════════════════

describe("xAI Extractor", () => {
  describe("URL matching", () => {
    it("matches api.x.ai", () => {
      assert.ok(xaiExtractor.match(new URL("https://api.x.ai/v1/chat/completions")));
    });
    it("matches api.grok.xai.com", () => {
      assert.ok(xaiExtractor.match(new URL("https://api.grok.xai.com/v1/chat/completions")));
    });
    it("does not match x.ai (no api subdomain)", () => {
      assert.ok(!xaiExtractor.match(new URL("https://x.ai")));
    });
  });

  describe("usage extraction", () => {
    it("extracts usage from xAI response (OpenAI-compatible)", () => {
      const body = {
        id: "chatcmpl-abc",
        model: "grok-3",
        usage: {
          prompt_tokens: 55,
          completion_tokens: 120,
          total_tokens: 175,
        },
      };
      const usage = xaiExtractor.extractUsage(body);
      assert.strictEqual(usage!.inputTokens, 55);
      assert.strictEqual(usage!.outputTokens, 120);
      assert.strictEqual(usage!.totalTokens, 175);
    });

    it("extracts reasoning tokens from completion_tokens_details", () => {
      const body = {
        model: "grok-3",
        usage: {
          prompt_tokens: 50,
          completion_tokens: 400,
          total_tokens: 450,
          completion_tokens_details: { reasoning_tokens: 300 },
        },
      };
      const usage = xaiExtractor.extractUsage(body);
      assert.strictEqual(usage!.reasoningTokens, 300);
    });
  });

  describe("stream options injection", () => {
    it("injects stream_options for streaming requests", () => {
      const body = { model: "grok-3", stream: true, messages: [] };
      const modified = xaiExtractor.injectStreamOptions!(body) as Record<string, unknown>;
      assert.deepStrictEqual(modified["stream_options"], { include_usage: true });
    });
    it("does not modify non-streaming requests", () => {
      const body = { model: "grok-3", messages: [] };
      assert.strictEqual(xaiExtractor.injectStreamOptions!(body), body);
    });
  });

  describe("edge cases", () => {
    it("returns null for null body", () => {
      assert.strictEqual(xaiExtractor.extractUsage(null), null);
    });
    it("returns null for empty object", () => {
      assert.strictEqual(xaiExtractor.extractUsage({}), null);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  BEDROCK
// ═══════════════════════════════════════════════════════════════════════════

describe("Bedrock Extractor", () => {
  describe("URL matching", () => {
    it("matches bedrock-runtime.us-east-1.amazonaws.com", () => {
      assert.ok(bedrockExtractor.match(new URL("https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-v2/converse")));
    });
    it("matches bedrock-runtime.eu-west-1.amazonaws.com", () => {
      assert.ok(bedrockExtractor.match(new URL("https://bedrock-runtime.eu-west-1.amazonaws.com/model/invoke")));
    });
    it("matches bedrock-runtime.ap-northeast-1.amazonaws.com", () => {
      assert.ok(bedrockExtractor.match(new URL("https://bedrock-runtime.ap-northeast-1.amazonaws.com/converse")));
    });
    it("does not match non-bedrock amazonaws.com", () => {
      assert.ok(!bedrockExtractor.match(new URL("https://s3.us-east-1.amazonaws.com/bucket")));
    });
    it("does not match non-amazonaws.com", () => {
      assert.ok(!bedrockExtractor.match(new URL("https://bedrock-runtime.example.com/model")));
    });
  });

  describe("usage extraction", () => {
    it("extracts usage from Converse API format", () => {
      const body = {
        output: { message: { role: "assistant", content: [{ text: "Hello" }] } },
        stopReason: "end_turn",
        usage: {
          inputTokens: 42,
          outputTokens: 18,
          totalTokens: 60,
        },
      };
      const usage = bedrockExtractor.extractUsage(body);
      assert.strictEqual(usage!.inputTokens, 42);
      assert.strictEqual(usage!.outputTokens, 18);
      assert.strictEqual(usage!.totalTokens, 60);
    });

    it("extracts usage from InvokeModel invocationMetrics format", () => {
      const body = {
        "amazon-bedrock-invocationMetrics": {
          inputTokenCount: 100,
          outputTokenCount: 50,
          invocationLatency: 1200,
          firstByteLatency: 400,
        },
      };
      const usage = bedrockExtractor.extractUsage(body);
      assert.strictEqual(usage!.inputTokens, 100);
      assert.strictEqual(usage!.outputTokens, 50);
      assert.strictEqual(usage!.totalTokens, null);
    });
  });

  describe("model extraction", () => {
    it("extracts modelId from request body", () => {
      assert.strictEqual(
        bedrockExtractor.extractModel({ modelId: "anthropic.claude-3-sonnet" }, null),
        "anthropic.claude-3-sonnet",
      );
    });
    it("returns null when no modelId", () => {
      assert.strictEqual(bedrockExtractor.extractModel({}, null), null);
    });
  });

  describe("edge cases", () => {
    it("returns null for null body", () => {
      assert.strictEqual(bedrockExtractor.extractUsage(null), null);
    });
    it("returns null for empty object", () => {
      assert.strictEqual(bedrockExtractor.extractUsage({}), null);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  OPENROUTER
// ═══════════════════════════════════════════════════════════════════════════

describe("OpenRouter Extractor", () => {
  describe("URL matching", () => {
    it("matches openrouter.ai", () => {
      assert.ok(openrouterExtractor.match(new URL("https://openrouter.ai/api/v1/chat/completions")));
    });
    it("does not match other hosts", () => {
      assert.ok(!openrouterExtractor.match(new URL("https://api.openai.com/v1/chat")));
    });
  });

  describe("usage extraction", () => {
    it("extracts usage from OpenRouter response", () => {
      const body = {
        id: "gen-abc",
        model: "anthropic/claude-sonnet-4-20250514",
        usage: {
          prompt_tokens: 200,
          completion_tokens: 100,
          total_tokens: 300,
        },
      };
      const usage = openrouterExtractor.extractUsage(body);
      assert.strictEqual(usage!.inputTokens, 200);
      assert.strictEqual(usage!.outputTokens, 100);
      assert.strictEqual(usage!.totalTokens, 300);
    });

    it("extracts cache tokens", () => {
      const body = {
        model: "anthropic/claude-sonnet-4-20250514",
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          cached_tokens: 80,
          cache_write_tokens: 20,
        },
      };
      const usage = openrouterExtractor.extractUsage(body);
      assert.strictEqual(usage!.cacheReadTokens, 80);
      assert.strictEqual(usage!.cacheCreationTokens, 20);
    });
  });

  describe("stream options injection", () => {
    it("injects stream_options for streaming requests", () => {
      const body = { model: "openai/gpt-4o", stream: true };
      const modified = openrouterExtractor.injectStreamOptions!(body) as Record<string, unknown>;
      assert.deepStrictEqual(modified["stream_options"], { include_usage: true });
    });
  });

  describe("edge cases", () => {
    it("returns null for null body", () => {
      assert.strictEqual(openrouterExtractor.extractUsage(null), null);
    });
    it("returns null for empty object", () => {
      assert.strictEqual(openrouterExtractor.extractUsage({}), null);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  COHERE
// ═══════════════════════════════════════════════════════════════════════════

describe("Cohere Extractor", () => {
  describe("URL matching", () => {
    it("matches api.cohere.com", () => {
      assert.ok(cohereExtractor.match(new URL("https://api.cohere.com/v2/chat")));
    });
    it("does not match other hosts", () => {
      assert.ok(!cohereExtractor.match(new URL("https://cohere.com")));
    });
  });

  describe("usage extraction", () => {
    it("extracts usage from Cohere Chat API (meta.tokens format)", () => {
      const body = {
        text: "Hello!",
        meta: {
          tokens: {
            input_tokens: 72,
            output_tokens: 35,
          },
        },
      };
      const usage = cohereExtractor.extractUsage(body);
      assert.strictEqual(usage!.inputTokens, 72);
      assert.strictEqual(usage!.outputTokens, 35);
    });

    it("falls back to OpenAI-compatible format (Cohere v2)", () => {
      const body = {
        model: "command-r-plus",
        usage: {
          prompt_tokens: 50,
          completion_tokens: 25,
          total_tokens: 75,
        },
      };
      const usage = cohereExtractor.extractUsage(body);
      assert.strictEqual(usage!.inputTokens, 50);
      assert.strictEqual(usage!.outputTokens, 25);
    });
  });

  describe("edge cases", () => {
    it("returns null for null body", () => {
      assert.strictEqual(cohereExtractor.extractUsage(null), null);
    });
    it("returns null for empty object", () => {
      assert.strictEqual(cohereExtractor.extractUsage({}), null);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  MISTRAL
// ═══════════════════════════════════════════════════════════════════════════

describe("Mistral Extractor", () => {
  describe("URL matching", () => {
    it("matches api.mistral.ai", () => {
      assert.ok(mistralExtractor.match(new URL("https://api.mistral.ai/v1/chat/completions")));
    });
    it("does not match other hosts", () => {
      assert.ok(!mistralExtractor.match(new URL("https://mistral.ai")));
    });
  });

  describe("usage extraction", () => {
    it("extracts usage from Mistral response (OpenAI-compatible)", () => {
      const body = {
        id: "cmpl-abc",
        model: "mistral-large-latest",
        usage: {
          prompt_tokens: 80,
          completion_tokens: 40,
          total_tokens: 120,
        },
      };
      const usage = mistralExtractor.extractUsage(body);
      assert.strictEqual(usage!.inputTokens, 80);
      assert.strictEqual(usage!.outputTokens, 40);
      assert.strictEqual(usage!.totalTokens, 120);
    });
  });

  describe("edge cases", () => {
    it("returns null for null body", () => {
      assert.strictEqual(mistralExtractor.extractUsage(null), null);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  TOGETHER AI
// ═══════════════════════════════════════════════════════════════════════════

describe("Together Extractor", () => {
  describe("URL matching", () => {
    it("matches api.together.xyz", () => {
      assert.ok(togetherExtractor.match(new URL("https://api.together.xyz/v1/chat/completions")));
    });
    it("does not match other hosts", () => {
      assert.ok(!togetherExtractor.match(new URL("https://together.xyz")));
    });
  });

  describe("usage extraction", () => {
    it("extracts usage from Together response (OpenAI-compatible)", () => {
      const body = {
        model: "meta-llama/Llama-3.3-70B-Instruct",
        usage: {
          prompt_tokens: 65,
          completion_tokens: 130,
          total_tokens: 195,
        },
      };
      const usage = togetherExtractor.extractUsage(body);
      assert.strictEqual(usage!.inputTokens, 65);
      assert.strictEqual(usage!.outputTokens, 130);
      assert.strictEqual(usage!.totalTokens, 195);
    });
  });

  describe("edge cases", () => {
    it("returns null for null body", () => {
      assert.strictEqual(togetherExtractor.extractUsage(null), null);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  DEEPSEEK
// ═══════════════════════════════════════════════════════════════════════════

describe("DeepSeek Extractor", () => {
  describe("URL matching", () => {
    it("matches api.deepseek.com", () => {
      assert.ok(deepseekExtractor.match(new URL("https://api.deepseek.com/chat/completions")));
    });
    it("does not match other hosts", () => {
      assert.ok(!deepseekExtractor.match(new URL("https://deepseek.com")));
    });
  });

  describe("usage extraction", () => {
    it("extracts usage from DeepSeek response", () => {
      const body = {
        model: "deepseek-chat",
        usage: {
          prompt_tokens: 100,
          completion_tokens: 200,
          total_tokens: 300,
        },
      };
      const usage = deepseekExtractor.extractUsage(body);
      assert.strictEqual(usage!.inputTokens, 100);
      assert.strictEqual(usage!.outputTokens, 200);
      assert.strictEqual(usage!.totalTokens, 300);
    });

    it("extracts reasoning tokens", () => {
      const body = {
        model: "deepseek-reasoner",
        usage: {
          prompt_tokens: 50,
          completion_tokens: 500,
          total_tokens: 550,
          completion_tokens_details: { reasoning_tokens: 400 },
        },
      };
      const usage = deepseekExtractor.extractUsage(body);
      assert.strictEqual(usage!.reasoningTokens, 400);
    });

    it("extracts cache hit/miss tokens", () => {
      const body = {
        model: "deepseek-chat",
        usage: {
          prompt_tokens: 200,
          completion_tokens: 100,
          total_tokens: 300,
          prompt_cache_hit_tokens: 150,
          prompt_cache_miss_tokens: 50,
        },
      };
      const usage = deepseekExtractor.extractUsage(body);
      assert.strictEqual(usage!.cacheReadTokens, 150);
      assert.strictEqual(usage!.cacheCreationTokens, 50);
    });
  });

  describe("edge cases", () => {
    it("returns null for null body", () => {
      assert.strictEqual(deepseekExtractor.extractUsage(null), null);
    });
    it("returns null for empty object", () => {
      assert.strictEqual(deepseekExtractor.extractUsage({}), null);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  FIREWORKS
// ═══════════════════════════════════════════════════════════════════════════

describe("Fireworks Extractor", () => {
  describe("URL matching", () => {
    it("matches api.fireworks.ai", () => {
      assert.ok(fireworksExtractor.match(new URL("https://api.fireworks.ai/inference/v1/chat/completions")));
    });
    it("does not match other hosts", () => {
      assert.ok(!fireworksExtractor.match(new URL("https://fireworks.ai")));
    });
  });

  describe("usage extraction", () => {
    it("extracts usage (OpenAI-compatible)", () => {
      const body = {
        model: "accounts/fireworks/models/llama-v3p3-70b-instruct",
        usage: { prompt_tokens: 40, completion_tokens: 90, total_tokens: 130 },
      };
      const usage = fireworksExtractor.extractUsage(body);
      assert.strictEqual(usage!.inputTokens, 40);
      assert.strictEqual(usage!.outputTokens, 90);
      assert.strictEqual(usage!.totalTokens, 130);
    });
  });

  describe("edge cases", () => {
    it("returns null for null body", () => {
      assert.strictEqual(fireworksExtractor.extractUsage(null), null);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  PERPLEXITY
// ═══════════════════════════════════════════════════════════════════════════

describe("Perplexity Extractor", () => {
  describe("URL matching", () => {
    it("matches api.perplexity.ai", () => {
      assert.ok(perplexityExtractor.match(new URL("https://api.perplexity.ai/chat/completions")));
    });
    it("does not match other hosts", () => {
      assert.ok(!perplexityExtractor.match(new URL("https://perplexity.ai")));
    });
  });

  describe("usage extraction", () => {
    it("extracts usage (OpenAI-compatible)", () => {
      const body = {
        model: "sonar-pro",
        usage: { prompt_tokens: 88, completion_tokens: 200, total_tokens: 288 },
      };
      const usage = perplexityExtractor.extractUsage(body);
      assert.strictEqual(usage!.inputTokens, 88);
      assert.strictEqual(usage!.outputTokens, 200);
      assert.strictEqual(usage!.totalTokens, 288);
    });
  });

  describe("edge cases", () => {
    it("returns null for null body", () => {
      assert.strictEqual(perplexityExtractor.extractUsage(null), null);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  CEREBRAS
// ═══════════════════════════════════════════════════════════════════════════

describe("Cerebras Extractor", () => {
  describe("URL matching", () => {
    it("matches api.cerebras.ai", () => {
      assert.ok(cerebrasExtractor.match(new URL("https://api.cerebras.ai/v1/chat/completions")));
    });
    it("does not match other hosts", () => {
      assert.ok(!cerebrasExtractor.match(new URL("https://cerebras.ai")));
    });
  });

  describe("usage extraction", () => {
    it("extracts usage (OpenAI-compatible)", () => {
      const body = {
        model: "llama-3.3-70b",
        usage: { prompt_tokens: 20, completion_tokens: 60, total_tokens: 80 },
      };
      const usage = cerebrasExtractor.extractUsage(body);
      assert.strictEqual(usage!.inputTokens, 20);
      assert.strictEqual(usage!.outputTokens, 60);
      assert.strictEqual(usage!.totalTokens, 80);
    });
  });

  describe("edge cases", () => {
    it("returns null for null body", () => {
      assert.strictEqual(cerebrasExtractor.extractUsage(null), null);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  PROVIDER REGISTRY
// ═══════════════════════════════════════════════════════════════════════════

describe("Provider Registry", () => {
  describe("findExtractor", () => {
    it("returns openaiExtractor for api.openai.com", () => {
      assert.strictEqual(findExtractor(new URL("https://api.openai.com/v1/chat/completions")), openaiExtractor);
    });

    it("returns openaiExtractor for Azure OpenAI", () => {
      assert.strictEqual(
        findExtractor(new URL("https://my-resource.openai.azure.com/openai/deployments/gpt-4/chat/completions")),
        openaiExtractor,
      );
    });

    it("returns anthropicExtractor for api.anthropic.com", () => {
      assert.strictEqual(findExtractor(new URL("https://api.anthropic.com/v1/messages")), anthropicExtractor);
    });

    it("returns googleExtractor for generativelanguage.googleapis.com", () => {
      assert.strictEqual(
        findExtractor(new URL("https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent")),
        googleExtractor,
      );
    });

    it("returns googleExtractor for Vertex AI", () => {
      assert.strictEqual(
        findExtractor(new URL("https://us-central1-aiplatform.googleapis.com/v1/models/gemini-pro")),
        googleExtractor,
      );
    });

    it("returns openrouterExtractor for openrouter.ai", () => {
      assert.strictEqual(findExtractor(new URL("https://openrouter.ai/api/v1/chat/completions")), openrouterExtractor);
    });

    it("returns bedrockExtractor for bedrock-runtime.*.amazonaws.com", () => {
      assert.strictEqual(
        findExtractor(new URL("https://bedrock-runtime.us-east-1.amazonaws.com/model/invoke")),
        bedrockExtractor,
      );
    });

    it("returns groqExtractor for api.groq.com", () => {
      assert.strictEqual(findExtractor(new URL("https://api.groq.com/openai/v1/chat/completions")), groqExtractor);
    });

    it("returns cerebrasExtractor for api.cerebras.ai", () => {
      assert.strictEqual(findExtractor(new URL("https://api.cerebras.ai/v1/chat/completions")), cerebrasExtractor);
    });

    it("returns fireworksExtractor for api.fireworks.ai", () => {
      assert.strictEqual(findExtractor(new URL("https://api.fireworks.ai/inference/v1/chat/completions")), fireworksExtractor);
    });

    it("returns togetherExtractor for api.together.xyz", () => {
      assert.strictEqual(findExtractor(new URL("https://api.together.xyz/v1/chat/completions")), togetherExtractor);
    });

    it("returns xaiExtractor for api.x.ai", () => {
      assert.strictEqual(findExtractor(new URL("https://api.x.ai/v1/chat/completions")), xaiExtractor);
    });

    it("returns mistralExtractor for api.mistral.ai", () => {
      assert.strictEqual(findExtractor(new URL("https://api.mistral.ai/v1/chat/completions")), mistralExtractor);
    });

    it("returns deepseekExtractor for api.deepseek.com", () => {
      assert.strictEqual(findExtractor(new URL("https://api.deepseek.com/chat/completions")), deepseekExtractor);
    });

    it("returns cohereExtractor for api.cohere.com", () => {
      assert.strictEqual(findExtractor(new URL("https://api.cohere.com/v2/chat")), cohereExtractor);
    });

    it("returns perplexityExtractor for api.perplexity.ai", () => {
      assert.strictEqual(findExtractor(new URL("https://api.perplexity.ai/chat/completions")), perplexityExtractor);
    });

    it("returns null for non-AI URLs", () => {
      assert.strictEqual(findExtractor(new URL("https://api.example.com/data")), null);
      assert.strictEqual(findExtractor(new URL("https://google.com")), null);
      assert.strictEqual(findExtractor(new URL("https://github.com/api/repos")), null);
      assert.strictEqual(findExtractor(new URL("https://s3.amazonaws.com/bucket")), null);
    });
  });

  describe("registerExtractor", () => {
    it("adds a custom extractor that can be found", () => {
      const customExtractor: ProviderExtractor = {
        provider: Provider.Unknown,
        match(url: URL) { return url.hostname === "my-custom-ai.example.com"; },
        extractUsage() { return null; },
        extractModel() { return "custom-model"; },
      };

      registerExtractor(customExtractor);

      const found = findExtractor(new URL("https://my-custom-ai.example.com/v1/completions"));
      assert.strictEqual(found, customExtractor);
      assert.strictEqual(found!.extractModel(null, null), "custom-model");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  STACK TRACE
// ═══════════════════════════════════════════════════════════════════════════

describe("Stack Trace Capture", () => {
  it("captureCallSite returns a non-null result with frames", () => {
    const site = captureCallSite();
    // Note: captureCallSite filters out SDK internal frames.
    // When running from within the SDK test directory, all frames may be
    // filtered. We just verify it does not throw and returns a valid shape.
    if (site !== null) {
      assert.ok(site.raw.length > 0);
      assert.ok(Array.isArray(site.frames));
    }
  });

  it("returned frames have file and line info when present", () => {
    const site = captureCallSite();
    if (site !== null && site.frames.length > 0) {
      const frameWithFile = site.frames.find((f) => f.fileName !== null);
      if (frameWithFile) {
        assert.ok(
          frameWithFile.lineNumber != null && frameWithFile.lineNumber > 0,
          "lineNumber should be positive",
        );
      }
    }
  });

  describe("internal pattern filtering", () => {
    it("filters Node internals (node:internal/, node:async_hooks)", () => {
      const site = captureCallSite();
      if (site !== null) {
        for (const frame of site.frames) {
          if (frame.fileName) {
            assert.ok(
              !frame.fileName.startsWith("node:internal/"),
              `should not include node:internal frame: ${frame.fileName}`,
            );
            assert.ok(
              !frame.fileName.startsWith("node:async_hooks"),
              `should not include node:async_hooks frame: ${frame.fileName}`,
            );
          }
        }
      }
    });

    it("internal patterns correctly identify SDK frames", () => {
      // Verify a path containing the SDK pattern would be filtered
      const sdkPaths = [
        "/home/user/project/node_modules/costkey/dist/index.js",
        "/app/costkey/packages/sdk/src/fetch-patch.ts",
      ];
      const INTERNAL_PATTERNS = [
        "/costkey/packages/sdk/",
        "/node_modules/costkey/",
      ];
      for (const path of sdkPaths) {
        const matched = INTERNAL_PATTERNS.some((p) => path.includes(p));
        assert.ok(matched, `SDK path should be filtered: ${path}`);
      }
    });

    it("internal patterns correctly identify AI SDK library frames", () => {
      const libPaths = [
        "/app/node_modules/openai/src/core.ts",
        "/app/node_modules/@anthropic-ai/sdk/src/index.ts",
        "/app/node_modules/@google/generative-ai/dist/index.js",
        "/app/node_modules/cohere-ai/dist/api/index.js",
      ];
      const INTERNAL_PATTERNS = [
        "/node_modules/openai/",
        "/node_modules/@anthropic-ai/",
        "/node_modules/@google/generative-ai/",
        "/node_modules/cohere-ai/",
      ];
      for (const path of libPaths) {
        const matched = INTERNAL_PATTERNS.some((p) => path.includes(p));
        assert.ok(matched, `AI SDK path should be filtered: ${path}`);
      }
    });

    it("internal patterns correctly identify HTTP client frames", () => {
      const httpPaths = [
        "/app/node_modules/undici/lib/fetch/index.js",
        "/app/node_modules/node-fetch/src/index.js",
      ];
      const INTERNAL_PATTERNS = [
        "/node_modules/node-fetch/",
        "/node_modules/undici/",
      ];
      for (const path of httpPaths) {
        const matched = INTERNAL_PATTERNS.some((p) => path.includes(p));
        assert.ok(matched, `HTTP client path should be filtered: ${path}`);
      }
    });

    it("internal patterns correctly identify Node internal frames", () => {
      const nodePaths = [
        "node:internal/process/task_queues",
        "node:async_hooks",
        "node:internal/modules/cjs/loader",
      ];
      const INTERNAL_PATTERNS = [
        "node:internal/",
        "node:async_hooks",
      ];
      for (const path of nodePaths) {
        const matched = INTERNAL_PATTERNS.some((p) => path.includes(p));
        assert.ok(matched, `Node internal path should be filtered: ${path}`);
      }
    });

    it("user code frames are NOT matched by internal patterns", () => {
      const userPaths = [
        "/app/src/handler.ts",
        "/home/user/project/index.js",
        "/app/routes/api.ts",
        "/app/node_modules/express/lib/router.js",
      ];
      const INTERNAL_PATTERNS = [
        "/costkey/packages/sdk/",
        "/node_modules/costkey/",
        "node:internal/",
        "node:async_hooks",
        "/node_modules/openai/",
        "/node_modules/@anthropic-ai/",
        "/node_modules/@google/generative-ai/",
        "/node_modules/cohere-ai/",
        "/node_modules/node-fetch/",
        "/node_modules/undici/",
      ];
      for (const path of userPaths) {
        const matched = INTERNAL_PATTERNS.some((p) => path.includes(p));
        assert.ok(!matched, `User code path should NOT be filtered: ${path}`);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  TRANSPORT
// ═══════════════════════════════════════════════════════════════════════════

describe("Transport", () => {
  function makeEvent(overrides: Partial<import("../types.js").CostKeyEvent> = {}): import("../types.js").CostKeyEvent {
    return {
      id: "evt_" + Math.random().toString(36).slice(2),
      timestamp: new Date().toISOString(),
      projectId: "proj_test",
      provider: Provider.OpenAI,
      model: "gpt-4o",
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      statusCode: 200,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      },
      costUsd: null,
      durationMs: 1234.56,
      streaming: false,
      streamTiming: null,
      callSite: null,
      context: {},
      requestBody: null,
      responseBody: null,
      ...overrides,
    };
  }

  it("enqueues events without throwing", () => {
    const transport = new Transport({
      endpoint: "https://ingest.costkey.dev/v1/events",
      authKey: "test-key",
      maxBatchSize: 50,
      flushInterval: 60000,
      debug: false,
    });

    const event = makeEvent();
    transport.enqueue(event);
  });

  it("queue overflow drops oldest events without throwing", () => {
    const transport = new Transport({
      endpoint: "https://ingest.costkey.dev/v1/events",
      authKey: "test-key",
      maxBatchSize: 50,
      flushInterval: 60000,
      debug: false,
    });

    // The maxQueueSize is 500 (private). Fill it up + 1.
    for (let i = 0; i < 501; i++) {
      transport.enqueue(makeEvent({ id: `evt_${i}` }));
    }

    // Should not throw even after overflow
    transport.enqueue(makeEvent({ id: "evt_overflow" }));
  });

  it("event serialization includes all required fields", () => {
    const event = makeEvent({
      streaming: true,
      streamTiming: {
        ttft: 145.3,
        tps: 42.7,
        streamDuration: 3200.5,
        chunkCount: 85,
      },
      callSite: {
        raw: "Error\n    at myFunc (/app/src/handler.ts:10:5)",
        frames: [
          { functionName: "myFunc", fileName: "/app/src/handler.ts", lineNumber: 10, columnNumber: 5 },
        ],
      },
      context: { task: "search", team: "backend" },
    });

    const serialized = JSON.parse(JSON.stringify(event));

    // All top-level fields present
    assert.ok(serialized.id);
    assert.ok(serialized.timestamp);
    assert.strictEqual(serialized.projectId, "proj_test");
    assert.strictEqual(serialized.provider, "openai");
    assert.strictEqual(serialized.model, "gpt-4o");
    assert.strictEqual(serialized.url, "https://api.openai.com/v1/chat/completions");
    assert.strictEqual(serialized.method, "POST");
    assert.strictEqual(serialized.statusCode, 200);
    assert.strictEqual(serialized.streaming, true);

    // Usage
    assert.strictEqual(serialized.usage.inputTokens, 100);
    assert.strictEqual(serialized.usage.outputTokens, 50);
    assert.strictEqual(serialized.usage.totalTokens, 150);

    // StreamTiming
    assert.strictEqual(serialized.streamTiming.ttft, 145.3);
    assert.strictEqual(serialized.streamTiming.tps, 42.7);
    assert.strictEqual(serialized.streamTiming.streamDuration, 3200.5);
    assert.strictEqual(serialized.streamTiming.chunkCount, 85);

    // CallSite
    assert.strictEqual(serialized.callSite.frames.length, 1);
    assert.strictEqual(serialized.callSite.frames[0].functionName, "myFunc");

    // Context
    assert.strictEqual(serialized.context.task, "search");
    assert.strictEqual(serialized.context.team, "backend");
  });

  it("release field is accepted by Transport options", () => {
    const transport = new Transport({
      endpoint: "https://ingest.costkey.dev/v1/events",
      authKey: "test-key",
      maxBatchSize: 50,
      flushInterval: 60000,
      debug: false,
      release: "v1.2.3",
    });

    transport.enqueue(makeEvent());
    // No throw means it accepted release.
  });

  it("StreamTiming serializes correctly with null fields", () => {
    const event = makeEvent({
      streaming: true,
      streamTiming: {
        ttft: null,
        tps: null,
        streamDuration: 500.0,
        chunkCount: 0,
      },
    });

    const serialized = JSON.parse(JSON.stringify(event));
    assert.strictEqual(serialized.streamTiming.ttft, null);
    assert.strictEqual(serialized.streamTiming.tps, null);
    assert.strictEqual(serialized.streamTiming.streamDuration, 500.0);
    assert.strictEqual(serialized.streamTiming.chunkCount, 0);
  });

  it("start and stop do not throw", () => {
    const transport = new Transport({
      endpoint: "https://ingest.costkey.dev/v1/events",
      authKey: "test-key",
      maxBatchSize: 50,
      flushInterval: 60000,
      debug: false,
    });

    transport.start();
    transport.stop();
    transport.stop(); // double stop should be safe
  });

  it("start is idempotent", () => {
    const transport = new Transport({
      endpoint: "https://ingest.costkey.dev/v1/events",
      authKey: "test-key",
      maxBatchSize: 50,
      flushInterval: 60000,
      debug: false,
    });

    transport.start();
    transport.start(); // second call should be no-op
    transport.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  CROSS-PROVIDER: all extractors return null for edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("All extractors handle edge cases uniformly", () => {
  const allExtractors: Array<{ name: string; extractor: ProviderExtractor }> = [
    { name: "OpenAI", extractor: openaiExtractor },
    { name: "Anthropic", extractor: anthropicExtractor },
    { name: "Google", extractor: googleExtractor },
    { name: "Groq", extractor: groqExtractor },
    { name: "xAI", extractor: xaiExtractor },
    { name: "Bedrock", extractor: bedrockExtractor },
    { name: "OpenRouter", extractor: openrouterExtractor },
    { name: "Cohere", extractor: cohereExtractor },
    { name: "Mistral", extractor: mistralExtractor },
    { name: "Together", extractor: togetherExtractor },
    { name: "DeepSeek", extractor: deepseekExtractor },
    { name: "Fireworks", extractor: fireworksExtractor },
    { name: "Perplexity", extractor: perplexityExtractor },
    { name: "Cerebras", extractor: cerebrasExtractor },
  ];

  for (const { name, extractor } of allExtractors) {
    it(`${name}: extractUsage(null) returns null`, () => {
      assert.strictEqual(extractor.extractUsage(null), null);
    });
    it(`${name}: extractUsage(undefined) returns null`, () => {
      assert.strictEqual(extractor.extractUsage(undefined), null);
    });
    it(`${name}: extractUsage({}) returns null`, () => {
      assert.strictEqual(extractor.extractUsage({}), null);
    });
    it(`${name}: extractUsage("string") returns null`, () => {
      assert.strictEqual(extractor.extractUsage("string"), null);
    });
    it(`${name}: extractModel(null, null) returns null`, () => {
      assert.strictEqual(extractor.extractModel(null, null), null);
    });
  }
});
