import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getAllPageFolders,
  createPageFolder,
  updatePageFolder,
  deletePageFolder,
} from '@/lib/repositories/pageFolderRepository';
import { getPagesByFolder } from '@/lib/repositories/pageRepository';

export function registerPageFolderTools(server: McpServer) {
  server.tool(
    'list_page_folders',
    'List all page folders with their hierarchy. Folders organize pages into groups with shared URL prefixes.',
    {},
    async () => {
      const folders = await getAllPageFolders({ is_published: false });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(folders.map((f) => ({
            id: f.id,
            name: f.name,
            slug: f.slug,
            page_folder_id: f.page_folder_id,
            depth: f.depth,
            order: f.order,
          })), null, 2),
        }],
      };
    },
  );

  server.tool(
    'create_page_folder',
    'Create a new page folder. Pages inside the folder inherit its URL slug as a prefix.',
    {
      name: z.string().describe('Folder name (e.g. "Blog", "Services")'),
      slug: z.string().optional().describe('URL slug. Auto-generated from name if omitted.'),
      page_folder_id: z.string().nullable().optional().describe('Parent folder ID for nesting, or null for root'),
    },
    async ({ name, slug, page_folder_id }) => {
      const folderSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const parentId = page_folder_id ?? null;

      const siblings = await getPagesByFolder(parentId);
      const folders = await getAllPageFolders({ is_published: false });
      const siblingFolders = folders.filter((f) =>
        parentId === null ? f.page_folder_id === null : f.page_folder_id === parentId
      );

      const maxOrder = Math.max(
        siblings.reduce((max, p) => Math.max(max, p.order ?? 0), -1),
        siblingFolders.reduce((max, f) => Math.max(max, f.order ?? 0), -1),
      );

      const parentFolder = parentId ? folders.find((f) => f.id === parentId) : null;
      const depth = parentFolder ? parentFolder.depth + 1 : 0;

      const folder = await createPageFolder({
        name,
        slug: folderSlug,
        page_folder_id: parentId,
        depth,
        order: maxOrder + 1,
        is_published: false,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ message: `Created folder "${name}"`, folder }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'update_page_folder',
    'Update a page folder name, slug, or settings.',
    {
      folder_id: z.string().describe('The folder ID to update'),
      name: z.string().optional().describe('New folder name'),
      slug: z.string().optional().describe('New URL slug'),
      settings: z.record(z.string(), z.unknown()).optional().describe('Folder settings (e.g. auth)'),
    },
    async ({ folder_id, name, slug, settings }) => {
      const updates: Record<string, unknown> = {};
      if (name !== undefined) updates.name = name;
      if (slug !== undefined) updates.slug = slug;
      if (settings !== undefined) updates.settings = settings;

      const folder = await updatePageFolder(folder_id, updates);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ message: `Updated folder "${folder.name}"`, folder }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'delete_page_folder',
    'Delete a page folder and all its contents (pages and sub-folders). This is a soft delete.',
    {
      folder_id: z.string().describe('The folder ID to delete'),
    },
    async ({ folder_id }) => {
      await deletePageFolder(folder_id);
      return {
        content: [{ type: 'text' as const, text: `Folder ${folder_id} and all its contents deleted successfully.` }],
      };
    },
  );
}
