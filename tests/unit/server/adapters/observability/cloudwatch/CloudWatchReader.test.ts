/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CloudWatchReader — the only file that talks to AWS. The real SDK client
 * object is used (command classes, config) with only `send` replaced, so the
 * commands and their inputs are the real ones.
 */

import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
  StopQueryCommand,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchReader, Semaphore } from '@/server/adapters/observability/cloudwatch/CloudWatchReader';

function clientWith(send: (cmd: any) => any): CloudWatchLogsClient {
  const c = new CloudWatchLogsClient({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
  (c as any).send = async (cmd: any) => send(cmd);
  return c;
}

describe('CloudWatchReader', () => {
  describe('filterEvents completeness (reviewer probe)', () => {
    it('reaching the row limit while CloudWatch still has a nextToken is NOT complete', async () => {
      const r = new CloudWatchReader({ region: 'us-east-1' }, clientWith(() => ({ events: [{ message: 'one' }], nextToken: 'more' })));
      const res = await r.filterEvents({ logGroup: 'g', pattern: 'p', startMs: 0, endMs: 1, limit: 1 });
      expect(res.events).toHaveLength(1);
      expect(res.complete).toBe(false);
    });

    it('stopping at the page budget is NOT complete; exhausting the window is', async () => {
      let pages = 0;
      const r = new CloudWatchReader({ region: 'us-east-1' }, clientWith(() => ({ events: [], nextToken: ++pages < 3 ? `t${pages}` : undefined })));
      expect((await r.filterEvents({ logGroup: 'g', pattern: 'p', startMs: 0, endMs: 1, limit: 100, maxPages: 2 })).complete).toBe(false);
      pages = 0;
      expect((await r.filterEvents({ logGroup: 'g', pattern: 'p', startMs: 0, endMs: 1, limit: 100 })).complete).toBe(true);
    });

    it('sends the real FilterLogEventsCommand with the caller\'s window and remaining limit', async () => {
      const seen: any[] = [];
      const r = new CloudWatchReader({ region: 'us-east-1' }, clientWith((cmd) => { seen.push(cmd); return { events: [{ message: 'a' }, { message: 'b' }], nextToken: seen.length < 2 ? 'n' : undefined }; }));
      await r.filterEvents({ logGroup: 'aws/spans', pattern: '"x"', startMs: 1000.4, endMs: 2000.2, limit: 3 });
      expect(seen[0]).toBeInstanceOf(FilterLogEventsCommand);
      expect(seen[0].input).toMatchObject({ logGroupName: 'aws/spans', filterPattern: '"x"', startTime: 1000, endTime: 2001, limit: 3 });
      expect(seen[1].input).toMatchObject({ limit: 1, nextToken: 'n' });
    });
  });

  describe('insights lifecycle', () => {
    it('polls GetQueryResults until Complete and reports truncation at the row limit', async () => {
      const seen: any[] = [];
      let polls = 0;
      const r = new CloudWatchReader({ region: 'us-east-1', insightsPollMs: 1 }, clientWith((cmd) => {
        seen.push(cmd);
        if (cmd instanceof StartQueryCommand) return { queryId: 'q1' };
        if (cmd instanceof GetQueryResultsCommand) return ++polls < 2 ? { status: 'Running' } : { status: 'Complete', results: [[{ field: '@message', value: 'm1' }], [{ field: '@message', value: 'm2' }]] };
        throw new Error('unexpected');
      }));
      const res = await r.insights({ logGroups: ['aws/spans'], query: 'fields @message', startMs: 1000, endMs: 60_000, limit: 2 });
      expect(res.rows.map((x) => x['@message'])).toEqual(['m1', 'm2']);
      expect(res.truncated).toBe(true); // exactly the limit → more may exist
      expect(seen[0].input).toMatchObject({ logGroupNames: ['aws/spans'], startTime: 1, endTime: 60, limit: 2 });
    });

    it('cancels the query server-side (StopQuery) when the local deadline passes', async () => {
      const seen: any[] = [];
      const r = new CloudWatchReader({ region: 'us-east-1', insightsPollMs: 1, insightsTimeoutMs: 5 }, clientWith((cmd) => {
        seen.push(cmd);
        if (cmd instanceof StartQueryCommand) return { queryId: 'q-slow' };
        if (cmd instanceof GetQueryResultsCommand) return { status: 'Running' };
        if (cmd instanceof StopQueryCommand) return { success: true };
        throw new Error('unexpected');
      }));
      await expect(r.insights({ logGroups: ['g'], query: 'q', startMs: 0, endMs: 1000 })).rejects.toThrow(/timed out.*stopped/);
      const stop = seen.find((c) => c instanceof StopQueryCommand);
      expect(stop.input).toEqual({ queryId: 'q-slow' });
    });

    it('surfaces a failed query as an error', async () => {
      const r = new CloudWatchReader({ region: 'us-east-1', insightsPollMs: 1 }, clientWith((cmd) => (cmd instanceof StartQueryCommand ? { queryId: 'q' } : { status: 'Failed' })));
      await expect(r.insights({ logGroups: ['g'], query: 'q', startMs: 0, endMs: 1 })).rejects.toThrow(/failed/);
    });
  });

  describe('describeLogGroups fan-out cap', () => {
    it('returns at most maxLogGroups and flags truncation', async () => {
      const r = new CloudWatchReader({ region: 'us-east-1', maxLogGroups: 3 }, clientWith((cmd) => {
        expect(cmd).toBeInstanceOf(DescribeLogGroupsCommand);
        const start = cmd.input.nextToken ? Number(cmd.input.nextToken) : 0;
        const names = Array.from({ length: 50 }, (_, i) => `/agent-health/svc-${start + i}`);
        return { logGroups: names.map((n) => ({ logGroupName: n })), nextToken: String(start + 50) };
      }));
      const res = await r.describeLogGroups('/agent-health/');
      expect(res.names).toHaveLength(3);
      expect(res.truncated).toBe(true);
    });
  });

  describe('Semaphore', () => {
    it('never runs more than `limit` tasks at once', async () => {
      const s = new Semaphore(2);
      let active = 0; let peak = 0;
      await Promise.all(Array.from({ length: 6 }, () => s.run(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 2)); active--; })));
      expect(peak).toBe(2);
    });
  });
});
