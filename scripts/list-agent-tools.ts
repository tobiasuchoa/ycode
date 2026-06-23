/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Inspect the shared agent tool registry from the CLI.
 *
 *   npm run agent:tools              # list every tool + Anthropic conversion check
 *   npm run agent:tools -- create_page   # dump one tool's Anthropic schema
 *
 * The registry pulls in `server-only` modules (the tools run in a server route
 * handler at runtime), so we neutralize `server-only` for this standalone CLI.
 */
import Module from 'module';

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return origLoad.call(this, request, parent, isMain);
};

// Required AFTER the patch so the server-only modules load cleanly.
const { getAgentTools, getAgentToolMap } = require('@/lib/agent/tools/registry');
const { toAnthropicTool } = require('@/lib/agent/tools/to-anthropic');

interface AgentToolLike {
  name: string;
  description: string;
}

const requested = process.argv[2];

if (requested) {
  const tool = getAgentToolMap().get(requested);
  if (!tool) {
    console.error(`No tool named "${requested}".`);
    process.exit(1);
  }
  console.log(JSON.stringify(toAnthropicTool(tool), null, 2));
  process.exit(0);
}

const tools: AgentToolLike[] = getAgentTools();
console.log(`Shared agent registry: ${tools.length} tools\n`);

let converted = 0;
const failures: string[] = [];
for (const tool of tools) {
  try {
    toAnthropicTool(tool);
    converted += 1;
  } catch (err) {
    failures.push(`${tool.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const summary = tool.description.split('\n')[0].slice(0, 70);
  console.log(`  ${tool.name.padEnd(34)} ${summary}`);
}

console.log(`\nAnthropic schema conversion: ${converted}/${tools.length} succeeded.`);
if (failures.length > 0) {
  console.log('Failures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('Tip: npm run agent:tools -- <tool_name> to see a single tool\'s Anthropic schema.');
