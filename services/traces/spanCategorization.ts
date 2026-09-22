/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Span Categorization Service
 *
 * Categorizes spans based on OTel GenAI semantic conventions.
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
 */

import { Span, SpanCategory, CategorizedSpan, OTelComplianceResult } from '@/types';
import { debug } from '@/lib/debug';
import {
  // Attribute names
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_SYSTEM,
  // OTel DB semconv (stable + legacy)
  ATTR_DB_SYSTEM_NAME,
  ATTR_DB_SYSTEM,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_NAMESPACE,
  ATTR_DB_COLLECTION_NAME,
  // OTel HTTP semconv (stable + legacy)
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_METHOD,
  // Operation name values
  GEN_AI_OPERATION_NAME_VALUE_CREATE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
  GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
} from '@opentelemetry/semantic-conventions/incubating';

/**
 * OTel operation names that map to AGENT category
 */
const AGENT_OPERATIONS = [
  GEN_AI_OPERATION_NAME_VALUE_CREATE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
];

/**
 * OTel operation names that map to LLM category
 */
const LLM_OPERATIONS = [
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
  GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT,
];

/**
 * OTel operation names that map to TOOL category
 */
const TOOL_OPERATIONS = [GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL];

/**
 * A span is a database / search client call when it carries the OTel DB
 * semconv system attribute (stable `db.system.name`, or legacy `db.system`).
 * @see https://opentelemetry.io/docs/specs/semconv/db/db-spans/
 */
export function isDbSpan(span: Span): boolean {
  const attrs = span.attributes || {};
  return Boolean(attrs[ATTR_DB_SYSTEM_NAME] || attrs[ATTR_DB_SYSTEM]);
}

/**
 * True when the span carries GenAI context beyond `gen_ai.operation.name`
 * (a provider / system / agent identity). Used to classify framework-specific
 * operation names (e.g. an agent-loop iteration span) as AGENT orchestration
 * rather than OTHER.
 */
function hasGenAiContext(attrs: Record<string, any>): boolean {
  return Boolean(
    attrs[ATTR_GEN_AI_PROVIDER_NAME] || attrs[ATTR_GEN_AI_SYSTEM] || attrs[ATTR_GEN_AI_AGENT_NAME]
  );
}

/**
 * Normalise the span kind we persist (`attributes.spanKind`) — the OpenSearch
 * and OTLP paths store the OTLP enum name (`SPAN_KIND_SERVER`), other
 * pipelines may store the bare word (`SERVER`) or the numeric OTLP code (2).
 */
function isServerKind(attrs: Record<string, any>): boolean {
  const kind = attrs['spanKind'] ?? attrs['span.kind'] ?? attrs['kind'];
  if (kind === undefined || kind === null) return false;
  if (typeof kind === 'number') return kind === 2;
  return /(^|_)SERVER$/i.test(String(kind));
}

/**
 * An entrypoint span is the inbound request boundary of the agent service: an
 * HTTP SERVER span (`http.request.method`, or legacy `http.method`, with
 * kind SERVER). Such spans are the agent invocation itself, so they are
 * categorised as AGENT — but their wall-clock duration is the whole request,
 * so consumers attributing time per category should only count their SELF
 * time (the `isEntrypoint` flag on `CategorizedSpan` signals this).
 *
 * Note: the eval `test_case` span is usually the W3C parent of this span, so
 * "has no parent" is deliberately NOT part of the check.
 */
export function isEntrypointSpan(span: Span): boolean {
  const attrs = span.attributes || {};
  const hasHttpMethod = Boolean(attrs[ATTR_HTTP_REQUEST_METHOD] || attrs[ATTR_HTTP_METHOD]);
  return hasHttpMethod && isServerKind(attrs);
}

/**
 * Category metadata (color, icon, label)
 */
interface CategoryMeta {
  color: string;      // Tailwind color class
  bgColor: string;    // Background color class for badges
  icon: string;       // lucide-react icon name
  label: string;      // Display label
}

