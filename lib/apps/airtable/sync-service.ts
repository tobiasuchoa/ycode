/**
 * Airtable Sync Service
 *
 * Handles full and incremental sync of Airtable records into CMS collections.
 * Uses existing collection repositories for all database operations.
 *
 * Performance: reconciliation uses batch operations throughout — bulk insert
 * for new items/values, bulk upsert for updates, and batch soft-delete.
 * Dirty checking skips records whose mapped values haven't changed.
 */

import { randomUUID } from 'crypto';

import { getSupabaseAdmin } from '@/lib/supabase-server';
import { getAppSettingValue, setAppSetting } from '@/lib/repositories/appSettingsRepository';
import { slugify } from '@/lib/collection-utils';
import { isAssetFieldType, isMultipleAssetField } from '@/lib/collection-field-utils';
import { uploadFile } from '@/lib/file-upload';
import { getFieldsByCollectionId, createField } from '@/lib/repositories/collectionFieldRepository';
import {
  createItemsBulk,
  getItemsByCollectionId,
} from '@/lib/repositories/collectionItemRepository';
import {
  insertValuesBulk,
  getValuesByItemIds,
} from '@/lib/repositories/collectionItemValueRepository';

import { listAllRecords, getWebhookPayloads } from './index';
import { transformFieldValue } from './field-mapping';
import type { AirtableConnection, AirtableRecord, SyncResult } from './types';
import type { CollectionFieldType } from '@/types';

export const APP_ID = 'airtable';
const HIDDEN_FIELD_KEY = 'airtable_id';
const SLUG_FIELD_KEY = 'slug';
const BULK_CHUNK_SIZE = 500;
const ATTACHMENT_CONCURRENCY = 5;

// =============================================================================
// Connection Helpers
// =============================================================================

/** Get the stored Airtable API token, throwing if not configured */
export async function requireAirtableToken(): Promise<string> {
  const token = await getAppSettingValue<string>(APP_ID, 'api_token');
  if (!token) throw new Error('Airtable token not configured');
  return token;
}

/** Load all Airtable connections from app_settings */
export async function getConnections(): Promise<AirtableConnection[]> {
  return (await getAppSettingValue<AirtableConnection[]>(APP_ID, 'connections')) ?? [];
}

/** Persist connections back to app_settings */
export async function saveConnections(connections: AirtableConnection[]): Promise<void> {
  await setAppSetting(APP_ID, 'connections', connections);
}

/** Find a connection by ID */
export async function getConnectionById(connectionId: string): Promise<AirtableConnection | null> {
  const connections = await getConnections();
  return connections.find((c) => c.id === connectionId) ?? null;
}

/** Parse connectionId from a request body and resolve the connection, or throw */
export async function requireConnectionFromBody(
  request: Request
): Promise<AirtableConnection> {
  const { connectionId } = await request.json();
  if (!connectionId || typeof connectionId !== 'string') {
    throw new Error('connectionId is required');
  }
  const connection = await getConnectionById(connectionId);
  if (!connection) throw new Error('Connection not found');
  return connection;
}

/** Update a single connection field and persist */
export async function updateConnection(
  connectionId: string,
  patch: Partial<AirtableConnection>
): Promise<AirtableConnection | null> {
  const connections = await getConnections();
  const idx = connections.findIndex((c) => c.id === connectionId);
  if (idx === -1) return null;

  connections[idx] = { ...connections[idx], ...patch };
  await saveConnections(connections);
  return connections[idx];
}

// =============================================================================
// Hidden Field Management
// =============================================================================

/**
 * Ensure the hidden airtable_id field exists on a collection.
 * Creates it if missing, returns the field ID.
 */
