import type { McpTarget } from './services.js';

export interface CatalogEntry {
  readonly name: string;
  readonly server: McpTarget['id'];
  readonly title: string;
  readonly description: string;
  readonly requiredScopes: readonly string[];
  readonly readOnly: boolean;
}

/**
 * The tools the gateway is willing to route to.
 *
 * Held here rather than discovered at runtime so that an unknown tool name is
 * refused before any token is minted or any upstream contacted, and so the
 * console can render the catalogue without a live connection to every server.
 * The policy bundle's `allow-known-tools` rule lists the same names; the
 * integration suite asserts the two agree.
 */
export const TOOL_CATALOG: readonly CatalogEntry[] = [
  {
    name: 'sf.query',
    server: 'salesforce',
    title: 'Run a SOQL query',
    description:
      'Query Account, Contact, Opportunity or Task. Results are limited to the records the caller may see.',
    requiredScopes: ['salesforce:read'],
    readOnly: true,
  },
  {
    name: 'sf.get_contact',
    server: 'salesforce',
    title: 'Get a contact',
    description: 'Fetch one contact by id, with the account it belongs to.',
    requiredScopes: ['salesforce:read'],
    readOnly: true,
  },
  {
    name: 'sf.list_opportunities',
    server: 'salesforce',
    title: 'List opportunities',
    description: 'Pipeline summary and opportunity list, filtered by stage, value or close date.',
    requiredScopes: ['salesforce:read'],
    readOnly: true,
  },
  {
    name: 'sf.create_task',
    server: 'salesforce',
    title: 'Create a follow-up task',
    description: 'Create a task owned by the caller against a record they can see.',
    requiredScopes: ['salesforce:write'],
    readOnly: false,
  },
  {
    name: 'pg.list_tables',
    server: 'postgres',
    title: 'List warehouse tables',
    description: 'Available warehouse tables and how many rows each exposes to the caller.',
    requiredScopes: ['postgres:read'],
    readOnly: true,
  },
  {
    name: 'pg.describe_table',
    server: 'postgres',
    title: 'Describe a warehouse table',
    description: 'Columns of a warehouse table and the row-level security applied to it.',
    requiredScopes: ['postgres:read'],
    readOnly: true,
  },
  {
    name: 'pg.query',
    server: 'postgres',
    title: 'Run a read-only warehouse query',
    description: 'Execute a single SELECT against the warehouse under the caller own database role.',
    requiredScopes: ['postgres:query'],
    readOnly: true,
  },
  {
    name: 'policy.explain',
    server: 'policy-engine',
    title: 'Explain a policy decision',
    description: 'Evaluate a hypothetical call and return every rule that was considered.',
    requiredScopes: ['policy:evaluate'],
    readOnly: true,
  },
  {
    name: 'policy.list_rules',
    server: 'policy-engine',
    title: 'List policy rules',
    description: 'The rules in a bundle, in evaluation order.',
    requiredScopes: ['policy:read'],
    readOnly: true,
  },
];

const BY_NAME = new Map(TOOL_CATALOG.map((entry) => [entry.name, entry]));

export function findTool(name: string): CatalogEntry | undefined {
  return BY_NAME.get(name);
}

export function toolsForServer(server: McpTarget['id']): CatalogEntry[] {
  return TOOL_CATALOG.filter((entry) => entry.server === server);
}
