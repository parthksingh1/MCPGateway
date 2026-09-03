import { randomUUID } from 'node:crypto';

import { defineTool, type ToolDefinition } from '@mcpgateway/mcp-runtime';
import { NotFoundError } from '@mcpgateway/shared';
import { z } from 'zod';

import {
  describeVisibility,
  isVisible,
  visibleRecords,
  visibilityFor,
  type Dataset,
  type OpportunityRecord,
  type TaskRecord,
} from './dataset.js';
import { executeQuery, parseSoql } from './soql.js';

const MAX_ROWS = 200;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the runtime's tool list is heterogeneous; see McpServiceOptions.
export function createCrmTools(dataset: Dataset): ToolDefinition<any>[] {
  const query = defineTool({
    name: 'sf.query',
    title: 'Run a SOQL query',
    description:
      'Runs a SOQL query against Account, Contact, Opportunity or Task. Results are restricted to the records the caller is entitled to see, which is determined by the scopes on their token rather than by the query.',
    inputSchema: {
      soql: z
        .string()
        .min(1)
        .describe('SELECT <fields> FROM <Object> [WHERE ...] [ORDER BY ...] [LIMIT n]'),
    },
    requiredScopes: ['salesforce:read'],
    readOnly: true,
    handler: async (args, context) => {
      const parsed = parseSoql(args.soql);
      // Visibility is applied to the record set before the query runs, so a
      // WHERE clause can only narrow it further. There is no clause a caller
      // can write that reaches a record they could not already see.
      const permitted = visibleRecords(dataset, parsed.object, context.principal);
      const result = executeQuery(parsed, permitted, { maxRows: MAX_ROWS });

      return {
        ...result,
        object: parsed.object,
        visibility: describeVisibility(context.principal),
        recordsInScope: permitted.length,
      };
    },
  });

  const getContact = defineTool({
    name: 'sf.get_contact',
    title: 'Get a contact',
    description: 'Returns a single contact by id, together with the account it belongs to.',
    inputSchema: {
      contactId: z.string().min(3).describe('Contact record id, for example 003000000000042'),
    },
    requiredScopes: ['salesforce:read'],
    readOnly: true,
    handler: async (args, context) => {
      const contact = dataset.contacts.find((record) => record.Id === args.contactId);

      // A record the caller cannot see reports the same "not found" as one that
      // does not exist. Distinguishing them would confirm the record's
      // existence to someone with no right to know it.
      if (!contact || !isVisible(contact, context.principal)) {
        throw new NotFoundError(`Contact ${args.contactId}`);
      }

      const account = dataset.accounts.find((record) => record.Id === contact.AccountId);
      return {
        contact,
        account: account && isVisible(account, context.principal) ? account : null,
        visibility: describeVisibility(context.principal),
      };
    },
  });

  const listOpportunities = defineTool({
    name: 'sf.list_opportunities',
    title: 'List opportunities',
    description:
      'Returns opportunities visible to the caller with pipeline totals, optionally filtered by stage, minimum amount or close date window.',
    inputSchema: {
      stage: z.string().optional().describe('Exact stage name, e.g. Negotiation'),
      minAmount: z.number().min(0).optional().describe('Minimum opportunity amount'),
      closingBefore: z.string().optional().describe('ISO date; only opportunities closing before it'),
      openOnly: z.boolean().default(false).describe('Exclude Closed Won and Closed Lost'),
      limit: z.number().int().min(1).max(MAX_ROWS).default(50),
    },
    requiredScopes: ['salesforce:read'],
    readOnly: true,
    handler: async (args, context) => {
      const permitted = visibleRecords(
        dataset,
        'Opportunity',
        context.principal,
      ) as unknown as OpportunityRecord[];

      const closingBefore = args.closingBefore ? Date.parse(args.closingBefore) : null;

      const filtered = permitted.filter((opportunity) => {
        if (args.stage && opportunity.StageName.toLowerCase() !== args.stage.toLowerCase()) {
          return false;
        }
        if (args.minAmount !== undefined && opportunity.Amount < args.minAmount) return false;
        if (args.openOnly && opportunity.StageName.startsWith('Closed')) return false;
        if (closingBefore !== null && Date.parse(opportunity.CloseDate) >= closingBefore) {
          return false;
        }
        return true;
      });

      const sorted = [...filtered].sort((a, b) => b.Amount - a.Amount);
      const totalValue = filtered.reduce((sum, opportunity) => sum + opportunity.Amount, 0);
      const weightedValue = filtered.reduce(
        (sum, opportunity) => sum + (opportunity.Amount * opportunity.Probability) / 100,
        0,
      );

      const byStage: Record<string, { count: number; value: number }> = {};
      for (const opportunity of filtered) {
        const entry = byStage[opportunity.StageName] ?? { count: 0, value: 0 };
        entry.count += 1;
        entry.value += opportunity.Amount;
        byStage[opportunity.StageName] = entry;
      }

      return {
        totalSize: filtered.length,
        totalValue: Math.round(totalValue),
        weightedValue: Math.round(weightedValue),
        byStage,
        visibility: describeVisibility(context.principal),
        visibilityLevel: visibilityFor(context.principal),
        records: sorted.slice(0, args.limit),
      };
    },
  });

  const createTask = defineTool({
    name: 'sf.create_task',
    title: 'Create a follow-up task',
    description:
      'Creates a follow-up task owned by the caller, optionally linked to an account or opportunity they can see.',
    inputSchema: {
      subject: z.string().min(1).max(255).describe('Task subject line'),
      relatedTo: z
        .string()
        .optional()
        .describe('Id of an account or opportunity the task relates to'),
      contactId: z.string().optional().describe('Id of the contact the task concerns'),
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Due date as YYYY-MM-DD'),
      priority: z.enum(['Low', 'Normal', 'High']).default('Normal'),
    },
    requiredScopes: ['salesforce:write'],
    readOnly: false,
    handler: async (args, context) => {
      // A task may only reference records the caller can see. Without this a
      // write becomes an oracle: the success or failure of the link would
      // reveal whether a record exists.
      for (const [label, id] of [
        ['relatedTo', args.relatedTo],
        ['contactId', args.contactId],
      ] as const) {
        if (!id) continue;
        const referenced =
          dataset.accounts.find((record) => record.Id === id) ??
          dataset.opportunities.find((record) => record.Id === id) ??
          dataset.contacts.find((record) => record.Id === id);
        if (!referenced || !isVisible(referenced, context.principal)) {
          throw new NotFoundError(`Record ${id} referenced by ${label}`);
        }
      }

      const task: TaskRecord = {
        Id: `00T${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`,
        TenantId: context.principal.tenantId,
        Subject: args.subject,
        WhatId: args.relatedTo ?? null,
        WhoId: args.contactId ?? null,
        ActivityDate: args.dueDate,
        Status: 'Not Started',
        Priority: args.priority,
        // Ownership follows the token, not an argument.
        OwnerId: context.principal.subject,
        CreatedDate: new Date().toISOString(),
      };

      dataset.tasks.push(task);
      context.logger.info({ taskId: task.Id }, 'task created');

      return { created: true, task };
    },
  });

  return [query, getContact, listOpportunities, createTask];
}
