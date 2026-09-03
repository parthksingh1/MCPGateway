// MOCK: Salesforce. Stands in for a real CRM behind the same MCP tool surface
// an official @salesforce/mcp server would present (sf.query with SOQL,
// sf.get_contact, sf.list_opportunities, sf.create_task). The records live in
// memory and are loaded from fixtures/*.json; the visibility rules applied to
// them are the real point of this server and are not simplified.
//
// Swapping this for a live org means replacing the four functions at the bottom
// of this file with API calls. Nothing above them changes.

import { readFile } from 'node:fs/promises';

import type { DownstreamPrincipal } from '@mcpgateway/mcp-runtime';

export interface AccountRecord {
  /** Present so a record can be addressed generically by SOQL field name. */
  readonly [field: string]: unknown;
  readonly Id: string;
  readonly TenantId: string;
  readonly Name: string;
  readonly Industry: string;
  readonly Territory: string;
  readonly OwnerId: string;
  readonly AnnualRevenue: number;
  readonly NumberOfEmployees: number;
  readonly Segment: string;
  readonly BillingCity: string;
  readonly CreatedDate: string;
}

export interface ContactRecord {
  /** Present so a record can be addressed generically by SOQL field name. */
  readonly [field: string]: unknown;
  readonly Id: string;
  readonly TenantId: string;
  readonly AccountId: string;
  readonly FirstName: string;
  readonly LastName: string;
  readonly Name: string;
  readonly Email: string;
  readonly Phone: string;
  readonly Title: string;
  readonly Territory: string;
  readonly OwnerId: string;
  readonly CreatedDate: string;
}

export interface OpportunityRecord {
  /** Present so a record can be addressed generically by SOQL field name. */
  readonly [field: string]: unknown;
  readonly Id: string;
  readonly TenantId: string;
  readonly AccountId: string;
  readonly Name: string;
  readonly StageName: string;
  readonly Amount: number;
  readonly Probability: number;
  readonly CloseDate: string;
  readonly Territory: string;
  readonly OwnerId: string;
  readonly ForecastCategory: string;
  readonly CreatedDate: string;
}

export interface TaskRecord {
  /** Present so a record can be addressed generically by SOQL field name. */
  readonly [field: string]: unknown;
  readonly Id: string;
  readonly TenantId: string;
  readonly Subject: string;
  readonly WhatId: string | null;
  readonly WhoId: string | null;
  readonly ActivityDate: string;
  readonly Status: string;
  readonly Priority: string;
  readonly OwnerId: string;
  readonly CreatedDate: string;
}

export type SObjectName = 'Account' | 'Contact' | 'Opportunity' | 'Task';

export interface CrmRecord {
  readonly Id: string;
  readonly TenantId: string;
  readonly OwnerId: string;
  readonly Territory?: string;
  readonly [field: string]: unknown;
}

export interface Dataset {
  readonly accounts: readonly AccountRecord[];
  readonly contacts: readonly ContactRecord[];
  readonly opportunities: readonly OpportunityRecord[];
  readonly tasks: TaskRecord[];
  records(object: SObjectName): readonly CrmRecord[];
}

const FIXTURE_DIR = new URL('../fixtures/', import.meta.url);

async function readFixture<T>(name: string): Promise<T[]> {
  return JSON.parse(await readFile(new URL(name, FIXTURE_DIR), 'utf8')) as T[];
}

export async function loadDataset(): Promise<Dataset> {
  const [accounts, contacts, opportunities] = await Promise.all([
    readFixture<AccountRecord>('accounts.json'),
    readFixture<ContactRecord>('contacts.json'),
    readFixture<OpportunityRecord>('opportunities.json'),
  ]);

  const tasks: TaskRecord[] = [];

  return {
    accounts,
    contacts,
    opportunities,
    tasks,
    records: (object) => {
      switch (object) {
        case 'Account':
          return accounts as unknown as readonly CrmRecord[];
        case 'Contact':
          return contacts as unknown as readonly CrmRecord[];
        case 'Opportunity':
          return opportunities as unknown as readonly CrmRecord[];
        case 'Task':
          return tasks as unknown as readonly CrmRecord[];
        default:
          return [];
      }
    },
  };
}

/**
 * Record visibility, derived from the caller's scopes.
 *
 * This is where permission mirroring stops being a diagram and becomes an
 * observable difference in a result set. The rules mirror how CRM sharing
 * actually works:
 *
 *   salesforce:read       records the caller owns
 *   salesforce:read.team  + records owned by anyone in the same territory
 *   salesforce:read.all   + every record in the tenant
 *
 * Note what the scopes come from: an exchanged token minted for this specific
 * caller. An analyst and their manager call the identical tool with identical
 * arguments and get different rows back, because their tokens differ. Under a
 * shared service account both would see everything, and the difference between
 * them would exist only in whatever the application layer remembered to filter.
 */
export type Visibility = 'own' | 'territory' | 'tenant';

export function visibilityFor(principal: DownstreamPrincipal): Visibility {
  if (principal.scopes.includes('salesforce:read.all')) return 'tenant';
  if (principal.scopes.includes('salesforce:read.team')) return 'territory';
  return 'own';
}

export function isVisible(record: CrmRecord, principal: DownstreamPrincipal): boolean {
  // Tenant isolation is absolute and checked before anything else.
  if (record.TenantId !== principal.tenantId) return false;

  switch (visibilityFor(principal)) {
    case 'tenant':
      return true;
    case 'territory':
      // A manager without a territory on their token sees their own records
      // only. Failing closed here matters: the alternative is that a missing
      // claim silently widens their reach to the whole tenant.
      return principal.territory !== null && record.Territory === principal.territory;
    case 'own':
      return record.OwnerId === principal.subject;
    default:
      return false;
  }
}

export function visibleRecords(
  dataset: Dataset,
  object: SObjectName,
  principal: DownstreamPrincipal,
): CrmRecord[] {
  return dataset.records(object).filter((record) => isVisible(record, principal));
}

/** Human-readable summary of why a caller sees what they see. */
export function describeVisibility(principal: DownstreamPrincipal): string {
  switch (visibilityFor(principal)) {
    case 'tenant':
      return 'All records in the tenant (salesforce:read.all)';
    case 'territory':
      return `Records in the ${principal.territory ?? 'unknown'} territory (salesforce:read.team)`;
    default:
      return 'Records owned by the caller (salesforce:read)';
  }
}
