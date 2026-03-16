import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAllPages, getPageById, getPagesByFolder, createPage, updatePage, deletePage, duplicatePage } from '@/lib/repositories/pageRepository';
import { getAllPageFolders } from '@/lib/repositories/pageFolderRepository';
import { upsertDraftLayers } from '@/lib/repositories/pageLayersRepository';
import { broadcastPageCreated, broadcastPageUpdated, broadcastPageDeleted, broadcastLayersChanged } from '@/lib/mcp/broadcast';

export function registerPageTools(server: McpServer) {
  server.tool(
    'list_pages',
    'List all pages in the website with their IDs, names, slugs, and folder structure',
    {},
    async () => {
      const pages = await getAllPages();
      const folders = await getAllPageFolders();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ pages, folders }, null, 2) }],
      };
    },
  );

  server.tool(
    'get_page',
    'Get a single page by ID, including its settings and metadata',
    { page_id: z.string().describe('The page ID') },
    async ({ page_id }) => {
      const page = await getPageById(page_id);
      if (!page) {
        return { content: [{ type: 'text' as const, text: `Error: Page "${page_id}" not found.` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(page, null, 2) }] };
    },
  );

  server.tool(
    'create_page',
    'Create a new page. Returns the created page with its ID. The page is created as a draft — use the publish tool to make it live.',
    {
      name: z.string().describe('Page title (e.g. "About Us", "Contact")'),
      slug: z.string().optional().describe('URL slug. Auto-generated from name if omitted.'),
      page_folder_id: z.string().nullable().optional().describe('Parent folder ID, or null for root'),
      is_index: z.boolean().optional().describe('Set to true to make this the homepage'),
      is_dynamic: z.boolean().optional().describe('Set to true for CMS dynamic pages'),
    },
    async (args) => {
      const isIndex = args.is_index || false;
      const slug = isIndex ? '' : (args.slug || args.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
      const folderId = args.page_folder_id ?? null;

      const siblings = await getPagesByFolder(folderId);
      const maxOrder = siblings.reduce((max, p) => Math.max(max, p.order ?? 0), -1);

      const page = await createPage({
        name: args.name,
        slug,
        is_published: false,
        page_folder_id: folderId,
        order: maxOrder + 1,
        depth: 0,
        is_index: isIndex,
        is_dynamic: args.is_dynamic || false,
        error_page: null,
        settings: {},
      });

      const initialLayers = [{
        id: 'body',
        name: 'body',
        classes: '',
        children: [],
      }];
      await upsertDraftLayers(page.id, initialLayers);

      broadcastPageCreated(page).catch(() => {});
      broadcastLayersChanged(page.id, initialLayers).catch(() => {});

      return { content: [{ type: 'text' as const, text: JSON.stringify(page, null, 2) }] };
    },
  );

  server.tool(
    'update_page',
    "Update a page's name, slug, or folder.",
    {
      page_id: z.string().describe('The page ID to update'),
      name: z.string().optional().describe('New page title'),
      slug: z.string().optional().describe('New URL slug'),
      page_folder_id: z.string().nullable().optional().describe('Move to folder ID, or null for root'),
    },
    async ({ page_id, ...data }) => {
      const page = await updatePage(page_id, data);
      broadcastPageUpdated(page_id, data).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(page, null, 2) }] };
    },
  );

  server.tool(
    'update_page_settings',
    `Update page SEO, custom code, or password protection settings.

SEO: Set title, description, noindex, and OG image (asset ID).
Custom code: Inject HTML into <head> or before </body>.
Password protection: Enable/disable with a password.`,
    {
      page_id: z.string().describe('The page ID'),
      seo: z.object({
        title: z.string().optional().describe('SEO title (appears in browser tab and search results)'),
        description: z.string().optional().describe('SEO meta description'),
        noindex: z.boolean().optional().describe('Prevent search engines from indexing this page'),
        image_asset_id: z.string().nullable().optional().describe('OG image asset ID for social sharing'),
      }).optional(),
      custom_code: z.object({
        head: z.string().optional().describe('HTML to inject into <head> (e.g. analytics scripts)'),
        body: z.string().optional().describe('HTML to inject before </body>'),
      }).optional(),
      auth: z.object({
        enabled: z.boolean().describe('Enable or disable password protection'),
        password: z.string().optional().describe('Password for accessing the page'),
      }).optional(),
    },
    async ({ page_id, seo, custom_code, auth }) => {
      const existing = await getPageById(page_id);
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `Error: Page "${page_id}" not found.` }], isError: true };
      }

      const settings = { ...existing.settings };

      if (seo) {
        settings.seo = {
          ...(settings.seo || { title: '', description: '', noindex: false, image: null }),
          ...(seo.title !== undefined ? { title: seo.title } : {}),
          ...(seo.description !== undefined ? { description: seo.description } : {}),
          ...(seo.noindex !== undefined ? { noindex: seo.noindex } : {}),
          ...(seo.image_asset_id !== undefined ? { image: seo.image_asset_id } : {}),
        };
      }

      if (custom_code) {
        settings.custom_code = {
          ...(settings.custom_code || { head: '', body: '' }),
          ...(custom_code.head !== undefined ? { head: custom_code.head } : {}),
          ...(custom_code.body !== undefined ? { body: custom_code.body } : {}),
        };
      }

      if (auth) {
        settings.auth = {
          enabled: auth.enabled,
          password: auth.password || settings.auth?.password || '',
        };
      }

      const page = await updatePage(page_id, { settings });
      broadcastPageUpdated(page_id, { settings }).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Updated page settings', settings: page.settings }, null, 2) }] };
    },
  );

  server.tool(
    'duplicate_page',
    'Create a copy of a page including all its layers.',
    { page_id: z.string().describe('The page ID to duplicate') },
    async ({ page_id }) => {
      const page = await duplicatePage(page_id);
      broadcastPageCreated(page).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: `Duplicated page as "${page.name}"`, page }, null, 2) }] };
    },
  );

  server.tool(
    'delete_page',
    'Permanently delete a page and all its layers',
    { page_id: z.string().describe('The page ID to delete') },
    async ({ page_id }) => {
      await deletePage(page_id);
      broadcastPageDeleted(page_id).catch(() => {});
      return { content: [{ type: 'text' as const, text: `Page ${page_id} deleted successfully.` }] };
    },
  );
}
