/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Observability data sources — Settings card.
 *
 * Several sources can be read side by side (e.g. your own OpenSearch cluster
 * AND a CloudWatch account): traces/logs are merged into one view, each span
 * tagged with its source; metrics come from the first source holding a run's
 * spans. Every source is a `Type → fields` form:
 *   - OpenSearch: endpoint, auth (none / basic / SigV4), index patterns
 *   - CloudWatch: region, AWS profile, traces + logs log groups
 * with Test Connection / Save / Remove. The first source is the "primary"
 * (`observability` in config); the rest are `observabilitySources`.
 *
 * Code-first mode (agent-health.config.ts present) makes all of this
 * read-only: the server answers 409 on Save and the forms say so.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Loader2, Plus, Save, Server, Trash2, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ClusterAuthType } from '@/types';
import type { ConfigStatus } from '@/lib/dataSourceConfig';
import { ENV_CONFIG } from '@/lib/config';

export const PASSWORD_STORED_SENTINEL = '__STORED__';

export type SourceType = 'opensearch' | 'cloudwatch';

export interface SourceDraft {
  id: string;            // 'primary' or the additional source id
  name: string;
  type: SourceType;
  // OpenSearch
  endpoint: string;
  authType: ClusterAuthType;
  username: string;
  password: string;
  awsService: 'es' | 'aoss';
  tlsSkipVerify: boolean;
  tracesIndex: string;
  logsIndex: string;
  metricsIndex: string;
  // shared AWS
  awsProfile: string;
  awsRegion: string;
  // CloudWatch
  tracesLogGroup: string;
  logsLogGroup: string;
}

export function emptyDraft(id: string, type: SourceType = 'opensearch'): SourceDraft {
  return {
    id, name: '', type,
    endpoint: '', authType: 'basic', username: '', password: '', awsService: 'es', tlsSkipVerify: false,
    tracesIndex: '', logsIndex: '', metricsIndex: '',
    awsProfile: '', awsRegion: '', tracesLogGroup: '', logsLogGroup: '',
  };
}

type StatusSource = NonNullable<ConfigStatus['observability']['sources']>[number];

/** Server config status (no secrets) → editable draft; a stored password becomes the sentinel. */
export function draftFromStatus(id: string, s: Partial<StatusSource> & { name?: string }): SourceDraft {
  return {
    ...emptyDraft(id, s.type === 'cloudwatch' ? 'cloudwatch' : 'opensearch'),
    name: s.name || '',
    endpoint: s.endpoint || '',
    authType: (s.authType as ClusterAuthType) || 'basic',
    username: s.username || '',
    password: s.hasPassword ? PASSWORD_STORED_SENTINEL : '',
    awsProfile: s.awsProfile || '',
    awsRegion: s.awsRegion || '',
    awsService: s.awsService || 'es',
    tracesIndex: s.indexes?.traces || '',
    logsIndex: s.indexes?.logs || '',
    metricsIndex: s.indexes?.metrics || '',
    tracesLogGroup: s.logGroups?.traces || '',
    logsLogGroup: s.logGroups?.logs || '',
  };
}

/** Request body for Save / Test Connection, per type. */
export function draftToBody(d: SourceDraft): Record<string, unknown> {
  if (d.type === 'cloudwatch') {
    return {
      type: 'cloudwatch',
      ...(d.name && { name: d.name }),
      awsRegion: d.awsRegion,
      awsProfile: d.awsProfile || undefined,
      logGroups: { traces: d.tracesLogGroup || undefined, logs: d.logsLogGroup || undefined },
    };
  }
  return {
    type: 'opensearch',
    ...(d.name && { name: d.name }),
    endpoint: d.endpoint,
    authType: d.authType !== 'basic' ? d.authType : undefined,
    username: d.username || undefined,
    password: d.password === PASSWORD_STORED_SENTINEL ? undefined : (d.password || undefined),
    awsProfile: d.awsProfile || undefined,
    awsRegion: d.awsRegion || undefined,
    awsService: d.awsService !== 'es' ? d.awsService : undefined,
    tlsSkipVerify: d.tlsSkipVerify,
    indexes: { traces: d.tracesIndex || undefined, logs: d.logsIndex || undefined, metrics: d.metricsIndex || undefined },
  };
}

export function draftIsComplete(d: SourceDraft): boolean {
  return d.type === 'cloudwatch' ? !!d.awsRegion.trim() : !!d.endpoint.trim();
}

type Verdict = { status: 'idle' | 'testing' | 'success' | 'error'; message: string };

interface SourceFormProps {
  draft: SourceDraft;
  isPrimary: boolean;
  readOnly: boolean;
  source?: ConfigStatus['observability']['source'];
  health?: { status: string; error?: string };
  onChange: (d: SourceDraft) => void;
  onSaved: () => void;
  onRemoved: () => void;
}

