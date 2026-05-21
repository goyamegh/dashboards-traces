/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getCategoryFromLabels,
  getDifficultyFromLabels,
  getSubcategoryFromLabels,
  migrateLegacyFieldsToLabels,
  hasLabelPrefix,
} from '@/lib/testCaseLabels';

describe('testCaseLabels', () => {
  describe('getCategoryFromLabels', () => {
    it('returns the category value when present', () => {
      expect(getCategoryFromLabels(['category:RCA', 'team:platform'])).toBe('RCA');
    });

    it('returns undefined when no category label is present', () => {
      expect(getCategoryFromLabels(['team:platform', 'tier:p0'])).toBeUndefined();
    });

    it('returns undefined for empty / missing input', () => {
      expect(getCategoryFromLabels(undefined)).toBeUndefined();
      expect(getCategoryFromLabels([])).toBeUndefined();
    });

    it('returns undefined when the label has an empty value', () => {
      expect(getCategoryFromLabels(['category:'])).toBeUndefined();
    });

    it('returns the first match when multiple are present', () => {
      expect(getCategoryFromLabels(['category:Security', 'category:RCA'])).toBe('Security');
    });
  });

  describe('getDifficultyFromLabels', () => {
    it('returns the canonical difficulty value', () => {
      expect(getDifficultyFromLabels(['difficulty:Medium'])).toBe('Medium');
    });

    it('normalizes case (mixed input → canonical Easy/Medium/Hard)', () => {
      expect(getDifficultyFromLabels(['difficulty:hard'])).toBe('Hard');
      expect(getDifficultyFromLabels(['difficulty:EASY'])).toBe('Easy');
    });

    it('returns the raw value for non-canonical difficulties', () => {
      expect(getDifficultyFromLabels(['difficulty:Trivial'])).toBe('Trivial');
    });

    it('returns undefined when no difficulty label is present', () => {
      expect(getDifficultyFromLabels(['category:RCA'])).toBeUndefined();
    });
  });

  describe('getSubcategoryFromLabels', () => {
    it('returns the subcategory value when present', () => {
      expect(getSubcategoryFromLabels(['subcategory:auth'])).toBe('auth');
    });

    it('returns undefined when no subcategory label is present', () => {
      expect(getSubcategoryFromLabels(['category:RCA'])).toBeUndefined();
    });
  });

  describe('migrateLegacyFieldsToLabels', () => {
    it('builds labels from legacy fields when no labels exist', () => {
      const out = migrateLegacyFieldsToLabels({ category: 'RCA', difficulty: 'Medium' });
      expect(out).toEqual(['category:RCA', 'difficulty:Medium']);
    });

    it('preserves existing labels and appends legacy fields', () => {
      const out = migrateLegacyFieldsToLabels({
        category: 'RCA',
        difficulty: 'Easy',
        labels: ['team:platform'],
      });
      expect(out).toEqual(['team:platform', 'category:RCA', 'difficulty:Easy']);
    });

    it('does not duplicate when an existing label already covers a facet', () => {
      const out = migrateLegacyFieldsToLabels({
        category: 'Security',                       // ignored — labels[0] wins
        difficulty: 'Easy',
        labels: ['category:RCA'],
      });
      expect(out).toEqual(['category:RCA', 'difficulty:Easy']);
    });

    it('handles missing legacy fields gracefully', () => {
      expect(migrateLegacyFieldsToLabels({})).toEqual([]);
      expect(migrateLegacyFieldsToLabels({ labels: ['x'] })).toEqual(['x']);
    });

    it('migrates subcategory too', () => {
      const out = migrateLegacyFieldsToLabels({ subcategory: 'auth' });
      expect(out).toEqual(['subcategory:auth']);
    });
  });

  describe('hasLabelPrefix', () => {
    it('detects a present prefix', () => {
      expect(hasLabelPrefix(['category:RCA'], 'category')).toBe(true);
      expect(hasLabelPrefix(['category:RCA'], 'category:')).toBe(true);
    });

    it('returns false for missing prefix', () => {
      expect(hasLabelPrefix(['team:platform'], 'category')).toBe(false);
    });

    it('returns false for empty / undefined input', () => {
      expect(hasLabelPrefix(undefined, 'category')).toBe(false);
      expect(hasLabelPrefix([], 'category')).toBe(false);
    });
  });
});
