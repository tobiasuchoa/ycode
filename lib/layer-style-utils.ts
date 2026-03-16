/**
 * Layer Style Utilities
 *
 * Core logic for applying, detaching, and managing layer styles
 */

import type { Layer, LayerStyle, TextStyle } from '@/types';

/**
 * Apply a style to a layer
 * Replaces layer's classes and design with style's values
 * Clears any previous style overrides
 */
export function applyStyleToLayer(layer: Layer, style: LayerStyle): Layer {
  return {
    ...layer,
    classes: style.classes,
    design: style.design,
    styleId: style.id,
    styleOverrides: undefined, // Clear any previous overrides
  };
}

/**
 * Detach style from a layer
 * Copies the current effective styling (style + overrides) to the layer's own classes/design
 * Then removes the style link and overrides
 */
export function detachStyleFromLayer(layer: Layer, style?: LayerStyle): Layer {
  // When updateStyledLayer is called, it updates both layer.classes/design AND styleOverrides
  // So we can just use what's already on the layer

  // Remove style references but keep current classes/design
  const { styleId, styleOverrides, ...rest } = layer;

  return {
    ...rest,
    // Keep the layer's current classes and design
    // (which already includes style + overrides if they were applied)
    classes: layer.classes || '',
    design: layer.design,
  } as Layer;
}

/**
 * Check if layer has a style applied
 */
export function hasStyle(layer: Layer): boolean {
  return !!layer.styleId;
}

/**
 * Check if layer has style overrides
 * Returns true if layer has a valid style AND has local modifications that differ from the style
 */
export function hasStyleOverrides(layer: Layer, style?: LayerStyle): boolean {
  const hasValidStyleId = layer.styleId && layer.styleId.trim() !== '';

  if (!hasValidStyleId || !layer.styleOverrides) {
    return false;
  }

  // If no style provided, we can only check if styleOverrides exists
  // This is a simple check used when we don't have the style loaded
  if (!style) {
    return true;
  }

  // Compare current values with style values to see if they actually differ
  const classesMatch = layer.classes === style.classes;
  const designMatch = JSON.stringify(layer.design || {}) === JSON.stringify(style.design || {});

  // Has overrides if either classes or design differ from the style
  return !classesMatch || !designMatch;
}

/**
 * Reset layer to original style
 * Removes overrides and reapplies style's current values
 */
export function resetLayerToStyle(layer: Layer, style: LayerStyle): Layer {
  if (!layer.styleId || layer.styleId !== style.id) {
    return layer;
  }

  return {
    ...layer,
    classes: style.classes,
    design: style.design,
    styleOverrides: undefined,
  };
}

/**
 * Update a styled layer
 * Tracks changes as overrides when a style is applied
 * If no style is applied, updates normally
 */
export function updateStyledLayer(
  layer: Layer,
  updates: { classes?: string; design?: Layer['design'] }
): Layer {
  // Check if layer has a valid style ID (not just empty string or undefined)
  const hasValidStyleId = layer.styleId && layer.styleId.trim() !== '';

  if (!hasValidStyleId) {
    // No style applied, just update normally
    return { ...layer, ...updates };
  }

  // Style is applied - track as overrides
  return {
    ...layer,
    ...updates,
    styleOverrides: {
      classes: updates.classes !== undefined ? updates.classes : layer.styleOverrides?.classes,
      design: updates.design !== undefined ? updates.design : layer.styleOverrides?.design,
    },
  };
}

/**
 * Build a partial update that routes classes/design through the style system.
 * Extra fields (e.g. variables) are passed through unchanged.
 * Use this for atomic updates that combine style-tracked and non-tracked fields.
 */
export function buildStyledUpdate(
  layer: Layer,
  updates: Partial<Layer>,
): Partial<Layer> {
  const { classes: rawClasses, design, ...rest } = updates;
  const classes = Array.isArray(rawClasses) ? rawClasses.join(' ') : rawClasses;

  if (classes === undefined && design === undefined) {
    return updates;
  }

  const styledLayer = updateStyledLayer(layer, { classes, design });
  const result: Partial<Layer> = {
    ...rest,
    design: styledLayer.design,
    classes: styledLayer.classes,
  };

  if (styledLayer.styleOverrides !== layer.styleOverrides) {
    result.styleOverrides = styledLayer.styleOverrides;
  }

  return result;
}

/**
 * Update textStyles entries that reference a given style.
 * Only updates entries WITHOUT overrides (overridden entries keep their custom values).
 */
function updateTextStylesWithStyle(
  textStyles: Record<string, TextStyle>,
  styleId: string,
  newClasses: string,
  newDesign?: Layer['design']
): Record<string, TextStyle> | null {
  let changed = false;
  const updated: Record<string, TextStyle> = {};

  for (const [key, ts] of Object.entries(textStyles)) {
    if (ts.styleId === styleId && !ts.styleOverrides) {
      updated[key] = { ...ts, classes: newClasses, design: newDesign };
      changed = true;
    } else {
      updated[key] = ts;
    }
  }

  return changed ? updated : null;
}

