/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '@/lib/config/index.js';
import { ensureServer } from '../utils/serverLifecycle.js';
import { ApiClient } from '../utils/apiClient.js';

interface ErrorPattern {
  errorType: string;
  count: number;
  spanNames: string[];
  avgDurationMs: number;
  exampleMessages: string[];
}

interface ServiceErrorAnalysis {
  serviceName: string;
  totalTraces: number;
  tracesWithErrors: number;
  errorRate: number;
  totalErrorSpans: number;
  errorPatterns: ErrorPattern[];
  avgErrorDurationMs: number;
}

/**
 * Analyze error patterns from trace data
 */
function analyzeErrorPatterns(spans: any[]): {
  errorSpans: any[];
  patterns: ErrorPattern[];
  avgDurationMs: number;
} {
  const errorSpans = spans.filter(s => s.status === 'ERROR');

  if (errorSpans.length === 0) {
    return { errorSpans, patterns: [], avgDurationMs: 0 };
  }

  // Group by error type (extracted from attributes or name)
  const patternMap = new Map<string, {
    count: number;
    spanNames: Set<string>;
    durations: number[];
    messages: Set<string>;
  }>();

  let totalDuration = 0;

  for (const span of errorSpans) {
    const errorType = extractErrorType(span);
    const spanName = span.name || 'Unknown';
    const duration = span.duration || 0;
    const errorMsg = extractErrorMessage(span);

    totalDuration += duration;

    if (!patternMap.has(errorType)) {
      patternMap.set(errorType, {
        count: 0,
        spanNames: new Set(),
        durations: [],
        messages: new Set(),
      });
    }

    const pattern = patternMap.get(errorType)!;
    pattern.count++;
    pattern.spanNames.add(spanName);
    pattern.durations.push(duration);
    if (errorMsg) pattern.messages.add(errorMsg);
  }

  // Convert to ErrorPattern array
  const patterns: ErrorPattern[] = Array.from(patternMap.entries())
    .map(([errorType, data]) => ({
      errorType,
      count: data.count,
      spanNames: Array.from(data.spanNames),
      avgDurationMs: data.durations.reduce((a, b) => a + b, 0) / data.durations.length,
      exampleMessages: Array.from(data.messages).slice(0, 3), // Top 3 examples
    }))
    .sort((a, b) => b.count - a.count); // Sort by frequency

  const avgDurationMs = totalDuration / errorSpans.length;

  return { errorSpans, patterns, avgDurationMs };
}

/**
 * Extract error type from span attributes or name
 */
function extractErrorType(span: any): string {
  const attrs = span.attributes || {};

  // Check common error type attributes
  if (attrs['error.type']) return attrs['error.type'];
  if (attrs['exception.type']) return attrs['exception.type'];
  if (attrs['http.status_code'] >= 400) return `HTTP ${attrs['http.status_code']}`;

  // Fallback to span name patterns
  const name = span.name || '';
  if (name.includes('timeout')) return 'Timeout';
  if (name.includes('connection')) return 'Connection Error';
  if (name.includes('auth')) return 'Authentication Error';

  return 'Unknown Error';
}

/**
 * Extract error message from span events or attributes
 */
function extractErrorMessage(span: any): string | null {
  const attrs = span.attributes || {};

  // Check attributes
  if (attrs['error.message']) return attrs['error.message'];
  if (attrs['exception.message']) return attrs['exception.message'];

  // Check span events
  if (span.events && Array.isArray(span.events)) {
    for (const event of span.events) {
      if (event.name === 'exception' && event.attributes?.['exception.message']) {
        return event.attributes['exception.message'];
      }
    }
  }

  return null;
}

/**
 * Fetch and analyze traces for a service
 */
