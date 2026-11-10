import { configDefaults, defineConfig } from "vitest/config";

// LangChain needs Node 20+, Mastra 22.13+, and the OpenAI Agents SDK doesn't
// load on Node 18. The SDK still supports Node 18, so on 18 only these suites skip.
const node = Number(process.versions.node.split(".")[0]);
const needsNode20 = [
  "src/__tests__/integrations/langchain.test.ts",
  "src/__tests__/integrations/mastra.test.ts",
  "src/__tests__/integrations/openai-agents.test.ts",
];

export default defineConfig({
  test: {
    globals: true,
    exclude: [...configDefaults.exclude, ...(node < 20 ? needsNode20 : [])],
  },
});
