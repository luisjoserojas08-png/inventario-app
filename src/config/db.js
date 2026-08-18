const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  family: 4 // ESTO ES LA CLAVE: Fuerza IPv4 y evita el error ENETUNREACH en Render
});

module.exports = pool;