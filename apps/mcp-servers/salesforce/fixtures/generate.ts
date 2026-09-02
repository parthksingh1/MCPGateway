/**
 * Regenerates the CRM fixtures.
 *
 * Run with `pnpm --filter @mcpgateway/mcp-salesforce fixtures`. The output is
 * committed, so a checkout produces byte-identical data without running this;
 * the generator exists so the shape of the data is reviewable rather than
 * arriving as an opaque blob.
 *
 * Everything is derived from a fixed seed. Two properties matter:
 *   - record ownership is spread across the seeded users so that scope-based
 *     visibility produces visibly different result sets per caller, and
 *   - amounts and close dates carry seasonality, so charts built on this data
 *     are not flat lines.
 */
import { writeFile } from 'node:fs/promises';

const SEED = 0x5f3a_71c9;

/** mulberry32 — small, fast, and reproducible across platforms. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const random = createRandom(SEED);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const between = (min: number, max: number): number => min + random() * (max - min);
const intBetween = (min: number, max: number): number => Math.floor(between(min, max + 1));

interface Owner {
  readonly id: string;
  readonly territory: string;
}

interface TenantPlan {
  readonly tenantId: string;
  readonly owners: readonly Owner[];
  readonly accounts: number;
  readonly contacts: number;
  readonly opportunities: number;
}

const TENANTS: readonly TenantPlan[] = [
  {
    tenantId: 'acme-corp',
    owners: [
      { id: 'usr_alice', territory: 'West' },
      { id: 'usr_bob', territory: 'West' },
      { id: 'usr_priya', territory: 'East' },
      { id: 'usr_evan', territory: 'East' },
    ],
    accounts: 50,
    contacts: 250,
    opportunities: 100,
  },
  {
    tenantId: 'globex',
    owners: [
      { id: 'usr_grace', territory: 'North' },
      { id: 'usr_hugo', territory: 'North' },
      { id: 'usr_jonah', territory: 'South' },
    ],
    accounts: 30,
    contacts: 150,
    opportunities: 60,
  },
  {
    tenantId: 'initech',
    owners: [
      { id: 'usr_karen', territory: 'Central' },
      { id: 'usr_liam', territory: 'Central' },
      { id: 'usr_mia', territory: 'Central' },
    ],
    accounts: 20,
    contacts: 100,
    opportunities: 40,
  },
];

const INDUSTRIES = [
  'Manufacturing',
  'Financial Services',
  'Healthcare',
  'Retail',
  'Technology',
  'Energy',
  'Logistics',
  'Public Sector',
];

const ACCOUNT_PREFIXES = [
  'Northwind',
  'Vertex',
  'Blue Harbor',
  'Ridgeline',
  'Cascade',
  'Ironwood',
  'Meridian',
  'Solstice',
  'Kestrel',
  'Foundry',
  'Lantern',
  'Cobalt',
  'Anvil',
  'Harborview',
  'Pinnacle',
  'Silverbrook',
  'Fairwater',
  'Greystone',
  'Copperfield',
  'Eastgate',
];

const ACCOUNT_SUFFIXES = [
  'Industries',
  'Group',
  'Holdings',
  'Systems',
  'Partners',
  'Logistics',
  'Analytics',
  'Health',
  'Energy',
  'Labs',
];

const FIRST_NAMES = [
  'Amara', 'Noah', 'Sofia', 'Liam', 'Yuki', 'Mateo', 'Ingrid', 'Omar', 'Zara', 'Felix',
  'Nadia', 'Tomas', 'Leila', 'Arjun', 'Elena', 'Kofi', 'Maja', 'Rafael', 'Anika', 'Dmitri',
  'Clara', 'Hassan', 'Beatriz', 'Jonas', 'Mei', 'Owen', 'Saoirse', 'Andre', 'Freya', 'Idris',
];

const LAST_NAMES = [
  'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Rossi', 'Haddad', 'Novak', 'Delgado', 'Fischer',
  'Bergstrom', 'Kowalski', 'Ferreira', 'Nakamura', 'Alvarez', 'Petrov', 'Sinclair', 'Dubois',
  'Vargas', 'Larsen', 'Mensah', 'Castellano', 'Bianchi', 'Rahman', 'Sorensen', 'Whitfield',
];

const TITLES = [
  'Head of Operations',
  'VP Finance',
  'Procurement Lead',
  'Director of IT',
  'Chief Operating Officer',
  'Supply Chain Manager',
  'Plant Manager',
  'Head of Data',
  'Commercial Director',
  'Facilities Lead',
];

const STAGES = [
  'Prospecting',
  'Qualification',
  'Needs Analysis',
  'Proposal',
  'Negotiation',
  'Closed Won',
  'Closed Lost',
];

const STAGE_PROBABILITY: Record<string, number> = {
  Prospecting: 10,
  Qualification: 25,
  'Needs Analysis': 40,
  Proposal: 60,
  Negotiation: 80,
  'Closed Won': 100,
  'Closed Lost': 0,
};

const SEGMENTS = ['Enterprise', 'Mid-Market', 'SMB'];
const CITIES: Record<string, string[]> = {
  West: ['San Francisco', 'Seattle', 'Portland', 'Denver', 'Phoenix'],
  East: ['Boston', 'New York', 'Philadelphia', 'Atlanta', 'Miami'],
  North: ['Toronto', 'Minneapolis', 'Chicago', 'Detroit', 'Montreal'],
  South: ['Austin', 'Houston', 'Nashville', 'Charlotte', 'New Orleans'],
  Central: ['Kansas City', 'St. Louis', 'Omaha', 'Tulsa', 'Des Moines'],
};

function salesforceId(prefix: string, index: number): string {
  return `${prefix}${index.toString(36).toUpperCase().padStart(12, '0')}`;
}

function isoDay(offsetDays: number): string {
  const base = Date.UTC(2026, 0, 1);
  return new Date(base + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Quarter-end weighting. Deal value clusters in the last month of each quarter,
 * which is what makes a pipeline chart look like a pipeline rather than noise.
 */
