import { describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, commit, initHistory, move, redo, undo } from './builder-history';

describe('builder history', () => {
  it('undoes and redoes in order, and a new edit clears redo', () => {
    let h = initHistory('a');
    h = commit(h, 'b');
    h = commit(h, 'c');
    h = undo(h);
    expect(h.present).toBe('b');
    h = undo(h);
    expect(h.present).toBe('a');
    expect(undo(h)).toBe(h);
    h = redo(h);
    expect(h.present).toBe('b');
    h = commit(h, 'd');
    expect(h.future).toEqual([]);
    expect(redo(h)).toBe(h);
  });

  it('ignores no-op commits and caps the history', () => {
    const h0 = initHistory(0);
    expect(commit(h0, 0)).toBe(h0);
    let h = h0;
    for (let i = 1; i <= HISTORY_LIMIT + 10; i++) h = commit(h, i);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
  });
});

describe('move', () => {
  it('moves items and clamps at the ends', () => {
    expect(move(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(move(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    const list = ['a', 'b'];
    expect(move(list, 0, -1)).toBe(list);
    expect(move(list, 5, 1)).toBe(list);
  });
});
