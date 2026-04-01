import { NextRequest, NextResponse } from 'next/server';
import { getItemsWithValues, createItem, getItemWithValues, getMaxIdValue, enrichItemsWithStatus, enrichSingleItemWithStatus, publishSingleItem, unpublishSingleItem } from '@/lib/repositories/collectionItemRepository';
import { getCollectionById } from '@/lib/repositories/collectionRepository';
import { clearAllCache } from '@/lib/services/cacheService';
import { setValuesByFieldName } from '@/lib/repositories/collectionItemValueRepository';
import { getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import { getAssetsByIds } from '@/lib/repositories/assetRepository';
import { findStatusFieldId, isAssetFieldType, isMultipleAssetField } from '@/lib/collection-field-utils';
import type { StatusAction } from '@/lib/collection-field-utils';
import { noCache } from '@/lib/api-response';
import type { CollectionItemWithValues, CollectionField } from '@/types';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/collections/[id]/items
 * Get all items with values for a collection (draft version)
 * Query params:
 *  - search: string (optional) - Filter items by searching across all field values
 *  - page: number (optional, default: 1) - Page number
 *  - limit: number (optional, default: 25) - Items per page
 *  - sortBy: string (optional) - Field ID to sort by, or 'manual', 'random', 'none'
 *  - sortOrder: 'asc' | 'desc' (optional, default: 'asc') - Sort order
 *  - offset: number (optional) - Number of items to skip
 *  - includeAssets: 'true' (optional) - Include referenced assets in the response
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Extract query parameters
    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search') || undefined;
    const page = parseInt(searchParams.get('page') || '1', 10);
    const limit = parseInt(searchParams.get('limit') || '25', 10);
    const sortBy = searchParams.get('sortBy') || undefined;
    const sortOrder = (searchParams.get('sortOrder') || 'asc') as 'asc' | 'desc';
    const offsetParam = searchParams.get('offset');
    const filtersParam = searchParams.get('filters');
    const includeAssets = searchParams.get('includeAssets') === 'true';

    // Calculate offset (use explicit offset if provided, otherwise calculate from page)
    const offset = offsetParam ? parseInt(offsetParam, 10) : (page - 1) * limit;

    // Parse dynamic filter conditions from query param
    let dynamicFilters: Array<{ fieldId: string; operator: string; value: string }> = [];
    if (filtersParam) {
      try {
        dynamicFilters = JSON.parse(filtersParam);
      } catch {
        // Ignore malformed filter param
      }
    }

    // When sorting by a field value, we must fetch ALL items first to sort globally,
    // then paginate the sorted result. Otherwise DB pagination order won't match.
    const needsGlobalSort = sortBy && sortBy !== 'none' && sortBy !== 'manual';

    // Build filters object
    const filters = {
      ...(search ? { search } : {}),
      // Only apply DB pagination when we don't need global sorting
      ...(!needsGlobalSort ? { limit, offset } : {}),
    };

    // Always get draft items in the builder
    let { items, total } = await getItemsWithValues(id, false, filters);

    // Find status field ID for enrichment
    const allFields = await getFieldsByCollectionId(id, false);
    const statusFieldId = findStatusFieldId(allFields);

    // Enrich items with computed status values before sorting
    await enrichItemsWithStatus(items, id, statusFieldId);

    // Apply dynamic filters from filter layer conditions
    if (dynamicFilters.length > 0) {
      items = items.filter(item => {
        return dynamicFilters.every(filter => {
          const fieldValue = String(item.values[filter.fieldId] ?? '').toLowerCase();
          const filterValue = String(filter.value).toLowerCase();

          switch (filter.operator) {
            case 'contains':
              return fieldValue.includes(filterValue);
            case 'does_not_contain':
              return !fieldValue.includes(filterValue);
            case 'is':
              return fieldValue === filterValue;
            case 'is_not':
              return fieldValue !== filterValue;
            case 'starts_with':
              return fieldValue.startsWith(filterValue);
            case 'ends_with':
              return fieldValue.endsWith(filterValue);
            case 'is_empty':
              return fieldValue === '';
            case 'is_not_empty':
              return fieldValue !== '';
            case 'gt':
              return parseFloat(fieldValue) > parseFloat(filterValue);
            case 'gte':
              return parseFloat(fieldValue) >= parseFloat(filterValue);
            case 'lt':
              return parseFloat(fieldValue) < parseFloat(filterValue);
            case 'lte':
              return parseFloat(fieldValue) <= parseFloat(filterValue);
            default:
              return fieldValue.includes(filterValue);
          }
        });
      });
    }

    // Apply sorting
    if (sortBy && sortBy !== 'none') {
      if (sortBy === 'manual') {
        // manual_order is already the DB default sort — no extra work needed
      } else if (sortBy === 'random') {
        items = [...items].sort(() => Math.random() - 0.5);
      } else {
        // Sort by field value (globally, before pagination)
        items = [...items].sort((a, b) => {
          const aStr = String(a.values[sortBy] || '');
          const bStr = String(b.values[sortBy] || '');

          const aNum = aStr.trim() !== '' ? Number(aStr) : NaN;
          const bNum = bStr.trim() !== '' ? Number(bStr) : NaN;

          if (!isNaN(aNum) && !isNaN(bNum)) {
            return sortOrder === 'asc' ? aNum - bNum : bNum - aNum;
          }

          const comparison = aStr.localeCompare(bStr);
          return sortOrder === 'asc' ? comparison : -comparison;
        });
      }
    }

    // Apply pagination after global sorting (if we fetched all items)
    if (needsGlobalSort) {
      total = items.length;
      items = items.slice(offset, offset + limit);
    }

    // Optionally resolve referenced assets for the returned items
    const responseData: Record<string, unknown> = { items, total, page, limit };

    if (includeAssets) {
      const assetIds = extractAssetIdsFromItems(items, allFields);
      if (assetIds.length > 0) {
        const assetsMap = await getAssetsByIds(assetIds, false);
        responseData.referencedAssets = Object.values(assetsMap);
      }
    }

    return noCache({ data: responseData });
  } catch (error) {
    console.error('Error fetching collection items:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch items' },
      500
    );
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extract unique asset IDs from item values based on asset-type fields. */
function extractAssetIdsFromItems(
  items: CollectionItemWithValues[],
  fields: CollectionField[],
): string[] {
  const assetFieldIds = fields.filter(f => isAssetFieldType(f.type)).map(f => f.id);
  const multiAssetFieldIds = new Set(
    fields.filter(f => isMultipleAssetField(f)).map(f => f.id),
  );

  if (assetFieldIds.length === 0) return [];

  const ids = new Set<string>();

  for (const item of items) {
    for (const fieldId of assetFieldIds) {
      const value = item.values[fieldId];
      if (!value) continue;

      if (multiAssetFieldIds.has(fieldId)) {
        const arr = Array.isArray(value) ? value : [];
        for (const v of arr) {
          if (typeof v === 'string' && v && UUID_RE.test(v)) ids.add(v);
        }
      } else if (typeof value === 'string' && UUID_RE.test(value)) {
        ids.add(value);
      }
    }
  }

  return Array.from(ids);
}

