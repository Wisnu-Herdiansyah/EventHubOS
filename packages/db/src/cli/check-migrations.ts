import { lintMigration, loadMigrations } from '../migrate.ts';

// Static migration gate for CI: naming, contiguity, and destructive-statement lint.
const migrations = await loadMigrations();
let failed = false;
for (const m of migrations) {
  const findings = lintMigration(m.sql);
  if (findings.length > 0) {
    failed = true;
    process.stderr.write(
      `${m.version}_${m.name}: destructive/isolation-weakening statements without justification: ${findings.join(', ')}\n`,
    );
  }
}
if (failed) process.exit(1);
process.stdout.write(`migrations ok: ${migrations.length} file(s) checked\n`);
