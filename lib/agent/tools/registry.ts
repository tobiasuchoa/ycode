import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerPageTools } from '@/lib/mcp/tools/pages';
import { registerPageFolderTools } from '@/lib/mcp/tools/page-folders';
import { registerLayerTools } from '@/lib/mcp/tools/layers';
import { registerBatchTools } from '@/lib/mcp/tools/batch';
import { registerLayoutTools } from '@/lib/mcp/tools/layouts';
import { registerCollectionTools } from '@/lib/mcp/tools/collections';
import { registerCollectionLayerTools } from '@/lib/mcp/tools/collection-layers';
import { registerStyleTools } from '@/lib/mcp/tools/styles';
import { registerAssetTools } from '@/lib/mcp/tools/assets';
import { registerAssetFolderTools } from '@/lib/mcp/tools/asset-folders';
import { registerComponentTools } from '@/lib/mcp/tools/components';
import { registerColorVariableTools } from '@/lib/mcp/tools/color-variables';
import { registerFontTools } from '@/lib/mcp/tools/fonts';
import { registerLocaleTools } from '@/lib/mcp/tools/locales';
import { registerFormTools } from '@/lib/mcp/tools/forms';
import { registerSettingsTools } from '@/lib/mcp/tools/settings';
import { registerPublishingTools } from '@/lib/mcp/tools/publishing';
import { registerAnimationTools } from '@/lib/mcp/tools/animations';

import type { AgentTool, AgentToolResult } from './types';

/**
 * Shared, framework-agnostic tool registry.
 *
 * The existing MCP tool files register their tools by calling
 * `server.tool(name, description, zodRawShape, handler)`. Rather than rewrite
 * all of them, we replay the exact same registration calls against a lightweight
 * collecting host. This captures every tool's name, description, schema, and
 * handler without touching the MCP code path — so the MCP server (external
 * agents) and the in-app agent runtime are guaranteed to expose identical tools.
 */

type ToolRegistrar = (server: McpServer) => void;

/**
 * Every registrar from createMcpServer, MINUS the resource registrars
 * (registerReferenceResources / registerSiteResources), which expose read-only
 * MCP resources rather than callable tools.
 */
const TOOL_REGISTRARS: ToolRegistrar[] = [
  registerPageTools,
  registerPageFolderTools,
  registerLayerTools,
  registerBatchTools,
  registerLayoutTools,
  registerCollectionTools,
  registerCollectionLayerTools,
  registerStyleTools,
  registerAssetTools,
  registerAssetFolderTools,
  registerComponentTools,
  registerColorVariableTools,
  registerFontTools,
  registerLocaleTools,
  registerFormTools,
  registerSettingsTools,
  registerPublishingTools,
  registerAnimationTools,
];

/** The raw handler shape every tool file passes as the 4th arg to server.tool. */
type RawToolHandler = (args: Record<string, unknown>) => Promise<AgentToolResult>;

interface CollectedTool {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: RawToolHandler;
}

/** The single `server.tool(...)` overload every tool file actually uses. */
interface CollectingHost {
  tool: (
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    handler: RawToolHandler,
  ) => void;
}

/**
 * A stand-in for McpServer that records `server.tool(...)` calls instead of
 * wiring them to an MCP transport. Only the 4-arg overload is used by the
 * tool files (verified across all of lib/mcp/tools), so that is all we capture.
 */
function createCollectingHost(sink: CollectedTool[]): CollectingHost {
  return {
    tool(name, description, inputSchema, handler) {
      sink.push({ name, description, inputSchema, handler });
    },
  };
}

let cachedTools: AgentTool[] | null = null;

/**
 * Collect every building tool as a framework-agnostic descriptor.
 *
 * Each descriptor's `execute` validates incoming args against the tool's zod
 * schema (applying defaults, stripping unknown keys) exactly as the MCP SDK
 * does before invoking the handler.
 */
export function getAgentTools(): AgentTool[] {
  if (cachedTools) return cachedTools;

  const collected: CollectedTool[] = [];
  const host = createCollectingHost(collected) as unknown as McpServer;
  for (const register of TOOL_REGISTRARS) {
    register(host);
  }

  const tools = collected.map((tool): AgentTool => {
    const schema = z.object(tool.inputSchema);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: async (args) => {
        const parsed = schema.parse(args ?? {}) as Record<string, unknown>;
        return tool.handler(parsed);
      },
    };
  });

  // Tool names must be unique across files — the LLM and MCP both key on name.
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate agent tool name: "${tool.name}"`);
    }
    seen.add(tool.name);
  }

  cachedTools = tools;
  return cachedTools;
}

let cachedToolMap: Map<string, AgentTool> | null = null;

/** Tool descriptors keyed by name, for fast lookup during a tool-calling loop. */
export function getAgentToolMap(): Map<string, AgentTool> {
  if (cachedToolMap) return cachedToolMap;
  cachedToolMap = new Map(getAgentTools().map((tool) => [tool.name, tool]));
  return cachedToolMap;
}
