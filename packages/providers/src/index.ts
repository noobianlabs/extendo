import type { Plugin, Provider, ProviderInfo, Registry } from '@extendo/contracts';
import { anthropicProvider } from './anthropic.js';
import { demoProvider } from './demo.js';
import { deepSeekProvider, openAIProvider } from './openai.js';
export * from './anthropic.js';
export * from './demo.js';
export * from './openai.js';

export const acpProvider: Provider = {
  id: 'acp',
  async *stream() { throw new Error('ACP is not implemented in v0.1'); },
};

export function providerInfos(env: NodeJS.ProcessEnv = process.env): ProviderInfo[] {
  return [
    { id: 'demo', name: 'Demo', model: 'extendo-demo', configured: true },
    { id: 'anthropic', name: 'Anthropic', model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', configured: Boolean(env.ANTHROPIC_API_KEY) },
    { id: 'openai', name: 'OpenAI compatible', model: env.OPENAI_MODEL || 'gpt-5-mini', configured: Boolean(env.OPENAI_API_KEY) },
    { id: 'deepseek', name: 'DeepSeek', model: env.DEEPSEEK_MODEL || 'deepseek-chat', configured: Boolean(env.DEEPSEEK_API_KEY) },
  ];
}

/** A demo turn normally streams quickly; a scripted run can slow it to steer a turn while it runs. */
function demoDelay(env: NodeJS.ProcessEnv): { delay?: number } {
  const value = Number(env.EXTENDO_DEMO_DELAY ?? '');
  return Number.isFinite(value) && value > 0 ? { delay: value } : {};
}

export function providersPlugin(env: NodeJS.ProcessEnv = process.env): Plugin {
  return {
    name: 'providers',
    apply(ctx) {
      const registry = ctx.get<Registry<Provider>>('providers');
      const adapters = [
        demoProvider(demoDelay(env)),
        ...(env.ANTHROPIC_API_KEY ? [anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY })] : []),
        ...(env.OPENAI_API_KEY ? [openAIProvider({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL })] : []),
        ...(env.DEEPSEEK_API_KEY ? [deepSeekProvider({ apiKey: env.DEEPSEEK_API_KEY, baseUrl: env.DEEPSEEK_BASE_URL })] : []),
      ];
      for (const adapter of adapters) {
        registry.register(ctx, adapter.id, adapter);
        ctx.emit('llm/register', { id: adapter.id });
      }
      ctx.provide('provider-info', providerInfos(env));
    },
  };
}
