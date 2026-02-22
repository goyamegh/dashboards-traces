/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sample Benchmarks for Demo Mode
 *
 * Pre-configured benchmarks with completed runs showcasing Travel Planner
 * evaluation results. Always visible alongside real benchmarks - IDs prefixed
 * with 'demo-'.
 */

import type { Benchmark } from '../../types/index.js';

export const SAMPLE_BENCHMARKS: Benchmark[] = [
  {
    id: 'demo-bench-basic',
    name: 'Travel Planning Accuracy - Demo',
    description: 'Evaluates basic to intermediate travel planning scenarios: weekend trip, international itinerary, and budget optimization.',
    createdAt: '2024-01-15T10:00:00.000Z',
    updatedAt: '2024-01-15T10:30:00.000Z',
    currentVersion: 1,
    versions: [
      {
        version: 1,
        createdAt: '2024-01-15T10:00:00.000Z',
        testCaseIds: [
          'demo-travel-001',
          'demo-travel-002',
          'demo-travel-003',
        ],
      },
    ],
    testCaseIds: [
      'demo-travel-001',
      'demo-travel-002',
      'demo-travel-003',
    ],
    runs: [
      {
        id: 'demo-run-001',
        name: 'Baseline Run',
        description: 'Initial evaluation with Claude 3.5 Sonnet on basic travel scenarios',
        createdAt: '2024-01-15T10:05:00.000Z',
        status: 'completed',
        benchmarkVersion: 1,
        testCaseSnapshots: [
          { id: 'demo-travel-001', version: 1, name: 'Weekend Getaway to Napa Valley' },
          { id: 'demo-travel-002', version: 1, name: 'Japan Cherry Blossom Season Trip' },
          { id: 'demo-travel-003', version: 1, name: 'Budget Southeast Asia Adventure' },
        ],
        agentKey: 'ml-commons',
        modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        results: {
          'demo-travel-001': { reportId: 'demo-report-001', status: 'completed' },
          'demo-travel-002': { reportId: 'demo-report-002', status: 'completed' },
          'demo-travel-003': { reportId: 'demo-report-003', status: 'completed' },
        },
      },
    ],
  },
  {
    id: 'demo-bench-advanced',
    name: 'Complex Travel Scenarios - Demo',
    description: 'Evaluates complex travel scenarios: budget optimization, group logistics, and time-pressure booking.',
    createdAt: '2024-01-15T11:00:00.000Z',
    updatedAt: '2024-01-15T11:30:00.000Z',
    currentVersion: 1,
    versions: [
      {
        version: 1,
        createdAt: '2024-01-15T11:00:00.000Z',
        testCaseIds: [
          'demo-travel-003',
          'demo-travel-004',
          'demo-travel-005',
        ],
      },
    ],
    testCaseIds: [
      'demo-travel-003',
      'demo-travel-004',
      'demo-travel-005',
    ],
    runs: [
      {
        id: 'demo-run-002',
        name: 'Advanced Scenarios Run',
        description: 'Evaluation of complex multi-agent coordination scenarios',
        createdAt: '2024-01-15T11:05:00.000Z',
        status: 'completed',
        benchmarkVersion: 1,
        testCaseSnapshots: [
          { id: 'demo-travel-003', version: 1, name: 'Budget Southeast Asia Adventure' },
          { id: 'demo-travel-004', version: 1, name: 'Team Building Retreat in Colorado' },
          { id: 'demo-travel-005', version: 1, name: 'Last-Minute Holiday Deal' },
        ],
        agentKey: 'ml-commons',
        modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        results: {
          'demo-travel-003': { reportId: 'demo-report-003b', status: 'completed' },
          'demo-travel-004': { reportId: 'demo-report-004', status: 'completed' },
          'demo-travel-005': { reportId: 'demo-report-005', status: 'completed' },
        },
      },
    ],
  },
];

/**
 * Get a sample benchmark by ID
 */
export function getSampleBenchmark(id: string): Benchmark | undefined {
  return SAMPLE_BENCHMARKS.find(bench => bench.id === id);
}

/**
 * Get all sample benchmarks
 */
export function getAllSampleBenchmarks(): Benchmark[] {
  return [...SAMPLE_BENCHMARKS];
}

/**
 * Check if an ID is a sample benchmark
 */
export function isSampleBenchmarkId(id: string): boolean {
  return id.startsWith('demo-exp-') || id.startsWith('demo-run-') || id.startsWith('demo-bench-');
}

// Backwards compatibility aliases
/** @deprecated Use SAMPLE_BENCHMARKS instead */
export const SAMPLE_EXPERIMENTS = SAMPLE_BENCHMARKS;
/** @deprecated Use getSampleBenchmark instead */
export const getSampleExperiment = getSampleBenchmark;
/** @deprecated Use getAllSampleBenchmarks instead */
export const getAllSampleExperiments = getAllSampleBenchmarks;
/** @deprecated Use isSampleBenchmarkId instead */
export const isSampleExperimentId = isSampleBenchmarkId;
