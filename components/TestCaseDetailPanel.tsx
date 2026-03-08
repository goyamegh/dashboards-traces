/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Calendar, Play, Repeat, ChevronDown, ChevronRight, MessageCircle, Zap } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TestCase } from '@/types';
import { getLabelColor, formatDate } from '@/lib/utils';

interface TestCaseDetailPanelProps {
  testCase: TestCase;
  totalRuns?: number;
}

export const TestCaseDetailPanel: React.FC<TestCaseDetailPanelProps> = ({ testCase, totalRuns }) => {
  const [idealAnswerExpanded, setIdealAnswerExpanded] = useState(false);
  return (
    <div className="space-y-4">
      {/* Labels */}
      {(testCase.labels || []).length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Labels</h4>
          <div className="flex items-center gap-2 flex-wrap">
            {testCase.labels.map((label) => (
              <Badge key={label} variant="outline" className={getLabelColor(label)}>
                {label}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Metadata */}
      <div className="space-y-1 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Calendar size={12} />
          <span>Created {formatDate(testCase.createdAt)}</span>
        </div>
        {totalRuns !== undefined && (
          <div className="flex items-center gap-2">
            <Play size={12} />
            <span>{totalRuns} run{totalRuns !== 1 ? 's' : ''}</span>
          </div>
        )}
      </div>

      {/* Description */}
      {testCase.description && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Description</h4>
          <p className="text-sm text-muted-foreground">{testCase.description}</p>
        </div>
      )}

      {/* Initial Prompt */}
      <div className="space-y-1">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Prompt</h4>
        <Card className="bg-muted/30">
          <CardContent className="p-3">
            <p className="text-sm whitespace-pre-wrap">{testCase.initialPrompt}</p>
          </CardContent>
        </Card>
      </div>

      {/* Expected Outcomes */}
      {testCase.expectedOutcomes && testCase.expectedOutcomes.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Expected Outcomes</h4>
          <ul className="space-y-1">
            {testCase.expectedOutcomes.map((outcome, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-opensearch-blue mt-0.5">•</span>
                <span>{outcome}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Context */}
      {testCase.context && testCase.context.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Context ({testCase.context.length})</h4>
          <div className="space-y-2">
            {testCase.context.map((ctx, i) => (
              <Card key={i} className="bg-muted/30">
                <CardContent className="p-2">
                  <p className="text-xs font-medium text-muted-foreground mb-1">{ctx.description}</p>
                  <pre className="text-xs overflow-x-auto max-h-20 overflow-y-auto">{ctx.value.slice(0, 200)}{ctx.value.length > 200 ? '...' : ''}</pre>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Tools */}
      {testCase.tools && testCase.tools.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Tools ({testCase.tools.length})</h4>
          <div className="flex flex-wrap gap-1">
            {testCase.tools.map((tool, i) => (
              <Badge key={i} variant="secondary" className="text-xs">
                {tool.name}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Expected PPL */}
      {testCase.expectedPPL && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Expected PPL</h4>
          <Card className="bg-muted/30">
            <CardContent className="p-2">
              <pre className="text-xs overflow-x-auto">{testCase.expectedPPL}</pre>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Multi-Turn Scenario */}
      {testCase.multiTurnScenario && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
            <Repeat size={12} /> Multi-Turn Scenario
          </h4>

          {/* User Motivation */}
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">User Motivation</span>
            <p className="text-sm">{testCase.multiTurnScenario.userMotivation}</p>
          </div>

          {/* Acceptance Criteria */}
          {testCase.multiTurnScenario.acceptanceCriteria.length > 0 && (
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Acceptance Criteria</span>
              <ul className="space-y-1">
                {testCase.multiTurnScenario.acceptanceCriteria.map((criterion, i) => (
                  <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                    <span className="text-opensearch-blue mt-0.5">•</span>
                    <span>{criterion}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Ideal Answer (collapsible) */}
          <div className="space-y-1">
            <button
              className="text-xs text-muted-foreground flex items-center gap-1 hover:text-foreground transition-colors"
              onClick={() => setIdealAnswerExpanded(!idealAnswerExpanded)}
            >
              {idealAnswerExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Ideal Answer
            </button>
            {idealAnswerExpanded && (
              <Card className="bg-muted/30">
                <CardContent className="p-2">
                  <p className="text-xs whitespace-pre-wrap">{testCase.multiTurnScenario.idealAnswer}</p>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Critical Components */}
          {testCase.multiTurnScenario.criticalComponents && (
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Critical Components</span>
              <div className="text-xs space-y-1">
                <div className="flex items-start gap-2 pl-2 border-l-2 border-red-500/30">
                  <span className="text-red-400 font-medium">Root Cause:</span>
                  <span className="text-muted-foreground">{testCase.multiTurnScenario.criticalComponents.rootCause}</span>
                </div>
                <div className="flex items-start gap-2 pl-2 border-l-2 border-emerald-500/30">
                  <span className="text-emerald-400 font-medium">Remediation:</span>
                  <span className="text-muted-foreground">{testCase.multiTurnScenario.criticalComponents.remediation}</span>
                </div>
              </div>
            </div>
          )}

          {/* Turn Limit */}
          {testCase.multiTurnScenario.turnLimit && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Turn Limit:</span>
              <Badge variant="secondary" className="text-[10px]">{testCase.multiTurnScenario.turnLimit}</Badge>
            </div>
          )}

          {/* Reference Turns */}
          {testCase.multiTurnScenario.referenceTurns && testCase.multiTurnScenario.referenceTurns.length > 0 && (
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Reference Turns ({testCase.multiTurnScenario.referenceTurns.length})</span>
              <div className="space-y-2">
                {testCase.multiTurnScenario.referenceTurns.map((rt, i) => (
                  <Card key={i} className="bg-muted/30">
                    <CardContent className="p-2 space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">Turn {rt.turn}</Badge>
                        <span className="text-xs truncate">{rt.user}</span>
                      </div>
                      <div className="flex gap-1 flex-wrap">
                        {rt.expectedTopics.map((topic, j) => (
                          <Badge key={j} variant="secondary" className="text-[10px]">{topic}</Badge>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2">{rt.groundTruth}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Follow-Up Questions */}
      {testCase.followUpQuestions && testCase.followUpQuestions.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
            <MessageCircle size={12} /> Follow-Up Questions
          </h4>
          <div className="space-y-2">
            {testCase.followUpQuestions.map((fq, i) => (
              <Card key={i} className="bg-muted/30">
                <CardContent className="p-2 space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      <Zap size={8} className="mr-0.5" />
                      {fq.trigger}
                    </Badge>
                  </div>
                  <p className="text-sm">{fq.question}</p>
                  <p className="text-xs text-muted-foreground">{fq.businessValue}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
