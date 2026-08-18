const { Pool } = require('pg');
require('dotenv').config();

// Extraemos los datos de la URL o usamos variables individuales si existen,
// pero configuramos explícitamente el host, puerto y family: 4 para IPv4.
const pool = new Pool({
  host: process.env.DB_HOST || 'db.bwgkgpvkdmgosocudgbi.supabase.co',
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'Skubal$$..%%',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 6543,
  ssl: {
    rejectUnauthorized: false
  },
  family: 4 // OBLIGA al sistema a usar IPv4 y evita el error ENETUNREACH en Render
});

module.exports = pool;