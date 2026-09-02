import { readdir, readFile } from 'node:fs/promises';

import { ConfigurationError } from '@mcpgateway/shared';
import { parse as parseYaml } from 'yaml';

import { bundleSchema, type Bundle } from './schema.js';

const POLICY_DIR = new URL('../policies/', import.meta.url);

export interface PolicyCatalogue {
  readonly bundles: ReadonlyMap<string, Bundle>;
  get(name: string): Bundle;
  list(): Bundle[];
}

/**
 * Loads every bundle in `policies/` at boot.
 *
 * A malformed bundle fails the process rather than being skipped: a policy
 * engine that quietly runs with fewer rules than the operator wrote is worse
 * than one that refuses to start.
 */
export async function loadPolicies(dir: URL = POLICY_DIR): Promise<PolicyCatalogue> {
  const entries = await readdir(dir).catch(() => {
    throw new ConfigurationError(`Policy directory not found: ${dir.pathname}`);
  });

  const files = entries.filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'));
  if (files.length === 0) {
    throw new ConfigurationError(`No policy bundles found in ${dir.pathname}`);
  }

  const bundles = new Map<string, Bundle>();
  for (const file of files) {
    const raw = await readFile(new URL(file, dir), 'utf8');
    const parsed = bundleSchema.safeParse(parseYaml(raw));
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n');
      throw new ConfigurationError(`Invalid policy bundle '${file}':\n${issues}`);
    }

    const ids = new Set<string>();
    for (const rule of parsed.data.rules) {
      if (ids.has(rule.id)) {
        throw new ConfigurationError(`Duplicate rule id '${rule.id}' in bundle '${file}'`);
      }
      ids.add(rule.id);
    }

    bundles.set(parsed.data.name, parsed.data);
  }

  return {
    bundles,
    get: (name) => {
      const bundle = bundles.get(name);
      if (!bundle) throw new ConfigurationError(`Unknown policy bundle '${name}'`);
      return bundle;
    },
    list: () => [...bundles.values()],
  };
}
