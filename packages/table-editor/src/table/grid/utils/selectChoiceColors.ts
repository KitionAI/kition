import type { IGridTheme } from '../configs';
import type { ISelectChoice } from '../renderers';

type SelectChoicePalette = Record<
  string,
  {
    light: { backgroundColor: string; color: string };
    dark: { backgroundColor: string; color: string };
  }
>;

const selectChoicePalette: SelectChoicePalette = {
  green: {
    light: { backgroundColor: '#d1fae5', color: '#065f46' },
    dark: { backgroundColor: '#064e3b', color: '#a7f3d0' },
  },
  blue: {
    light: { backgroundColor: '#e0f2fe', color: '#075985' },
    dark: { backgroundColor: '#0c4a6e', color: '#bae6fd' },
  },
  yellow: {
    light: { backgroundColor: '#fef3c7', color: '#92400e' },
    dark: { backgroundColor: '#78350f', color: '#fde68a' },
  },
  red: {
    light: { backgroundColor: '#ffe4e6', color: '#9f1239' },
    dark: { backgroundColor: '#881337', color: '#fecdd3' },
  },
  purple: {
    light: { backgroundColor: '#e6e0f5', color: '#5b21b6' },
    dark: { backgroundColor: '#4c1d95', color: '#ddd6fe' },
  },
  gray: {
    light: { backgroundColor: '#e4e4e7', color: '#27272a' },
    dark: { backgroundColor: '#3f3f46', color: '#f4f4f5' },
  },
};

export function resolveSelectChoiceColors(
  choice: ISelectChoice | undefined,
  theme: IGridTheme,
) {
  const mode = theme.themeKey === 'dark' ? 'dark' : 'light';
  const toneColors = choice?.tone ? selectChoicePalette[choice.tone]?.[mode] : undefined;

  return {
    backgroundColor: choice?.backgroundColor ?? toneColors?.backgroundColor ?? theme.cellOptionBg,
    color: choice?.color ?? toneColors?.color ?? theme.cellOptionTextColor,
  };
}
