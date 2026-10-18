// Small grid-specific helpers kept local to the canvas renderer.

export enum Colors {
  BlueLight2 = 'blueLight2',
  BlueLight1 = 'blueLight1',
  BlueBright = 'blueBright',
  Blue = 'blue',
  BlueDark1 = 'blueDark1',

  CyanLight2 = 'cyanLight2',
  CyanLight1 = 'cyanLight1',
  CyanBright = 'cyanBright',
  Cyan = 'cyan',
  CyanDark1 = 'cyanDark1',

  GrayLight2 = 'grayLight2',
  GrayLight1 = 'grayLight1',
  GrayBright = 'grayBright',
  Gray = 'gray',
  GrayDark1 = 'grayDark1',

  GreenLight2 = 'greenLight2',
  GreenLight1 = 'greenLight1',
  GreenBright = 'greenBright',
  Green = 'green',
  GreenDark1 = 'greenDark1',

  OrangeLight2 = 'orangeLight2',
  OrangeLight1 = 'orangeLight1',
  OrangeBright = 'orangeBright',
  Orange = 'orange',
  OrangeDark1 = 'orangeDark1',

  PinkLight2 = 'pinkLight2',
  PinkLight1 = 'pinkLight1',
  PinkBright = 'pinkBright',
  Pink = 'pink',
  PinkDark1 = 'pinkDark1',

  PurpleLight2 = 'purpleLight2',
  PurpleLight1 = 'purpleLight1',
  PurpleBright = 'purpleBright',
  Purple = 'purple',
  PurpleDark1 = 'purpleDark1',

  RedLight2 = 'redLight2',
  RedLight1 = 'redLight1',
  RedBright = 'redBright',
  Red = 'red',
  RedDark1 = 'redDark1',

  TealLight2 = 'tealLight2',
  TealLight1 = 'tealLight1',
  TealBright = 'tealBright',
  Teal = 'teal',
  TealDark1 = 'tealDark1',

  YellowLight2 = 'yellowLight2',
  YellowLight1 = 'yellowLight1',
  YellowBright = 'yellowBright',
  Yellow = 'yellow',
  YellowDark1 = 'yellowDark1',
}

const rgbTuplesByColor: Record<string, [number, number, number]> = {
  [Colors.BlueBright]: [0, 123, 255],
  [Colors.BlueDark1]: [0, 63, 135],
  [Colors.BlueLight1]: [153, 204, 255],
  [Colors.BlueLight2]: [204, 229, 255],
  [Colors.Blue]: [0, 102, 204],

  [Colors.CyanBright]: [0, 188, 212],
  [Colors.CyanDark1]: [0, 96, 100],
  [Colors.CyanLight1]: [153, 228, 236],
  [Colors.CyanLight2]: [204, 244, 248],
  [Colors.Cyan]: [0, 151, 167],

  [Colors.GrayBright]: [160, 160, 160],
  [Colors.GrayDark1]: [80, 80, 80],
  [Colors.GrayLight1]: [220, 220, 220],
  [Colors.GrayLight2]: [245, 245, 245],
  [Colors.Gray]: [128, 128, 128],

  [Colors.GreenBright]: [40, 167, 69],
  [Colors.GreenDark1]: [20, 83, 35],
  [Colors.GreenLight1]: [144, 238, 144],
  [Colors.GreenLight2]: [204, 255, 204],
  [Colors.Green]: [30, 130, 76],

  [Colors.OrangeBright]: [255, 159, 0],
  [Colors.OrangeDark1]: [204, 85, 0],
  [Colors.OrangeLight1]: [255, 204, 153],
  [Colors.OrangeLight2]: [255, 229, 204],
  [Colors.Orange]: [250, 128, 0],

  [Colors.PinkBright]: [255, 64, 123],
  [Colors.PinkDark1]: [194, 24, 91],
  [Colors.PinkLight1]: [255, 182, 193],
  [Colors.PinkLight2]: [255, 224, 230],
  [Colors.Pink]: [255, 20, 147],

  [Colors.PurpleBright]: [155, 89, 182],
  [Colors.PurpleDark1]: [102, 51, 153],
  [Colors.PurpleLight1]: [204, 153, 255],
  [Colors.PurpleLight2]: [229, 204, 255],
  [Colors.Purple]: [128, 0, 128],

  [Colors.RedBright]: [241, 86, 70],
  [Colors.RedDark1]: [163, 10, 10],
  [Colors.RedLight1]: [255, 163, 163],
  [Colors.RedLight2]: [255, 214, 214],
  [Colors.Red]: [217, 10, 25],

  [Colors.TealBright]: [0, 150, 136],
  [Colors.TealDark1]: [0, 75, 68],
  [Colors.TealLight1]: [128, 203, 196],
  [Colors.TealLight2]: [178, 235, 242],
  [Colors.Teal]: [0, 121, 107],

  [Colors.YellowBright]: [255, 212, 59],
  [Colors.YellowDark1]: [250, 176, 5],
  [Colors.YellowLight1]: [255, 236, 153],
  [Colors.YellowLight2]: [255, 243, 191],
  [Colors.Yellow]: [252, 196, 25],
}

