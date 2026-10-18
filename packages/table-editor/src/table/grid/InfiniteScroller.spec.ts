import { describe, expect, it } from 'vitest';

import { getHorizontalScrollerGeometry } from './InfiniteScroller';

describe('getHorizontalScrollerGeometry', () => {
  it('aligns the horizontal scrollbar with the left edge of the grid viewport', () => {
    expect(getHorizontalScrollerGeometry(1200, 1800, 112)).toEqual({
      left: 0,
      viewportWidth: 1200,
      contentWidth: 1912,
    });
  });

  it('preserves the maximum horizontal scroll distance after removing the inset', () => {
    const containerWidth = 1200;
    const scrollWidth = 1800;
    const contentInset = 112;
    const geometry = getHorizontalScrollerGeometry(containerWidth, scrollWidth, contentInset);
    const previousMaximum = scrollWidth - (containerWidth - contentInset);
    const nextMaximum = geometry.contentWidth - geometry.viewportWidth;

    expect(nextMaximum).toBe(previousMaximum);
  });
});
