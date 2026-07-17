import { describe, expect, it } from 'vitest';
import { applyBudget, budgetItems, truncationFooter } from './renderShared';

describe('renderShared', () => {
  it('budgetItems always includes the first item even when oversized', () => {
    const { blocks, included } = budgetItems(['x'.repeat(10_000), 'y'], (s) => s, 10);
    expect(included).toBe(1);
    expect(blocks).toHaveLength(1);
  });

  it('budgetItems stops when the budget is exhausted', () => {
    const items = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
    const { included } = budgetItems(items, (s) => s, 20); // 40 chars ≈ 10 tokens each
    expect(included).toBe(2);
  });

  it('truncationFooter includes the next offset when given', () => {
    expect(truncationFooter(5, 'result', 12)).toContain('offset=12');
    expect(truncationFooter(5, 'line')).toContain('token budget reached');
  });

  it('applyBudget appends an omitted-lines footer when truncating', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(80)}`);
    const result = applyBudget(lines, 50);
    expect(result.text).toContain('omitted');
  });

  it('applyBudget leaves short output untouched', () => {
    const result = applyBudget(['a', 'b'], 1500);
    expect(result.text).toBe('a\nb');
  });
});
