/**
 * Airtable -> CMS Field Type Mapping
 *
 * Maps Airtable field types to CMS CollectionFieldType and
 * transforms Airtable field values into CMS-compatible strings.
 */

import type { CollectionFieldType } from '@/types';
import type { AirtableFieldType } from './types';
import { markdownToTiptapJson } from './markdown-to-tiptap';

// =============================================================================
// Type Mapping
// =============================================================================

const FIELD_TYPE_MAP: Record<AirtableFieldType, CollectionFieldType> = {
  singleLineText: 'text',
  email: 'email',
  url: 'link',
  multilineText: 'text',
  number: 'number',
  percent: 'number',
  currency: 'number',
  singleSelect: 'text',
  multipleSelects: 'text',
  singleCollaborator: 'text',
  multipleCollaborators: 'text',
  multipleRecordLinks: 'text',
  date: 'date_only',
  dateTime: 'date',
  phoneNumber: 'phone',
  multipleAttachments: 'image',
  checkbox: 'boolean',
  formula: 'text',
  createdTime: 'date',
  rollup: 'text',
  count: 'number',
  lookup: 'text',
  multipleLookupValues: 'text',
  autoNumber: 'number',
  barcode: 'text',
  rating: 'number',
  richText: 'rich_text',
  duration: 'number',
  lastModifiedTime: 'date',
  button: 'text',
  createdBy: 'text',
  lastModifiedBy: 'text',
  externalSyncSource: 'text',
  aiText: 'text',
};

/** Get the CMS field type for an Airtable field type */
export function getCmsFieldType(airtableType: AirtableFieldType): CollectionFieldType {
  return FIELD_TYPE_MAP[airtableType] || 'text';
}

/** Check if an Airtable field type is compatible with a CMS field type */
export function isFieldTypeCompatible(
  airtableType: AirtableFieldType,
  cmsType: CollectionFieldType
): boolean {
  const suggestedType = getCmsFieldType(airtableType);
  if (suggestedType === cmsType) return true;

  // text is universally compatible — any value can serialize to string
  if (cmsType === 'text') return true;

  // number types are interchangeable
  const numericAirtable: AirtableFieldType[] = ['number', 'percent', 'currency', 'count', 'rating', 'duration', 'autoNumber'];
  if (cmsType === 'number' && numericAirtable.includes(airtableType)) return true;

  // date types are interchangeable
  const dateAirtable: AirtableFieldType[] = ['date', 'dateTime', 'createdTime', 'lastModifiedTime'];
  if ((cmsType === 'date' || cmsType === 'date_only') && dateAirtable.includes(airtableType)) return true;

  // rich_text accepts any text-like Airtable field
  const textLikeAirtable: AirtableFieldType[] = [
    'singleLineText', 'multilineText', 'richText', 'formula', 'rollup',
    'lookup', 'multipleLookupValues', 'aiText',
  ];
  if (cmsType === 'rich_text' && textLikeAirtable.includes(airtableType)) return true;

  // image accepts attachments and explicit URLs
  if (cmsType === 'image' && (airtableType === 'multipleAttachments' || airtableType === 'url')) return true;

  // link accepts URL or text fields
  const linkLikeAirtable: AirtableFieldType[] = ['url', 'singleLineText', 'formula'];
  if (cmsType === 'link' && linkLikeAirtable.includes(airtableType)) return true;

  // email accepts email or text fields
  if (cmsType === 'email' && (airtableType === 'email' || airtableType === 'singleLineText')) return true;

  // phone accepts phone or text fields
  if (cmsType === 'phone' && (airtableType === 'phoneNumber' || airtableType === 'singleLineText')) return true;

  // boolean accepts checkbox or numeric (0/1)
  if (cmsType === 'boolean' && (airtableType === 'checkbox' || airtableType === 'number')) return true;

  // color accepts text fields (hex values)
  if (cmsType === 'color' && (airtableType === 'singleLineText' || airtableType === 'formula' || airtableType === 'singleSelect')) return true;

  // status accepts select fields or text
  const statusLikeAirtable: AirtableFieldType[] = ['singleSelect', 'singleLineText', 'formula'];
  if (cmsType === 'status' && statusLikeAirtable.includes(airtableType)) return true;

  // media types (audio, video, document) accept attachments and URLs
  const mediaTypes: CollectionFieldType[] = ['audio', 'video', 'document'];
  if (mediaTypes.includes(cmsType) && (airtableType === 'multipleAttachments' || airtableType === 'url')) return true;

  return false;
}

// =============================================================================
// Value Transformation
// =============================================================================

/**
 * Transform an Airtable field value into a CMS-compatible string.
 * @param cmsType - Optional target CMS type, used for format-aware conversion (e.g. markdown → TipTap JSON)
 */
export function transformFieldValue(
  value: unknown,
  airtableType: AirtableFieldType,
  cmsType?: CollectionFieldType
): string | null {
  if (value === null || value === undefined) return null;

  switch (airtableType) {
    case 'richText':
      if (cmsType === 'rich_text' && typeof value === 'string') {
        return markdownToTiptapJson(value);
      }
      return typeof value === 'string' ? value : String(value);

    case 'checkbox':
      return value ? 'true' : 'false';

    case 'number':
    case 'percent':
    case 'currency':
    case 'count':
    case 'rating':
    case 'duration':
    case 'autoNumber':
      return String(value);

    case 'multipleSelects':
      return Array.isArray(value) ? value.join(', ') : String(value);

    case 'multipleAttachments':
      return extractAttachmentUrl(value);

    case 'singleCollaborator':
      return extractCollaboratorName(value);

    case 'multipleCollaborators':
      return extractMultipleCollaboratorNames(value);

    case 'multipleRecordLinks':
      return Array.isArray(value) ? value.join(', ') : String(value);

    case 'multipleLookupValues':
      return Array.isArray(value) ? value.map(String).join(', ') : String(value);

    case 'barcode':
      return typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>).text as string ?? null
        : String(value);

    case 'button':
      return typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>).label as string ?? null
        : null;

    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

function extractAttachmentUrl(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value[0]?.url ?? null;
}

function extractCollaboratorName(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const collab = value as Record<string, unknown>;
  return (collab.name as string) ?? (collab.email as string) ?? null;
}

function extractMultipleCollaboratorNames(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value
    .map((c) => (c as Record<string, unknown>).name ?? (c as Record<string, unknown>).email ?? '')
    .filter(Boolean)
    .join(', ');
}
