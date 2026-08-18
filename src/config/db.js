const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
  ssl: {
    rejectUnauthorized: false
  },
  // Forzar el uso de IPv4 para evitar el error de red en Render
  connectionTimeoutMillis: 5000,
  keepAlive: true,
  family: 4 
});

module.exports = pool;