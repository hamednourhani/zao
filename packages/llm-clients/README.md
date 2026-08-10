# @zao/llm-clients

LLM client registry for zao — the single component that owns provider credentials, maps canonical `llm_id`s to provider-specific API model IDs, and creates Vercel AI SDK models on demand.

## Quick start

```typescript
import { createDefaultRegistry } from "@zao/llm-clients";

const registry = await createDefaultRegistry();
const client = await registry.getClient("deepseek:deepseek-chat");
const model = client.createModel({ temperature: 0.1 });
```

## Config file

Create `~/.zao/llm-providers.yaml` (use `llm-providers.yaml.example` as a template):

```yaml
llm_providers:
  deepseek:
    api_key: "${DEEPSEEK_API_KEY}"
    models:
      deepseek-chat:
        api_model_id: "deepseek-chat"

  openai:
    api_key: "${OPENAI_API_KEY}"
    models:
      gpt-4o:
        api_model_id: "gpt-4o"
      gpt-4o-mini:
        api_model_id: "gpt-4o-mini"
```

Override the path with `--llm-providers <path>` or `ZAO_LLM_PROVIDERS_PATH`.

## API

### `createDefaultRegistry(options?)`

Loads config from `llm-providers.yaml` and registers built-in adapters (deepseek, openai). Throws typed `LlmClientConfigError` on any config failure.

### `createTestRegistry()`

Returns an empty registry for test injection. Use `registerProvider()` to add test adapters.

### `registry.getClient(llmId)`

Resolves `"provider:model-slug"` to a ready `LlmClient`.

### `registry.listClients()`

Returns all configured provider/model combinations for controller planning.

### `registry.registerProvider(adapter, config?)`

Register a provider adapter at runtime (test injection + future extensions).

## `llm_id` format

`provider:model-slug` — e.g. `"deepseek:deepseek-chat"`, `"openai:gpt-4o"`.

## Test injection

```typescript
import { createTestRegistry } from "@zao/llm-clients";

const registry = createTestRegistry();
registry.registerProvider(myTestAdapter, {
  apiKey: "sk-test",
  models: { mock: { apiModelId: "mock" } },
});
const client = await registry.getClient("test:mock");
```

## Errors

All config errors extend `LlmClientConfigError` with a `code` property:

| Error | Code |
|---|---|
| `ConfigFileNotFoundError` | `CONFIG_FILE_NOT_FOUND` |
| `ConfigParseError` | `CONFIG_PARSE_ERROR` |
| `ConfigValidationError` | `CONFIG_VALIDATION_ERROR` |
| `ProviderNotConfiguredError` | `PROVIDER_NOT_CONFIGURED` |
| `ModelNotConfiguredError` | `MODEL_NOT_CONFIGURED` |
| `MissingApiKeyError` | `MISSING_API_KEY` |