const CATEGORY_META: Record<SpanCategory, CategoryMeta> = {
  AGENT: {
    color: 'text-indigo-400',
    bgColor: 'bg-indigo-500/20',
    icon: 'Bot',
    label: 'Agent',
  },
  LLM: {
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/20',
    icon: 'Zap',
    label: 'LLM',
  },
  TOOL: {
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/20',
    icon: 'Wrench',
    label: 'Tool',
  },
  RETRIEVAL: {
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/20',
    icon: 'Database',
    label: 'Retrieval',
  },
  EVAL: {
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/20',
    icon: 'ClipboardCheck',
    label: 'Eval',
  },
  ERROR: {
    color: 'text-red-400',
    bgColor: 'bg-red-500/20',
    icon: 'AlertCircle',
    label: 'Error',
  },
  OTHER: {
    color: 'text-slate-400',
    bgColor: 'bg-slate-500/20',
    icon: 'Circle',
    label: 'Other',
  },
};

/**
 * Get category metadata for a given category
 */
export function getCategoryMeta(category: SpanCategory): CategoryMeta {
  return CATEGORY_META[category];
}

/**
 * Determine span category, standards-first:
 *
 *  0. `status === 'ERROR'`                       → ERROR
 *  1. OTel DB semconv (`db.system.name`/`db.system`) → RETRIEVAL. Checked before
 *     GenAI because a span carrying both describes a data-store call made on
 *     behalf of the agent — the DB attributes are the leaf semantic, the
 *     GenAI ones are inherited context.
 *  2. OTel GenAI `gen_ai.operation.name`:
 *       - a known value                          → EVAL / AGENT / LLM / TOOL
 *       - an unknown (framework-specific) value **with** GenAI context
 *         (`gen_ai.provider.name` / `gen_ai.system` / `gen_ai.agent.name`)
 *                                                → AGENT (orchestration)
 *       - an unknown value without that context falls through to (4)
 *  3. HTTP SERVER span (inbound request boundary)  → AGENT (see isEntrypointSpan)
 *  4. Name-based pattern matching for legacy agents (e.g. Langgraph)
 *  5. Otherwise                                   → OTHER ("we do not know")
 */
export function getSpanCategory(span: Span): SpanCategory {
  // Error status takes precedence
  if (span.status === 'ERROR') {
    return 'ERROR';
  }

  const attrs = span.attributes || {};

  // 1. OTel DB semantic conventions — leaf semantic wins over GenAI context
  if (isDbSpan(span)) {
    return 'RETRIEVAL';
  }

  // 2. Standards-first: OTel GenAI semantic conventions
  const operationName = attrs[ATTR_GEN_AI_OPERATION_NAME];

  if (operationName) {
    if (operationName === 'evaluation') {
      return 'EVAL';
    }
    if (AGENT_OPERATIONS.includes(operationName)) {
      return 'AGENT';
    }
    if (LLM_OPERATIONS.includes(operationName)) {
      return 'LLM';
    }
    if (TOOL_OPERATIONS.includes(operationName)) {
      return 'TOOL';
    }
    // Framework-specific operation name (e.g. an agent-loop cycle) that still
    // identifies itself as GenAI → agent orchestration, not "unknown".
    if (hasGenAiContext(attrs)) {
      return 'AGENT';
    }
  }

  // 3. Inbound HTTP request boundary of the agent service
  if (isEntrypointSpan(span)) {
    return 'AGENT';
  }

  // 4. Fallback: Name-based pattern matching (for Langgraph, legacy agents)
  const name = span.name?.toLowerCase() || '';

  // LLM patterns - check first as they're most specific
  if (name.includes('bedrock') || name.includes('converse') || name.includes('callmodel') || name.includes('llm')) {
    return 'LLM';
  }

  // Tool patterns - check before agent since tool spans may contain 'agent' prefix
  if (name.includes('executetool') || name.includes('tool.execute')) {
    return 'TOOL';
  }

  // Eval patterns - evaluation spans from agent-health telemetry
  if (name.includes('test_suite_run') || name.includes('test_case')) {
    return 'EVAL';
  }

  // Agent patterns - root spans, orchestration, and internal processing
  if (name.includes('agent.run') || name.includes('invoke_agent') ||
      name.includes('generateresponse') || name.includes('processinput')) {
    return 'AGENT';
  }

  return 'OTHER';
}

