/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { FileCode2, GitBranch, MessageSquareText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { TestCaseDetailPanel } from '@/components/TestCaseDetailPanel';
import type { TestCase } from '@/types';

interface BenchmarkCaseDefinitionProps {
  testCase: TestCase;
  totalRuns?: number;
}

/**
 * Compatibility wrapper for the case detail pane.
 *
 * When the shared TestCaseDefinition from #420 lands, callers can swap this
 * component for that renderer in one line; until then this deliberately reuses
 * main's TestCaseDetailPanel and only fills its provenance/trajectory gaps.
 */
export const BenchmarkCaseDefinition: React.FC<BenchmarkCaseDefinitionProps> = ({
  testCase,
  totalRuns,
}) => (
  <div className="space-y-5">
    <TestCaseDetailPanel testCase={testCase} totalRuns={totalRuns} />

    {(testCase.sourceFile || testCase.sourceHash) && (
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Provenance</h4>
        <Card className="bg-muted/30">
          <CardContent className="p-3 space-y-2">
            {testCase.sourceFile && (
              <div className="flex items-start gap-2 text-sm">
                <FileCode2 size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
                <code className="text-xs break-all">{testCase.sourceFile}</code>
              </div>
            )}
            {testCase.sourceHash && (
              <div className="flex items-start gap-2 text-sm">
                <GitBranch size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
                <code className="text-xs break-all">sha256:{testCase.sourceHash}</code>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    )}

    {testCase.expectedTrajectory && testCase.expectedTrajectory.length > 0 && (
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Expected Trajectory</h4>
        <ol className="space-y-2">
          {testCase.expectedTrajectory.map(item => (
            <li key={item.step} className="rounded-md border p-3 text-sm">
              <div className="font-medium">{item.step}. {item.description}</div>
              {item.requiredTools.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {item.requiredTools.map(tool => <Badge key={tool} variant="secondary" className="text-[10px]">{tool}</Badge>)}
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>
    )}

    {testCase.followUpQuestions && testCase.followUpQuestions.length > 0 && (
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Follow-up Questions</h4>
        {testCase.followUpQuestions.map((followUp, index) => (
          <Card key={`${followUp.trigger}-${index}`} className="bg-muted/30">
            <CardContent className="p-3 flex items-start gap-2">
              <MessageSquareText size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm">{followUp.question}</p>
                <p className="text-xs text-muted-foreground mt-1">{followUp.businessValue}</p>
                <Badge variant="outline" className="text-[10px] mt-2">{followUp.trigger}</Badge>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    )}
  </div>
);
