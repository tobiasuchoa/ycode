/**
 * Models the in-app AI builder can use.
 *
 * This module has no server-only imports so it can be shared between the client
 * (model picker UI) and the server (request validation). The actual default is
 * still resolved server-side from settings/env in `lib/agent/config.ts`.
 */

export interface AgentModelOption {
  id: string;
  label: string;
}

export const AGENT_MODELS: AgentModelOption[] = [
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
];

/** Whether a requested model id is one the agent is allowed to use. */
export function isAllowedModel(id: string): boolean {
  return AGENT_MODELS.some((model) => model.id === id);
}
