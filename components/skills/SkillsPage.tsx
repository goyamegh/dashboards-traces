/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Loader2, CheckCircle, XCircle, Play, Wand2, FolderOpen, ArrowUpCircle, ChevronRight, Folder, Scale } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { discoverSkills, validateSkill, streamSkillEval, getSkillResults } from '@/services/client/skillsApi';
import type { DiscoveredSkill } from '@/services/client/skillsApi';
import type { SkillValidationResult, SkillEvalProgressEvent, SkillBenchmarkResult, AgentConfig, ModelConfig } from '@/types';

type EvalPhase = 'idle' | 'validating' | 'running' | 'done' | 'error';

function PathBreadcrumb({ path }: { path: string }) {
  const segments = path.split('/').filter(Boolean);
  return (
    <div className="flex items-center gap-0.5 text-xs text-muted-foreground">
      {segments.map((segment, i) => (
        <React.Fragment key={i}>
          {i > 0 && <ChevronRight className="h-3 w-3 flex-shrink-0" />}
          <span className={i === segments.length - 1 ? 'font-medium text-foreground flex items-center gap-1' : ''}>
            {i === segments.length - 1 && <Folder className="h-3 w-3 inline" />}
            {segment}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

export const SkillsPage: React.FC = () => {
  // Config inputs
  const [skillPath, setSkillPath] = useState('');
  const [selectedAgent, setSelectedAgent] = useState('');
  const [selectedModel, setSelectedModel] = useState('');

  // Discovered skills
  const [availableSkills, setAvailableSkills] = useState<DiscoveredSkill[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(true);

  // Validation
  const [validation, setValidation] = useState<SkillValidationResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Eval state
  const [evalPhase, setEvalPhase] = useState<EvalPhase>('idle');
  const [progressText, setProgressText] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [totalEvals, setTotalEvals] = useState(0);
  const [completedEvals, setCompletedEvals] = useState(0);

  // Results
  const [benchmark, setBenchmark] = useState<SkillBenchmarkResult | null>(null);
  const [improvement, setImprovement] = useState<{
    applied: boolean;
    changes: string;
    reasoning: string;
    improvedInstructions?: string;
  } | null>(null);
  const [iterations, setIterations] = useState<SkillBenchmarkResult[]>([]);

  // Active tab
  const [activeTab, setActiveTab] = useState('skill');

  // Agents/models from config
  const agents = DEFAULT_CONFIG.agents;
  const models = Object.entries(DEFAULT_CONFIG.models).map(([key, cfg]) => ({ key, ...cfg }));

  // Discover skills on mount
  useEffect(() => {
    discoverSkills()
      .then(setAvailableSkills)
      .catch(() => setAvailableSkills([]))
      .finally(() => setLoadingSkills(false));
  }, []);

  // Set defaults
  useEffect(() => {
    const claudeAgent = agents.find(a => a.connectorType === 'claude-code');
    if (claudeAgent && !selectedAgent) setSelectedAgent(claudeAgent.key);
    const realModel = models.find(m => !m.model_id.startsWith('mock://'));
    if (realModel && !selectedModel) setSelectedModel(realModel.key);
  }, [agents.length, models.length]);

  const handleSkillSelect = useCallback(async (path: string) => {
    setSkillPath(path);
    setValidation(null);
    setValidationError(null);
    setBenchmark(null);
    setImprovement(null);
    setEvalPhase('validating');
    try {
      const result = await validateSkill(path);
      setValidation(result);
      if (!result.valid) {
        setValidationError(result.errors.join('; '));
      }
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : String(err));
      setValidation(null);
    } finally {
      setEvalPhase('idle');
    }
  }, []);

  const handleRunEval = useCallback(async (auto = false) => {
    if (!validation?.valid) return;
    setEvalPhase('running');
    setProgressText('Starting evaluation...');
    setProgressPercent(0);
    setCompletedEvals(0);
    setBenchmark(null);
    setImprovement(null);

    try {
      const result = await streamSkillEval(
        {
          path: skillPath.trim(),
          agentKey: selectedAgent || undefined,
          modelId: selectedModel || undefined,
          auto,
        },
        (event: SkillEvalProgressEvent) => {
          switch (event.type) {
            case 'started':
              setTotalEvals(event.totalEvals);
              setProgressText(`Evaluating "${event.skillName}" (${event.totalEvals} evals)`);
              break;
            case 'eval_running':
              setProgressText(`Eval #${event.evalId} [${event.condition}]: running agent...`);
              break;
            case 'eval_grading':
              setProgressText(`Eval #${event.evalId} [${event.condition}]: grading assertions...`);
              break;
            case 'eval_done':
              setCompletedEvals(prev => {
                const next = prev + 1;
                setProgressPercent(Math.round((next / (totalEvals * 2)) * 100));
                return next;
              });
              setProgressText(`Eval #${event.evalId} [${event.condition}]: ${Math.round(event.passRate * 100)}% pass rate`);
              break;
            case 'improving':
              setProgressText('Analyzing failures and proposing improvements...');
              setProgressPercent(90);
              break;
            case 'improved':
              setImprovement({
                applied: event.applied,
                changes: event.changes,
                reasoning: event.reasoning,
                improvedInstructions: event.improvedInstructions,
              });
              break;
          }
        },
      );

      setBenchmark(result.benchmark);
      if (result.improvement) setImprovement(result.improvement);
      setEvalPhase('done');
      setProgressPercent(100);
      setActiveTab('results');

      // Load history
      loadHistory();
    } catch (err) {
      setEvalPhase('error');
      setProgressText(err instanceof Error ? err.message : String(err));
    }
  }, [validation, skillPath, selectedAgent, selectedModel, totalEvals]);

  const loadHistory = useCallback(async () => {
    if (!validation?.skill) return;
    const workspace = `agent-health-data/skill-evals/${validation.skill.metadata.name}`;
    try {
      const { iterations: iters } = await getSkillResults(workspace);
      setIterations(iters);
    } catch {
      // Workspace might not exist yet
    }
  }, [validation]);

  const fmtPct = (n: number) => `${Math.round(n * 100)}%`;
  const fmtDelta = (n: number) => {
    const sign = n >= 0 ? '+' : '';
    return `${sign}${Math.round(n * 100)}%`;
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl" data-testid="skills-page">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Wand2 className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold" data-testid="skills-title">Skills Evaluator</h1>
          <p className="text-sm text-muted-foreground">Evaluate and improve AgentSkills via A/B testing</p>
        </div>
        <Badge variant="outline" className="ml-auto">AgentSkills.io</Badge>
      </div>

      {/* Input Section */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          {/* Skill selector dropdown */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
              <FolderOpen className="h-3 w-3" />Skill
            </label>
            <Select value={skillPath} onValueChange={handleSkillSelect}>
              <SelectTrigger className="h-9" data-testid="skill-selector">
                <SelectValue placeholder={loadingSkills ? 'Discovering skills...' : 'Select a skill'} />
              </SelectTrigger>
              <SelectContent>
                {availableSkills.map(s => (
                  <SelectItem key={s.path} value={s.path}>
                    <div className="flex items-center gap-2">
                      <span>{s.name}</span>
                      <span className="text-muted-foreground text-xs">— {s.path}</span>
                    </div>
                  </SelectItem>
                ))}
                {!loadingSkills && availableSkills.length === 0 && (
                  <SelectItem value="__none__" disabled>No skills found</SelectItem>
                )}
              </SelectContent>
            </Select>
            {skillPath && <PathBreadcrumb path={skillPath} />}
          </div>

          {/* Config row */}
          <div className="flex gap-3 items-center">
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">Agent Under Test</label>
              <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                <SelectTrigger className="h-9" data-testid="agent-selector">
                  <SelectValue placeholder="Select agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map(a => (
                    <SelectItem key={a.key} value={a.key}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                <Scale className="h-3 w-3" />Judge Model
              </label>
              <Select value={selectedModel} onValueChange={setSelectedModel}>
                <SelectTrigger className="h-9" data-testid="judge-model-selector">
                  <SelectValue placeholder="Select judge model" />
                </SelectTrigger>
                <SelectContent>
                  {models.filter(m => !m.model_id.startsWith('mock://')).map(m => (
                    <SelectItem key={m.key} value={m.key}>{m.display_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 flex items-end">
              <Button
                className="w-full"
                data-testid="run-evaluation-btn"
                onClick={() => handleRunEval(false)}
                disabled={!validation?.valid || evalPhase === 'running'}
              >
                {evalPhase === 'running' ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" />Running...</>
                ) : (
                  <><Play className="h-4 w-4 mr-2" />Run Evaluation</>
                )}
              </Button>
            </div>
          </div>

          {/* Validation result */}
          {validation && (
            <div data-testid="validation-result" className={`flex items-center gap-3 p-3 rounded-md ${validation.valid ? 'bg-green-50 dark:bg-green-950/20' : 'bg-red-50 dark:bg-red-950/20'}`}>
              {validation.valid ? (
                <CheckCircle className="h-4 w-4 text-green-600" />
              ) : (
                <XCircle className="h-4 w-4 text-red-600" />
              )}
              <div className="flex-1 min-w-0">
                {validation.skill && (
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{validation.skill.metadata.name}</span>
                    <span className="text-xs text-muted-foreground truncate">{validation.skill.metadata.description}</span>
                  </div>
                )}
                {validation.evalsFile && (
                  <span className="text-xs text-muted-foreground">{validation.evalsFile.evals.length} eval cases</span>
                )}
                {!validation.evalsFile && validation.valid && (
                  <span className="text-xs text-amber-600">No evals — will auto-generate on run</span>
                )}
              </div>
              {validation.warnings.map((w, i) => (
                <Badge key={i} variant="outline" className="text-amber-600 text-xs">{w}</Badge>
              ))}
            </div>
          )}
          {validationError && (
            <div className="p-3 rounded-md bg-red-50 dark:bg-red-950/20 text-sm text-red-600">{validationError}</div>
          )}

          {/* Progress bar */}
          {evalPhase === 'running' && (
            <div className="space-y-2">
              <Progress value={progressPercent} className="h-2" />
              <p className="text-xs text-muted-foreground">{progressText}</p>
            </div>
          )}
          {evalPhase === 'error' && (
            <div className="p-3 rounded-md bg-red-50 dark:bg-red-950/20 text-sm text-red-600">{progressText}</div>
          )}
        </CardContent>
      </Card>

      {/* Results Tabs */}
      {(validation?.valid || benchmark) && (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="skill">SKILL.md</TabsTrigger>
            <TabsTrigger value="results" disabled={!benchmark}>Results</TabsTrigger>
            <TabsTrigger value="improvement" disabled={!improvement}>Improvement</TabsTrigger>
            <TabsTrigger value="history" disabled={iterations.length === 0}>History ({iterations.length})</TabsTrigger>
          </TabsList>

          {/* SKILL.md Tab */}
          <TabsContent value="skill">
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm font-medium">Skill Instructions</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-xs bg-muted p-4 rounded-md overflow-auto max-h-96 whitespace-pre-wrap font-mono">
                  {validation?.skill?.instructions || 'Validate a skill to view its instructions.'}
                </pre>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Results Tab */}
          <TabsContent value="results">
            {benchmark && (
              <Card>
                <CardHeader className="py-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-medium">
                      Iteration {benchmark.iteration} — {benchmark.created_at.split('T')[0]}
                    </CardTitle>
                    <Badge variant={benchmark.run_summary.delta.pass_rate > 0 ? 'default' : 'destructive'}>
                      Delta: {fmtDelta(benchmark.run_summary.delta.pass_rate)}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Metric</TableHead>
                        <TableHead>With Skill</TableHead>
                        <TableHead>Without Skill</TableHead>
                        <TableHead>Delta</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell className="font-medium">Pass Rate</TableCell>
                        <TableCell>{fmtPct(benchmark.run_summary.with_skill.pass_rate.mean)}</TableCell>
                        <TableCell>{fmtPct(benchmark.run_summary.without_skill.pass_rate.mean)}</TableCell>
                        <TableCell className={benchmark.run_summary.delta.pass_rate >= 0 ? 'text-green-600' : 'text-red-600'}>
                          {fmtDelta(benchmark.run_summary.delta.pass_rate)}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium">Avg Time</TableCell>
                        <TableCell>{benchmark.run_summary.with_skill.time_seconds.mean.toFixed(1)}s</TableCell>
                        <TableCell>{benchmark.run_summary.without_skill.time_seconds.mean.toFixed(1)}s</TableCell>
                        <TableCell className={benchmark.run_summary.delta.time_seconds <= 0 ? 'text-green-600' : 'text-red-600'}>
                          {benchmark.run_summary.delta.time_seconds >= 0 ? '+' : ''}{benchmark.run_summary.delta.time_seconds.toFixed(1)}s
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium">Avg Tokens</TableCell>
                        <TableCell>{Math.round(benchmark.run_summary.with_skill.tokens.mean)}</TableCell>
                        <TableCell>{Math.round(benchmark.run_summary.without_skill.tokens.mean)}</TableCell>
                        <TableCell>{Math.round(benchmark.run_summary.delta.tokens)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Improvement Tab */}
          <TabsContent value="improvement">
            {improvement && (
              <Card>
                <CardHeader className="py-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      {improvement.applied ? (
                        <><CheckCircle className="h-4 w-4 text-green-600" />Improvement Applied</>
                      ) : (
                        <><ArrowUpCircle className="h-4 w-4 text-amber-600" />Improvement Proposed</>
                      )}
                    </CardTitle>
                    {!improvement.applied && (
                      <Button size="sm" onClick={() => handleRunEval(true)}>
                        <Wand2 className="h-3 w-3 mr-1" />Apply & Re-run
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Changes</p>
                    <p className="text-sm">{improvement.changes}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Reasoning</p>
                    <p className="text-sm">{improvement.reasoning}</p>
                  </div>
                  {improvement.improvedInstructions && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">Proposed Instructions</p>
                      <pre className="text-xs bg-muted p-4 rounded-md overflow-auto max-h-96 whitespace-pre-wrap font-mono">
                        {improvement.improvedInstructions}
                      </pre>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* History Tab */}
          <TabsContent value="history">
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm font-medium">Iteration History</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Iteration</TableHead>
                      <TableHead>With Skill</TableHead>
                      <TableHead>Without Skill</TableHead>
                      <TableHead>Delta</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {iterations.map((iter) => (
                      <TableRow
                        key={iter.iteration}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => { setBenchmark(iter); setActiveTab('results'); }}
                      >
                        <TableCell>#{iter.iteration}</TableCell>
                        <TableCell>{fmtPct(iter.run_summary.with_skill.pass_rate.mean)}</TableCell>
                        <TableCell>{fmtPct(iter.run_summary.without_skill.pass_rate.mean)}</TableCell>
                        <TableCell className={iter.run_summary.delta.pass_rate >= 0 ? 'text-green-600' : 'text-red-600'}>
                          {fmtDelta(iter.run_summary.delta.pass_rate)}
                        </TableCell>
                        <TableCell>{iter.run_summary.with_skill.time_seconds.mean.toFixed(1)}s</TableCell>
                        <TableCell className="text-muted-foreground">{iter.created_at.split('T')[0]}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
};