async function analyzeServiceErrors(
  client: ApiClient,
  serviceName: string,
  startTime?: string,
  endTime?: string,
  limit: number = 1000
): Promise<ServiceErrorAnalysis> {
  console.log(chalk.gray(`\nFetching traces for service: ${serviceName}...`));

  // Fetch traces for this service
  const response = await client.fetchTraces({
    serviceName,
    startTime,
    endTime,
    size: limit,
  });

  const spans = response.spans || [];

  console.log(chalk.gray(`  Found ${spans.length} spans`));

  // Group spans by traceId
  const traceMap = new Map<string, any[]>();
  for (const span of spans) {
    if (!traceMap.has(span.traceId)) {
      traceMap.set(span.traceId, []);
    }
    traceMap.get(span.traceId)!.push(span);
  }

  const totalTraces = traceMap.size;

  // Count traces with errors
  let tracesWithErrors = 0;
  for (const traceSpans of traceMap.values()) {
    if (traceSpans.some(s => s.status === 'ERROR')) {
      tracesWithErrors++;
    }
  }

  const errorRate = totalTraces > 0 ? (tracesWithErrors / totalTraces) * 100 : 0;

  // Analyze error patterns across all spans
  const { errorSpans, patterns, avgDurationMs } = analyzeErrorPatterns(spans);

  return {
    serviceName,
    totalTraces,
    tracesWithErrors,
    errorRate,
    totalErrorSpans: errorSpans.length,
    errorPatterns: patterns,
    avgErrorDurationMs: avgDurationMs,
  };
}

/**
 * Print service error analysis
 */
function printServiceAnalysis(analysis: ServiceErrorAnalysis): void {
  console.log(chalk.bold.cyan(`\n${'='.repeat(60)}`));
  console.log(chalk.bold.cyan(`Service: ${analysis.serviceName}`));
  console.log(chalk.bold.cyan('='.repeat(60)));

  console.log(chalk.white(`Total Traces: ${analysis.totalTraces}`));
  console.log(chalk.white(`Traces with Errors: ${analysis.tracesWithErrors}`));

  const errorRateColor = analysis.errorRate > 10 ? chalk.red : analysis.errorRate > 5 ? chalk.yellow : chalk.green;
  console.log(errorRateColor(`Error Rate: ${analysis.errorRate.toFixed(2)}%`));

  console.log(chalk.white(`Total Error Spans: ${analysis.totalErrorSpans}`));
  console.log(chalk.white(`Avg Error Span Duration: ${analysis.avgErrorDurationMs.toFixed(2)}ms`));

  if (analysis.errorPatterns.length > 0) {
    console.log(chalk.bold.white('\nError Patterns:'));
    for (const pattern of analysis.errorPatterns) {
      console.log(chalk.yellow(`\n  • ${pattern.errorType}`));
      console.log(chalk.gray(`    Count: ${pattern.count}`));
      console.log(chalk.gray(`    Avg Duration: ${pattern.avgDurationMs.toFixed(2)}ms`));
      console.log(chalk.gray(`    Affected Spans: ${pattern.spanNames.join(', ')}`));
      if (pattern.exampleMessages.length > 0) {
        console.log(chalk.gray(`    Example Messages:`));
        pattern.exampleMessages.forEach(msg => {
          console.log(chalk.gray(`      - ${msg.substring(0, 80)}${msg.length > 80 ? '...' : ''}`));
        });
      }
    }
  } else {
    console.log(chalk.green('\n✓ No error patterns detected'));
  }
}

/**
 * Print comparison between two services
 */
