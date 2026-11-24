import { Pool } from 'pg';
import { databaseConnectionUrl } from '../../../../packages/core/src/modules/database/topology.ts';

/** The database function can delete only UUID-scoped release fixtures. */
export function createCleanup(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required for cleanup.');
  const url = new URL(databaseConnectionUrl(connectionString));
  // Neon transaction pooling cannot retain a session advisory lock. Keep the exact
  // endpoint, database and runtime login, using its direct hostname for this one session.
  if (url.hostname.endsWith('.neon.tech')) url.hostname = url.hostname.replace('-pooler.', '.');
  const pool = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000, idleTimeoutMillis: 1000, allowExitOnIdle: true });
  let client; let fixtureId; let lost = false;
  const lifetime = new AbortController();
  const disconnected = () => { lost = true; lifetime.abort(); };
  const query = (text, values) => {
    if (lost) throw new Error('Release fixture lock connection was lost.');
    return (client ?? pool).query(text, values);
  };
  async function release() {
    if (!client) return;
    try {
      if (!lost) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`blast:partner-release:${fixtureId}`]);
    } finally {
      client.removeListener('error', disconnected);
      // Never return a possibly still-locked session to the pool after an unlock failure.
      client.release(true);
      client = undefined; fixtureId = undefined;
    }
  }
  async function remove(label) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await query('SELECT public.partner_cleanup_release_fixture($1::text)', [label]);
        return;
      } catch { if (attempt === 2) throw new Error('Primary cleanup unavailable.'); }
    }
  }
  return {
    signal: lifetime.signal,
    async claim(id) {
      if (client || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
        throw new Error('Invalid release fixture lock request.');
      client = await pool.connect(); fixtureId = id;
      client.on('error', disconnected);
      try {
        const result = await query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`blast:partner-release:${id}`]);
        if (result.rows[0]?.locked === true) return true;
        await release();
        return false;
      } catch (error) { await release(); throw error; }
    },
    async prove(partnerId) {
      if (!client) throw new Error('Release fixture lock is required.');
      const result = await query('SELECT 1 FROM public.partner_api_partners WHERE id = $1', [partnerId]);
      return result.rowCount === 1;
    },
    release,
    // A killed build cannot run finally. The next gate reaps abandoned runs older than an hour.
    stale: () => remove(null),
    run: label => remove(label),
    async close() { try { await release(); } finally { await pool.end(); } },
  };
}