export async function ensureRecordIdField(collectionId: string): Promise<string> {
  const fields = await getFieldsByCollectionId(collectionId);
  const existing = fields.find((f) => f.key === HIDDEN_FIELD_KEY);

  if (existing) return existing.id;

  const maxOrder = fields.reduce((max, f) => Math.max(max, f.order), 0);
  const field = await createField({
    name: 'Airtable ID',
    type: 'text',
    collection_id: collectionId,
    order: maxOrder + 1,
    hidden: true,
    key: HIDDEN_FIELD_KEY,
    is_computed: true,
    fillable: false,
  });

  return field.id;
}

// =============================================================================
// Full Sync
// =============================================================================

/**
 * Run a full sync for a connection.
 * Fetches all Airtable records and reconciles with CMS items.
 */
export async function fullSync(connection: AirtableConnection): Promise<SyncResult> {
  const token = await requireAirtableToken();

  await updateConnection(connection.id, { syncStatus: 'syncing', syncError: null });

  try {
    const airtableRecords = await listAllRecords(token, connection.baseId, connection.tableId);
    const result = await reconcileRecords(connection, airtableRecords);

    await updateConnection(connection.id, {
      syncStatus: 'idle',
      syncError: null,
      lastSyncedAt: result.syncedAt,
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown sync error';
    await updateConnection(connection.id, { syncStatus: 'error', syncError: message });
    throw error;
  }
}

// =============================================================================
// Webhook-triggered Sync
// =============================================================================

/**
 * Process an Airtable webhook notification.
 * Fetches payloads to determine changed tables, then re-syncs affected connections.
 */
export async function processWebhookNotification(
  baseId: string,
  webhookId: string
): Promise<SyncResult[]> {
  const token = await requireAirtableToken();

  const connections = await getConnections();
  const affectedConnections = connections.filter(
    (c) => c.baseId === baseId && c.webhookId === webhookId
  );

  if (affectedConnections.length === 0) return [];

  // Use the first matching connection's cursor (all share same webhook)
  const cursor = affectedConnections[0].webhookCursor || undefined;

  const payloadResponse = await getWebhookPayloads(token, baseId, webhookId, cursor);

  if (!payloadResponse.payloads?.length) {
    // Advance cursor even when no payloads
    if (payloadResponse.cursor) {
      for (const conn of affectedConnections) {
        await updateConnection(conn.id, { webhookCursor: payloadResponse.cursor });
      }
    }
    return [];
  }

  // Collect table IDs that have data changes
  const changedTableIds = new Set<string>();
  for (const payload of payloadResponse.payloads) {
    if (payload.changedTablesById) {
      for (const tableId of Object.keys(payload.changedTablesById)) {
        changedTableIds.add(tableId);
      }
    }
  }

  // Re-sync connections whose table was affected
  const results: SyncResult[] = [];
  for (const conn of affectedConnections) {
    if (changedTableIds.has(conn.tableId)) {
      const result = await fullSync(conn);
      results.push(result);
    }
    // Always advance cursor
    await updateConnection(conn.id, { webhookCursor: payloadResponse.cursor });
  }

  return results;
}

// =============================================================================
// Record Reconciliation
// =============================================================================

/** System field IDs resolved once per sync */
interface AutoFields {
  idFieldId: string | null;
  createdAtFieldId: string | null;
  updatedAtFieldId: string | null;
}

/** Shared context passed to buildRecordValues to avoid repeating params */
interface SyncContext {
  fieldMapping: AirtableConnection['fieldMapping'];
  recordIdFieldId: string;
  slugCtx: SlugContext | null;
  assetCache: Map<string, string>;
  /** CMS field IDs mapped from attachments — pre-computed for perf */
  attachmentFieldIds: Map<string, boolean>;
  /** Fingerprints of existing attachment data keyed by "recordId:fieldId" */
  attachmentFingerprintCache: Map<string, string>;
  autoFields: AutoFields;
}

interface SlugContext {
  slugFieldId: string;
  existingSlugs: Set<string>;
}

function generateUniqueSlug(value: string | null, ctx: SlugContext): string {
  const base = slugify(value || 'item');
  if (!ctx.existingSlugs.has(base)) {
    ctx.existingSlugs.add(base);
    return base;
  }

  let n = 1;
  while (ctx.existingSlugs.has(`${base}-${n}`)) n++;
  const unique = `${base}-${n}`;
  ctx.existingSlugs.add(unique);
  return unique;
}

/**
 * Fingerprint attachment data using stable Airtable attachment IDs + filenames.
 * URLs are NOT used because Airtable rotates them every ~2 hours.
 */
function attachmentFingerprint(rawValue: unknown): string {
  if (!Array.isArray(rawValue) || rawValue.length === 0) return '';
  return rawValue
    .map((a) => {
      const att = a as Record<string, unknown>;
      return `${att?.id ?? ''}|${att?.filename ?? ''}`;
    })
    .join(',');
}

/**
 * Build the mapped values for a single Airtable record.
 * Pass existingItemValues when processing an existing record — attachment fields
 * whose raw data hasn't changed will reuse the stored asset IDs instead of
 * re-downloading.
 */
async function buildRecordValues(
  record: AirtableRecord,
  ctx: SyncContext,
  existingItemValues?: Record<string, string>
): Promise<Record<string, string | null>> {
  const values: Record<string, string | null> = {
    [ctx.recordIdFieldId]: record.id,
  };

  for (const mapping of ctx.fieldMapping) {
    const rawValue = record.fields[mapping.airtableFieldId];
    const isMultipleAsset = ctx.attachmentFieldIds.get(mapping.cmsFieldId);

    if (isMultipleAsset !== undefined) {
      const fpKey = `${record.id}:${mapping.cmsFieldId}`;
      const fp = attachmentFingerprint(rawValue);

      // Skip download if fingerprint matches previous sync and we have a stored value
      if (existingItemValues) {
        const prevFp = ctx.attachmentFingerprintCache.get(fpKey);
        if (prevFp === fp && existingItemValues[mapping.cmsFieldId]) {
          values[mapping.cmsFieldId] = existingItemValues[mapping.cmsFieldId];
          ctx.attachmentFingerprintCache.set(fpKey, fp);
          continue;
        }
      }

      values[mapping.cmsFieldId] = await uploadAttachmentsAsAssets(rawValue, ctx.assetCache, isMultipleAsset);
      ctx.attachmentFingerprintCache.set(fpKey, fp);
      continue;
    }

    let value = transformFieldValue(rawValue, mapping.airtableFieldType, mapping.cmsFieldType);

    if (ctx.slugCtx && mapping.cmsFieldId === ctx.slugCtx.slugFieldId) {
      // For existing records, temporarily remove their current slug so the
      // record doesn't conflict with itself (prevents flip-flopping)
      const currentSlug = existingItemValues?.[ctx.slugCtx.slugFieldId] as string | undefined;
      if (currentSlug) ctx.slugCtx.existingSlugs.delete(currentSlug);

      value = generateUniqueSlug(value, ctx.slugCtx);
    }

    values[mapping.cmsFieldId] = value;
  }

  return values;
}

/**
 * Download Airtable attachments and upload as CMS assets.
 * Single-asset fields return one UUID; multi-asset fields return a JSON array of UUIDs.
 * Downloads up to ATTACHMENT_CONCURRENCY files in parallel.
 */
async function uploadAttachmentsAsAssets(
  rawValue: unknown,
  cache: Map<string, string>,
  isMultiple: boolean
): Promise<string | null> {
  if (!Array.isArray(rawValue) || rawValue.length === 0) return null;

  const attachments = isMultiple ? rawValue : [rawValue[0]];

  // Separate cached vs uncached to avoid redundant downloads
  const tasks: Array<{ att: Record<string, unknown>; url: string; index: number }> = [];
  const results: Array<{ index: number; assetId: string }> = [];

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i] as Record<string, unknown>;
    const url = att?.url as string | undefined;
    if (!url) continue;

    const cached = cache.get(url);
    if (cached) {
      results.push({ index: i, assetId: cached });
    } else {
      tasks.push({ att, url, index: i });
    }
  }

  // Download uncached attachments with concurrency limit
  for (let i = 0; i < tasks.length; i += ATTACHMENT_CONCURRENCY) {
    const batch = tasks.slice(i, i + ATTACHMENT_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async ({ att, url, index }) => {
        const res = await fetch(url);
        if (!res.ok) return null;

        const contentType = (att.type as string) || res.headers.get('content-type') || 'image/png';
        const buffer = await res.arrayBuffer();
        const blob = new Blob([buffer], { type: contentType });
        const filename = (att.filename as string) || url.split('/').pop()?.split('?')[0] || 'attachment';
        const file = new File([blob], filename, { type: contentType });

        const asset = await uploadFile(file, 'airtable-sync');
        if (!asset) return null;

        cache.set(url, asset.id);
        return { index, assetId: asset.id };
      })
    );

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled' && outcome.value) {
        results.push(outcome.value);
      }
    }
  }

  if (results.length === 0) return null;

  // Restore original order
  results.sort((a, b) => a.index - b.index);
  const assetIds = results.map((r) => r.assetId);

  return isMultiple ? JSON.stringify(assetIds) : assetIds[0];
}