export function ObservabilitySourceForm({ draft, isPrimary, readOnly, source, health, onChange, onSaved, onRemoved }: SourceFormProps) {
  const [verdict, setVerdict] = useState<Verdict>({ status: 'idle', message: '' });
  const [showPassword, setShowPassword] = useState(false);
  const set = (patch: Partial<SourceDraft>) => onChange({ ...draft, ...patch });
  const tid = (suffix: string) => `obs-${draft.id}-${suffix}`;

  const test = async () => {
    if (!draftIsComplete(draft)) {
      setVerdict({ status: 'error', message: draft.type === 'cloudwatch' ? 'AWS region is required' : 'Endpoint URL is required' });
      return;
    }
    setVerdict({ status: 'testing', message: 'Testing connection...' });
    try {
      let res: Response;
      try {
        res = await fetch(`${ENV_CONFIG.backendUrl}/api/observability/test-connection`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draftToBody(draft)),
        });
      } catch {
        setVerdict({ status: 'error', message: 'Could not reach the backend server. Make sure it is running.' });
        return;
      }
      // An empty / non-JSON body (e.g. the dev proxy's 502 when the backend is
      // down) must not surface the browser's raw SyntaxError.
      const r = await res.json().catch(() => null);
      if (!r) {
        setVerdict({ status: 'error', message: `Backend returned an invalid response (HTTP ${res.status}). Make sure the server is running.` });
        return;
      }
      if (r.status === 'ok') setVerdict({ status: 'success', message: `Connected to ${r.clusterName || 'the data source'} (${r.latencyMs}ms)${r.message ? ` — ${r.message}` : ''}` });
      else setVerdict({ status: 'error', message: r.message || 'Connection failed' });
    } catch (e) {
      setVerdict({ status: 'error', message: e instanceof Error ? e.message : 'Connection failed' });
    }
  };

  const save = async () => {
    if (!draftIsComplete(draft)) {
      setVerdict({ status: 'error', message: draft.type === 'cloudwatch' ? 'AWS region is required' : 'Endpoint URL is required' });
      return;
    }
    try {
      const url = isPrimary
        ? `${ENV_CONFIG.backendUrl}/api/storage/config/observability`
        : `${ENV_CONFIG.backendUrl}/api/storage/config/observability/sources/${encodeURIComponent(draft.id)}`;
      const res = await fetch(url, { method: isPrimary ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draftToBody(draft)) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to save' }));
        throw new Error(err.error || 'Failed to save');
      }
      setVerdict({ status: 'success', message: 'Saved' });
      onSaved();
      setTimeout(() => setVerdict((v) => (v.message === 'Saved' ? { status: 'idle', message: '' } : v)), 3000);
    } catch (e) {
      setVerdict({ status: 'error', message: e instanceof Error ? e.message : 'Failed to save' });
    }
  };

  const remove = async () => {
    if (!window.confirm(isPrimary ? 'Clear the primary observability configuration? Will fall back to environment variables.' : `Remove source "${draft.name || draft.id}"?`)) return;
    try {
      const url = isPrimary
        ? `${ENV_CONFIG.backendUrl}/api/storage/config/observability`
        : `${ENV_CONFIG.backendUrl}/api/storage/config/observability/sources/${encodeURIComponent(draft.id)}`;
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to remove' }));
        throw new Error(err.error || 'Failed to remove');
      }
      onRemoved();
    } catch (e) {
      setVerdict({ status: 'error', message: e instanceof Error ? e.message : 'Failed to remove' });
    }
  };

  return (
    <div className="space-y-3 p-3 border rounded-lg" data-testid={`observability-source-${draft.id}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant={isPrimary ? 'default' : 'secondary'}>{isPrimary ? 'Primary' : 'Additional'}</Badge>
        {source && (
          <span className="text-xs text-muted-foreground" data-testid={tid('source')}>
            {source === 'file' ? 'Runtime state (.agent-health/state.json)' : source === 'typescript' ? 'Config file (agent-health.config.ts)' : source === 'environment' ? 'Environment variables' : 'Not configured'}
          </span>
        )}
        {health && (
          <span className={`inline-flex items-center gap-1 text-xs ${health.status === 'ok' ? 'text-green-500' : 'text-amber-500'}`} data-testid={tid('health')}>
            {health.status === 'ok' ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
            {health.status === 'ok' ? 'reachable' : health.error || health.status}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {!isPrimary && (
          <div className="space-y-1.5">
            <Label htmlFor={tid('name')} className="text-xs">Name</Label>
            <Input id={tid('name')} placeholder="e.g. team CloudWatch" value={draft.name} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} />
          </div>
        )}
        <div className="space-y-1.5">
          <Label className="text-xs">Type</Label>
          <Select value={draft.type} onValueChange={(v) => set({ type: v as SourceType })} disabled={readOnly}>
            <SelectTrigger className="h-8 text-xs" data-testid={tid('type')}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="opensearch">OpenSearch</SelectItem>
              <SelectItem value="cloudwatch">Amazon CloudWatch</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {draft.type === 'cloudwatch' ? (
        <div className="space-y-3" data-testid={tid('cloudwatch-fields')}>
          <p className="text-xs text-muted-foreground">
            Reads spans from CloudWatch Transaction Search (<code>aws/spans</code>) and OTel logs from per-agent log groups. Credentials come from the AWS profile / default chain.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={tid('region')} className="text-xs">AWS region</Label>
              <Input id={tid('region')} placeholder="us-east-1" value={draft.awsRegion} disabled={readOnly} onChange={(e) => set({ awsRegion: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={tid('profile')} className="text-xs">AWS profile (optional)</Label>
              <Input id={tid('profile')} placeholder="default credential chain" value={draft.awsProfile} disabled={readOnly} onChange={(e) => set({ awsProfile: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={tid('traces-group')} className="text-xs">Traces log group</Label>
              <Input id={tid('traces-group')} placeholder="aws/spans" value={draft.tracesLogGroup} disabled={readOnly} onChange={(e) => set({ tracesLogGroup: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={tid('logs-group')} className="text-xs">Logs log group</Label>
              <Input id={tid('logs-group')} placeholder="/agent-health/{service.name}" value={draft.logsLogGroup} disabled={readOnly} onChange={(e) => set({ logsLogGroup: e.target.value })} />
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3" data-testid={tid('opensearch-fields')}>
          <div className="space-y-1.5">
            <Label htmlFor={tid('endpoint')} className="text-xs">Endpoint URL</Label>
            <Input id={tid('endpoint')} placeholder="https://opensearch.example.com:9200" value={draft.endpoint} disabled={readOnly} onChange={(e) => set({ endpoint: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Authentication Type</Label>
            <Select value={draft.authType} onValueChange={(v) => set({ authType: v as ClusterAuthType })} disabled={readOnly}>
              <SelectTrigger className="h-8 text-xs" data-testid={tid('auth')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No Auth</SelectItem>
                <SelectItem value="basic">Basic Auth (username/password)</SelectItem>
                <SelectItem value="sigv4">AWS SigV4</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {draft.authType === 'basic' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={tid('username')} className="text-xs">Username (optional)</Label>
                <Input id={tid('username')} value={draft.username} disabled={readOnly} onChange={(e) => set({ username: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={tid('password')} className="text-xs">Password (optional)</Label>
                <Input id={tid('password')} type={showPassword ? 'text' : 'password'} disabled={readOnly}
                  placeholder={draft.password === PASSWORD_STORED_SENTINEL ? '•••••••• (stored)' : ''}
                  value={draft.password === PASSWORD_STORED_SENTINEL ? '' : draft.password}
                  onFocus={() => setShowPassword(false)}
                  onChange={(e) => set({ password: e.target.value })} />
              </div>
            </div>
          )}
          {draft.authType === 'sigv4' && (
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={tid('region')} className="text-xs">AWS region</Label>
                <Input id={tid('region')} placeholder="us-east-1" value={draft.awsRegion} disabled={readOnly} onChange={(e) => set({ awsRegion: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={tid('profile')} className="text-xs">AWS profile (optional)</Label>
                <Input id={tid('profile')} value={draft.awsProfile} disabled={readOnly} onChange={(e) => set({ awsProfile: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Service</Label>
                <Select value={draft.awsService} onValueChange={(v) => set({ awsService: v as 'es' | 'aoss' })} disabled={readOnly}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="es">Managed OpenSearch (es)</SelectItem>
                    <SelectItem value="aoss">Serverless (aoss)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={tid('traces-index')} className="text-xs">Traces index</Label>
              <Input id={tid('traces-index')} placeholder="otel-v1-apm-span-*" value={draft.tracesIndex} disabled={readOnly} onChange={(e) => set({ tracesIndex: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={tid('logs-index')} className="text-xs">Logs index</Label>
              <Input id={tid('logs-index')} placeholder="ml-commons-logs-*" value={draft.logsIndex} disabled={readOnly} onChange={(e) => set({ logsIndex: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={tid('metrics-index')} className="text-xs">Metrics index</Label>
              <Input id={tid('metrics-index')} placeholder="otel-v1-apm-service-map*" value={draft.metricsIndex} disabled={readOnly} onChange={(e) => set({ metricsIndex: e.target.value })} />
            </div>
          </div>
        </div>
      )}

      {verdict.message && (
        <div className={`flex items-center gap-2 text-sm ${verdict.status === 'success' ? 'text-green-400' : verdict.status === 'error' ? 'text-red-400' : 'text-muted-foreground'}`} data-testid={tid('verdict')}>
          {verdict.status === 'testing' && <Loader2 size={14} className="animate-spin" />}
          {verdict.status === 'success' && <CheckCircle2 size={14} />}
          {verdict.status === 'error' && <XCircle size={14} />}
          {verdict.message}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={test} disabled={verdict.status === 'testing' || !draftIsComplete(draft)} data-testid={tid('test')}>
          {verdict.status === 'testing' ? <><Loader2 size={14} className="mr-1 animate-spin" />Testing...</> : 'Test Connection'}
        </Button>
        {!readOnly && (
          <>
            <Button size="sm" onClick={save} className="bg-opensearch-blue hover:bg-blue-600" data-testid={tid('save')}>
              <Save size={14} className="mr-1" />Save
            </Button>
            <Button variant="outline" size="sm" onClick={remove} data-testid={tid('remove')}>
              <Trash2 size={14} className="mr-1" />{isPrimary ? 'Clear' : 'Remove'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

interface CardProps {
  configStatus: ConfigStatus | null;
  onChanged: () => void;
}

export function ObservabilitySourcesCard({ configStatus, onChanged }: CardProps) {
  const obs = configStatus?.observability;
  const readOnly = obs?.source === 'typescript' || (obs?.sources ?? []).some((s) => s.source === 'typescript');

  const [primary, setPrimary] = useState<SourceDraft>(emptyDraft('primary'));
  const [extras, setExtras] = useState<SourceDraft[]>([]);
  const [health, setHealth] = useState<Record<string, { status: string; error?: string }>>({});

  // Re-seed drafts whenever the server status changes (after save/remove).
  useEffect(() => {
    if (!obs) return;
    setPrimary(obs.configured ? draftFromStatus('primary', obs) : emptyDraft('primary'));
    // Known sources are re-seeded from the server; drafts the server does not
    // know yet (just added, or saved but status not refreshed) are kept.
    setExtras((prev) => {
      const fromServer = (obs.sources ?? []).map((s) => draftFromStatus(s.id, s));
      const known = new Set(fromServer.map((d) => d.id));
      return [...fromServer, ...prev.filter((d) => !known.has(d.id))];
    });
  }, [obs]);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch(`${ENV_CONFIG.backendUrl}/api/observability/sources/health`);
      if (!res.ok) return;
      const data = await res.json();
      const map: Record<string, { status: string; error?: string }> = {};
      for (const s of data.sources ?? []) map[s.id] = s.health;
      setHealth(map);
    } catch { /* health is advisory */ }
  }, []);
  useEffect(() => { void loadHealth(); }, [loadHealth, obs]);

  const addSource = () => {
    const id = `src-${Date.now().toString(36)}`;
    setExtras((xs) => [...xs, emptyDraft(id, 'cloudwatch')]);
  };

  const sourceCount = useMemo(() => (obs?.configured ? 1 : 0) + (obs?.sources?.length ?? 0), [obs]);

  return (
    <Card className="mb-6" data-testid="observability-sources-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server size={18} />
          Observability Data Sources
          {sourceCount > 1 && <Badge variant="secondary" data-testid="observability-source-count">{sourceCount} sources</Badge>}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          OTEL traces, logs and metrics. Several sources are read side by side — spans from every source appear in one view, each tagged with its source; metrics come from the first source that holds a run's spans.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {readOnly && (
          <p className="text-xs text-muted-foreground" data-testid="observability-readonly-note">
            Managed by <code>agent-health.config.ts</code> (code-first mode) — edit the file and restart to change sources. Test Connection still works.
          </p>
        )}
        <ObservabilitySourceForm
          draft={primary}
          isPrimary
          readOnly={readOnly}
          source={obs?.source}
          health={health['primary']}
          onChange={setPrimary}
          onSaved={onChanged}
          onRemoved={onChanged}
        />
        {extras.map((d, i) => (
          <ObservabilitySourceForm
            key={d.id}
            draft={d}
            isPrimary={false}
            readOnly={readOnly || (obs?.sources ?? []).find((s) => s.id === d.id)?.source === 'typescript'}
            source={(obs?.sources ?? []).find((s) => s.id === d.id)?.source}
            health={health[d.id]}
            onChange={(nd) => setExtras((xs) => xs.map((x, j) => (j === i ? nd : x)))}
            onSaved={onChanged}
            onRemoved={() => { setExtras((xs) => xs.filter((_, j) => j !== i)); onChanged(); }}
          />
        ))}
        {!readOnly && (
          <Button variant="outline" size="sm" onClick={addSource} data-testid="observability-add-source">
            <Plus size={14} className="mr-1" />Add source
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
