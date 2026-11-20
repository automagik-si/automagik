import { readdir, readFile } from 'node:fs/promises';
import { unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';
import type { Miniflare } from 'miniflare';

export async function migrate(db: Awaited<ReturnType<Miniflare['getD1Database']>>, names?: string[]) {
  const migrations = names ?? (await readdir('migrations')).filter(file => file.endsWith('.sql')).sort();
  for (const name of migrations) {
    const migration = await readFile(`migrations/${name}`, 'utf8');
    for (const sql of splitSqlQuery(migration)) await db.prepare(sql).run();
  }
}
