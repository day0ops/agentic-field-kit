import { test, expect, describe } from 'bun:test';
import {
  WINDOW_THRESHOLD,
  MAX_VIEWPORT_SIZE,
  computeViewportSize,
  computeScrollTop,
} from '../../src/lib/prompts.js';

describe('WINDOW_THRESHOLD', () => {
  test('is 30', () => {
    expect(WINDOW_THRESHOLD).toBe(30);
  });
});

describe('MAX_VIEWPORT_SIZE', () => {
  test('is 25', () => {
    expect(MAX_VIEWPORT_SIZE).toBe(25);
  });
});

describe('computeViewportSize', () => {
  test('returns totalLines when it fits in the terminal', () => {
    expect(computeViewportSize(5, 40, 6)).toBe(5);
  });

  test('clips to available terminal rows minus overhead', () => {
    expect(computeViewportSize(200, 25, 6)).toBe(19);
  });

  test('never exceeds MAX_VIEWPORT_SIZE even on a very tall terminal', () => {
    expect(computeViewportSize(200, 60, 6)).toBe(25);
  });

  test('never goes below a floor of 10 rows even on a tiny terminal', () => {
    expect(computeViewportSize(200, 12, 6)).toBe(10);
  });

  test('falls back to a 24-row terminal when terminalRows is falsy', () => {
    expect(computeViewportSize(200, 0, 6)).toBe(18);
    expect(computeViewportSize(200, undefined, 6)).toBe(18);
  });
});

describe('computeScrollTop', () => {
  test('stays at 0 when everything fits in the viewport', () => {
    expect(computeScrollTop(0, 9, 10, 10)).toBe(0);
  });

  test('does not move while the active line stays inside the current window', () => {
    expect(computeScrollTop(5, 10, 100, 10)).toBe(5);
  });

  test('jumps up to the active line when it moves above the window', () => {
    expect(computeScrollTop(20, 15, 100, 10)).toBe(15);
  });

  test('advances just enough to keep the active line as the last visible row', () => {
    // window [20,30), active line moves to 30 -> window must become [21,31)
    expect(computeScrollTop(20, 30, 100, 10)).toBe(21);
  });

  test('clamps so the window never scrolls past the end of the list', () => {
    expect(computeScrollTop(85, 99, 100, 10)).toBe(90);
  });
});