/**
 * POST /ycode/api/collections/[id]/items
 * Create a new item with field values (draft)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const body = await request.json();

    // Extract item data, values, and optional status action
    const { values, status_action, ...itemData } = body;

    // Create the item (draft)
    const item = await createItem({
      collection_id: id,
      manual_order: itemData.manual_order ?? 0,
      is_published: false, // Always create as draft
    });
    // Get all fields to map field keys to field IDs
    const fields = await getFieldsByCollectionId(id, false);

    // Find field IDs for built-in fields
    const idField = fields.find(f => f.key === 'id');
    const createdAtField = fields.find(f => f.key === 'created_at');
    const updatedAtField = fields.find(f => f.key === 'updated_at');

    // Calculate auto-incrementing ID based on max ID value + 1
    const maxId = await getMaxIdValue(id, false);
    const autoIncrementId = maxId + 1;
    // Get current timestamp for created_at and updated_at
    const now = new Date().toISOString();

    // Set field values if provided, and add auto-generated fields
    // Use field IDs (UUIDs) as keys, not field keys
    const valuesWithAutoFields: Record<string, any> = {
      ...values,
    };
    // Set auto-incrementing ID if ID field exists
    if (idField) {
      valuesWithAutoFields[idField.id] = autoIncrementId.toString();
    }

    // Set timestamps if fields exist
    if (createdAtField) {
      valuesWithAutoFields[createdAtField.id] = now;
    }
    if (updatedAtField) {
      valuesWithAutoFields[updatedAtField.id] = now;
    }

    if (valuesWithAutoFields && typeof valuesWithAutoFields === 'object') {
      await setValuesByFieldName(
        item.id,
        id,
        valuesWithAutoFields,
        {},
        false // Create draft values
      );
    }

    // Apply status action if provided
    const action = status_action as StatusAction | undefined;
    if (action === 'draft') {
      await unpublishSingleItem(item.id);
      await clearAllCache();
    } else if (action === 'stage') {
      // New items are already staged (is_publishable defaults to true)
    } else if (action === 'publish') {
      const publishedCollection = await getCollectionById(id, true);
      if (!publishedCollection) {
        return noCache(
          { error: 'Cannot publish item: the collection has not been published yet' },
          400
        );
      }
      await publishSingleItem(item.id);
      await clearAllCache();
    }

    // Get item with values and enrich with status
    const itemWithValues = await getItemWithValues(item.id, false);
    if (itemWithValues) {
      await enrichSingleItemWithStatus(itemWithValues, id);
    }

    return noCache(
      { data: itemWithValues },
      201
    );
  } catch (error) {
    console.error('Error creating item:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to create item' },
      500
    );
  }
}
