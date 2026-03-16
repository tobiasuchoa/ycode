/**
 * Color Variables Store
 *
 * Global state for site-wide color variables (design tokens).
 * Provides CRUD operations and CSS declaration generation.
 */

import { create } from 'zustand';
import { colorVariablesApi } from '@/lib/api';
import type { ColorVariable, Layer } from '@/types';

interface ColorVariablesState {
  colorVariables: ColorVariable[];
  isLoading: boolean;
  error: string | null;
  previewOverride: { id: string; value: string } | null;
}

interface ColorVariablesActions {
  loadColorVariables: () => Promise<void>;
  createColorVariable: (name: string, value: string) => Promise<ColorVariable | null>;
  updateColorVariable: (id: string, data: { name?: string; value?: string }) => Promise<ColorVariable | null>;
  deleteColorVariable: (id: string) => Promise<boolean>;
  reorderColorVariables: (orderedIds: string[]) => Promise<void>;
  getVariableById: (id: string) => ColorVariable | undefined;
  setPreviewOverride: (override: { id: string; value: string } | null) => void;
  generateCssDeclarations: () => string;
}

type ColorVariablesStore = ColorVariablesState & ColorVariablesActions;

export const useColorVariablesStore = create<ColorVariablesStore>((set, get) => ({
  colorVariables: [],
  isLoading: false,
  error: null,
  previewOverride: null,

  loadColorVariables: async () => {
    set({ isLoading: true, error: null });

    try {
      const response = await colorVariablesApi.getAll();

      if (response.error) {
        throw new Error(response.error);
      }

      set({ colorVariables: response.data || [], isLoading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load color variables';
      set({ error: message, isLoading: false });
    }
  },

  createColorVariable: async (name, value) => {
    try {
      const response = await colorVariablesApi.create({ name, value });

      if (response.error) {
        set({ error: response.error });
        return null;
      }

      if (response.data) {
        set((state) => ({
          colorVariables: [...state.colorVariables, response.data!],
        }));
        return response.data;
      }

      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create color variable';
      set({ error: message });
      return null;
    }
  },

  updateColorVariable: async (id, data) => {
    try {
      const response = await colorVariablesApi.update(id, data);

      if (response.error) {
        set({ error: response.error });
        return null;
      }

      if (response.data) {
        set((state) => ({
          colorVariables: state.colorVariables.map((v) =>
            v.id === id ? response.data! : v
          ),
        }));
        return response.data;
      }

      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update color variable';
      set({ error: message });
      return null;
    }
  },

  deleteColorVariable: async (id) => {
    try {
      const variable = get().colorVariables.find((v) => v.id === id);
      const rawValue = variable?.value || '#000000';
      const hexOnly = rawValue.split('/')[0];

      const toCssRgba = (val: string): string => {
        const parts = val.split('/');
        if (parts.length < 2) return val;
        const hex = parts[0];
        const opacity = parseInt(parts[1]) / 100;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${opacity})`;
      };
      const cssValue = toCssRgba(rawValue);

      const response = await colorVariablesApi.delete(id);

      if (response.error) {
        set({ error: response.error });
        return false;
      }

      // Detach variable from all layers, replacing with resolved color
      try {
        const { usePagesStore } = await import('./usePagesStore');
        const { useComponentsStore } = await import('./useComponentsStore');
        const pagesStore = usePagesStore.getState();
        const componentsStore = useComponentsStore.getState();

        const replaceInClasses = (classes: string | string[]): string | string[] => {
          const replace = (s: string) =>
            s.replaceAll(`color:var(--${id})`, rawValue)
              .replaceAll(`var(--${id})`, cssValue);
          if (Array.isArray(classes)) {
            return classes.map(replace);
          }
          return replace(classes);
        };

        const replaceInLayers = (layers: Layer[]): Layer[] =>
          layers.map((layer) => ({
            ...layer,
            classes: replaceInClasses(layer.classes),
            children: layer.children ? replaceInLayers(layer.children) : undefined,
          }));

        for (const [pageId, draft] of Object.entries(pagesStore.draftsByPageId)) {
          if (!draft) continue;
          const updated = replaceInLayers(draft.layers);
          pagesStore.setDraftLayers(pageId, updated);
        }

        for (const comp of componentsStore.components) {
          if (!comp.layers) continue;
          const updated = replaceInLayers(comp.layers as Layer[]);
          useComponentsStore.setState((state) => ({
            components: state.components.map((c) =>
              c.id === comp.id ? { ...c, layers: updated } : c
            ),
          }));
        }
      } catch (detachError) {
        console.error('Failed to detach color variable from layers:', detachError);
      }

      set((state) => ({
        colorVariables: state.colorVariables.filter((v) => v.id !== id),
      }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete color variable';
      set({ error: message });
      return false;
    }
  },

  reorderColorVariables: async (orderedIds) => {
    const { colorVariables } = get();
    const reordered = orderedIds
      .map((id, index) => {
        const v = colorVariables.find((cv) => cv.id === id);
        return v ? { ...v, sort_order: index } : null;
      })
      .filter(Boolean) as ColorVariable[];

    set({ colorVariables: reordered });

    try {
      await colorVariablesApi.reorder(orderedIds);
    } catch (error) {
      console.error('Failed to persist color variable order:', error);
      set({ colorVariables });
    }
  },

  getVariableById: (id) => {
    return get().colorVariables.find((v) => v.id === id);
  },

  setPreviewOverride: (override) => {
    set({ previewOverride: override });
  },

  generateCssDeclarations: () => {
    const { colorVariables, previewOverride } = get();
    if (colorVariables.length === 0 && !previewOverride) return '';

    const toCssValue = (val: string): string => {
      const parts = val.split('/');
      if (parts.length < 2) return val;
      const hex = parts[0];
      const opacity = parseInt(parts[1]) / 100;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${opacity})`;
    };

    const declarations = colorVariables
      .map((v) => {
        if (previewOverride && v.id === previewOverride.id) {
          return `--${v.id}: ${toCssValue(previewOverride.value)};`;
        }
        return `--${v.id}: ${toCssValue(v.value)};`;
      })
      .join(' ');

    return `:root { ${declarations} }`;
  },
}));
