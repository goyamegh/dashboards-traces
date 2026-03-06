/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  fetchLogs,
  fetchLogsLegacy,
  LogsQueryOptions,
  LegacyLogsQueryOptions,
} from '@/server/services/logsService';

// Mock fetch globally (still needed for fetchLogsLegacy)
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Create a mock OpenSearch SDK Client
function createMockClient(searchResult?: any) {
  return {
    search: jest.fn().mockResolvedValue({
      body: searchResult || { hits: { hits: [], total: { value: 0 } } },
    }),
    close: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('LogsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fetchLogs', () => {
    it('should fetch logs by runId', async () => {
      const mockResponse = {
        hits: {
          hits: [
            {
              _index: 'ml-commons-logs-2024.01.01',
              _source: {
                '@timestamp': '2024-01-01T00:00:00Z',
                message: '[run_id=test-run] Test log message',
                level: 'INFO',
                source: 'agent',
              },
            },
          ],
          total: { value: 1 },
        },
      };
      const client = createMockClient(mockResponse);

      const options: LogsQueryOptions = { runId: 'test-run', size: 50 };
      const result = await fetchLogs(options, client, 'ml-commons-logs-*');

      expect(client.search).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'ml-commons-logs-*',
          body: expect.objectContaining({
            size: 50,
          }),
        })
      );

      const searchBody = client.search.mock.calls[0][0].body;
      expect(searchBody.query.bool.must).toContainEqual({
        match: { message: 'test-run' },
      });

      expect(result.total).toBe(1);
      expect(result.logs).toHaveLength(1);
      expect(result.logs[0].message).toContain('test-run');
    });

    it('should add time range filter when no runId is provided', async () => {
      const client = createMockClient();

      const options: LogsQueryOptions = { query: 'error' };
      await fetchLogs(options, client);

      const searchBody = client.search.mock.calls[0][0].body;
      const timeRangeFilter = searchBody.query.bool.must.find(
        (f: any) => f.range && f.range['@timestamp']
      );
      expect(timeRangeFilter).toBeDefined();
    });

    it('should not add time range filter when runId is provided', async () => {
      const client = createMockClient();

      const options: LogsQueryOptions = { runId: 'test-run' };
      await fetchLogs(options, client);

      const searchBody = client.search.mock.calls[0][0].body;
      const timeRangeFilter = searchBody.query.bool.must.find(
        (f: any) => f.range && f.range['@timestamp']
      );
      expect(timeRangeFilter).toBeUndefined();
    });

    it('should filter by custom query', async () => {
      const client = createMockClient();

      const options: LogsQueryOptions = { query: 'exception' };
      await fetchLogs(options, client);

      const searchBody = client.search.mock.calls[0][0].body;
      expect(searchBody.query.bool.must).toContainEqual({
        match: { message: 'exception' },
      });
    });

    it('should transform hits to log entries', async () => {
      const mockResponse = {
        hits: {
          hits: [
            {
              _index: 'ml-commons-logs-2024.01.01',
              _source: {
                '@timestamp': '2024-01-01T12:00:00Z',
                message: 'Test message',
                level: 'ERROR',
                source: 'test-source',
                custom_field: 'custom_value',
              },
            },
          ],
          total: { value: 1 },
        },
      };
      const client = createMockClient(mockResponse);

      const options: LogsQueryOptions = { runId: 'test' };
      const result = await fetchLogs(options, client);

      expect(result.logs[0]).toMatchObject({
        timestamp: '2024-01-01T12:00:00Z',
        index: 'ml-commons-logs-2024.01.01',
        message: 'Test message',
        level: 'ERROR',
        source: 'test-source',
        custom_field: 'custom_value',
      });
    });

    it('should handle missing source fields gracefully', async () => {
      const mockResponse = {
        hits: {
          hits: [
            {
              _index: 'test-index',
              _source: {
                some_field: 'value',
              },
            },
          ],
          total: { value: 1 },
        },
      };
      const client = createMockClient(mockResponse);

      const options: LogsQueryOptions = { runId: 'test' };
      const result = await fetchLogs(options, client);

      expect(result.logs[0].level).toBe('info');
      expect(result.logs[0].source).toBe('unknown');
    });

    it('should use default index pattern when not provided', async () => {
      const client = createMockClient();

      await fetchLogs({ runId: 'test' }, client);

      expect(client.search).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'ml-commons-logs-*',
        })
      );
    });

    it('should use custom index pattern', async () => {
      const client = createMockClient();

      await fetchLogs({ runId: 'test' }, client, 'custom-logs-*');

      expect(client.search).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'custom-logs-*',
        })
      );
    });
  });

  describe('fetchLogsLegacy', () => {
    it('should throw error when required fields are missing', async () => {
      await expect(
        fetchLogsLegacy({
          endpoint: '',
          indexPattern: 'logs-*',
          query: {},
        })
      ).rejects.toThrow('Missing required fields');

      await expect(
        fetchLogsLegacy({
          endpoint: 'http://localhost:9200',
          indexPattern: '',
          query: {},
        })
      ).rejects.toThrow('Missing required fields');

      await expect(
        fetchLogsLegacy({
          endpoint: 'http://localhost:9200',
          indexPattern: 'logs-*',
          query: null as any,
        })
      ).rejects.toThrow('Missing required fields');
    });

    it('should proxy OpenSearch query', async () => {
      const mockResponse = { hits: { hits: [], total: { value: 0 } } };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const options: LegacyLogsQueryOptions = {
        endpoint: 'http://localhost:9200',
        indexPattern: 'my-logs-*',
        query: { match_all: {} },
      };

      const result = await fetchLogsLegacy(options);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9200/my-logs-*/_search',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ match_all: {} }),
        })
      );
      expect(result).toEqual(mockResponse);
    });

    it('should include auth header when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [] } }),
      });

      const options: LegacyLogsQueryOptions = {
        endpoint: 'http://localhost:9200',
        indexPattern: 'logs-*',
        query: {},
        auth: 'Bearer token123',
      };

      await fetchLogsLegacy(options);

      const requestHeaders = mockFetch.mock.calls[0][1].headers;
      expect(requestHeaders['Authorization']).toBe('Bearer token123');
    });

    it('should throw error on non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal server error'),
      });

      const options: LegacyLogsQueryOptions = {
        endpoint: 'http://localhost:9200',
        indexPattern: 'logs-*',
        query: {},
      };

      await expect(fetchLogsLegacy(options)).rejects.toThrow('Internal server error');
    });
  });
});
