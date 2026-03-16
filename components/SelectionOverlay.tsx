'use client';

/**
 * SelectionOverlay Component
 *
 * Renders selection, hover, and parent outlines on top of the canvas iframe.
 * Uses direct DOM manipulation for instant updates during scrolling.
 * 
 * Note: Drag initiation for sibling reordering is handled by the
 * useCanvasSiblingReorder hook, which listens to iframe mousedown events.
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { useEditorStore } from '@/stores/useEditorStore';

interface SelectionOverlayProps {
  /** Reference to the canvas iframe element */
  iframeElement: HTMLIFrameElement | null;
  /** Reference to the container element for positioning */
  containerElement: HTMLElement | null;
  /** Currently selected layer ID */
  selectedLayerId: string | null;
  /** Currently hovered layer ID */
  hoveredLayerId: string | null;
  /** Parent layer ID (one level up from selected) */
  parentLayerId: string | null;
  /** Current zoom level (percentage) */
  zoom: number;
  /** Active sublayer index within a richText element (null = highlight whole layer) */
  activeSublayerIndex?: number | null;
  /** Active list item index within a list (null = highlight whole list block) */
  activeListItemIndex?: number | null;
}

const SELECTED_OUTLINE_CLASS = 'outline outline-1 outline-blue-500';
const HOVERED_OUTLINE_CLASS = 'outline outline-1 outline-blue-400/50';
const PARENT_OUTLINE_CLASS = 'outline outline-1 outline-dashed outline-blue-400';