/**
 * Detach a style from all textStyles entries.
 * Keeps current classes/design but removes the style link.
 */
function detachStyleFromTextStyles(
  textStyles: Record<string, TextStyle>,
  styleId: string,
): Record<string, TextStyle> | null {
  let changed = false;
  const updated: Record<string, TextStyle> = {};

  for (const [key, ts] of Object.entries(textStyles)) {
    if (ts.styleId === styleId) {
      const { styleId: _, styleOverrides: __, ...rest } = ts;
      updated[key] = rest;
      changed = true;
    } else {
      updated[key] = ts;
    }
  }

  return changed ? updated : null;
}

/**
 * Update all layers using a specific style
 * Recursively traverses layer tree and updates layers that have the style applied
 * Also updates textStyles entries that reference the style
 * Only updates layers/entries WITHOUT overrides (overridden ones keep their custom values)
 */
export function updateLayersWithStyle(
  layers: Layer[],
  styleId: string,
  newClasses: string,
  newDesign?: Layer['design']
): Layer[] {
  return layers.map(layer => {
    let updatedLayer = layer;

    // Update this layer if it uses the style and has no overrides
    if (layer.styleId === styleId && !layer.styleOverrides) {
      updatedLayer = {
        ...updatedLayer,
        classes: newClasses,
        design: newDesign,
      };
    }

    // Update textStyles entries that reference this style
    if (layer.textStyles) {
      const updatedTextStyles = updateTextStylesWithStyle(layer.textStyles, styleId, newClasses, newDesign);
      if (updatedTextStyles) {
        updatedLayer = updatedLayer === layer
          ? { ...layer, textStyles: updatedTextStyles }
          : { ...updatedLayer, textStyles: updatedTextStyles };
      }
    }

    // Recursively update children
    if (layer.children && layer.children.length > 0) {
      const updatedChildren = updateLayersWithStyle(layer.children, styleId, newClasses, newDesign);
      if (updatedChildren !== layer.children) {
        updatedLayer = updatedLayer === layer
          ? { ...layer, children: updatedChildren }
          : { ...updatedLayer, children: updatedChildren };
      }
    }

    return updatedLayer;
  });
}

/**
 * Detach a style from all layers
 * Used when a style is deleted
 * Keeps current classes/design values but removes the style link
 * Also detaches from textStyles entries that reference the style
 */
export function detachStyleFromLayers(layers: Layer[], styleId: string): Layer[] {
  return layers.map(layer => {
    let updatedLayer = layer;

    // Detach if this layer uses the style
    if (layer.styleId === styleId) {
      const { styleId: _, styleOverrides: __, ...rest } = layer;
      updatedLayer = rest as Layer;
    }

    // Detach from textStyles entries
    if (layer.textStyles) {
      const updatedTextStyles = detachStyleFromTextStyles(layer.textStyles, styleId);
      if (updatedTextStyles) {
        updatedLayer = updatedLayer === layer
          ? { ...layer, textStyles: updatedTextStyles }
          : { ...updatedLayer, textStyles: updatedTextStyles };
      }
    }

    // Recursively detach from children
    if (layer.children && layer.children.length > 0) {
      const updatedChildren = detachStyleFromLayers(layer.children, styleId);
      if (updatedChildren !== layer.children) {
        updatedLayer = updatedLayer === layer
          ? { ...layer, children: updatedChildren }
          : { ...updatedLayer, children: updatedChildren };
      }
    }

    return updatedLayer;
  });
}

/**
 * Count how many layers use a specific style
 * Includes both direct layer.styleId and textStyles[*].styleId references
 */
export function countLayersUsingStyle(layers: Layer[], styleId: string): number {
  let count = 0;

  for (const layer of layers) {
    if (layer.styleId === styleId) {
      count++;
    }

    if (layer.textStyles) {
      for (const ts of Object.values(layer.textStyles)) {
        if (ts.styleId === styleId) {
          count++;
        }
      }
    }

    if (layer.children && layer.children.length > 0) {
      count += countLayersUsingStyle(layer.children, styleId);
    }
  }

  return count;
}

/**
 * Get all layer IDs using a specific style
 * Includes layers that reference the style via textStyles[*].styleId
 */
export function getLayerIdsUsingStyle(layers: Layer[], styleId: string): string[] {
  const ids: string[] = [];

  for (const layer of layers) {
    if (layer.styleId === styleId) {
      ids.push(layer.id);
    } else if (layer.textStyles) {
      for (const ts of Object.values(layer.textStyles)) {
        if (ts.styleId === styleId) {
          ids.push(layer.id);
          break;
        }
      }
    }

    if (layer.children && layer.children.length > 0) {
      ids.push(...getLayerIdsUsingStyle(layer.children, styleId));
    }
  }

  return ids;
}
