# Providers

The provider boundary is `Provider.stream(request): AsyncIterable<ModelChunk>`. The request carries the selected model, ordered system prompt sections, normalized conversation (including tool calls/results), model-visible JSON Schemas, and an abort signal. Emit text and reasoning deltas incrementally; emit only complete tool calls, with stable unique IDs and JSON arguments. Optionally emit usage, then emit `done` once the provider protocol confirms completion. Throw or emit an error on a failed stream. Use the request signal for both HTTP and stream reads.

| Provider | Key | Configuration |
| --- | --- | --- |
| Demo | None | `extendo-demo`; scripted local responses, no real shell, network, or workspace writes |

`EXTENDO_DEMO_DELAY` slows the demo provider's streamed text (milliseconds per fragment). It exists
so a scripted end-to-end run can steer a worker while its turn is genuinely running; leave it unset
for the normal demo speed.
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` |
| OpenAI compatible | `OPENAI_API_KEY` | `OPENAI_BASE_URL` (including the API path such as `/v1`), `OPENAI_MODEL` |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL` |

Set the variables in the process environment and restart Extendo. Settings exposes availability and selects an adapter/default model; neither REST nor RPC returns the keys. By default Extendo uses Demo so setup never requires credentials. The ACP adapter is a typed runtime stub for a future release.

Register an adapter from a plugin with `ctx.get<Registry<Provider>>('providers').register(ctx, provider.id, provider)`, then emit `llm/register` with its ID. The local runtime discovers registered providers by ID, so the adapter needs no server-route change. Add deterministic wire-fixture tests like those in `packages/providers/src/index.test.ts`; no paid key is needed to test parsing, cancellation and the request envelope.
