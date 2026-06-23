import Anthropic from '@anthropic-ai/sdk';

import { toAnthropicTools } from '@/lib/agent/tools/to-anthropic';

import type {
  AgentContentBlock,
  AgentMessage,
  AgentProvider,
  ProviderStreamEvent,
  ProviderStreamOptions,
} from './types';

/**
 * BYOK Anthropic provider.
 *
 * Translates the runtime's provider-neutral conversation into Anthropic's wire
 * format, streams the response, and maps Anthropic stream events back to neutral
 * ProviderStreamEvents. The large system prompt and tool definitions are marked
 * for prompt caching to cut cost and latency on multi-turn tool loops.
 */
export function createAnthropicProvider(apiKey: string): AgentProvider {
  const client = new Anthropic({ apiKey });

  return {
    id: 'anthropic-byok',

    async *streamMessage(options: ProviderStreamOptions): AsyncIterable<ProviderStreamEvent> {
      const tools = withToolCaching(toAnthropicTools(options.tools));

      const stream = client.messages.stream(
        {
          model: options.model,
          max_tokens: options.maxTokens,
          system: [
            { type: 'text', text: options.system, cache_control: { type: 'ephemeral' } },
          ],
          tools,
          messages: toAnthropicMessages(options.messages),
        },
        { signal: options.signal },
      );

      // Track in-flight tool_use blocks by content index to assemble their
      // streamed input JSON before emitting a complete tool_use event.
      const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
      let stopReason: string | null = null;
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            inputTokens = event.message.usage?.input_tokens ?? 0;
            break;

          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              toolBlocks.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                json: '',
              });
            }
            break;

          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              yield { type: 'text_delta', text: event.delta.text };
            } else if (event.delta.type === 'input_json_delta') {
              const block = toolBlocks.get(event.index);
              if (block) block.json += event.delta.partial_json;
            }
            break;

          case 'content_block_stop': {
            const block = toolBlocks.get(event.index);
            if (block) {
              toolBlocks.delete(event.index);
              yield {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: parseToolInput(block.json),
              };
            }
            break;
          }

          case 'message_delta':
            stopReason = event.delta.stop_reason ?? stopReason;
            outputTokens = event.usage?.output_tokens ?? outputTokens;
            break;

          case 'message_stop':
            yield {
              type: 'message_stop',
              stopReason,
              usage: { inputTokens, outputTokens },
            };
            break;

          default:
            break;
        }
      }
    },
  };
}

/** Mark the final tool as a cache breakpoint so all tool definitions are cached. */
function withToolCaching(tools: ReturnType<typeof toAnthropicTools>): Anthropic.Tool[] {
  const anthropicTools = tools as unknown as Anthropic.Tool[];
  if (anthropicTools.length > 0) {
    anthropicTools[anthropicTools.length - 1] = {
      ...anthropicTools[anthropicTools.length - 1],
      cache_control: { type: 'ephemeral' },
    };
  }
  return anthropicTools;
}

function toAnthropicMessages(messages: AgentMessage[]): Anthropic.MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map(toAnthropicBlock),
  }));
}

function toAnthropicBlock(block: AgentContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
  }
}

/** Tool input arrives as streamed partial JSON; empty means a no-arg tool. */
function parseToolInput(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}
