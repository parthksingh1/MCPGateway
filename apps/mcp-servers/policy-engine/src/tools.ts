import { defineTool, type ToolDefinition } from '@mcpgateway/mcp-runtime';
import { z } from 'zod';

import { evaluate } from './evaluator.js';
import type { PolicyCatalogue } from './loader.js';
import { evaluationInputSchema } from './schema.js';

const requestShape = {
  tool: z.string().min(1).describe('Fully qualified tool name, for example sf.query'),
  server: z.string().min(1).describe('MCP server the tool belongs to'),
  bundle: z.string().default('baseline').describe('Policy bundle to evaluate against'),
  principal: z
    .object({
      subject: z.string(),
      tenantId: z.string(),
      role: z.string(),
      scopes: z.array(z.string()).default([]),
      territory: z.string().nullable().default(null),
    })
    .describe('The caller, as carried by their token'),
  tenant: z
    .object({ id: z.string(), plan: z.string() })
    .describe('Tenant the call is made on behalf of'),
  arguments: z.record(z.unknown()).default({}).describe('Arguments the tool was called with'),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the runtime's tool list is heterogeneous; see McpServiceOptions.
export function createPolicyTools(catalogue: PolicyCatalogue): ToolDefinition<any>[] {
  const evaluateTool = defineTool({
    name: 'policy.evaluate',
    title: 'Evaluate policy',
    description:
      'Returns an allow or deny decision for a proposed tool call, together with the rule that decided it and any rate tier override.',
    inputSchema: requestShape,
    requiredScopes: ['policy:evaluate'],
    readOnly: true,
    handler: async (args) => {
      const bundle = catalogue.get(args.bundle);
      const input = evaluationInputSchema.parse({
        tool: args.tool,
        server: args.server,
        principal: args.principal,
        tenant: args.tenant,
        arguments: args.arguments,
      });
      const result = evaluate(bundle, input);

      // The default response omits the full trace: the gateway makes this call
      // on every request and only needs the decision. `policy.explain` returns
      // the trace for an operator looking at one specific call.
      return {
        decision: result.decision,
        ruleId: result.ruleId,
        reason: result.reason,
        rateTier: result.rateTier,
        bundle: bundle.name,
        evaluatedRules: result.evaluatedRules,
        durationMs: Number(result.durationMs.toFixed(3)),
      };
    },
  });

  const explainTool = defineTool({
    name: 'policy.explain',
    title: 'Explain a policy decision',
    description:
      'Evaluates the same request as policy.evaluate but returns every rule that was considered, whether it matched, and the definition of the rule that decided.',
    inputSchema: requestShape,
    requiredScopes: ['policy:evaluate'],
    readOnly: true,
    handler: async (args) => {
      const bundle = catalogue.get(args.bundle);
      const input = evaluationInputSchema.parse({
        tool: args.tool,
        server: args.server,
        principal: args.principal,
        tenant: args.tenant,
        arguments: args.arguments,
      });
      const result = evaluate(bundle, input);
      const deciding = bundle.rules.find((rule) => rule.id === result.ruleId);

      return {
        decision: result.decision,
        ruleId: result.ruleId,
        reason: result.reason,
        rateTier: result.rateTier,
        bundle: bundle.name,
        defaultEffect: bundle.defaultEffect,
        decidingRule: deciding
          ? { id: deciding.id, priority: deciding.priority, description: deciding.description }
          : null,
        trace: result.trace,
        durationMs: Number(result.durationMs.toFixed(3)),
      };
    },
  });

  const listTool = defineTool({
    name: 'policy.list_rules',
    title: 'List policy rules',
    description: 'Returns the rules in a bundle, in the order they are evaluated.',
    inputSchema: { bundle: z.string().default('baseline') },
    requiredScopes: ['policy:read'],
    readOnly: true,
    handler: async (args) => {
      const bundle = catalogue.get(args.bundle);
      return {
        bundle: bundle.name,
        defaultEffect: bundle.defaultEffect,
        rules: [...bundle.rules]
          .sort((a, b) => a.priority - b.priority)
          .map((rule) => ({
            id: rule.id,
            priority: rule.priority,
            effect: rule.effect,
            description: rule.description.trim(),
            reason: rule.reason ?? null,
            rateTier: rule.rateTier ?? null,
            match: rule.match,
          })),
      };
    },
  });

  return [evaluateTool, explainTool, listTool];
}
