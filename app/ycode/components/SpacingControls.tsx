'use client';

import { useCallback, memo } from 'react';
import { Label } from '@/components/ui/label';
import { useDesignSync } from '@/hooks/use-design-sync';
import { useControlledInputs } from '@/hooks/use-controlled-input';
import { useEditorStore } from '@/stores/useEditorStore';
import { extractMeasurementValue } from '@/lib/measurement-utils';
import { removeSpaces } from '@/lib/utils';
import type { Layer } from '@/types';
import MarginPadding from './MarginPadding';

interface SpacingControlsProps {
  layer: Layer | null;
  onLayerUpdate: (layerId: string, updates: Partial<Layer>) => void;
  activeTextStyleKey?: string | null;
}

const SpacingControls = memo(function SpacingControls({ layer, onLayerUpdate, activeTextStyleKey }: SpacingControlsProps) {
  const { activeBreakpoint, activeUIState } = useEditorStore();
  const { debouncedUpdateDesignProperty, getDesignProperty } = useDesignSync({
    layer,
    onLayerUpdate,
    activeBreakpoint,
    activeUIState,
    activeTextStyleKey,
  });

  const marginTop = getDesignProperty('spacing', 'marginTop') || '';
  const marginRight = getDesignProperty('spacing', 'marginRight') || '';
  const marginBottom = getDesignProperty('spacing', 'marginBottom') || '';
  const marginLeft = getDesignProperty('spacing', 'marginLeft') || '';
  const paddingTop = getDesignProperty('spacing', 'paddingTop') || '';
  const paddingRight = getDesignProperty('spacing', 'paddingRight') || '';
  const paddingBottom = getDesignProperty('spacing', 'paddingBottom') || '';
  const paddingLeft = getDesignProperty('spacing', 'paddingLeft') || '';

  const inputs = useControlledInputs({
    marginTop,
    marginRight,
    marginBottom,
    marginLeft,
    paddingTop,
    paddingRight,
    paddingBottom,
    paddingLeft,
  }, extractMeasurementValue);

  const [marginTopInput, setMarginTopInput] = inputs.marginTop;
  const [marginRightInput, setMarginRightInput] = inputs.marginRight;
  const [marginBottomInput, setMarginBottomInput] = inputs.marginBottom;
  const [marginLeftInput, setMarginLeftInput] = inputs.marginLeft;
  const [paddingTopInput, setPaddingTopInput] = inputs.paddingTop;
  const [paddingRightInput, setPaddingRightInput] = inputs.paddingRight;
  const [paddingBottomInput, setPaddingBottomInput] = inputs.paddingBottom;
  const [paddingLeftInput, setPaddingLeftInput] = inputs.paddingLeft;

  type SpacingProperty = 'marginTop' | 'marginRight' | 'marginBottom' | 'marginLeft' | 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft';

  const setters: Record<SpacingProperty, (v: string) => void> = {
    marginTop: setMarginTopInput,
    marginRight: setMarginRightInput,
    marginBottom: setMarginBottomInput,
    marginLeft: setMarginLeftInput,
    paddingTop: setPaddingTopInput,
    paddingRight: setPaddingRightInput,
    paddingBottom: setPaddingBottomInput,
    paddingLeft: setPaddingLeftInput,
  };

  const handleChange = useCallback((property: SpacingProperty, value: string) => {
    setters[property](value);
    if (value === 'auto') {
      debouncedUpdateDesignProperty('spacing', property, 'auto');
    } else {
      const sanitized = removeSpaces(value);
      debouncedUpdateDesignProperty('spacing', property, sanitized || null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedUpdateDesignProperty]);

  return (
    <div className="py-5">
      <header className="py-4 -mt-4">
        <Label>Spacing</Label>
      </header>

      <MarginPadding
        values={{
          marginTop: marginTopInput,
          marginRight: marginRightInput,
          marginBottom: marginBottomInput,
          marginLeft: marginLeftInput,
          paddingTop: paddingTopInput,
          paddingRight: paddingRightInput,
          paddingBottom: paddingBottomInput,
          paddingLeft: paddingLeftInput,
        }}
        onChange={handleChange}
      />
    </div>
  );
});
export default SpacingControls;
