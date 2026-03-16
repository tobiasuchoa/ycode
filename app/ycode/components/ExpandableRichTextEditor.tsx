'use client';

/**
 * Compact rich-text editor with an "Richtext editor" button that opens
 * a RichTextEditorSheet for full-featured editing.
 */

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import RichTextEditor from './RichTextEditor';
import RichTextEditorSheet from './RichTextEditorSheet';
import { CollectionFieldSelector, type FieldSourceType } from './CollectionFieldSelector';
import { hasLinkOrComponent } from '@/lib/tiptap-utils';
import { getVariableLabel } from '@/lib/cms-variables-utils';
import { flattenFieldGroups, hasFieldsMatching, DISPLAYABLE_FIELD_TYPES } from '@/lib/collection-field-utils';
import type { CollectionField, Collection } from '@/types';
import type { FieldGroup } from '@/lib/collection-field-utils';

interface ExpandableRichTextEditorProps {
  value: any;
  onChange: (val: any) => void;
  /** Called on blur with the current content — use for deferred persistence */
  onBlur?: (val: any) => void;
  placeholder?: string;
  /** Bold title in the sheet header */
  sheetTitle?: string;
  /** Muted description in the sheet header */
  sheetDescription?: string;
  fieldGroups?: FieldGroup[];
  allFields?: Record<string, CollectionField[]>;
  collections?: Collection[];
  disabled?: boolean;
  /** Only show the button, hide the inline editor */
  buttonOnly?: boolean;
}

export default function ExpandableRichTextEditor({
  value,
  onChange,
  onBlur,
  placeholder = 'Enter value...',
  sheetTitle,
  sheetDescription,
  fieldGroups,
  allFields,
  collections,
  disabled = false,
  buttonOnly = false,
}: ExpandableRichTextEditorProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [cmsDropdownOpen, setCmsDropdownOpen] = useState(false);
  const isComplex = useMemo(() => hasLinkOrComponent(value), [value]);

  const canShowVariables = useMemo(
    () => hasFieldsMatching(fieldGroups, f => DISPLAYABLE_FIELD_TYPES.includes(f.type)),
    [fieldGroups],
  );

  const fields = useMemo(
    () => flattenFieldGroups(fieldGroups),
    [fieldGroups],
  );

  const handleFieldSelect = (fieldId: string, relationshipPath: string[], source?: FieldSourceType, layerId?: string) => {
    const field = fields.find(f => f.id === fieldId);
    const variableData = {
      type: 'field' as const,
      data: {
        field_id: fieldId,
        relationships: relationshipPath,
        source,
        field_type: field?.type || null,
        collection_layer_id: layerId,
      },
    };
    const label = getVariableLabel(variableData, fields, allFields);

    const newContent = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'dynamicVariable',
          attrs: { variable: variableData, label },
        }],
      }],
    };
    onChange(newContent);
    setCmsDropdownOpen(false);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="flex-1 gap-2.5"
          onClick={() => setSheetOpen(true)}
        >
          Expand
          <span><Icon name="expand" className="size-2.5" /></span>
        </Button>

        {buttonOnly && canShowVariables && (
          <DropdownMenu
            open={cmsDropdownOpen}
            onOpenChange={setCmsDropdownOpen}
          >
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                title="Insert CMS Variable"
                disabled={disabled}
              >
                <Icon name="database" className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            {fieldGroups && (
              <DropdownMenuContent
                className="w-56 py-1 px-1"
                align="end"
                sideOffset={4}
              >
                <CollectionFieldSelector
                  fieldGroups={fieldGroups}
                  allFields={allFields || {}}
                  collections={collections || []}
                  onSelect={handleFieldSelect}
                />
              </DropdownMenuContent>
            )}
          </DropdownMenu>
        )}
      </div>

      {!buttonOnly && !isComplex && (
        <RichTextEditor
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          placeholder={placeholder}
          fieldGroups={fieldGroups}
          allFields={allFields}
          collections={collections}
          withFormatting={true}
          showFormattingToolbar={false}
          disabled={disabled}
        />
      )}

      <RichTextEditorSheet
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open);
          if (!open) onBlur?.(value);
        }}
        title={sheetTitle}
        description={sheetDescription}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        fieldGroups={fieldGroups}
        allFields={allFields}
        collections={collections}
      />
    </div>
  );
}