function seasonalMultiplier(dayOfYear: number): number {
  const monthIndex = Math.floor((dayOfYear % 365) / 30.4);
  const quarterEnd = monthIndex % 3 === 2;
  return quarterEnd ? between(1.3, 1.9) : between(0.7, 1.15);
}

interface Account {
  Id: string;
  TenantId: string;
  Name: string;
  Industry: string;
  Territory: string;
  OwnerId: string;
  AnnualRevenue: number;
  NumberOfEmployees: number;
  Segment: string;
  BillingCity: string;
  CreatedDate: string;
}

interface Contact {
  Id: string;
  TenantId: string;
  AccountId: string;
  FirstName: string;
  LastName: string;
  Name: string;
  Email: string;
  Phone: string;
  Title: string;
  Territory: string;
  OwnerId: string;
  CreatedDate: string;
}

interface Opportunity {
  Id: string;
  TenantId: string;
  AccountId: string;
  Name: string;
  StageName: string;
  Amount: number;
  Probability: number;
  CloseDate: string;
  Territory: string;
  OwnerId: string;
  ForecastCategory: string;
  CreatedDate: string;
}

function generate(): { accounts: Account[]; contacts: Contact[]; opportunities: Opportunity[] } {
  const accounts: Account[] = [];
  const contacts: Contact[] = [];
  const opportunities: Opportunity[] = [];

  let accountSeq = 1;
  let contactSeq = 1;
  let opportunitySeq = 1;

  for (const tenant of TENANTS) {
    const tenantAccounts: Account[] = [];

    for (let i = 0; i < tenant.accounts; i += 1) {
      const owner = tenant.owners[i % tenant.owners.length] as Owner;
      const name = `${pick(ACCOUNT_PREFIXES)} ${pick(ACCOUNT_SUFFIXES)}`;
      const segment = pick(SEGMENTS);
      const account: Account = {
        Id: salesforceId('001', accountSeq++),
        TenantId: tenant.tenantId,
        Name: name,
        Industry: pick(INDUSTRIES),
        Territory: owner.territory,
        OwnerId: owner.id,
        AnnualRevenue: Math.round(
          segment === 'Enterprise'
            ? between(250_000_000, 4_000_000_000)
            : segment === 'Mid-Market'
              ? between(25_000_000, 250_000_000)
              : between(1_000_000, 25_000_000),
        ),
        NumberOfEmployees: intBetween(20, 25_000),
        Segment: segment,
        BillingCity: pick(CITIES[owner.territory] ?? ['Springfield']),
        CreatedDate: isoDay(-intBetween(200, 1_400)),
      };
      accounts.push(account);
      tenantAccounts.push(account);
    }

    for (let i = 0; i < tenant.contacts; i += 1) {
      const account = tenantAccounts[i % tenantAccounts.length] as Account;
      const firstName = pick(FIRST_NAMES);
      const lastName = pick(LAST_NAMES);
      const domain = account.Name.toLowerCase().replace(/[^a-z]+/g, '') || 'example';
      contacts.push({
        Id: salesforceId('003', contactSeq++),
        TenantId: tenant.tenantId,
        AccountId: account.Id,
        FirstName: firstName,
        LastName: lastName,
        Name: `${firstName} ${lastName}`,
        Email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${domain}.example`,
        Phone: `+1-${intBetween(200, 989)}-${intBetween(200, 999)}-${String(intBetween(0, 9999)).padStart(4, '0')}`,
        Title: pick(TITLES),
        Territory: account.Territory,
        // Contacts follow the account they belong to, as they do in a real CRM.
        OwnerId: account.OwnerId,
        CreatedDate: isoDay(-intBetween(30, 900)),
      });
    }

    for (let i = 0; i < tenant.opportunities; i += 1) {
      const account = tenantAccounts[i % tenantAccounts.length] as Account;
      const stage = pick(STAGES);
      const closeOffset = intBetween(-120, 180);
      const amount = Math.round(
        between(15_000, account.Segment === 'Enterprise' ? 1_200_000 : 220_000) *
          seasonalMultiplier(Math.abs(closeOffset)),
      );
      opportunities.push({
        Id: salesforceId('006', opportunitySeq++),
        TenantId: tenant.tenantId,
        AccountId: account.Id,
        Name: `${account.Name} — ${pick(['Renewal', 'Expansion', 'New Business', 'Upgrade', 'Pilot'])} ${2026 + Math.floor(closeOffset / 365)}`,
        StageName: stage,
        Amount: amount,
        Probability: STAGE_PROBABILITY[stage] ?? 50,
        CloseDate: isoDay(closeOffset),
        Territory: account.Territory,
        OwnerId: account.OwnerId,
        ForecastCategory:
          stage === 'Closed Won'
            ? 'Closed'
            : stage === 'Closed Lost'
              ? 'Omitted'
              : (STAGE_PROBABILITY[stage] ?? 0) >= 60
                ? 'Commit'
                : 'Pipeline',
        CreatedDate: isoDay(closeOffset - intBetween(30, 210)),
      });
    }
  }

  return { accounts, contacts, opportunities };
}

async function main(): Promise<void> {
  const { accounts, contacts, opportunities } = generate();
  const dir = new URL('./', import.meta.url);

  await writeFile(new URL('accounts.json', dir), `${JSON.stringify(accounts, null, 2)}\n`);
  await writeFile(new URL('contacts.json', dir), `${JSON.stringify(contacts, null, 2)}\n`);
  await writeFile(
    new URL('opportunities.json', dir),
    `${JSON.stringify(opportunities, null, 2)}\n`,
  );

  console.log(
    `Wrote ${accounts.length} accounts, ${contacts.length} contacts, ${opportunities.length} opportunities`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
