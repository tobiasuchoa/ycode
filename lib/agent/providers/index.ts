import { resolveAgentConfig } from '@/lib/agent/config';

import { createAnthropicProvider } from './anthropic';
import type { AgentProvider } from './types';

/**
 * Provider selection.
 *
 * The open-source build ships only the BYOK Anthropic provider. The Ycode Cloud
 * overlay calls `registerHostedProvider` at startup to take over for hosted
 * tenants — so the hosted implementation lives entirely in the overlay and is
 * simply absent from self-host builds.
 */

export class AgentConfigurationError extends Error {}

type HostedProviderFactory = () => Promise<AgentProvider | null>;

let hostedProviderFactory: HostedProviderFactory | null = null;

/** Called by the Cloud overlay to provide a hosted (managed-key) backend. */
export function registerHostedProvider(factory: HostedProviderFactory): void {
  hostedProviderFactory = factory;
}

/**
 * Resolve the active provider for the current request.
 *
 * Prefers a registered hosted provider (Cloud); otherwise falls back to BYOK
 * using the resolved Anthropic key. Throws AgentConfigurationError when no
 * usable backend is configured, so the API route can surface a clear message.
 */
export async function getAgentProvider(): Promise<{ provider: AgentProvider; model: string }> {
  const config = await resolveAgentConfig();

  if (hostedProviderFactory) {
    const hosted = await hostedProviderFactory();
    if (hosted) return { provider: hosted, model: config.model };
  }

  if (!config.apiKey) {
    throw new AgentConfigurationError(
      'No Anthropic API key configured. Set ANTHROPIC_API_KEY (or the ai_anthropic_api_key setting) to use the AI builder.',
    );
  }

  return { provider: createAnthropicProvider(config.apiKey), model: config.model };
}
