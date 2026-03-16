'use client';

import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useEditorStore } from '@/stores/useEditorStore';
import type { UIState, Layer } from '@/types';

interface UIStateSelectorProps {
  selectedLayer: Layer | null;
}

export default function UIStateSelector({ selectedLayer }: UIStateSelectorProps) {
  const { activeUIState, setActiveUIState } = useEditorStore();

  // Determine which states are applicable for the current layer
  const isDisabledApplicable = () => {
    if (!selectedLayer) return false;
    const applicableTypes = ['button', 'input', 'textarea', 'select', 'slideButtonPrev', 'slideButtonNext'];
    return applicableTypes.includes(selectedLayer.name || '');
  };

  const isCurrentApplicable = () => {
    if (!selectedLayer) return false;
    const applicableTypes = ['link', 'a', 'navigation', 'slideBullet'];
    return applicableTypes.includes(selectedLayer.name || '');
  };

  return (
    <div className="sticky -top-2 bg-background z-30 py-4 flex flex-row gap-2">
      <Select value={activeUIState} onValueChange={(value) => setActiveUIState(value as UIState)}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select..." />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectGroup>
            <SelectItem value="neutral">Neutral</SelectItem>
            <SelectItem value="hover">Hover</SelectItem>
            <SelectItem value="focus">Focus</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="disabled" disabled={!isDisabledApplicable()}>
              Disabled
            </SelectItem>
            <SelectItem value="current" disabled={!isCurrentApplicable()}>
              Current
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
