const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'db.bwgkgpvkdmgosocudgbi.supabase.co',
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'Skubal$$..%%',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 6543,
  ssl: {
    rejectUnauthorized: false
  },
  family: 4 // Fuerza IPv4 estrictamente
});

module.exports = pool;