/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const mockClusterFailures = jest.fn();
const mockGetClusterById = jest.fn();
const mockDebug = jest.fn();

jest.mock('@/server/services/failureClusterService', () => ({
  clusterFailures: (...args: any[]) => mockClusterFailures(...args),
  getClusterById: (...args: any[]) => mockGetClusterById(...args),
}));

jest.mock('@/lib/debug', () => ({
  debug: (...args: any[]) => mockDebug(...args),
}));

import express, { Application } from 'express';
const request = require('supertest');
import comparisonClusterRouter from '@/server/routes/comparisonCluster';

function makeApp(): Application {
  const app = express();
  app.use(express.json());
  app.use(comparisonClusterRouter);
  return app;
}

describe('Comparison cluster routes', () => {
  let app: Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = makeApp();
  });

  it('validates loserLabel, winnerLabel, and cases shape', async () => {
    const missingLoser = await request(app)
      .post('/api/comparison/cluster-failures')
      .send({ winnerLabel: 'winner', cases: [] });
    expect(missingLoser.status).toBe(400);
    expect(missingLoser.body).toEqual({ error: '`loserLabel` is required' });

    const missingWinner = await request(app)
      .post('/api/comparison/cluster-failures')
      .send({ loserLabel: 'loser', cases: [] });
    expect(missingWinner.status).toBe(400);
    expect(missingWinner.body).toEqual({ error: '`winnerLabel` is required' });

    const invalidCases = await request(app)
      .post('/api/comparison/cluster-failures')
      .send({ loserLabel: 'loser', winnerLabel: 'winner', cases: 'nope' });
    expect(invalidCases.status).toBe(400);
    expect(invalidCases.body).toEqual({ error: '`cases` must be an array' });
  });

  it('returns an empty result for an empty cases list', async () => {
    const res = await request(app)
      .post('/api/comparison/cluster-failures')
      .send({ loserLabel: 'loser', winnerLabel: 'winner', cases: [] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ clusters: [], totalFailures: 0, modelId: '' });
    expect(mockClusterFailures).not.toHaveBeenCalled();
  });

  it('sanitizes cases and forwards force/modelId options to the clustering service', async () => {
    mockClusterFailures.mockResolvedValue({ clusters: [{ id: 'cluster-1' }], totalFailures: 1, modelId: 'judge-x' });

    const res = await request(app)
      .post('/api/comparison/cluster-failures')
      .send({
        loserLabel: 'Claude',
        winnerLabel: 'Kiro',
        force: 1,
        modelId: 'judge-x',
        cases: [
          null,
          {
            caseId: 'case-1',
            caseName: 'Case One',
            judgeReasoning: 'Reason',
            improvementStrategies: ['retry'],
            firstDivergence: { step: 2 },
          },
          {
            caseId: '',
            caseName: 'invalid',
          },
          {
            caseId: 'case-2',
            caseName: 42,
            improvementStrategies: 'not-an-array',
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(mockClusterFailures).toHaveBeenCalledWith(
      {
        loserLabel: 'Claude',
        winnerLabel: 'Kiro',
        cases: [
          {
            caseId: 'case-1',
            caseName: 'Case One',
            judgeReasoning: 'Reason',
            improvementStrategies: ['retry'],
            firstDivergence: { step: 2 },
          },
          {
            caseId: 'case-2',
            caseName: undefined,
            judgeReasoning: undefined,
            improvementStrategies: undefined,
            firstDivergence: undefined,
          },
        ],
      },
      { force: true, modelId: 'judge-x' }
    );
    expect(res.body).toEqual({ clusters: [{ id: 'cluster-1' }], totalFailures: 1, modelId: 'judge-x' });
  });

  it('returns 400 when all cases are removed during sanitization', async () => {
    const res = await request(app)
      .post('/api/comparison/cluster-failures')
      .send({
        loserLabel: 'loser',
        winnerLabel: 'winner',
        cases: [{ caseName: 'missing-case-id' }],
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'No valid `cases` after sanitization' });
  });

  it('returns 500 when clustering fails', async () => {
    mockClusterFailures.mockRejectedValue(new Error('bedrock down'));

    const res = await request(app)
      .post('/api/comparison/cluster-failures')
      .send({
        loserLabel: 'loser',
        winnerLabel: 'winner',
        cases: [{ caseId: 'case-1' }],
      });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'bedrock down' });
    expect(mockDebug).toHaveBeenCalledWith('ComparisonCluster', 'failed: bedrock down');
  });

  it('returns a cached cluster by id', async () => {
    mockGetClusterById.mockReturnValue({ id: 'cluster-1', summary: 'cached cluster' });

    const res = await request(app).get('/api/comparison/clusters/cluster-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'cluster-1', summary: 'cached cluster' });
  });

  it('returns 404 when a cached cluster cannot be found', async () => {
    mockGetClusterById.mockReturnValue(null);

    const res = await request(app).get('/api/comparison/clusters/missing');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: 'Cluster missing not found (cache may have expired)',
    });
  });
});
