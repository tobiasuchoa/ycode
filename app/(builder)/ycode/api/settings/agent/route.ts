import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  PROVIDER_KEY_SETTINGS,
  resolveAgentConfig,
  sanitizeEnabledModels,
  SETTING_AGENT_ENABLED,
  SETTING_ENABLED_MODELS,
  SETTING_MODEL,
} from '@/lib/agent/config';
import { AGENT_MODELS, AGENT_PROVIDERS } from '@/lib/agent/models';
import { setSettings } from '@/lib/repositories/settingsRepository';

import type { ResolvedAgentConfig } from '@/lib/agent/config';
import type { AgentProviderId } from '@/lib/agent/models';

/**
 * GET /ycode/api/settings/agent
 *
 * Agent (AI builder) configuration status. API keys are never returned in
 * full — only a masked hint per provider — so they can't leak into client state.
 */
export async function GET() {
  try {
    const config = await resolveAgentConfig();
    return NextResponse.json({ data: toStatusPayload(config) });
  } catch (error) {
    console.error('[API] Error fetching agent settings:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch agent settings' },
      { status: 500 }
    );
  }
}

const providerIds = ['anthropic', 'openai', 'google'] as const;

const putSchema = z.object({
  // Per-provider keys: undefined = keep current; null / "" = remove stored key.
  keys: z
    .object({
      anthropic: z.string().nullish(),
      openai: z.string().nullish(),
      google: z.string().nullish(),
    })
    .partial()
    .optional(),
  model: z.string().optional(),
  enabledModels: z.array(z.string()).optional(),
  agentEnabled: z.boolean().optional(),
});

/**
 * PUT /ycode/api/settings/agent
 *
 * Save agent configuration. Only provided fields are updated. These are
 * builder-only settings, so no public-page cache invalidation is needed.
 */
export async function PUT(request: NextRequest) {
  try {
    const body = putSchema.parse(await request.json());
    const updates: Record<string, unknown> = {};

    for (const providerId of providerIds) {
      const key = body.keys?.[providerId];
      if (key !== undefined) {
        const trimmed = key?.trim() ?? '';
        // null deletes the row (setSettings semantics).
        updates[PROVIDER_KEY_SETTINGS[providerId]] = trimmed.length > 0 ? trimmed : null;
      }
    }

    if (body.model !== undefined) {
      if (!AGENT_MODELS.some((option) => option.id === body.model)) {
        return NextResponse.json({ error: 'Unknown model' }, { status: 400 });
      }
      updates[SETTING_MODEL] = body.model;
    }

    if (body.enabledModels !== undefined) {
      const enabled = sanitizeEnabledModels(body.enabledModels);
      if (enabled.length !== body.enabledModels.length) {
        return NextResponse.json(
          { error: 'At least one valid model must be enabled' },
          { status: 400 }
        );
      }
      updates[SETTING_ENABLED_MODELS] = enabled;
    }

    if (body.agentEnabled !== undefined) {
      // Store only the opt-out; `null` deletes the row so "on" stays the default.
      updates[SETTING_AGENT_ENABLED] = body.agentEnabled ? null : false;
    }

    if (Object.keys(updates).length > 0) {
      await setSettings(updates);
    }

    const config = await resolveAgentConfig();

    return NextResponse.json({
      data: toStatusPayload(config),
      message: 'Agent settings updated successfully',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    console.error('[API] Error updating agent settings:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update agent settings' },
      { status: 500 }
    );
  }
}

function toStatusPayload(config: ResolvedAgentConfig) {
  const providers = {} as Record<AgentProviderId, { configured: boolean; source: 'setting' | 'env' | null; maskedKey: string | null }>;
  for (const provider of AGENT_PROVIDERS) {
    const resolved = config.providers[provider.id];
    providers[provider.id] = {
      configured: resolved.apiKey !== null,
      source: resolved.source,
      maskedKey: resolved.apiKey ? maskKey(resolved.apiKey) : null,
    };
  }
  return {
    configured: config.configured,
    agentEnabled: config.agentEnabled,
    providers,
    model: config.model,
    enabledModels: config.enabledModels,
  };
}

/** "sk-ant-...wxyz" — enough to recognize the key without exposing it. */
function maskKey(key: string): string {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}
