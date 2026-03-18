/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  formatMarkdownTable,
  formatJson,
  parseOutputFormat,
  OUTPUT_FORMAT_CHOICES,
  type OutputFormat,
} from '@/cli/utils/formatOutput';

describe('formatOutput', () => {
  describe('formatMarkdownTable', () => {
    it('should render a basic markdown table', () => {
      const headers = ['Name', 'Value'];
      const rows = [
        ['foo', '1'],
        ['bar', '2'],
      ];

      const result = formatMarkdownTable(headers, rows);

      expect(result).toBe(
        '| Name | Value |\n' +
        '| --- | --- |\n' +
        '| foo | 1 |\n' +
        '| bar | 2 |'
      );
    });

    it('should handle single column', () => {
      const result = formatMarkdownTable(['ID'], [['abc'], ['def']]);
      expect(result).toContain('| ID |');
      expect(result).toContain('| abc |');
    });

    it('should handle empty rows', () => {
      const result = formatMarkdownTable(['A', 'B'], []);
      const lines = result.split('\n');
      expect(lines).toHaveLength(2); // header + separator only
    });

    it('should handle cells with special characters', () => {
      const result = formatMarkdownTable(['Name'], [['hello | world']]);
      expect(result).toContain('hello | world');
    });

    it('should handle many columns', () => {
      const headers = ['A', 'B', 'C', 'D', 'E'];
      const rows = [['1', '2', '3', '4', '5']];
      const result = formatMarkdownTable(headers, rows);
      expect(result.split('|').length).toBeGreaterThan(5);
    });
  });

  describe('formatJson', () => {
    it('should format objects as indented JSON', () => {
      const result = formatJson({ key: 'value' });
      expect(result).toBe('{\n  "key": "value"\n}');
    });

    it('should format arrays', () => {
      const result = formatJson([1, 2, 3]);
      expect(result).toBe('[\n  1,\n  2,\n  3\n]');
    });

    it('should handle null', () => {
      expect(formatJson(null)).toBe('null');
    });
  });

  describe('parseOutputFormat', () => {
    it('should return table for "table"', () => {
      expect(parseOutputFormat('table')).toBe('table');
    });

    it('should return json for "json"', () => {
      expect(parseOutputFormat('json')).toBe('json');
    });

    it('should return markdown for "markdown"', () => {
      expect(parseOutputFormat('markdown')).toBe('markdown');
    });

    it('should accept "md" as alias for markdown', () => {
      expect(parseOutputFormat('md')).toBe('markdown');
    });

    it('should be case-insensitive', () => {
      expect(parseOutputFormat('JSON')).toBe('json');
      expect(parseOutputFormat('TABLE')).toBe('table');
      expect(parseOutputFormat('MARKDOWN')).toBe('markdown');
      expect(parseOutputFormat('MD')).toBe('markdown');
    });

    it('should default to table for unknown formats', () => {
      expect(parseOutputFormat('csv')).toBe('table');
      expect(parseOutputFormat('xml')).toBe('table');
      expect(parseOutputFormat('')).toBe('table');
    });
  });

  describe('OUTPUT_FORMAT_CHOICES', () => {
    it('should contain all three formats', () => {
      expect(OUTPUT_FORMAT_CHOICES).toEqual(['table', 'json', 'markdown']);
    });
  });
});
