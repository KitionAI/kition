import { describe, expect, it } from 'vitest';

import { getGridTheme, lightGridTheme } from '../configs';
import { resolveSelectChoiceColors } from './selectChoiceColors';

describe('resolveSelectChoiceColors', () => {
  it('resolves configured tones for light and dark grid themes', () => {
    const choice = { id: 'Ready', name: 'Ready', tone: 'red' };

    expect(resolveSelectChoiceColors(choice, lightGridTheme)).toEqual({
      backgroundColor: '#ffe4e6',
      color: '#9f1239',
    });
    expect(resolveSelectChoiceColors(choice, getGridTheme(true))).toEqual({
      backgroundColor: '#881337',
      color: '#fecdd3',
    });
  });

  it('preserves explicit choice colors and falls back to the grid theme', () => {
    expect(resolveSelectChoiceColors({
      id: 'Custom',
      name: 'Custom',
      backgroundColor: '#123456',
      color: '#ffffff',
    }, lightGridTheme)).toEqual({
      backgroundColor: '#123456',
      color: '#ffffff',
    });

    expect(resolveSelectChoiceColors(undefined, lightGridTheme)).toEqual({
      backgroundColor: lightGridTheme.cellOptionBg,
      color: lightGridTheme.cellOptionTextColor,
    });
  });
});
