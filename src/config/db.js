const { Pool } = require('pg');
require('dotenv').config();

console.log("DATABASE_URL configurada:", process.env.DATABASE_URL ? "SÍ ESTÁ PRESENTE" : "ESTÁ VACÍA O FALTANTE");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  family: 4, // Fuerza IPv4 a nivel de pool
  // Opciones adicionales para evitar que intente usar sockets IPv6
  keepAlive: true,
});

module.exports = pool;