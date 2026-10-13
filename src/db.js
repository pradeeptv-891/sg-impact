import pg from 'pg';

import config from '../config.js';

// bigint (series numbers) and numeric (amounts) come back as JS numbers. Both stay
// well inside the safe integer / 2-decimal range this add-on deals with.
pg.types.setTypeParser(pg.types.builtins.INT8, value => Number(value));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, value => Number(value));

let pool;

function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
      max: 5,
    });
    pool.on('error', err => console.error('Postgres pool error', err.message));
  }
  return pool;
}

/**
 * The only thing the rest of the app needs from Postgres. Tests swap in a PGlite
 * instance with the same `query` shape via setDb().
 */
let db = {
  query: (text, params) => getPool().query(text, params),
};

export function setDb(replacement) {
  db = replacement;
}

export function query(text, params) {
  return db.query(text, params);
}

export async function one(text, params) {
  const { rows } = await db.query(text, params);
  return rows[0] || null;
}

export async function many(text, params) {
  const { rows } = await db.query(text, params);
  return rows;
}