function printComparison(service1: ServiceErrorAnalysis, service2: ServiceErrorAnalysis): void {
  console.log(chalk.bold.magenta(`\n${'='.repeat(60)}`));
  console.log(chalk.bold.magenta('COMPARISON SUMMARY'));
  console.log(chalk.bold.magenta('='.repeat(60)));

  // Error rate comparison
  const errorRateDiff = service1.errorRate - service2.errorRate;
  const diffColor = Math.abs(errorRateDiff) < 1 ? chalk.white : errorRateDiff > 0 ? chalk.red : chalk.green;
  const diffSymbol = errorRateDiff > 0 ? '↑' : errorRateDiff < 0 ? '↓' : '=';

  console.log(chalk.bold.white('\nError Rate:'));
  console.log(`  ${service1.serviceName}: ${service1.errorRate.toFixed(2)}%`);
  console.log(`  ${service2.serviceName}: ${service2.errorRate.toFixed(2)}%`);
  console.log(diffColor(`  Difference: ${diffSymbol} ${Math.abs(errorRateDiff).toFixed(2)}%`));

  // Error pattern comparison
  console.log(chalk.bold.white('\nUnique Error Patterns:'));
  const patterns1 = new Set(service1.errorPatterns.map(p => p.errorType));
  const patterns2 = new Set(service2.errorPatterns.map(p => p.errorType));

  const onlyIn1 = Array.from(patterns1).filter(p => !patterns2.has(p));
  const onlyIn2 = Array.from(patterns2).filter(p => !patterns1.has(p));
  const inBoth = Array.from(patterns1).filter(p => patterns2.has(p));

  if (onlyIn1.length > 0) {
    console.log(chalk.cyan(`\n  Only in ${service1.serviceName}:`));
    onlyIn1.forEach(p => console.log(chalk.gray(`    • ${p}`)));
  }

  if (onlyIn2.length > 0) {
    console.log(chalk.cyan(`\n  Only in ${service2.serviceName}:`));
    onlyIn2.forEach(p => console.log(chalk.gray(`    • ${p}`)));
  }

  if (inBoth.length > 0) {
    console.log(chalk.cyan(`\n  Common error patterns:`));
    inBoth.forEach(p => {
      const count1 = service1.errorPatterns.find(x => x.errorType === p)?.count || 0;
      const count2 = service2.errorPatterns.find(x => x.errorType === p)?.count || 0;
      console.log(chalk.gray(`    • ${p}: ${count1} vs ${count2}`));
    });
  }

  // Recommendations
  console.log(chalk.bold.yellow('\nRecommendations:'));
  if (service1.errorRate > service2.errorRate * 1.5) {
    console.log(chalk.yellow(`  ⚠ ${service1.serviceName} has significantly higher error rate - investigate urgently`));
  } else if (service2.errorRate > service1.errorRate * 1.5) {
    console.log(chalk.yellow(`  ⚠ ${service2.serviceName} has significantly higher error rate - investigate urgently`));
  } else {
    console.log(chalk.green(`  ✓ Error rates are comparable`));
  }

  if (onlyIn1.length > 2) {
    console.log(chalk.yellow(`  ⚠ ${service1.serviceName} has ${onlyIn1.length} unique error types - review configuration`));
  }
  if (onlyIn2.length > 2) {
    console.log(chalk.yellow(`  ⚠ ${service2.serviceName} has ${onlyIn2.length} unique error types - review configuration`));
  }
}

export function createCompareServicesCommand(): Command {
  const cmd = new Command('compare-services');

  cmd
    .description('Compare error patterns between two services from trace data')
    .requiredOption('-s, --services <service1,service2>', 'Comma-separated service names (e.g., "lambda-api,eks-api")')
    .option('--start <time>', 'Start time (ISO 8601 format or relative like "1h", "24h")')
    .option('--end <time>', 'End time (ISO 8601 format)')
    .option('--limit <number>', 'Maximum number of spans to fetch per service', '1000')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const serverResult = await ensureServer(config.server);
        const client = new ApiClient(serverResult.baseUrl);

        const serviceNames = options.services.split(',').map((s: string) => s.trim());
        if (serviceNames.length !== 2) {
          console.error(chalk.red('Error: Please provide exactly two service names'));
          process.exit(1);
        }

        const [service1Name, service2Name] = serviceNames;
        const limit = parseInt(options.limit, 10);

        console.log(chalk.bold.cyan('\nComparing Error Patterns Between Services'));
        console.log(chalk.gray(`Service 1: ${service1Name}`));
        console.log(chalk.gray(`Service 2: ${service2Name}`));
        if (options.start) console.log(chalk.gray(`Time Range: ${options.start} to ${options.end || 'now'}`));

        // Analyze both services
        const analysis1 = await analyzeServiceErrors(client, service1Name, options.start, options.end, limit);
        const analysis2 = await analyzeServiceErrors(client, service2Name, options.start, options.end, limit);

        // Print individual analyses
        printServiceAnalysis(analysis1);
        printServiceAnalysis(analysis2);

        // Print comparison
        printComparison(analysis1, analysis2);

        console.log(); // Final newline
      } catch (error) {
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });

  return cmd;
}
