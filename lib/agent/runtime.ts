import { SYSTEM_INSTRUCTIONS } from '@/lib/mcp/instructions';
import { DEFAULT_MAX_TOKENS, MAX_TOOL_TURNS } from '@/lib/agent/config';
import { getAgentToolMap, getAgentTools } from '@/lib/agent/tools/registry';

import type {
  AgentContentBlock,
  AgentMessage,
  AgentProvider,
  AgentToolResultBlock,
  AgentToolUseBlock,
} from './providers/types';

/** Editor context threaded into the system prompt so "this section" resolves. */
export interface AgentEditorContext {
  pageId?: string | null;
  selectedLayerIds?: string[];
  /** Selected layers with display names — preferred over bare ids when present. */
  selectedLayers?: Array<{ id: string; name?: string }>;
  /** Pages/collections/layers the user @-mentioned in the message. */
  mentions?: Array<{ type: 'page' | 'collection' | 'layer'; id: string; label: string }>;
  /** URLs the user referenced in the message. */
  referenceUrls?: string[];
}

export interface RunAgentOptions {
  provider: AgentProvider;
  model: string;
  messages: AgentMessage[];
  context?: AgentEditorContext;
  signal?: AbortSignal;
  maxTokens?: number;
}

/** High-level events streamed to the client for one user message. */
export type RuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; ok: boolean }
  | { type: 'done'; stopReason: string | null }
  | { type: 'error'; message: string };

/**
 * Run the agent tool-calling loop for one user turn.
 *
 * Streams the assistant's text and tool activity, executes tool calls in-process
 * via the shared registry, feeds results back to the model, and repeats until the
 * model stops requesting tools (or the turn ceiling is hit).
 */
export async function* runAgent(options: RunAgentOptions): AsyncIterable<RuntimeEvent> {
  const { provider, model, signal } = options;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const system = buildSystemPrompt(options.context);
  const tools = getAgentTools();
  const toolMap = getAgentToolMap();

  const messages: AgentMessage[] = [...options.messages];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
    const assistantBlocks: AgentContentBlock[] = [];
    const toolUses: AgentToolUseBlock[] = [];
    let text = '';
    let stopReason: string | null = null;

    for await (const event of provider.streamMessage({ system, messages, tools, model, maxTokens, signal })) {
      if (event.type === 'text_delta') {
        text += event.text;
        yield { type: 'text', text: event.text };
      } else if (event.type === 'tool_use') {
        const block: AgentToolUseBlock = {
          type: 'tool_use',
          id: event.id,
          name: event.name,
          input: event.input,
        };
        toolUses.push(block);
        yield { type: 'tool_call', id: event.id, name: event.name, input: event.input };
      } else if (event.type === 'message_stop') {
        stopReason = event.stopReason;
      }
    }

    if (text.trim()) {
      assistantBlocks.push({ type: 'text', text });
    }
    assistantBlocks.push(...toolUses);
    messages.push({ role: 'assistant', content: assistantBlocks });

    if (toolUses.length === 0) {
      yield { type: 'done', stopReason };
      return;
    }

    const results: AgentToolResultBlock[] = [];
    for (const call of toolUses) {
      const result = await executeTool(toolMap, call);
      results.push(result);
      yield { type: 'tool_result', id: call.id, name: call.name, ok: !result.isError };
    }

    messages.push({ role: 'user', content: results });
  }

  yield { type: 'error', message: `Reached the tool-call limit (${MAX_TOOL_TURNS}) without finishing.` };
}

async function executeTool(
  toolMap: ReturnType<typeof getAgentToolMap>,
  call: AgentToolUseBlock,
): Promise<AgentToolResultBlock> {
  const tool = toolMap.get(call.name);
  if (!tool) {
    return { type: 'tool_result', toolUseId: call.id, content: `Unknown tool: ${call.name}`, isError: true };
  }

  try {
    const result = await tool.execute(call.input);
    const content = result.content
      .map((part) => (typeof part.text === 'string' ? part.text : JSON.stringify(part)))
      .join('\n');
    return { type: 'tool_result', toolUseId: call.id, content: content || 'OK', isError: result.isError };
  } catch (error) {
    return {
      type: 'tool_result',
      toolUseId: call.id,
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

function buildSystemPrompt(context?: AgentEditorContext): string {
  const lines: string[] = [];
  if (context?.pageId) {
    lines.push(`The user is currently editing page with ID "${context.pageId}". When they refer to "this page", use this ID.`);
  }
  const selected = context?.selectedLayers?.length
    ? context.selectedLayers
    : context?.selectedLayerIds?.map((id) => ({ id, name: undefined }));

  if (selected && selected.length > 0) {
    const refs = selected
      .map((layer) => (layer.name ? `"${layer.name}" (id: ${layer.id})` : `id: ${layer.id}`))
      .join(', ');
    lines.push(
      `The user currently has these layer(s) selected: ${refs}. When they say "this", "this section", or "the selected element", they mean these layer(s). ` +
        `A selected layer is often a container/wrapper, not the exact element a change applies to — call get_layers and inspect its subtree, then apply each change to the descendant the property actually belongs to (e.g. text color/typography goes on the text/heading/button layer inside, not the wrapping div). ` +
        `If a change applies to several descendants, update all of them in one batch. Never ask the user to re-select a deeper element.`,
    );
  }

  if (context?.mentions && context.mentions.length > 0) {
    const byType = (type: string) =>
      context
        .mentions!.filter((mention) => mention.type === type)
        .map((mention) => `"${mention.label}" (id: ${mention.id})`)
        .join(', ');
    const parts: string[] = [];
    const pages = byType('page');
    const collections = byType('collection');
    const layers = byType('layer');
    if (pages) parts.push(`page(s): ${pages}`);
    if (collections) parts.push(`collection(s): ${collections}`);
    if (layers) parts.push(`layer(s): ${layers}`);
    if (parts.length > 0) {
      lines.push(`The user referenced ${parts.join('; ')}. Use these ids directly with the relevant tools.`);
    }
  }

  if (context?.referenceUrls && context.referenceUrls.length > 0) {
    const urls = context.referenceUrls.join(', ');
    lines.push(`The user referenced these URLs: ${urls}. You cannot browse the web, so do not invent their contents — use them as link destinations or literal content. If the user wants you to replicate a design from a URL, ask them to paste a screenshot instead.`);
  }

  if (lines.length === 0) return SYSTEM_INSTRUCTIONS;

  return `${SYSTEM_INSTRUCTIONS}\n\n## Current editor context\n\n${lines.join('\n')}`;
}