/**
 * Build display name for a span using OTel attributes
 */
export function buildDisplayName(span: Span, category: SpanCategory): string {
  const attrs = span.attributes || {};
  const operationName = attrs[ATTR_GEN_AI_OPERATION_NAME] || '';

  switch (category) {
    case 'AGENT': {
      const agentName = attrs[ATTR_GEN_AI_AGENT_NAME] || span.name;
      return operationName ? `${operationName} ${agentName}` : agentName;
    }

    case 'LLM': {
      const provider = attrs[ATTR_GEN_AI_PROVIDER_NAME] || '';
      const model = attrs[ATTR_GEN_AI_REQUEST_MODEL] || '';
      // Get short model name (last part after dots)
      const shortModel = model.split('.').pop() || model;
      const parts = [operationName, provider, shortModel].filter(Boolean);
      return parts.length > 0 ? parts.join(' ') : span.name;
    }

    case 'TOOL': {
      const toolName = attrs[ATTR_GEN_AI_TOOL_NAME] || span.name;
      return operationName ? `${operationName} ${toolName}` : toolName;
    }

    case 'RETRIEVAL': {
      // OTel DB span-name convention: `{db.operation.name} {target}` where the
      // target is the collection (table / index) or, failing that, the namespace.
      const op = attrs[ATTR_DB_OPERATION_NAME] || '';
      const target = attrs[ATTR_DB_COLLECTION_NAME] || attrs[ATTR_DB_NAMESPACE] || '';
      const parts = [op, target].filter(Boolean);
      return parts.length > 0 ? parts.join(' ') : span.name;
    }

    case 'EVAL': {
      const testName = attrs['test.case.name'] || attrs['test.suite.name'] || '';
      return testName ? `evaluation ${testName}` : span.name;
    }

    case 'ERROR':
    case 'OTHER':
    default:
      return span.name;
  }
}

/**
 * The category-derived fields added to a span by categorization. Shared by
 * `categorizeSpan` and the single-pass `preprocessSpanTree` so both produce
 * identical metadata.
 */
export function buildCategoryFields(
  span: Span
): Pick<CategorizedSpan, 'category' | 'categoryLabel' | 'categoryColor' | 'categoryIcon' | 'displayName' | 'isEntrypoint'> {
  const category = getSpanCategory(span);
  const meta = getCategoryMeta(category);
  const fields = {
    category,
    categoryLabel: meta.label,
    categoryColor: meta.color,
    categoryIcon: meta.icon,
    displayName: buildDisplayName(span, category),
  };
  return isEntrypointSpan(span) ? { ...fields, isEntrypoint: true } : fields;
}

/**
 * Categorize a single span with full metadata
 */
export function categorizeSpan(span: Span): CategorizedSpan {
  return {
    ...span,
    ...buildCategoryFields(span),
  };
}

/**
 * Categorize an array of spans
 */
export function categorizeSpans(spans: Span[]): CategorizedSpan[] {
  debug('SpanCategorization', 'Categorizing', spans.length, 'spans');
  return spans.map(categorizeSpan);
}

/**
 * Categorize a span tree (preserving hierarchy)
 */
export function categorizeSpanTree(spans: Span[]): CategorizedSpan[] {
  return spans.map(span => {
    const categorized = categorizeSpan(span);
    if (span.children && span.children.length > 0) {
      categorized.children = categorizeSpanTree(span.children);
    }
    return categorized;
  });
}

/**
 * Filter spans by categories
 */
export function filterSpansByCategory(
  spans: CategorizedSpan[],
  categories: SpanCategory[]
): CategorizedSpan[] {
  if (categories.length === 0) {
    return spans;
  }

  return spans.filter(span => categories.includes(span.category));
}

/**
 * Filter span tree by categories (preserves hierarchy, hides non-matching)
 */
