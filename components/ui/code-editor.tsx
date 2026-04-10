'use client';

import React, { useInsertionEffect } from 'react';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/components/prism-markup';
import { cn } from '@/lib/utils';

interface CodeEditorProps {
  value: string;
  onValueChange?: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}

function highlightHtml(code: string): string {
  return Prism.highlight(code, Prism.languages.markup, 'markup');
}

const STYLE_ID = 'code-editor-prism-theme';
const prismCss = `
.code-editor-root .token.tag { color: #e06c75; }
.code-editor-root .token.attr-name { color: #d19a66; }
.code-editor-root .token.attr-value { color: #98c379; }
.code-editor-root .token.punctuation { color: #abb2bf; }
.code-editor-root .token.comment { color: #5c6370; font-style: italic; }
.code-editor-root .token.entity { color: #d19a66; }
.code-editor-root .token.doctype { color: #5c6370; }
.code-editor-root .token.prolog { color: #5c6370; }
.code-editor-root .token.cdata { color: #5c6370; }
`;

let styleInjected = false;
function ensurePrismStyles() {
  if (styleInjected) return;
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) { styleInjected = true; return; }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = prismCss;
  document.head.appendChild(style);
  styleInjected = true;
}

const noop = () => {};

export function CodeEditor({
  value,
  onValueChange,
  readOnly = false,
  placeholder = '',
  className,
  autoFocus = false,
}: CodeEditorProps) {
  useInsertionEffect(ensurePrismStyles, []);

  return (
    <div
      className={cn(
        'code-editor-root rounded-lg border border-transparent bg-input overflow-auto font-mono text-xs',
        readOnly && 'cursor-default',
        className,
      )}
    >
      <Editor
        value={value}
        onValueChange={onValueChange ?? noop}
        highlight={highlightHtml}
        padding={12}
        readOnly={readOnly}
        placeholder={placeholder}
        autoFocus={autoFocus}
        textareaClassName="outline-none !min-h-[inherit]"
        preClassName="!min-h-[inherit]"
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: '11px',
          lineHeight: '1.6',
          minHeight: 'inherit',
        }}
      />
    </div>
  );
}
