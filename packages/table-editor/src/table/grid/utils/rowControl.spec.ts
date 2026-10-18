import { describe, expect, it } from 'vitest';

import { getRowControlOffsetY } from './rowControl';

describe('getRowControlOffsetY', () => {
  it('centers row controls for every supported row height', () => {
    expect(getRowControlOffsetY(32, 16)).toBe(8);
    expect(getRowControlOffsetY(40, 16)).toBe(12);
    expect(getRowControlOffsetY(56, 16)).toBe(20);
    expect(getRowControlOffsetY(88, 16)).toBe(36);
  });

  it('keeps oversized controls inside the row origin', () => {
    expect(getRowControlOffsetY(12, 16)).toBe(0);
  });
});
