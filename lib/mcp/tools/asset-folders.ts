import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getAllAssetFolders,
  createAssetFolder,
  updateAssetFolder,
  deleteAssetFolder,
} from '@/lib/repositories/assetFolderRepository';

export function registerAssetFolderTools(server: McpServer) {
  server.tool(
    'list_asset_folders',
    'List all asset folders. Assets can be organized into folders for better management.',
    {},
    async () => {
      const folders = await getAllAssetFolders(false);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(folders.map((f) => ({
            id: f.id,
            name: f.name,
            asset_folder_id: f.asset_folder_id,
            depth: f.depth,
            order: f.order,
          })), null, 2),
        }],
      };
    },
  );

  server.tool(
    'create_asset_folder',
    'Create a new asset folder to organize images and files.',
    {
      name: z.string().describe('Folder name (e.g. "Icons", "Hero Images", "Blog")'),
      asset_folder_id: z.string().nullable().optional().describe('Parent folder ID for nesting, or null for root'),
    },
    async ({ name, asset_folder_id }) => {
      const parentId = asset_folder_id ?? null;

      const allFolders = await getAllAssetFolders(false);
      const siblings = allFolders.filter((f) =>
        parentId === null ? f.asset_folder_id === null : f.asset_folder_id === parentId
      );
      const maxOrder = siblings.reduce((max, f) => Math.max(max, f.order ?? 0), -1);

      const parentFolder = parentId ? allFolders.find((f) => f.id === parentId) : null;
      const depth = parentFolder ? parentFolder.depth + 1 : 0;

      const folder = await createAssetFolder({
        name,
        asset_folder_id: parentId,
        depth,
        order: maxOrder + 1,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ message: `Created asset folder "${name}"`, folder }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'update_asset_folder',
    'Rename an asset folder.',
    {
      folder_id: z.string().describe('The asset folder ID to update'),
      name: z.string().describe('New folder name'),
    },
    async ({ folder_id, name }) => {
      const folder = await updateAssetFolder(folder_id, { name });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ message: `Renamed asset folder to "${name}"`, folder }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'delete_asset_folder',
    'Delete an asset folder and all assets within it. This is a soft delete.',
    {
      folder_id: z.string().describe('The asset folder ID to delete'),
    },
    async ({ folder_id }) => {
      await deleteAssetFolder(folder_id);
      return {
        content: [{ type: 'text' as const, text: `Asset folder ${folder_id} and its contents deleted successfully.` }],
      };
    },
  );
}
