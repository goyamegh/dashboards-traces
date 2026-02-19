/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { reportFormatterRegistry, registerFormatter, getFormatter } from '@/services/report/registry';
import type { ReportFormatter } from '@/services/report/types';

describe('ReportFormatterRegistry', () => {
  const mockFormatter: ReportFormatter = {
    format: 'test' as const,
    name: 'Test Formatter',
    extension: 'test',
    generate: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    reportFormatterRegistry.clear();
  });

  describe('register()', () => {
    it('should add a formatter and make it retrievable', () => {
      // Arrange & Act
      reportFormatterRegistry.register(mockFormatter);

      // Assert
      expect(reportFormatterRegistry.get('test')).toBe(mockFormatter);
    });

    it('should overwrite existing formatter with a warning', () => {
      // Arrange
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const replacementFormatter: ReportFormatter = {
        format: 'test' as const,
        name: 'Replacement Formatter',
        extension: 'test2',
        generate: jest.fn(),
      };

      reportFormatterRegistry.register(mockFormatter);

      // Act
      reportFormatterRegistry.register(replacementFormatter);

      // Assert
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Overwriting existing formatter for format: test')
      );
      expect(reportFormatterRegistry.get('test')).toBe(replacementFormatter);

      warnSpy.mockRestore();
    });
  });

  describe('get()', () => {
    it('should return undefined for unknown format', () => {
      // Act
      const result = reportFormatterRegistry.get('nonexistent');

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('getAll()', () => {
    it('should return all registered formatters', () => {
      // Arrange
      const anotherFormatter: ReportFormatter = {
        format: 'other' as const,
        name: 'Other Formatter',
        extension: 'other',
        generate: jest.fn(),
      };

      reportFormatterRegistry.register(mockFormatter);
      reportFormatterRegistry.register(anotherFormatter);

      // Act
      const all = reportFormatterRegistry.getAll();

      // Assert
      expect(all).toHaveLength(2);
      expect(all).toContain(mockFormatter);
      expect(all).toContain(anotherFormatter);
    });
  });

  describe('has()', () => {
    it('should return true for registered format', () => {
      // Arrange
      reportFormatterRegistry.register(mockFormatter);

      // Act & Assert
      expect(reportFormatterRegistry.has('test')).toBe(true);
    });

    it('should return false for unregistered format', () => {
      // Act & Assert
      expect(reportFormatterRegistry.has('unknown')).toBe(false);
    });
  });

  describe('getSupportedFormats()', () => {
    it('should return array of format strings', () => {
      // Arrange
      const anotherFormatter: ReportFormatter = {
        format: 'json' as const,
        name: 'JSON Formatter',
        extension: 'json',
        generate: jest.fn(),
      };

      reportFormatterRegistry.register(mockFormatter);
      reportFormatterRegistry.register(anotherFormatter);

      // Act
      const formats = reportFormatterRegistry.getSupportedFormats();

      // Assert
      expect(formats).toEqual(expect.arrayContaining(['test', 'json']));
      expect(formats).toHaveLength(2);
    });
  });

  describe('clear()', () => {
    it('should remove all formatters', () => {
      // Arrange
      reportFormatterRegistry.register(mockFormatter);
      expect(reportFormatterRegistry.has('test')).toBe(true);

      // Act
      reportFormatterRegistry.clear();

      // Assert
      expect(reportFormatterRegistry.has('test')).toBe(false);
      expect(reportFormatterRegistry.getAll()).toHaveLength(0);
      expect(reportFormatterRegistry.getSupportedFormats()).toHaveLength(0);
    });
  });

  describe('registerFormatter() helper', () => {
    it('should register a formatter via the singleton', () => {
      // Act
      registerFormatter(mockFormatter);

      // Assert
      expect(reportFormatterRegistry.get('test')).toBe(mockFormatter);
    });
  });

  describe('getFormatter() helper', () => {
    it('should retrieve a formatter via the singleton', () => {
      // Arrange
      reportFormatterRegistry.register(mockFormatter);

      // Act
      const result = getFormatter('test');

      // Assert
      expect(result).toBe(mockFormatter);
    });

    it('should return undefined for unknown format', () => {
      // Act
      const result = getFormatter('nonexistent');

      // Assert
      expect(result).toBeUndefined();
    });
  });
});
