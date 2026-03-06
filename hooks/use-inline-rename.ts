import { useState, useCallback } from 'react';

interface UseInlineRenameOptions {
  onSubmit: (id: string, value: string) => void | Promise<void>;
}

/**
 * Manages inline rename state (which item is being renamed and its current value).
 * Pairs with the InlineRenameInput component.
 */
export function useInlineRename({ onSubmit }: UseInlineRenameOptions) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const startRename = useCallback((id: string, currentName: string) => {
    setRenamingId(id);
    setRenameValue(currentName);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameValue('');
  }, []);

  const submitRename = useCallback(async () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null);
      setRenameValue('');
      return;
    }

    try {
      await onSubmit(renamingId, renameValue.trim());
    } catch (error) {
      console.error('Failed to rename:', error);
    }

    setRenamingId(null);
    setRenameValue('');
  }, [renamingId, renameValue, onSubmit]);

  return {
    renamingId,
    renameValue,
    setRenamingId,
    setRenameValue,
    startRename,
    cancelRename,
    submitRename,
  };
}
