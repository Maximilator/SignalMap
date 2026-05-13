import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const pool = new Pool({ connectionString: url });
const file = resolve(process.cwd(), '../../db/migrations/001_init.sql');
const sql = await readFile(file, 'utf8');

try {
  await pool.query(sql);
  console.log('Migration applied:', file);
} finally {
  await pool.end();
}
