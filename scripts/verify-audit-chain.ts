/**
 * Walks the audit hash chain and reports the first break.
 *
 * Usage:
 *   pnpm verify:audit                       verify every tenant
 *   pnpm verify:audit --tenant acme-corp    verify one tenant
 *   pnpm verify:audit --corrupt-row 42      alter row 42, verify, then restore
 *   pnpm verify:audit --json                machine-readable output
 *
 * `--corrupt-row` exists to make the guarantee checkable rather than asserted.
 * Note what it has to do to succeed: disable the guard trigger, which requires
 * table ownership. The application role cannot reach this code path at all, and
 * the restore afterwards leaves the chain valid again.
 */
import { verifyAllChains, verifyTenantChain, type ChainVerificationResult } from '@mcpgateway/audit';
import { createDatabase } from '@mcpgateway/shared/db';
import { sql } from 'drizzle-orm';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://mcpgw:mcpgw@localhost:5432/mcpgateway';

const RESET = '[0m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = '[33m';
const DIM = '[2m';
const BOLD = '[1m';

interface Options {
  readonly tenant: string | null;
  readonly corruptRow: number | null;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  let tenant: string | null = null;
  let corruptRow: number | null = null;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tenant') tenant = argv[++i] ?? null;
    else if (arg === '--corrupt-row') corruptRow = Number.parseInt(argv[++i] ?? '', 10);
    else if (arg === '--json') json = true;
  }

  return { tenant, corruptRow: Number.isFinite(corruptRow) ? corruptRow : null, json };
}

function report(result: ChainVerificationResult): void {
  const status = result.valid ? `${GREEN}VALID${RESET}` : `${RED}BROKEN${RESET}`;
  console.log(
    `  ${BOLD}${result.tenantId.padEnd(14)}${RESET} ${status}  ${result.rowsChecked} rows  ${DIM}${result.durationMs.toFixed(1)}ms${RESET}`,
  );

  if (result.firstBreak) {
    const failure = result.firstBreak;
    console.log(`      ${RED}first break at seq ${failure.seq ?? '(tail)'}${RESET}`);
    console.log(`      row      ${failure.id}`);
    console.log(`      reason   ${failure.reason}`);
    console.log(`      expected ${failure.expected}`);
    console.log(`      actual   ${failure.actual}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const handle = createDatabase(DATABASE_URL);

  try {
    if (options.corruptRow !== null) {
      await runTamperCheck(handle, options);
      return;
    }

    const results = options.tenant
      ? [await verifyTenantChain(handle.db, options.tenant)]
      : await verifyAllChains(handle.db);

    if (options.json) {
      console.log(JSON.stringify({ chains: results, allValid: results.every((r) => r.valid) }, null, 2));
    } else {
      console.log(`\n${BOLD}Audit chain verification${RESET}\n`);
      if (results.length === 0) console.log(`  ${DIM}No audit events found.${RESET}`);
      for (const result of results) report(result);
      const total = results.reduce((sum, result) => sum + result.rowsChecked, 0);
      console.log(
        `\n  ${results.every((r) => r.valid) ? GREEN + 'All chains verified' : RED + 'One or more chains are broken'}${RESET} ${DIM}(${total} rows)${RESET}\n`,
      );
    }

    process.exitCode = results.every((result) => result.valid) ? 0 : 1;
  } finally {
    await handle.close();
  }
}

async function runTamperCheck(
  handle: ReturnType<typeof createDatabase>,
  options: Options,
): Promise<void> {
  const seq = options.corruptRow;
  if (seq === null) return;

  const target = await handle.db.execute<
    { id: string; tenant_id: string; latency_ms: number; decision: string } & Record<string, unknown>
  >(sql`SELECT id, tenant_id, latency_ms, decision FROM audit_events WHERE seq = ${seq}`);

  const row = target.rows[0];
  if (!row) {
    console.error(`${RED}No audit row with seq ${seq}.${RESET}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n${BOLD}Tamper detection check${RESET}\n`);
  console.log(`  Target   row seq ${seq} (${row.id}) in tenant ${row.tenant_id}`);

  const before = await verifyTenantChain(handle.db, row.tenant_id);
  console.log(`  Before   ${before.valid ? GREEN + 'VALID' : RED + 'BROKEN'}${RESET} (${before.rowsChecked} rows)`);

  console.log(
    `\n  ${YELLOW}Altering the row.${RESET} ${DIM}This first has to disable the guard trigger, which`,
  );
  console.log(`  requires ownership of the table — the gateway's own role cannot do it.${RESET}\n`);

  const tamperedLatency = Number(row.latency_ms) + 1;
  await handle.db.execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update`);
  try {
    await handle.db.execute(sql`
      UPDATE audit_events SET latency_ms = ${tamperedLatency} WHERE seq = ${seq}
    `);

    const after = await verifyTenantChain(handle.db, row.tenant_id);
    console.log(`  After    ${after.valid ? GREEN + 'VALID' : RED + 'BROKEN'}${RESET}`);
    if (after.firstBreak) {
      console.log(`\n  ${RED}Detected:${RESET}`);
      console.log(`      first break at seq ${after.firstBreak.seq ?? '(tail)'}`);
      console.log(`      row      ${after.firstBreak.id}`);
      console.log(`      reason   ${after.firstBreak.reason}`);
      console.log(`      expected ${after.firstBreak.expected}`);
      console.log(`      actual   ${after.firstBreak.actual}`);
      console.log(
        `\n  ${DIM}One field changed by one millisecond, and the chain no longer verifies.${RESET}`,
      );
    }

    // Restore, so the check leaves nothing behind.
    await handle.db.execute(sql`
      UPDATE audit_events SET latency_ms = ${Number(row.latency_ms)} WHERE seq = ${seq}
    `);
    const restored = await verifyTenantChain(handle.db, row.tenant_id);
    console.log(
      `\n  Restored ${restored.valid ? GREEN + 'VALID' : RED + 'STILL BROKEN'}${RESET}\n`,
    );

    process.exitCode = after.valid || !restored.valid ? 1 : 0;
  } finally {
    await handle.db.execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