export function filterSpanTreeByCategory(
  spans: CategorizedSpan[],
  categories: SpanCategory[]
): CategorizedSpan[] {
  if (categories.length === 0) {
    return spans;
  }

  const filterTree = (nodes: CategorizedSpan[]): CategorizedSpan[] => {
    return nodes
      .map(span => {
        const matchesCategory = categories.includes(span.category);
        const filteredChildren = span.children
          ? filterTree(span.children as CategorizedSpan[])
          : [];

        // Include span if it matches OR if any children match
        if (matchesCategory || filteredChildren.length > 0) {
          return {
            ...span,
            children: filteredChildren.length > 0 ? filteredChildren : span.children,
          };
        }
        return null;
      })
      .filter((span): span is NonNullable<typeof span> => span !== null) as CategorizedSpan[];
  };

  return filterTree(spans);
}

/**
 * Count spans by category
 */
export function countByCategory(spans: CategorizedSpan[]): Record<SpanCategory, number> {
  const counts: Record<SpanCategory, number> = {
    AGENT: 0,
    LLM: 0,
    TOOL: 0,
    RETRIEVAL: 0,
    EVAL: 0,
    ERROR: 0,
    OTHER: 0,
  };

  const countRecursive = (nodes: CategorizedSpan[]) => {
    for (const span of nodes) {
      counts[span.category]++;
      if (span.children) {
        countRecursive(span.children as CategorizedSpan[]);
      }
    }
  };

  countRecursive(spans);
  return counts;
}

// ============ OTEL Compliance Checking ============

/**
 * Expected OTEL attributes by category. Each entry is either a single
 * attribute name or a list of alternatives (any one satisfies the expectation;
 * reported as `a|b` when all are missing).
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
 * @see https://opentelemetry.io/docs/specs/semconv/db/db-spans/
 */
type ExpectedAttribute = string | string[];

const EXPECTED_ATTRIBUTES: Record<SpanCategory, ExpectedAttribute[]> = {
  LLM: [ATTR_GEN_AI_OPERATION_NAME, ATTR_GEN_AI_REQUEST_MODEL, ATTR_GEN_AI_SYSTEM],
  TOOL: [ATTR_GEN_AI_OPERATION_NAME, ATTR_GEN_AI_TOOL_NAME],
  AGENT: [ATTR_GEN_AI_OPERATION_NAME, ATTR_GEN_AI_AGENT_NAME],
  // DB semconv: the system is required; a span should describe WHAT it did via
  // the query text (Recommended) or at least the operation name.
  RETRIEVAL: [ATTR_DB_SYSTEM_NAME, [ATTR_DB_QUERY_TEXT, ATTR_DB_OPERATION_NAME]],
  EVAL: [ATTR_GEN_AI_OPERATION_NAME],
  ERROR: [],  // Errors just need status
  OTHER: [],  // No expectations for OTHER
};

/**
 * Check if a span follows OTEL semantic conventions for its category
 */
export function checkOTelCompliance(span: CategorizedSpan): OTelComplianceResult {
  // The HTTP SERVER entrypoint is categorised AGENT but is an HTTP-semconv
  // span, not a GenAI one — judge it against the HTTP convention instead of
  // flagging it for missing gen_ai.* attributes.
  const expected: ExpectedAttribute[] = span.isEntrypoint
    ? [[ATTR_HTTP_REQUEST_METHOD, ATTR_HTTP_METHOD]]
    : EXPECTED_ATTRIBUTES[span.category] || [];
  const attrs = span.attributes || {};
  const missing = expected
    .filter(attr => (Array.isArray(attr) ? !attr.some(a => attrs[a]) : !attrs[attr]))
    .map(attr => (Array.isArray(attr) ? attr.join('|') : attr));

  return {
    isCompliant: missing.length === 0,
    missingAttributes: missing,
  };
}

/**
 * Check if any span in array has OTEL compliance warnings
 */
export function hasAnyWarnings(spans: CategorizedSpan[]): boolean {
  return spans.some(span => !checkOTelCompliance(span).isCompliant);
}
