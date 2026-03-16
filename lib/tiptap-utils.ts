/**
 * Tiptap Utilities
 *
 * Shared utilities for working with Tiptap JSON content
 * Used by both client-side rendering (text-format-utils) and server-side (page-fetcher)
 */

/**
 * Extract inline nodes from nested Tiptap rich text content
 * Flattens paragraphs and preserves marks for inline rendering
 * @param content - Array of Tiptap nodes to extract from
 * @param parentMarks - Marks to inherit from parent nodes
 */
export function extractInlineNodesFromRichText(
  content: any[],
  parentMarks: any[] = []
): any[] {
  const result: any[] = [];

  for (const node of content) {
    if (node.type === 'text') {
      // Merge marks from parent with node marks
      const combinedMarks = [...parentMarks, ...(node.marks || [])];
      result.push({
        type: 'text',
        text: node.text,
        marks: combinedMarks.length > 0 ? combinedMarks : undefined,
      });
    } else if (node.type === 'paragraph') {
      // Preserve paragraph styling by adding a dynamicStyle mark
      const paragraphMark = { type: 'dynamicStyle', attrs: { styleKeys: ['paragraph'] } };
      const marksWithParagraph = [...parentMarks, paragraphMark];
      if (node.content && node.content.length > 0) {
        result.push(...extractInlineNodesFromRichText(node.content, marksWithParagraph));
      } else {
        // Empty paragraphs use non-breaking space to preserve the empty line
        result.push({
          type: 'text',
          text: '\u00A0',
          marks: marksWithParagraph,
        });
      }
      // Add space between paragraphs when flattening
      result.push({ type: 'text', text: ' ' });
    } else if (node.type === 'heading') {
      // Preserve heading styling by adding a dynamicStyle mark with the heading level
      const level = node.attrs?.level || 1;
      const headingMark = { type: 'dynamicStyle', attrs: { styleKeys: [`h${level}`] } };
      const marksWithHeading = [...parentMarks, headingMark];
      if (node.content && node.content.length > 0) {
        result.push(...extractInlineNodesFromRichText(node.content, marksWithHeading));
      } else {
        // Empty headings use non-breaking space to preserve the empty line
        result.push({
          type: 'text',
          text: '\u00A0',
          marks: marksWithHeading,
        });
      }
      // Add space after heading when flattening
      result.push({ type: 'text', text: ' ' });
    } else if (node.type === 'dynamicVariable') {
      // Preserve dynamic variables with combined marks
      result.push({
        ...node,
        marks: [...parentMarks, ...(node.marks || [])],
      });
    } else if (node.type === 'bulletList' || node.type === 'orderedList') {
      // Preserve list nodes as-is - they'll be rendered as block elements
      result.push({
        ...node,
        marks: parentMarks.length > 0 ? parentMarks : undefined,
      });
      result.push({ type: 'text', text: ' ' });
    } else if (node.type === 'richTextComponent') {
      // Preserve embedded component nodes as-is for block rendering
      result.push(node);
    } else if (node.type === 'listItem') {
      // List items should be handled by their parent list
      // But if we encounter one directly, extract its content
      if (node.content) {
        result.push(...extractInlineNodesFromRichText(node.content, parentMarks));
      }
    } else if (node.content) {
      // Recursively extract from other nodes with content
      result.push(...extractInlineNodesFromRichText(node.content, parentMarks));
    }
  }

  return result;
}

/**
 * Check if a value is a valid Tiptap doc structure
 */
export function isTiptapDoc(value: unknown): value is { type: 'doc'; content: any[] } {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as any).type === 'doc' &&
    Array.isArray((value as any).content)
  );
}

/**
 * Check if Tiptap JSON content contains block-level elements (lists)
 * These cannot be nested inside restrictive tags (p, h1-h6, span, a, button)
 */
export function contentHasBlockElements(content: any): boolean {
  if (!content || typeof content !== 'object') {
    return false;
  }

  // Handle Tiptap doc structure
  if (content.type === 'doc' && Array.isArray(content.content)) {
    return content.content.some((block: any) =>
      block.type === 'bulletList' || block.type === 'orderedList' || block.type === 'richTextComponent'
    );
  }

  return false;
}

/**
 * Value resolver function type for looking up field values
 */
