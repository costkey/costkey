import { describe, it, expect } from "vitest";
import { openaiExtractor } from "../providers/openai.js";
import { anthropicExtractor } from "../providers/anthropic.js";
import { googleExtractor } from "../providers/google.js";
import { findExtractor } from "../providers/registry.js";

describe("Provider Registry", () => {
  it("matches OpenAI URLs", () => {
    expect(findExtractor(new URL("https://api.openai.com/v1/chat/completions"))).toBe(openaiExtractor);
  });

  it("matches Azure OpenAI URLs", () => {
    const ext = findExtractor(new URL("https://my-resource.openai.azure.com/openai/deployments/gpt-4/chat/completions"));
    expect(ext).toBe(openaiExtractor);
  });

  it("matches Anthropic URLs", () => {
    expect(findExtractor(new URL("https://api.anthropic.com/v1/messages"))).toBe(anthropicExtractor);
  });

  it("matches Google AI URLs", () => {
    expect(findExtractor(new URL("https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent"))).toBe(googleExtractor);
  });

  it("matches Vertex AI URLs", () => {
    expect(findExtractor(new URL("https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/publishers/google/models/gemini-pro:generateContent"))).toBe(googleExtractor);
  });

  it("returns null for non-AI URLs", () => {
    expect(findExtractor(new URL("https://api.example.com/data"))).toBeNull();
    expect(findExtractor(new URL("https://google.com"))).toBeNull();
  });
});

describe("OpenAI Extractor", () => {
  it("extracts usage from chat completion response", () => {
    const body = {
      id: "chatcmpl-abc",
      model: "gpt-4o",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    };

    const usage = openaiExtractor.extractUsage(body);
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
  });

  it("extracts usage from Responses API format", () => {
    const body = {
      id: "resp-abc",
      model: "gpt-4o",
      usage: {
        input_tokens: 200,
        output_tokens: 80,
        total_tokens: 280,
      },
    };

    const usage = openaiExtractor.extractUsage(body);
    expect(usage).toEqual({
      inputTokens: 200,
      outputTokens: 80,
      totalTokens: 280,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
  });

  it("extracts reasoning tokens from o-series models", () => {
    const body = {
      model: "o1",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 200,
        total_tokens: 300,
        completion_tokens_details: {
          reasoning_tokens: 128,
        },
      },
    };

    const usage = openaiExtractor.extractUsage(body);
    expect(usage?.reasoningTokens).toBe(128);
  });

  it("returns null for missing usage", () => {
    expect(openaiExtractor.extractUsage({})).toBeNull();
    expect(openaiExtractor.extractUsage(null)).toBeNull();
    expect(openaiExtractor.extractUsage("string")).toBeNull();
  });

  it("extracts model from response body", () => {
    expect(openaiExtractor.extractModel(null, { model: "gpt-4o-2024-11-20" })).toBe("gpt-4o-2024-11-20");
  });

  it("falls back to request body model", () => {
    expect(openaiExtractor.extractModel({ model: "gpt-4o" }, {})).toBe("gpt-4o");
  });

  it("injects stream_options for streaming requests", () => {
    const body = { model: "gpt-4o", stream: true, messages: [] };
    const modified = openaiExtractor.injectStreamOptions!(body);

    expect(modified).toEqual({
      model: "gpt-4o",
      stream: true,
      messages: [],
      stream_options: { include_usage: true },
    });
  });

  it("merges with existing stream_options", () => {
    const body = {
      model: "gpt-4o",
      stream: true,
      stream_options: { some_field: "value" },
    };
    const modified = openaiExtractor.injectStreamOptions!(body);

    expect(modified).toEqual({
      model: "gpt-4o",
      stream: true,
      stream_options: { some_field: "value", include_usage: true },
    });
  });

  it("does not modify non-streaming requests", () => {
    const body = { model: "gpt-4o", messages: [] };
    const result = openaiExtractor.injectStreamOptions!(body);
    expect(result).toBe(body); // Same reference, not modified
  });
});

describe("Anthropic Extractor", () => {
  it("extracts usage from messages response", () => {
    const body = {
      id: "msg_abc",
      model: "claude-sonnet-4-0-20250514",
      usage: {
        input_tokens: 300,
        output_tokens: 150,
      },
    };

    const usage = anthropicExtractor.extractUsage(body);
    expect(usage).toEqual({
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
  });

  it("extracts cache tokens", () => {
    const body = {
      model: "claude-sonnet-4-0-20250514",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 200,
      },
    };

    const usage = anthropicExtractor.extractUsage(body);
    expect(usage?.cacheReadTokens).toBe(500);
    expect(usage?.cacheCreationTokens).toBe(200);
  });
});

describe("Google Extractor", () => {
  it("extracts usage from Gemini response", () => {
    const body = {
      candidates: [{ content: { parts: [{ text: "Hello" }] } }],
      usageMetadata: {
        promptTokenCount: 50,
        candidatesTokenCount: 20,
        totalTokenCount: 70,
      },
    };

    const usage = googleExtractor.extractUsage(body);
    expect(usage).toEqual({
      inputTokens: 50,
      outputTokens: 20,
      totalTokens: 70,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
  });

  it("extracts thinking tokens", () => {
    const body = {
      usageMetadata: {
        promptTokenCount: 50,
        candidatesTokenCount: 100,
        totalTokenCount: 250,
        thoughtsTokenCount: 100,
      },
    };

    const usage = googleExtractor.extractUsage(body);
    expect(usage?.reasoningTokens).toBe(100);
  });
});
