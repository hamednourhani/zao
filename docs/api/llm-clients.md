# llm-clients API Reference

LLM provider registry and client lifecycle management.

## Configuration

```yaml
# ~/.zao/llm-providers.yaml
providers:
  deepseek:
    api_key: "${DEEPSEEK_API_KEY}"
    default_model: deepseek-chat
    models:
      - deepseek-chat
      - deepseek-reasoner

  openai:
    api_key: "${OPENAI_API_KEY}"
    default_model: gpt-4o
    models:
      - gpt-4o
      - gpt-4o-mini
```

## Core Exports

### Registry

```typescript
import { createDefaultRegistry } from "@zao/llm-clients";

const registry = await createDefaultRegistry();

// Get a client for a specific model
const client = await registry.getClient("deepseek:deepseek-chat");

// List available clients
const clients = registry.listClients();
```

### Client Interface

```typescript
interface LlmClient {
  llmId: string;          // "deepseek:deepseek-chat"
  providerId: string;     // "deepseek"
  modelSlug: string;      // "deepseek-chat"
  apiModelId: string;     // "deepseek-chat"
  createModel(options?: ModelOptions): LanguageModelV1;
}

interface ModelOptions {
  temperature?: number;
  maxTokens?: number;
}
```

### Structured Generation

```typescript
import { generateObject } from "ai";
import { z } from "zod";

const { object } = await generateObject({
  model: client.createModel({ temperature: 0.1 }),
  schema: z.object({
    summary: z.string(),
    decision: z.string(),
  }),
  prompt: "Analyze this code...",
});
```

## Provider Resolution

Providers are resolved via `llmId` strings in the format `provider:model`:

- `deepseek:deepseek-chat` → DeepSeek provider, deepseek-chat model
- `openai:gpt-4o` → OpenAI provider, gpt-4o model

Custom providers can be registered:

```typescript
import type { ProviderAdapter } from "@zao/llm-clients";

const customAdapter: ProviderAdapter = {
  providerId: "custom",
  validateConfig: (config) => { /* ... */ },
  createModel: (modelSlug, options, config) => { /* ... */ },
};

registry.registerProvider(customAdapter, {
  apiKey: "...",
  baseUrl: "https://api.example.com",
  models: {
    "model-name": { apiModelId: "model-name" },
  },
});
```
