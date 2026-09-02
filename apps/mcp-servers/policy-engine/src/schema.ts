import { z } from 'zod';

/**
 * Rule grammar.
 *
 * Deliberately small. A general-purpose policy language (Rego, CEL) is the
 * right answer for a real deployment and is listed as such in the architecture
 * notes; what this evaluator provides is the subset those languages are
 * actually used for at a gateway — comparing request attributes against
 * literals, sets and patterns — with the whole grammar visible in one file and
 * no evaluation of user-supplied code.
 */

export const operatorSchema = z.enum([
  'eq',
  'ne',
  'in',
  'not_in',
  'matches',
  'not_matches',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
  'missing',
  'contains',
  'not_contains',
  'contains_any',
  'starts_with',
  /** Compares the value at `path` against the value at another path. */
  'eq_field',
  'ne_field',
]);
export type Operator = z.infer<typeof operatorSchema>;

export interface Condition {
  readonly path?: string;
  readonly op?: Operator;
  readonly value?: unknown;
  readonly all?: readonly Condition[];
  readonly any?: readonly Condition[];
  readonly not?: Condition;
}

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z
    .object({
      path: z.string().min(1).optional(),
      op: operatorSchema.optional(),
      value: z.unknown().optional(),
      all: z.array(conditionSchema).optional(),
      any: z.array(conditionSchema).optional(),
      not: conditionSchema.optional(),
    })
    .refine(
      (condition) =>
        condition.all !== undefined ||
        condition.any !== undefined ||
        condition.not !== undefined ||
        (condition.path !== undefined && condition.op !== undefined),
      { message: 'A condition needs either a combinator (all/any/not) or both path and op' },
    ),
);

export const ruleSchema = z.object({
  id: z.string().min(1),
  priority: z.number().int().min(0).default(500),
  /**
   * `annotate` attaches metadata without deciding the request, so evaluation
   * continues to the next rule. Only `allow` and `deny` terminate.
   */
  effect: z.enum(['allow', 'deny', 'annotate']),
  description: z.string().default(''),
  reason: z.string().optional(),
  rateTier: z.string().optional(),
  match: conditionSchema,
});
export type Rule = z.infer<typeof ruleSchema>;

export const bundleSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  /** Applied when no rule decides. Fails closed. */
  defaultEffect: z.enum(['allow', 'deny']).default('deny'),
  defaultReason: z.string().default('No policy rule permits this call'),
  rules: z.array(ruleSchema).min(1),
});
export type Bundle = z.infer<typeof bundleSchema>;

export const evaluationInputSchema = z.object({
  tool: z.string().min(1),
  server: z.string().min(1),
  principal: z.object({
    subject: z.string(),
    tenantId: z.string(),
    role: z.string(),
    scopes: z.array(z.string()).default([]),
    territory: z.string().nullable().default(null),
  }),
  tenant: z.object({
    id: z.string(),
    plan: z.string(),
  }),
  arguments: z.record(z.unknown()).default({}),
});
export type EvaluationInput = z.infer<typeof evaluationInputSchema>;