export function SelectionOverlay({
  iframeElement,
  containerElement,
  selectedLayerId,
  hoveredLayerId,
  parentLayerId,
  zoom,
  activeSublayerIndex,
  activeListItemIndex,
}: SelectionOverlayProps) {
  // Container refs for outline groups (supports multiple instances per layer ID)
  const selectedContainerRef = useRef<HTMLDivElement>(null);
  const hoveredContainerRef = useRef<HTMLDivElement>(null);
  const parentContainerRef = useRef<HTMLDivElement>(null);
  
  // Track drag/animation state for scroll/mutation handlers
  const isDraggingRef = useRef(false);
  const isSliderAnimatingRef = useRef(false);

  const hideAllOutlines = useCallback(() => {
    if (selectedContainerRef.current) selectedContainerRef.current.style.display = 'none';
    if (hoveredContainerRef.current) hoveredContainerRef.current.style.display = 'none';
    if (parentContainerRef.current) parentContainerRef.current.style.display = 'none';
  }, []);

  // Update outline(s) for all elements matching a layer ID
  const updateOutline = useCallback((
    container: HTMLDivElement | null,
    layerId: string | null,
    iframeDoc: Document,
    iframeElement: HTMLIFrameElement,
    containerElement: HTMLElement,
    scale: number,
    outlineClass: string,
    blockIndex?: number | null,
    listItemIndex?: number | null,
  ) => {
    if (!container) return;

    if (!layerId || layerId === 'body') {
      container.style.display = 'none';
      return;
    }

    let targetElements: NodeListOf<Element>;
    if (blockIndex !== undefined && blockIndex !== null && listItemIndex !== undefined && listItemIndex !== null) {
      targetElements = iframeDoc.querySelectorAll(
        `[data-layer-id="${layerId}"] [data-block-index="${blockIndex}"] [data-list-item-index="${listItemIndex}"]`
      );
    } else if (blockIndex !== undefined && blockIndex !== null) {
      targetElements = iframeDoc.querySelectorAll(`[data-layer-id="${layerId}"] [data-block-index="${blockIndex}"]`);
    } else {
      targetElements = iframeDoc.querySelectorAll(`[data-layer-id="${layerId}"]`);
    }
    if (targetElements.length === 0) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';

    const iframeRect = iframeElement.getBoundingClientRect();
    const containerRect = containerElement.getBoundingClientRect();

    // Ensure we have the right number of child outline divs
    while (container.children.length < targetElements.length) {
      const div = document.createElement('div');
      div.className = `absolute ${outlineClass}`;
      container.appendChild(div);
    }
    // Hide excess children
    for (let i = targetElements.length; i < container.children.length; i++) {
      (container.children[i] as HTMLElement).style.display = 'none';
    }

    targetElements.forEach((targetElement, idx) => {
      const elementRect = targetElement.getBoundingClientRect();
      const child = container.children[idx] as HTMLElement;

      const top = iframeRect.top - containerRect.top + (elementRect.top * scale);
      const left = iframeRect.left - containerRect.left + (elementRect.left * scale);
      const width = elementRect.width * scale;
      const height = elementRect.height * scale;

      child.style.display = 'block';
      child.style.top = `${top}px`;
      child.style.left = `${left}px`;
      child.style.width = `${width}px`;
      child.style.height = `${height}px`;
    });
  }, []);

  // Update all outlines
  const updateAllOutlines = useCallback((skipSolidBorders = false) => {
    if (isSliderAnimatingRef.current) {
      hideAllOutlines();
      return;
    }

    if (!iframeElement || !containerElement) {
      hideAllOutlines();
      return;
    }

    const iframeDoc = iframeElement.contentDocument;
    if (!iframeDoc) {
      hideAllOutlines();
      return;
    }

    const scale = zoom / 100;

    // Update selected outline (skip during drag)
    if (!skipSolidBorders) {
      updateOutline(selectedContainerRef.current, selectedLayerId, iframeDoc, iframeElement, containerElement, scale, SELECTED_OUTLINE_CLASS, activeSublayerIndex, activeListItemIndex);

      // Update hovered outline (only if different from selected)
      const effectiveHoveredId = hoveredLayerId !== selectedLayerId ? hoveredLayerId : null;
      updateOutline(hoveredContainerRef.current, effectiveHoveredId, iframeDoc, iframeElement, containerElement, scale, HOVERED_OUTLINE_CLASS);
    }

    // When a sublayer is active, show the parent richText layer with parent outline
    const effectiveParentId = activeSublayerIndex !== null && activeSublayerIndex !== undefined
      ? selectedLayerId
      : (parentLayerId !== selectedLayerId ? parentLayerId : null);
    updateOutline(parentContainerRef.current, effectiveParentId, iframeDoc, iframeElement, containerElement, scale, PARENT_OUTLINE_CLASS);
  }, [iframeElement, containerElement, selectedLayerId, hoveredLayerId, parentLayerId, zoom, updateOutline, hideAllOutlines, activeSublayerIndex, activeListItemIndex]);

  // Initial update and updates when IDs change
  useEffect(() => {
    updateAllOutlines();
  }, [updateAllOutlines]);

  // Set up scroll/resize/mutation listeners
  useEffect(() => {
    if (!iframeElement || !containerElement) return;

    const iframeDoc = iframeElement.contentDocument;
    if (!iframeDoc) return;

    let scrollTimeout: ReturnType<typeof setTimeout> | null = null;

    // Hide outlines during scroll, show after scroll ends
    const handleScroll = () => {
      hideAllOutlines();

      // Clear existing timeout
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
      }

      // Show outlines after scrolling stops (150ms delay)
      scrollTimeout = setTimeout(() => {
        // Skip solid borders if dragging
        updateAllOutlines(isDraggingRef.current);
      }, 150);
    };

    // MutationObserver for DOM changes inside iframe
    let mutationTimeout: ReturnType<typeof setTimeout> | null = null;
    let mutationRafId: number | null = null;
    const mutationObserver = new MutationObserver((mutations) => {
      // Check if any mutation is a structural change (element added/removed)
      const hasStructuralChange = mutations.some(m => m.type === 'childList');

      if (hasStructuralChange) {
        hideAllOutlines();

        if (mutationTimeout) clearTimeout(mutationTimeout);

        // Show outlines after DOM settles
        mutationTimeout = setTimeout(() => {
          updateAllOutlines(isDraggingRef.current);
        }, 150);
      } else {
        // Attribute-only changes (class/style) - defer to next frame so
        // Tailwind Browser CDN has time to generate CSS for new classes
        // and the browser can reflow before we measure dimensions
        if (mutationRafId) cancelAnimationFrame(mutationRafId);
        mutationRafId = requestAnimationFrame(() => {
          mutationRafId = requestAnimationFrame(() => {
            updateAllOutlines(isDraggingRef.current);
            mutationRafId = null;
          });
        });
      }
    });

    // Observe the iframe body for changes
    if (iframeDoc.body) {
      mutationObserver.observe(iframeDoc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
    }

    // Hide outlines during viewport switch, show after transition settles
    let viewportTimeout: ReturnType<typeof setTimeout> | null = null;
    const handleViewportChange = () => {
      hideAllOutlines();

      if (viewportTimeout) clearTimeout(viewportTimeout);

      // Show outlines after viewport transition settles
      viewportTimeout = setTimeout(() => {
        updateAllOutlines(isDraggingRef.current);
      }, 150);
    };

    // Add event listeners
    containerElement.addEventListener('scroll', handleScroll, { passive: true });
    iframeDoc.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll, { passive: true });
    window.addEventListener('viewportChange', handleViewportChange);

    // Cleanup
    return () => {
      if (scrollTimeout) clearTimeout(scrollTimeout);
      if (viewportTimeout) clearTimeout(viewportTimeout);
      if (mutationTimeout) clearTimeout(mutationTimeout);
      if (mutationRafId) cancelAnimationFrame(mutationRafId);
      mutationObserver.disconnect();
      containerElement.removeEventListener('scroll', handleScroll);
      iframeDoc.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
      window.removeEventListener('viewportChange', handleViewportChange);
    };
  }, [iframeElement, containerElement, updateAllOutlines, hideAllOutlines]);

  // Check if layer dragging is active (to hide selection during drag)
  const isDraggingLayerOnCanvas = useEditorStore((state) => state.isDraggingLayerOnCanvas);

  // Hide solid selection/hover outlines during drag, but keep dashed parent outline
  useEffect(() => {
    isDraggingRef.current = isDraggingLayerOnCanvas;
    
    if (isDraggingLayerOnCanvas) {
      hideAllOutlines();
      updateAllOutlines(true); // skipSolidBorders = true, re-shows parent outline
    } else {
      // Re-show all outlines when drag ends
      updateAllOutlines(false);
    }
  }, [isDraggingLayerOnCanvas, updateAllOutlines, hideAllOutlines]);

  // Hide outlines during slider transitions
  const isSliderAnimating = useEditorStore((state) => state.isSliderAnimating);

  useEffect(() => {
    isSliderAnimatingRef.current = isSliderAnimating;
    if (isSliderAnimating) {
      hideAllOutlines();
    } else {
      updateAllOutlines();
    }
  }, [isSliderAnimating, updateAllOutlines, hideAllOutlines]);

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-40">
      {/* Parent outline container (dashed) - visible during drag */}
      <div ref={parentContainerRef} style={{ display: 'none' }} />

      {/* Hover outline container - hidden during drag */}
      <div ref={hoveredContainerRef} style={{ display: 'none' }} />

      {/* Selection outline container - hidden during drag */}
      <div ref={selectedContainerRef} style={{ display: 'none' }} />
    </div>
  );
}

export default SelectionOverlay;
