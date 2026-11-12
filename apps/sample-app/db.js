import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  max: 5,
  connectionTimeoutMillis: 1500,
  query_timeout: 1500,
  idleTimeoutMillis: 10000
});

pool.on('error', (error) => {
  console.error('Unexpected idle PostgreSQL client error:', error.message);
});
