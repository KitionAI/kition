import { describe, expect, it } from 'vitest';

import { RegionType } from '../interface';
import { isClickInPressedRegion } from './region';

describe('isClickInPressedRegion', () => {
  it('keeps a click on the cell its mousedown just made active', () => {
    // The mousedown activates the cell, so the click lands on the active cell it pressed.
    expect(isClickInPressedRegion(RegionType.Cell, RegionType.ActiveCell)).toBe(true);
    expect(isClickInPressedRegion(RegionType.ActiveCell, RegionType.Cell)).toBe(true);
  });

  it('keeps a click released in the region it was pressed in', () => {
    expect(isClickInPressedRegion(RegionType.Cell, RegionType.Cell)).toBe(true);
    expect(isClickInPressedRegion(RegionType.ColumnHeader, RegionType.ColumnHeader)).toBe(true);
  });

  it('drops a click that moved to another kind of region between press and release', () => {
    expect(isClickInPressedRegion(RegionType.ColumnHeader, RegionType.Cell)).toBe(false);
    expect(isClickInPressedRegion(RegionType.Cell, RegionType.AppendRow)).toBe(false);
    expect(isClickInPressedRegion(RegionType.None, RegionType.ActiveCell)).toBe(false);
  });
});
