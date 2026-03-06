'use client';

import React from 'react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface InlineRenameInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  variant?: 'rename' | 'rename-selected';
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}

/** Inline input for renaming items in lists/trees. Submits on Enter/blur, cancels on Escape. */
export const InlineRenameInput = React.forwardRef<HTMLInputElement, InlineRenameInputProps>(
  function InlineRenameInput(
    {
      value,
      onChange,
      onSubmit,
      onCancel,
      variant = 'rename-selected',
      placeholder,
      className,
      autoFocus = true,
    },
    ref
  ) {
    return (
      <Input
        ref={ref}
        variant={variant}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            onSubmit();
          } else if (e.key === 'Escape') {
            onCancel();
          }
        }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={onSubmit}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className={cn('grow mr-2', className)}
      />
    );
  }
);
