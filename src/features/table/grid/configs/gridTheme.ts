   
                                       
  
                                                                    
                                  
  
                                            
                                                                           
                                                            
                         
                                                                 
                                
   
import colors from 'tailwindcss/colors';
import { hexToRGBA } from '../utils';

export interface IGridTheme {
  staticWhite: string;
  staticBlack: string;
  iconBgCommon: string;
  iconFgCommon: string;
  iconFgHighlight: string;
  iconBgHighlight: string;
  iconBgSelected: string;
  iconFgSelected: string;
  iconSizeXS: number;
  iconSizeSM: number;
  iconSizeMD: number;
  iconSizeLG: number;
  fontSizeXXS: number;
  fontSizeXS: number;
  fontSizeSM: number;
  fontSizeMD: number;
  fontSizeLG: number;
  fontFamily: string;
  cellBg: string;
  cellBgHovered: string;
  cellBgSelected: string;
  cellBgLoading: string;
  cellLineColor: string;
  cellLineColorActived: string;
  cellTextColor: string;
  cellTextColorHighlight: string;
  cellOptionBg: string;
  cellOptionBgHighlight: string;
  cellOptionTextColor: string;
  groupHeaderBgPrimary: string;
  groupHeaderBgSecondary: string;
  groupHeaderBgTertiary: string;
  columnHeaderBg: string;
  columnHeaderBgHovered: string;
  columnHeaderBgSelected: string;
  columnHeaderNameColor: string;
  columnResizeHandlerBg: string;
  columnFreezeHandlerBg: string;
  columnDraggingPlaceholderBg: string;
  columnStatisticBgHoveredPrimary: string;
  columnStatisticBgHoveredSecondary: string;
  columnStatisticBgHoveredTertiary: string;
  rowHeaderTextColor: string;
  appendRowBg: string;
  appendRowBgHovered: string;
  avatarBg: string;
  avatarTextColor: string;
  avatarSizeXS: number;
  avatarSizeSM: number;
  avatarSizeMD: number;
  themeKey: string;
  scrollBarBg: string;
  interactionLineColorCommon: string;
  interactionLineColorHighlight: string;
  searchCursorBg: string;
  searchTargetIndexBg: string;
  commentCountBg: string;
  commentCountTextColor: string;
}

export const lightGridTheme: IGridTheme = {
  // Common
  staticWhite: '#FFFFFF',
  staticBlack: '#000000',
  iconFgCommon: colors.gray[500],
  iconBgCommon: colors.transparent,
  iconFgHighlight: colors.yellow[400],
  iconBgHighlight: colors.yellow[400],
  iconFgSelected: '#FFFFFF',
  iconBgSelected: '#5645d4',
  iconSizeXS: 16,
  iconSizeSM: 20,
  iconSizeMD: 24,
  iconSizeLG: 32,
  fontSizeXXS: 10,
  fontSizeXS: 12,
  fontSizeSM: 13,
  fontSizeMD: 14,
  fontSizeLG: 16,
  fontFamily:
    'Inter, Roboto, -apple-system, BlinkMacSystemFont, avenir next, avenir, segoe ui, helvetica neue, helvetica, Ubuntu, noto, arial, sans-serif',

  // Cell
  cellBg: colors.white,
  cellBgHovered: '#F7F7F7',
  cellBgSelected: '#F0F0F0',
  cellBgLoading: hexToRGBA(colors.black, 0.04),
  cellLineColor: colors.zinc[200],
  cellLineColorActived: '#5645d4',
  cellTextColor: colors.zinc[900],
  cellTextColorHighlight: colors.violet[500],
  cellOptionBg: colors.gray[300],
  cellOptionBgHighlight: colors.zinc[200],
  cellOptionTextColor: colors.black,

  // Group Header
  groupHeaderBgPrimary: '#FAFAFA',
  groupHeaderBgSecondary: '#F4F4F5',
  groupHeaderBgTertiary: '#EAEAEB',

  // Column Statistic
  columnStatisticBgHoveredPrimary: '#F2F2F2',
  columnStatisticBgHoveredSecondary: '#EDECEC',
  columnStatisticBgHoveredTertiary: '#E3E2E2',

  // Column Header
  columnHeaderBg: colors.zinc[50],
  columnHeaderBgHovered: colors.zinc[100],
  columnHeaderBgSelected: colors.zinc[200],
  columnHeaderNameColor: colors.zinc[900],
  columnResizeHandlerBg: colors.blue[500],
  columnFreezeHandlerBg: '#5645d4',
  columnDraggingPlaceholderBg: hexToRGBA(colors.black, 0.2),

  // Row Header
  rowHeaderTextColor: colors.zinc[500],

  // Append Row
  appendRowBg: colors.zinc[50],
  appendRowBgHovered: colors.zinc[100],

  // Avatar Theme
  avatarBg: colors.gray[100],
  avatarTextColor: colors.gray[950],
  avatarSizeXS: 16,
  avatarSizeSM: 20,
  avatarSizeMD: 24,

  themeKey: 'light',

  // ScrollBar
  scrollBarBg: colors.gray[400],

  // interaction
  interactionLineColorCommon: colors.zinc[300],
  interactionLineColorHighlight: colors.blue[500],

  // search cursor
  searchCursorBg: colors.blue[300],
  searchTargetIndexBg: colors.blue[100],

  // comment
  commentCountBg: colors.orange[400],
  commentCountTextColor: colors.white,
};

