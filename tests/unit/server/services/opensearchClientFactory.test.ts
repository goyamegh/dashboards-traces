/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Mock @opensearch-project/opensearch
const mockClientConstructor = jest.fn().mockReturnValue({ close: jest.fn() });
jest.mock('@opensearch-project/opensearch', () => ({
  Client: mockClientConstructor,
}));

// Mock AwsSigv4Signer
const mockAwsSigv4Signer = jest.fn().mockReturnValue({
  Connection: 'mock-connection',
});
jest.mock('@opensearch-project/opensearch/aws-v3', () => ({
  AwsSigv4Signer: mockAwsSigv4Signer,
}));

// Mock fromNodeProviderChain
const mockFromNodeProviderChain = jest.fn().mockReturnValue(
  jest.fn().mockResolvedValue({ accessKeyId: 'test', secretAccessKey: 'test' })
);
jest.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: mockFromNodeProviderChain,
}));

import { createOpenSearchClient, configToCacheKey } from '@/server/services/opensearchClientFactory';
import type { ClusterConfig } from '@/types';

describe('opensearchClientFactory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createOpenSearchClient', () => {
    it('should create a basic auth client with username/password', () => {
      const config: ClusterConfig = {
        endpoint: 'https://localhost:9200',
        username: 'admin',
        password: 'admin123',
      };

      createOpenSearchClient(config);

      expect(mockClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          node: 'https://localhost:9200',
          auth: { username: 'admin', password: 'admin123' },
          ssl: { rejectUnauthorized: true },
        })
      );
    });

    it('should create a basic auth client without credentials when not provided', () => {
      const config: ClusterConfig = {
        endpoint: 'https://localhost:9200',
      };

      createOpenSearchClient(config);

      expect(mockClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          node: 'https://localhost:9200',
          ssl: { rejectUnauthorized: true },
        })
      );
      // No auth property should be set
      const callArg = mockClientConstructor.mock.calls[0][0];
      expect(callArg.auth).toBeUndefined();
    });

    it('should respect tlsSkipVerify=true', () => {
      const config: ClusterConfig = {
        endpoint: 'https://localhost:9200',
        tlsSkipVerify: true,
      };

      createOpenSearchClient(config);

      expect(mockClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          ssl: { rejectUnauthorized: false },
        })
      );
    });

    it('should create a SigV4 client when authType is sigv4', () => {
      const config: ClusterConfig = {
        endpoint: 'https://search-domain.us-east-1.es.amazonaws.com',
        authType: 'sigv4',
        awsRegion: 'us-east-1',
      };

      createOpenSearchClient(config);

      expect(mockAwsSigv4Signer).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us-east-1',
          service: 'es',
        })
      );
      expect(mockClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          node: 'https://search-domain.us-east-1.es.amazonaws.com',
          Connection: 'mock-connection',
        })
      );
    });

    it('should pass awsProfile to fromNodeProviderChain', () => {
      const config: ClusterConfig = {
        endpoint: 'https://search-domain.us-east-1.es.amazonaws.com',
        authType: 'sigv4',
        awsRegion: 'us-east-1',
        awsProfile: 'MyProfile',
      };

      createOpenSearchClient(config);

      // Get the getCredentials function that was passed to AwsSigv4Signer
      const signerCall = mockAwsSigv4Signer.mock.calls[0][0];
      expect(signerCall.region).toBe('us-east-1');

      // Call getCredentials to trigger fromNodeProviderChain
      signerCall.getCredentials();
      expect(mockFromNodeProviderChain).toHaveBeenCalledWith({ profile: 'MyProfile' });
    });

    it('should use aoss service for serverless', () => {
      const config: ClusterConfig = {
        endpoint: 'https://collection.us-east-1.aoss.amazonaws.com',
        authType: 'sigv4',
        awsRegion: 'us-east-1',
        awsService: 'aoss',
      };

      createOpenSearchClient(config);

      expect(mockAwsSigv4Signer).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us-east-1',
          service: 'aoss',
        })
      );
    });

    it('should throw error when sigv4 is used without awsRegion', () => {
      const config: ClusterConfig = {
        endpoint: 'https://search-domain.us-east-1.es.amazonaws.com',
        authType: 'sigv4',
      };

      expect(() => createOpenSearchClient(config)).toThrow(
        'awsRegion is required when authType is "sigv4"'
      );
    });

    it('should create a client with no auth when authType is none', () => {
      const config: ClusterConfig = {
        endpoint: 'https://localhost:9200',
        authType: 'none',
      };

      createOpenSearchClient(config);

      expect(mockAwsSigv4Signer).not.toHaveBeenCalled();
      expect(mockClientConstructor).toHaveBeenCalledWith({
        node: 'https://localhost:9200',
        ssl: { rejectUnauthorized: true },
      });
      // No auth property should be set
      const callArg = mockClientConstructor.mock.calls[0][0];
      expect(callArg.auth).toBeUndefined();
    });

    it('should default to basic auth when authType is not specified', () => {
      const config: ClusterConfig = {
        endpoint: 'https://localhost:9200',
        username: 'admin',
        password: 'admin',
      };

      createOpenSearchClient(config);

      expect(mockAwsSigv4Signer).not.toHaveBeenCalled();
      expect(mockClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: { username: 'admin', password: 'admin' },
        })
      );
    });
  });

  describe('configToCacheKey', () => {
    it('should generate basic auth cache key with hashed credentials', () => {
      const key = configToCacheKey({
        endpoint: 'https://localhost:9200',
        username: 'admin',
        password: 'pass',
      });

      expect(key).toMatch(/^basic\|https:\/\/localhost:9200\|[a-f0-9]{16}$/);
      // Password should NOT appear in the key
      expect(key).not.toContain('pass');
      expect(key).not.toContain('admin');
    });

    it('should generate basic auth cache key without credentials', () => {
      const key = configToCacheKey({
        endpoint: 'https://localhost:9200',
      });

      expect(key).toMatch(/^basic\|https:\/\/localhost:9200\|[a-f0-9]{16}$/);
    });

    it('should generate sigv4 cache key', () => {
      const key = configToCacheKey({
        endpoint: 'https://search-domain.us-east-1.es.amazonaws.com',
        authType: 'sigv4',
        awsRegion: 'us-east-1',
        awsProfile: 'MyProfile',
      });

      expect(key).toBe('sigv4|https://search-domain.us-east-1.es.amazonaws.com|us-east-1|MyProfile|es');
    });

    it('should include awsService in sigv4 cache key', () => {
      const key = configToCacheKey({
        endpoint: 'https://collection.aoss.amazonaws.com',
        authType: 'sigv4',
        awsRegion: 'us-west-2',
        awsService: 'aoss',
      });

      expect(key).toBe('sigv4|https://collection.aoss.amazonaws.com|us-west-2||aoss');
    });

    it('should generate none auth cache key', () => {
      const key = configToCacheKey({
        endpoint: 'https://localhost:9200',
        authType: 'none',
      });

      expect(key).toBe('none|https://localhost:9200');
    });

    it('should produce different keys for different configs', () => {
      const key1 = configToCacheKey({ endpoint: 'https://a.com', username: 'u1', password: 'p1' });
      const key2 = configToCacheKey({ endpoint: 'https://b.com', username: 'u1', password: 'p1' });
      const key3 = configToCacheKey({ endpoint: 'https://a.com', authType: 'sigv4', awsRegion: 'us-east-1' });

      expect(key1).not.toBe(key2); // different endpoints
      expect(key1).not.toBe(key3); // different auth types
      // Verify no plaintext password in basic key
      expect(key1).not.toContain('p1');
    });

    it('should produce same hash for same credentials, different hash for different credentials', () => {
      const key1 = configToCacheKey({ endpoint: 'https://a.com', username: 'user', password: 'pass1' });
      const key2 = configToCacheKey({ endpoint: 'https://a.com', username: 'user', password: 'pass1' });
      const key3 = configToCacheKey({ endpoint: 'https://a.com', username: 'user', password: 'pass2' });

      expect(key1).toBe(key2);
      expect(key1).not.toBe(key3);
    });
  });
});