interface IRGB { r: number; g: number; b: number }

export const ColorUtils = {
  getHexForColor(colorString: string): string | null {
    const tuple = rgbTuplesByColor[colorString]
    if (!tuple) return null
    const hexNumber = (tuple[0] << 16) | (tuple[1] << 8) | tuple[2]
    return `#${hexNumber.toString(16).padStart(6, '0')}`
  },
  getRgbForColor(colorString: string): IRGB | null {
    const tuple = rgbTuplesByColor[colorString]
    if (!tuple) return null
    return { r: tuple[0], g: tuple[1], b: tuple[2] }
  },
  getRgbaStringForColor(colorString: string, alpha = 1): string | null {
    const rgb = ColorUtils.getRgbForColor(colorString)
    if (!rgb) return null
    return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`
  },
  shouldUseLightTextOnColor(colorString: string): boolean {
    if (!(colorString in rgbTuplesByColor)) return false
    const useDark = colorString.endsWith('Light1') || colorString.endsWith('Light2')
    return !useDark
  },
}

// Pure hex lighten / darken — replaces the `color` npm package dependency.
// `amount` is in [0, 1]. Same semantics as Color(...).lighten/darken approximated.
const clamp = (value: number, min = 0, max = 255) => Math.min(max, Math.max(min, value))

const parseHex = (hex: string): [number, number, number] => {
  const trimmed = hex.replace('#', '').trim()
  const value =
    trimmed.length === 3
      ? trimmed.split('').map((ch) => ch + ch).join('')
      : trimmed.padEnd(6, '0').slice(0, 6)
  const num = parseInt(value, 16)
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff]
}

const toHex = (r: number, g: number, b: number) => {
  const n = (clamp(r) << 16) | (clamp(g) << 8) | clamp(b)
  return `#${n.toString(16).padStart(6, '0')}`
}

const lighten = (hex: string, ratio: number) => {
  const [r, g, b] = parseHex(hex)
  return toHex(r + (255 - r) * ratio, g + (255 - g) * ratio, b + (255 - b) * ratio)
}

const darken = (hex: string, ratio: number) => {
  const [r, g, b] = parseHex(hex)
  return toHex(r * (1 - ratio), g * (1 - ratio), b * (1 - ratio))
}

export const contractColorForTheme = (color: string, theme: string | undefined): string => {
  if (!color || !color.startsWith('#')) return color
  return theme === 'light' ? darken(color, 0.5) : lighten(color, 0.5)
}

const RANDOM_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function getRandomString(len: number): string {
  let out = ''
  for (let i = 0; i < len; i += 1) {
    out += RANDOM_CHARS.charAt(Math.floor(Math.random() * RANDOM_CHARS.length))
  }
  return out
}

export type IButtonFieldOptions = {
  label: string
  color: Colors
  maxCount?: number
  resetCount?: boolean
  workflow?: { id?: string; name?: string; isActive?: boolean } | null
  confirm?: { title?: string; description?: string; confirmText?: string } | null
}

export type IButtonFieldCellValue = {
  count: number
}