export type FieldValueResolver = (fieldId: string, relationships?: string[], source?: string) => string | null | undefined;

/**
 * Check if rich text content contains block elements, including from inline variables
 * Uses a resolver function to look up field values, making it reusable for both
 * client-side (React) and server-side (HTML string) rendering
 *
 * @param content - Tiptap JSON content (doc structure)
 * @param resolveValue - Function to resolve field values by fieldId
 */
export function hasBlockElementsWithResolver(
  content: any,
  resolveValue: FieldValueResolver
): boolean {
  if (!content || typeof content !== 'object') {
    return false;
  }

  // Check direct content for lists
  if (contentHasBlockElements(content)) {
    return true;
  }

  if (content.type !== 'doc' || !Array.isArray(content.content)) {
    return false;
  }

  // Recursively check for dynamicVariable nodes that point to rich_text fields
  const checkNode = (node: any): boolean => {
    if (node.type === 'dynamicVariable') {
      const variable = node.attrs?.variable;
      if (variable?.type === 'field' && variable.data?.field_type === 'rich_text') {
        // rich_text CMS fields can contain block elements (lists, etc.) at any time,
        // and renderBlock uses <div> for paragraphs containing them, so the parent
        // must also be block-level to avoid <div> inside <p>
        return true;
      }
    }

    // Recursively check content arrays
    if (Array.isArray(node.content)) {
      return node.content.some(checkNode);
    }

    return false;
  };

  return content.content.some(checkNode);
}

/** Check if Tiptap JSON content contains a link mark or embedded component node. */
export function hasLinkOrComponent(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'richTextComponent') return true;
  if (node.marks?.some((m: any) => m.type === 'richTextLink')) return true;
  if (Array.isArray(node.content)) {
    return node.content.some(hasLinkOrComponent);
  }
  return false;
}

/** Extract the first CMS field binding from Tiptap JSON content (dynamicVariable node with type 'field'). */
export function getCmsFieldBinding(node: any): { field_id: string; label?: string; source?: 'page' | 'collection'; collection_layer_id?: string } | null {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'dynamicVariable') {
    const variable = node.attrs?.variable;
    if (variable?.type === 'field' && variable.data?.field_id) {
      return {
        field_id: variable.data.field_id,
        label: node.attrs?.label,
        source: variable.data.source,
        collection_layer_id: variable.data.collection_layer_id,
      };
    }
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      const result = getCmsFieldBinding(child);
      if (result) return result;
    }
  }
  return null;
}

/** Check if Tiptap JSON content contains components or inline variables (non-editable on canvas). */
export function hasComponentOrVariable(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'richTextComponent') return true;
  if (node.type === 'dynamicVariable') return true;
  if (Array.isArray(node.content)) {
    return node.content.some(hasComponentOrVariable);
  }
  return false;
}

/** Extract the rich-text content value from a layer's text variable. */
export function getRichTextValue(variables?: { text?: { type: string; data: { content: any } } }): any {
  const textVar = variables?.text;
  if (textVar?.type === 'dynamic_rich_text') return textVar.data.content;
  if (textVar?.type === 'dynamic_text') return textVar.data.content;
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

/**
 * Extract plain text from Tiptap JSON content
 * Useful for previews, search indexing, or fallback display
 */
export function extractPlainTextFromTiptap(content: any): string {
  if (!content || typeof content !== 'object') return '';

  let result = '';

  const extractFromNode = (node: any): void => {
    if (node.type === 'text' && node.text) {
      result += node.text;
    } else if (node.type === 'dynamicVariable' && node.attrs?.label) {
      result += `[${node.attrs.label}]`;
    } else if (node.type === 'paragraph') {
      if (result.length > 0 && !result.endsWith(' ')) {
        result += ' ';
      }
      if (Array.isArray(node.content)) {
        node.content.forEach(extractFromNode);
      }
    } else if (Array.isArray(node.content)) {
      node.content.forEach(extractFromNode);
    }
  };

  if (content.type === 'doc' && Array.isArray(content.content)) {
    content.content.forEach(extractFromNode);
  } else if (Array.isArray(content)) {
    content.forEach(extractFromNode);
  } else {
    extractFromNode(content);
  }

  return result.trim();
}
