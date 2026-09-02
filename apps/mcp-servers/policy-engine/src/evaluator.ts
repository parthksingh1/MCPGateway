import type { Bundle, Condition, EvaluationInput, Operator, Rule } from './schema.js';

export interface RuleTraceEntry {
  readonly ruleId: string;
  readonly matched: boolean;
  readonly effect: 'allow' | 'deny' | null;
  readonly detail?: string;
}

export interface PolicyResult {
  readonly decision: 'allow' | 'deny';
  readonly ruleId: string;
  readonly reason: string;
  readonly rateTier: string | null;
  readonly trace: RuleTraceEntry[];
  readonly evaluatedRules: number;
  readonly durationMs: number;
}

/**
 * Reads a dotted path out of the evaluation document.
 *
 * Returns `undefined` for a missing path rather than throwing, so a rule that
 * references an argument the tool did not receive simply does not match.
 */
export function readPath(input: EvaluationInput, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = input;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compareNumbers(
  left: unknown,
  right: unknown,
  compare: (a: number, b: number) => boolean,
): boolean {
  const a = typeof left === 'number' ? left : Number(left);
  const b = typeof right === 'number' ? right : Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return compare(a, b);
}

/** Inline-flag prefixes JavaScript accepts once translated. */
const SUPPORTED_INLINE_FLAGS = new Set(['i', 'm', 's', 'u']);

/**
 * Translates a leading inline flag group into JavaScript RegExp flags.
 *
 * Policy authors write `(?i)pattern`, the form used by Go, PCRE and Rego.
 * JavaScript has no inline flag syntax and treats it as an invalid group, so
 * without this every case-insensitive rule would silently fail to match — the
 * worst possible failure mode for a deny rule.
 */
function compilePattern(pattern: string): RegExp {
  const inline = /^\(\?([a-zA-Z]+)\)/.exec(pattern);
  if (!inline) return new RegExp(pattern);

  const requested = [...(inline[1] ?? '')];
  const unsupported = requested.filter((flag) => !SUPPORTED_INLINE_FLAGS.has(flag));
  if (unsupported.length > 0) {
    throw new SyntaxError(`Unsupported inline regular expression flag: ${unsupported.join('')}`);
  }

  return new RegExp(pattern.slice(inline[0].length), [...new Set(requested)].join(''));
}

/**
 * Regular expressions come from checked-in policy files, not from request data,
 * so they are trusted input. They are still compiled per evaluation and matched
 * against a bounded string.
 */
function matchesPattern(value: unknown, pattern: unknown): boolean {
  if (typeof pattern !== 'string') return false;
  const haystack = Array.isArray(value) ? value.join(' ') : value;
  if (typeof haystack !== 'string') return false;
  try {
    return compilePattern(pattern).test(haystack);
  } catch {
    // A malformed pattern must not silently allow the request through.
    return false;
  }
}

function applyOperator(
  op: Operator,
  actual: unknown,
  expected: unknown,
  input: EvaluationInput,
): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'in':
      return asArray(expected).includes(actual);
    case 'not_in':
      return !asArray(expected).includes(actual);
    case 'matches':
      return matchesPattern(actual, expected);
    case 'not_matches':
      return !matchesPattern(actual, expected);
    case 'gt':
      return compareNumbers(actual, expected, (a, b) => a > b);
    case 'gte':
      return compareNumbers(actual, expected, (a, b) => a >= b);
    case 'lt':
      return compareNumbers(actual, expected, (a, b) => a < b);
    case 'lte':
      return compareNumbers(actual, expected, (a, b) => a <= b);
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'missing':
      return actual === undefined || actual === null;
    case 'contains':
      return asArray(actual).includes(expected);
    case 'not_contains':
      return !asArray(actual).includes(expected);
    case 'contains_any': {
      const candidates = asArray(expected);
      const haystack = asArray(actual).map((item) =>
        typeof item === 'string' ? item.toLowerCase() : item,
      );
      return candidates.some((candidate) =>
        haystack.includes(typeof candidate === 'string' ? candidate.toLowerCase() : candidate),
      );
    }
    case 'starts_with':
      return (
        typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected)
      );
    case 'eq_field':
      return typeof expected === 'string' && actual === readPath(input, expected);
    case 'ne_field':
      return typeof expected === 'string' && actual !== readPath(input, expected);
    default:
      // Every operator in the schema is handled above; an unrecognised one
      // means the bundle and the evaluator disagree, so refuse to match.
      return false;
  }
}

export function evaluateCondition(condition: Condition, input: EvaluationInput): boolean {
  if (condition.all) {
    return condition.all.every((child) => evaluateCondition(child, input));
  }
  if (condition.any) {
    return condition.any.some((child) => evaluateCondition(child, input));
  }
  if (condition.not) {
    return !evaluateCondition(condition.not, input);
  }
  if (!condition.path || !condition.op) return false;

  return applyOperator(condition.op, readPath(input, condition.path), condition.value, input);
}

/**
 * Evaluate a bundle against one request.
 *
 * Rules run in ascending priority order. The first `allow` or `deny` whose
 * match succeeds decides; `annotate` rules attach a rate tier and evaluation
 * continues. Falling off the end applies the bundle's default effect, which is
 * `deny` in every bundle shipped here — an unrecognised call is refused rather
 * than waved through.
 */
export function evaluate(bundle: Bundle, input: EvaluationInput): PolicyResult {
  const startedAt = performance.now();
  const ordered = [...bundle.rules].sort(byPriority);
  const trace: RuleTraceEntry[] = [];
  let rateTier: string | null = null;

  for (const rule of ordered) {
    const matched = evaluateCondition(rule.match, input);

    trace.push({
      ruleId: rule.id,
      matched,
      effect: rule.effect === 'annotate' ? null : rule.effect,
      ...(rule.effect === 'annotate' && matched && rule.rateTier
        ? { detail: `rateTier=${rule.rateTier}` }
        : {}),
    });

    if (!matched) continue;

    if (rule.effect === 'annotate') {
      if (rule.rateTier) rateTier = rule.rateTier;
      continue;
    }

    return {
      decision: rule.effect,
      ruleId: rule.id,
      reason: rule.reason ?? rule.description ?? rule.id,
      rateTier,
      trace,
      evaluatedRules: trace.length,
      durationMs: performance.now() - startedAt,
    };
  }

  return {
    decision: bundle.defaultEffect,
    ruleId: `${bundle.name}.default`,
    reason: bundle.defaultReason,
    rateTier,
    trace,
    evaluatedRules: trace.length,
    durationMs: performance.now() - startedAt,
  };
}

function byPriority(a: Rule, b: Rule): number {
  // Ties break on id so evaluation order is deterministic across reloads.
  return a.priority === b.priority ? a.id.localeCompare(b.id) : a.priority - b.priority;
}
