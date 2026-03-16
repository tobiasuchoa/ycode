'use client';

/**
 * Layer Styles Panel
 *
 * UI for managing layer styles in the Right Sidebar
 * Allows creating, applying, editing, detaching, and deleting styles
 */

import { useCallback, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useLayerStylesStore } from '@/stores/useLayerStylesStore';
import { useLiveLayerStyleUpdates } from '@/hooks/use-live-layer-style-updates';
import {
  applyStyleToLayer,
  detachStyleFromLayer,
  hasStyleOverrides,
  resetLayerToStyle,
} from '@/lib/layer-style-utils';
import { detachStyleAcrossStores, updateStyleAcrossStores } from '@/lib/layer-style-store-utils';
import { getStyleGroup, getTextStyleGroup, isStyleGroupCompatible } from '@/lib/layer-style-groups';
import { DEFAULT_TEXT_STYLES } from '@/lib/text-format-utils';
import type { Layer, LayerStyle, TextStyle } from '@/types';

interface LayerStylesPanelProps {
  layer: Layer | null;
  pageId: string | null;
  onLayerUpdate: (layerId: string, updates: Partial<Layer>) => void;
  activeTextStyleKey?: string | null;
}

export default function LayerStylesPanel({
  layer,
  pageId,
  onLayerUpdate,
  activeTextStyleKey,
}: LayerStylesPanelProps) {
  const {
    styles,
    isLoading,
    createStyle,
    updateStyle,
    deleteStyle,
    getStyleById,
  } = useLayerStylesStore();

  // Real-time style sync
  const liveLayerStyleUpdates = useLiveLayerStyleUpdates();

  const [isCreating, setIsCreating] = useState(false);
  const [newStyleName, setNewStyleName] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [styleToDelete, setStyleToDelete] = useState<string | null>(null);

  const isTextStyleMode = !!activeTextStyleKey;

  // Determine the style group for this element
  const currentGroup = isTextStyleMode
    ? getTextStyleGroup(activeTextStyleKey!)
    : layer
      ? getStyleGroup(layer.name)
      : 'block';

  // Filter styles to show matching group (handles legacy group compatibility)
  const filteredStyles = styles.filter((s) => isStyleGroupCompatible(s.group, currentGroup));

  // Get the current text style when in text style mode
  const currentTextStyle: TextStyle | undefined = isTextStyleMode && layer?.textStyles
    ? layer.textStyles[activeTextStyleKey!] ?? DEFAULT_TEXT_STYLES[activeTextStyleKey!]
    : undefined;

  // Get the applied style - from text style or layer
  const appliedStyleId = isTextStyleMode
    ? currentTextStyle?.styleId
    : layer?.styleId;
  const appliedStyle = appliedStyleId ? getStyleById(appliedStyleId) : undefined;

  // Check for overrides
  const hasOverrides = (() => {
    if (!appliedStyle) return false;
    if (isTextStyleMode) {
      return !!currentTextStyle?.styleOverrides;
    }
    return layer ? hasStyleOverrides(layer, appliedStyle) : false;
  })();

  // Get current classes and design (from text style or layer)
  const currentClasses = isTextStyleMode
    ? currentTextStyle?.classes || ''
    : layer
      ? Array.isArray(layer.classes)
        ? layer.classes.join(' ')
        : layer.classes || ''
      : '';

  const currentDesign = isTextStyleMode
    ? currentTextStyle?.design
    : layer?.design;

  // Helper to update a text style on the layer
  const updateTextStyle = useCallback((updates: Partial<TextStyle>) => {
    if (!layer || !activeTextStyleKey) return;
    const currentTextStyles = layer.textStyles ?? { ...DEFAULT_TEXT_STYLES };
    const existingStyle = currentTextStyles[activeTextStyleKey] || {};
    onLayerUpdate(layer.id, {
      textStyles: {
        ...currentTextStyles,
        [activeTextStyleKey]: { ...existingStyle, ...updates },
      },
    });
  }, [layer, activeTextStyleKey, onLayerUpdate]);

  /**
   * Create a new style from current layer or text style
   */
  const handleCreateStyle = useCallback(async () => {
    if (!layer || !newStyleName.trim()) return;

    const style = await createStyle(newStyleName.trim(), currentClasses, currentDesign, currentGroup);

    if (style) {
      if (isTextStyleMode) {
        updateTextStyle({
          classes: style.classes,
          design: style.design,
          styleId: style.id,
          styleOverrides: undefined,
        });
      } else {
        const updatedLayer = applyStyleToLayer(layer, style);
        onLayerUpdate(layer.id, updatedLayer);
      }
      setNewStyleName('');
      setIsCreating(false);

      if (liveLayerStyleUpdates) {
        liveLayerStyleUpdates.broadcastStyleCreate(style);
      }
    }
  }, [layer, newStyleName, currentClasses, currentDesign, currentGroup, createStyle, onLayerUpdate, liveLayerStyleUpdates, isTextStyleMode, updateTextStyle]);

  /**
   * Apply a style to the current layer or text style
   */
  const handleApplyStyle = useCallback((styleId: string) => {
    if (!layer || !styleId) return;

    const style = getStyleById(styleId);
    if (!style) return;

    if (isTextStyleMode) {
      updateTextStyle({
        classes: style.classes,
        design: style.design,
        styleId: style.id,
        styleOverrides: undefined,
      });
    } else {
      const updatedLayer = applyStyleToLayer(layer, style);
      onLayerUpdate(layer.id, {
        classes: updatedLayer.classes,
        design: updatedLayer.design,
        styleId: updatedLayer.styleId,
        styleOverrides: undefined,
      });
    }
  }, [layer, getStyleById, onLayerUpdate, isTextStyleMode, updateTextStyle]);

  /**
   * Detach style from current layer or text style
   */
  const handleDetachStyle = useCallback(() => {
    if (!layer) return;

    if (isTextStyleMode) {
      updateTextStyle({
        styleId: undefined,
        styleOverrides: undefined,
      });
    } else {
      const updatedLayer = detachStyleFromLayer(layer, appliedStyle);
      onLayerUpdate(layer.id, {
        classes: updatedLayer.classes,
        design: updatedLayer.design,
        styleId: undefined,
        styleOverrides: undefined,
      });
    }
  }, [layer, appliedStyle, onLayerUpdate, isTextStyleMode, updateTextStyle]);

  /**
   * Reset overrides on current layer or text style
   */
  const handleResetOverrides = useCallback(() => {
    if (!layer || !appliedStyle) return;

    if (isTextStyleMode) {
      updateTextStyle({
        classes: appliedStyle.classes,
        design: appliedStyle.design,
        styleOverrides: undefined,
      });
    } else {
      const updatedLayer = resetLayerToStyle(layer, appliedStyle);
      onLayerUpdate(layer.id, {
        classes: updatedLayer.classes,
        design: updatedLayer.design,
        styleOverrides: undefined,
      });
    }
  }, [layer, appliedStyle, onLayerUpdate, isTextStyleMode, updateTextStyle]);

  /**
   * Update style with current values
   */
  const handleUpdateStyle = useCallback(async () => {
    if (!layer || !appliedStyle) return;

    await updateStyle(appliedStyle.id, {
      classes: currentClasses,
      design: currentDesign,
    });

    // Propagate style update to all layers (including textStyles entries)
    updateStyleAcrossStores(appliedStyle.id, currentClasses, currentDesign);

    if (isTextStyleMode) {
      updateTextStyle({ styleOverrides: undefined });
    } else {
      onLayerUpdate(layer.id, { styleOverrides: undefined });
    }

    if (liveLayerStyleUpdates) {
      liveLayerStyleUpdates.broadcastStyleUpdate(appliedStyle.id, {
        classes: currentClasses,
        design: currentDesign,
      });
    }
  }, [layer, appliedStyle, currentClasses, currentDesign, updateStyle, onLayerUpdate, liveLayerStyleUpdates, isTextStyleMode, updateTextStyle]);

  /**
   * Open delete confirmation dialog
   */
  const handleDeleteStyle = useCallback((styleId: string) => {
    setStyleToDelete(styleId);
    setDeleteDialogOpen(true);
  }, []);

  /**
   * Handle dialog close - reset state
   */
  const handleDeleteDialogClose = useCallback((open: boolean) => {
    setDeleteDialogOpen(open);
    if (!open) {
      setStyleToDelete(null);
    }
  }, []);

  /**
   * Confirm and delete a style
   */
  const confirmDeleteStyle = useCallback(async () => {
    if (!styleToDelete) return;

    // Delete the style (backend soft-deletes and detaches from all layers)
    // Store automatically removes from local state on success
    const result = await deleteStyle(styleToDelete);

    if (result.success) {
      // Update local state to detach style from all layers (pages and components)
      detachStyleAcrossStores(styleToDelete);

      // Broadcast style deletion to collaborators
      if (liveLayerStyleUpdates) {
        liveLayerStyleUpdates.broadcastStyleDelete(styleToDelete);
      }
    } else {
      // If deletion failed, throw error so dialog stays open
      throw new Error('Failed to delete layer style');
    }
  }, [styleToDelete, deleteStyle, liveLayerStyleUpdates]);

  /**
   * Rename the applied style
   */
  const handleRenameStyle = useCallback(async () => {
    if (!appliedStyle || !renameValue.trim()) return;

    await updateStyle(appliedStyle.id, { name: renameValue.trim() });
    setIsRenaming(false);
    setRenameValue('');

    // Broadcast style rename to collaborators
    if (liveLayerStyleUpdates) {
      liveLayerStyleUpdates.broadcastStyleUpdate(appliedStyle.id, { name: renameValue.trim() });
    }
  }, [appliedStyle, renameValue, updateStyle, liveLayerStyleUpdates]);

  if (!layer) {
    return (
      <div className="p-4 text-sm text-zinc-500">
        Select a layer to manage styles
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 pb-2 pt-2">
      {/* Style Selector or Rename Input */}
      {!isCreating && (
        <>
          {appliedStyle && isRenaming ? (
            <div className="flex flex-col gap-2">
              <Input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameStyle();
                  if (e.key === 'Escape') {
                    setIsRenaming(false);
                    setRenameValue('');
                  }
                }}
                autoFocus
              />
              <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                variant="default"
                onClick={handleRenameStyle}
              >
                Save changes
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setIsRenaming(false);
                  setRenameValue('');
                }}
              >
                Cancel
              </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Select
                  onValueChange={handleApplyStyle}
                  value={appliedStyleId || ''}
                >
                  <SelectTrigger className="flex-1">
                    {filteredStyles.length === 0 ? (
                    <span className="opacity-50">Apply layer style...</span>
                    ) : (
                    <SelectValue placeholder="Apply layer style..." />
                    )}
                    {hasOverrides && (
                      <span className="ml-auto text-yellow-400 text-[10px] pr-1">Customized</span>
                    )}
                  </SelectTrigger>
                  <SelectContent>
                    {filteredStyles.length === 0 ? (
                      <Empty>
                        <EmptyTitle>No layers styles</EmptyTitle>
                      </Empty>
                    ) : (
                      <SelectGroup>
                        {filteredStyles.map((style) => (
                          <SelectItem key={style.id} value={style.id}>
                            {style.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </>
      )}

      {/* Create New Style Modal/Form */}
      {isCreating && (
        <div className="flex flex-col gap-2">
          <Input
            placeholder="Style name..."
            value={newStyleName}
            onChange={(e) => setNewStyleName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateStyle();
              if (e.key === 'Escape') {
                setIsCreating(false);
                setNewStyleName('');
              }
            }}
            autoFocus
          />
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="default"
              onClick={handleCreateStyle}
              disabled={!newStyleName.trim()}
              className="flex-1"
            >
              Create
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setIsCreating(false);
                setNewStyleName('');
              }}
              className="flex-1"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!isCreating && !isRenaming && (
        <div className="flex">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setIsCreating(true)}
            className="flex-1"
          >
            <Icon name="plus" />
            New
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={handleUpdateStyle}
            disabled={!hasOverrides}
          >
            Update
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={handleDetachStyle}
            disabled={!appliedStyle}
          >
            Detach
          </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm" variant="ghost"

                >
                  <Icon name="more" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={handleResetOverrides}
                disabled={!hasOverrides}
              >
                Reset
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  if (!appliedStyle) return;
                  setRenameValue(appliedStyle.name);
                  setIsRenaming(true);
                }}
              >
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => appliedStyle && handleDeleteStyle(appliedStyle.id)}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={handleDeleteDialogClose}
        title="Delete layer style"
        description="Are you sure you want to delete this style? It will be detached from all layers."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={confirmDeleteStyle}
      />
    </div>
  );
}