/**
 * Check if two value maps differ for the mapped fields.
 * Normalizes both sides to strings since getValuesByItemIds returns
 * cast values (number, boolean, object) while buildRecordValues returns strings.
 */
function hasChanges(
  newValues: Record<string, string | null>,
  existingValues: Record<string, unknown> | undefined
): boolean {
  if (!existingValues) return true;
  for (const [fieldId, value] of Object.entries(newValues)) {
    const newStr = value ?? '';
    const existing = existingValues[fieldId];
    const existingStr = existing == null ? '' : typeof existing === 'object' ? JSON.stringify(existing) : String(existing);
    if (newStr !== existingStr) return true;
  }
  return false;
}

/**
 * Reconcile Airtable records against existing CMS items.
 * Uses batch operations and dirty checking for efficiency.
 */
async function reconcileRecords(
  connection: AirtableConnection,
  airtableRecords: AirtableRecord[]
): Promise<SyncResult> {
  const { collectionId, fieldMapping, recordIdFieldId } = connection;
  const result: SyncResult = { created: 0, updated: 0, deleted: 0, errors: [], syncedAt: new Date().toISOString() };

  // Load fields concurrently with items (independent queries)
  const [{ items: existingItems }, fields] = await Promise.all([
    getItemsByCollectionId(collectionId),
    getFieldsByCollectionId(collectionId),
  ]);

  const existingItemIds = existingItems.map((item) => item.id);
  const existingValues = existingItemIds.length > 0
    ? await getValuesByItemIds(existingItemIds)
    : {};

  // Pre-compute which mappings target attachment fields (checked once, not per-record)
  const multiAssetFieldIdSet = new Set(
    fields.filter((f) => isMultipleAssetField(f)).map((f) => f.id)
  );
  const attachmentFieldIds = new Map<string, boolean>();
  for (const mapping of fieldMapping) {
    if (mapping.airtableFieldType === 'multipleAttachments' && isAssetFieldType(mapping.cmsFieldType as CollectionFieldType)) {
      attachmentFieldIds.set(mapping.cmsFieldId, multiAssetFieldIdSet.has(mapping.cmsFieldId));
    }
  }

  // Build slug context if slug field is mapped
  const slugField = fields.find((f) => f.key === SLUG_FIELD_KEY);
  const slugIsMapped = slugField
    ? fieldMapping.some((m) => m.cmsFieldId === slugField.id)
    : false;

  let slugCtx: SlugContext | null = null;
  if (slugIsMapped && slugField) {
    const existingSlugs = new Set<string>();
    for (const item of existingItems) {
      const slug = existingValues[item.id]?.[slugField.id];
      if (slug) existingSlugs.add(slug);
    }
    slugCtx = { slugFieldId: slugField.id, existingSlugs };
  }

  // Resolve system auto-fields (id, created_at, updated_at)
  const idField = fields.find((f) => f.key === 'id');
  const createdAtField = fields.find((f) => f.key === 'created_at');
  const updatedAtField = fields.find((f) => f.key === 'updated_at');

  const autoFields: AutoFields = {
    idFieldId: idField?.id ?? null,
    createdAtFieldId: createdAtField?.id ?? null,
    updatedAtFieldId: updatedAtField?.id ?? null,
  };

  // Load previous attachment fingerprints from connection metadata
  const prevFingerprints = new Map<string, string>(
    Object.entries(connection.attachmentFingerprints ?? {})
  );

  // Build shared sync context — passed to every buildRecordValues call
  const ctx: SyncContext = {
    fieldMapping,
    recordIdFieldId,
    slugCtx,
    assetCache: new Map<string, string>(),
    attachmentFieldIds,
    attachmentFingerprintCache: prevFingerprints,
    autoFields,
  };

  // Index: airtableRecordId -> cmsItemId
  const recordIdToCmsItem = new Map<string, string>();
  for (const item of existingItems) {
    const vals = existingValues[item.id];
    if (vals?.[recordIdFieldId]) {
      recordIdToCmsItem.set(vals[recordIdFieldId], item.id);
    }
  }

  // Classify records
  const seenCmsItemIds = new Set<string>();
  const toCreate: AirtableRecord[] = [];
  const toUpdate: Array<{ cmsItemId: string; values: Record<string, string | null> }> = [];

  for (const record of airtableRecords) {
    const cmsItemId = recordIdToCmsItem.get(record.id);
    if (cmsItemId) {
      seenCmsItemIds.add(cmsItemId);
      const newValues = await buildRecordValues(record, ctx, existingValues[cmsItemId]);
      if (hasChanges(newValues, existingValues[cmsItemId])) {
        toUpdate.push({ cmsItemId, values: newValues });
      }
    } else {
      toCreate.push(record);
    }
  }

  // Collect item IDs to soft-delete
  const toDeleteIds: string[] = [];
  for (const item of existingItems) {
    if (existingValues[item.id]?.[recordIdFieldId] && !seenCmsItemIds.has(item.id)) {
      toDeleteIds.push(item.id);
    }
  }

  // --- BATCH CREATE ---
  if (toCreate.length > 0) {
    try {
      const newItemIds = toCreate.map(() => randomUUID());
      const newItems = newItemIds.map((id) => ({
        id,
        collection_id: collectionId,
        manual_order: 0,
        is_published: false,
        is_publishable: true,
      }));

      // Compute starting auto-increment ID from existing items
      let nextAutoId = 1;
      if (autoFields.idFieldId) {
        for (const item of existingItems) {
          const val = existingValues[item.id]?.[autoFields.idFieldId];
          if (val) {
            const num = parseInt(val, 10);
            if (!isNaN(num) && num >= nextAutoId) nextAutoId = num + 1;
          }
        }
      }

      // Build values concurrently with DB insert — IDs are pre-allocated
      const buildValues = async () => {
        const now = new Date().toISOString();
        const valuesToInsert: Array<{ item_id: string; field_id: string; value: string | null }> = [];
        for (let i = 0; i < toCreate.length; i++) {
          const vals = await buildRecordValues(toCreate[i], ctx);

          // Populate system auto-fields
          if (autoFields.idFieldId) {
            vals[autoFields.idFieldId] = String(nextAutoId++);
          }
          if (autoFields.createdAtFieldId) {
            vals[autoFields.createdAtFieldId] = now;
          }
          if (autoFields.updatedAtFieldId) {
            vals[autoFields.updatedAtFieldId] = now;
          }

          for (const [fieldId, value] of Object.entries(vals)) {
            valuesToInsert.push({ item_id: newItemIds[i], field_id: fieldId, value });
          }
        }
        return valuesToInsert;
      };

      const [, valuesToInsert] = await Promise.all([
        createItemsBulk(newItems),
        buildValues(),
      ]);

      for (let i = 0; i < valuesToInsert.length; i += BULK_CHUNK_SIZE) {
        await insertValuesBulk(valuesToInsert.slice(i, i + BULK_CHUNK_SIZE));
      }

      result.created = toCreate.length;
    } catch (error) {
      result.errors.push(`Create failed: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }

  // --- BATCH UPDATE (only dirty records) ---
  if (toUpdate.length > 0) {
    try {
      await batchUpsertValues(toUpdate);
      result.updated = toUpdate.length;
    } catch (error) {
      result.errors.push(`Update failed: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }

  // --- BATCH DELETE ---
  if (toDeleteIds.length > 0) {
    try {
      await batchSoftDelete(toDeleteIds);
      result.deleted = toDeleteIds.length;
    } catch (error) {
      result.errors.push(`Delete failed: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }

  // Persist attachment fingerprints for next sync to skip unchanged downloads
  if (ctx.attachmentFingerprintCache.size > 0) {
    await updateConnection(connection.id, {
      attachmentFingerprints: Object.fromEntries(ctx.attachmentFingerprintCache),
    });
  }

  return result;
}

// =============================================================================
// Batch Database Helpers
// =============================================================================

/**
 * Bulk upsert values using Knex raw SQL.
 * Supabase's .upsert() can't target the partial unique index
 * (WHERE deleted_at IS NULL), but raw ON CONFLICT can.
 */
async function batchUpsertValues(
  items: Array<{ cmsItemId: string; values: Record<string, string | null> }>
): Promise<void> {
  const { getKnexClient } = await import('@/lib/knex-client');
  const { getTenantIdFromHeaders } = await import('@/lib/supabase-server');
  const knex = await getKnexClient();
  const tenantId = await getTenantIdFromHeaders();

  const now = new Date().toISOString();
  const rows = items.flatMap(({ cmsItemId, values }) =>
    Object.entries(values).map(([fieldId, value]) => ({
      id: randomUUID(),
      item_id: cmsItemId,
      field_id: fieldId,
      value,
      is_published: false,
      created_at: now,
      updated_at: now,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    }))
  );

  // Build column list dynamically based on whether tenant_id is present
  const cols = tenantId
    ? 'id, item_id, field_id, value, is_published, created_at, updated_at, tenant_id'
    : 'id, item_id, field_id, value, is_published, created_at, updated_at';
  const placeholders = tenantId
    ? '(?, ?, ?, ?, ?, ?, ?, ?)'
    : '(?, ?, ?, ?, ?, ?, ?)';

  for (let i = 0; i < rows.length; i += BULK_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + BULK_CHUNK_SIZE);

    const params = tenantId
      ? chunk.flatMap((r) => [r.id, r.item_id, r.field_id, r.value, r.is_published, r.created_at, r.updated_at, tenantId])
      : chunk.flatMap((r) => [r.id, r.item_id, r.field_id, r.value, r.is_published, r.created_at, r.updated_at]);

    await knex.raw(
      `INSERT INTO collection_item_values (${cols})
       VALUES ${chunk.map(() => placeholders).join(', ')}
       ON CONFLICT (item_id, field_id, is_published) WHERE deleted_at IS NULL
       DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      params
    );
  }
}

/** Soft-delete multiple items in a single query */
async function batchSoftDelete(itemIds: string[]): Promise<void> {
  const client = await getSupabaseAdmin();
  if (!client) throw new Error('Supabase not configured');

  const now = new Date().toISOString();

  const { error } = await client
    .from('collection_items')
    .update({ deleted_at: now, updated_at: now })
    .in('id', itemIds)
    .eq('is_published', false);

  if (error) throw new Error(`Batch delete failed: ${error.message}`);
}
