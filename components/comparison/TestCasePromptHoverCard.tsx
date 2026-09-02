/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TestCasePromptHoverCard — wraps a test-case hyperlink (case row link, the
 * deep-dive's "View full test case" link, or any other place the comparison
 * surfaces link to a test case) so hovering (or focusing, for keyboard users)
 * it surfaces "what was actually asked" without navigating away.
 *
 * Built on the existing `@/components/ui/tooltip` primitive (Radix Tooltip,
 * already a project dependency and already used for exactly this kind of
 * "hover reveals more" affordance — see `VersionIndicator`) rather than
 * introducing a new `@radix-ui/react-hover-card` dependency: Radix Tooltip
 * already gives us the open-intent delay, portal rendering, collision
 * detection, Escape-to-close, and — critically — focus-triggered display for
 * keyboard users, for free. The only thing it doesn't give us is the richer
 * "card" content (name + badges + clamped prompt instead of one line of
 * text), which is just a matter of what we render inside `TooltipContent`.
 */

import React, { useState } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useTestCasePromptPreview } from '@/hooks/useTestCasePromptPreview';
import { selectPromptForVersion } from '@/services/comparison/testCasePromptCache';

// 250ms open delay: long enough that sweeping across a column of case links
// doesn't pop a card (and doesn't trigger the fetch) for every row the
// pointer passes over, short enough to still feel like a hover affordance
// once the user actually pauses on one.
const OPEN_DELAY_MS = 250;

// Clamp via inline style (not a `line-clamp-N` Tailwind utility) so the exact
// line count isn't tied to whichever clamp utilities happen to be generated
// elsewhere in the project — this is the one place that wants ~12.
const CLAMP_LINES = 12;

export interface TestCasePromptHoverCardProps {
  testCaseId: string;
  testCaseName?: string;
  /** The version this row/report actually used, if known (see selectPromptForVersion). */
  version?: number | string;
  /** Labels/category/difficulty already available to the caller — rendered as badges
   *  with no extra fetch ("cheap"). */
  labels?: string[];
  category?: string;
  difficulty?: string;
  children: React.ReactNode;
}

export const TestCasePromptHoverCard: React.FC<TestCasePromptHoverCardProps> = ({
  testCaseId,
  testCaseName,
  version,
  labels,
  category,
  difficulty,
  children,
}) => {
  const [open, setOpen] = useState(false);
  const { loading, versions, error } = useTestCasePromptPreview(testCaseId, open);
  const { initialPrompt, versionUsed, isFallbackVersion } = selectPromptForVersion(versions, version);

  const badgeLabels = labels && labels.length > 0
    ? labels
    : [category, difficulty].filter((v): v is string => !!v);

  return (
    <TooltipProvider delayDuration={OPEN_DELAY_MS}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          data-testid="compare-hover-prompt"
          side="bottom"
          align="start"
          collisionPadding={8}
          className="w-[380px] max-w-[90vw] rounded-md border bg-popover p-3 text-left text-popover-foreground shadow-lg"
        >
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="truncate text-xs font-semibold text-foreground">
              {testCaseName || testCaseId}
            </span>
            {versionUsed !== undefined && (
              <Badge
                variant="outline"
                className={cn('shrink-0 text-[10px]', isFallbackVersion && 'border-amber-500/40 text-amber-600 dark:text-amber-400')}
                data-testid="compare-hover-prompt-version"
                title={
                  isFallbackVersion
                    ? `The run used v${version}, which is no longer in this test case's captured history — showing the latest known version (v${versionUsed}) instead.`
                    : undefined
                }
              >
                {isFallbackVersion ? `v${versionUsed} (not the run's v${version})` : `v${versionUsed}`}
              </Badge>
            )}
          </div>

          {badgeLabels.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {badgeLabels.slice(0, 4).map((label) => (
                <Badge key={label} variant="outline" className="text-[9px]">
                  {label}
                </Badge>
              ))}
            </div>
          )}

          <div className="relative">
            {loading && versions.length === 0 ? (
              <div className="space-y-1.5" data-testid="compare-hover-prompt-loading">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-11/12" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ) : initialPrompt ? (
              <>
                <p
                  className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground/90"
                  style={{
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: CLAMP_LINES,
                    overflow: 'hidden',
                  }}
                >
                  {initialPrompt}
                </p>
                {/* Fade at the bottom signals there's more, without a hard cutoff. */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-popover to-transparent" />
              </>
            ) : error ? (
              <p className="text-[11px] italic text-muted-foreground">Couldn't load the prompt for this test case.</p>
            ) : (
              <p className="text-[11px] italic text-muted-foreground">No prompt captured for this test case.</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