// Token-backed dark values are read live from `:root` so the canvas theme
// tracks styles.css `.dark { … }` instead of duplicating its HSL triples.
// Canvas can't resolve `hsl(var(--x))`, so we read the raw triple ("222 18% 7%")
// off the computed style and wrap it into a color string. The fallbacks below
// are only used pre-mount / SSR and mirror the dark tokens in styles.css.
const DARK_TOKEN_FALLBACK: Record<string, string> = {
  '--background': '222 18% 7%',
  '--foreground': '210 14% 94%',
  '--card': '222 16% 11%',
  '--muted': '222 12% 15%',
  '--muted-foreground': '215 10% 70%',
  '--accent': '248 30% 22%',
  '--border': '222 12% 20%',
  '--hairline-soft': '222 12% 24%',
  '--primary': '248 62% 70%',
}

function tripleToHsl(triple: string): string {
  const parts = triple.trim().split(/\s+/)
  if (parts.length < 3) return triple
  return `hsl(${parts[0]}, ${parts[1]}, ${parts[2]})`
}

function readDarkToken(name: keyof typeof DARK_TOKEN_FALLBACK): string {
  const fallback = DARK_TOKEN_FALLBACK[name]
  if (typeof document === 'undefined') return tripleToHsl(fallback)
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return tripleToHsl(raw || fallback)
}

function buildDarkGridTheme(): IGridTheme {
  const dark = {
    background: readDarkToken('--background'),
    foreground: readDarkToken('--foreground'),
    card: readDarkToken('--card'),
    muted: readDarkToken('--muted'),
    mutedFg: readDarkToken('--muted-foreground'),
    accent: readDarkToken('--accent'),
    border: readDarkToken('--border'),
    hairlineSoft: readDarkToken('--hairline-soft'),
    primary: readDarkToken('--primary'),
  }

  return {
    ...lightGridTheme,
    themeKey: 'dark',

    // Cell
    cellBg:               dark.background,            // Match the main surface to avoid bright cell blocks.
    cellBgHovered:        'hsla(222, 12%, 50%, 0.12)',
    cellBgSelected:       'hsla(248, 30%, 50%, 0.28)',
    cellBgLoading:        'hsla(0, 0%, 100%, 0.04)',
    cellLineColor:        dark.hairlineSoft,
    cellLineColorActived: dark.primary,
    cellTextColor:        dark.foreground,
    cellTextColorHighlight: dark.primary,
    cellOptionBg:         'hsla(222, 12%, 40%, 0.4)',
    cellOptionBgHighlight: 'hsla(222, 12%, 50%, 0.5)',
    cellOptionTextColor:  dark.foreground,

    // Group Header
    groupHeaderBgPrimary:   'hsla(222, 12%, 22%, 0.6)',
    groupHeaderBgSecondary: 'hsla(222, 12%, 22%, 0.4)',
    groupHeaderBgTertiary:  'hsla(222, 12%, 22%, 0.25)',

    // Column Statistic
    columnStatisticBgHoveredPrimary:   'hsla(222, 12%, 22%, 0.55)',
    columnStatisticBgHoveredSecondary: 'hsla(222, 12%, 22%, 0.4)',
    columnStatisticBgHoveredTertiary:  'hsla(222, 12%, 22%, 0.25)',

    // Column Header
    columnHeaderBg:           dark.card,
    columnHeaderBgHovered:    'hsla(222, 12%, 22%, 0.7)',
    columnHeaderBgSelected:   dark.accent,
    columnHeaderNameColor:    dark.foreground,
    columnResizeHandlerBg:    dark.primary,
    columnFreezeHandlerBg:    dark.primary,
    columnDraggingPlaceholderBg: 'hsla(0, 0%, 100%, 0.18)',

    // Row Header
    rowHeaderTextColor: dark.mutedFg,

    // Append Row — match cellBg so the trailing "+ row" doesn't read as a glowing bar
    appendRowBg:        dark.background,
    appendRowBgHovered: 'hsla(222, 12%, 22%, 0.5)',

    // Avatar
    avatarBg:        'hsla(222, 12%, 30%, 0.6)',
    avatarTextColor: dark.foreground,

    // ScrollBar — match the global *::-webkit-scrollbar-thumb dark color
    scrollBarBg: 'hsla(215, 14%, 32%, 0.55)',

    // Interaction
    interactionLineColorCommon:    dark.border,
    interactionLineColorHighlight: dark.primary,

    // Search cursor / target — brand purple at low alpha so it reads on dark
    searchCursorBg:      'hsla(248, 62%, 60%, 0.55)',
    searchTargetIndexBg: 'hsla(248, 62%, 60%, 0.22)',

    // Comment
    commentCountBg:        'hsla(28, 80%, 60%, 0.7)',
    commentCountTextColor: dark.foreground,

    // Static icon contrasts — dark theme prefers light icon foreground
    iconFgCommon:    dark.mutedFg,
    iconFgSelected:  dark.background,
    iconBgSelected:  dark.primary,
  }
}

// Back-compat: existing call sites import { gridTheme } from './configs'.
// Keep it pointing at light so they continue to work without churn.
export const gridTheme = lightGridTheme;

// Build the canvas theme for the current mode. In dark mode the theme is read
// live from the `.dark` CSS tokens (must be called after the class is applied),
// so it stays in sync with styles.css automatically.
export function getGridTheme(isDark: boolean): IGridTheme {
  return isDark ? buildDarkGridTheme() : lightGridTheme;
}
