const { Pool } = require('pg');
require('dotenv').config();

// Imprimimos para verificar en los logs de Render si la URL está llegando
console.log("DATABASE_URL configurada:", process.env.DATABASE_URL ? "SÍ ESTÁ PRESENTE" : "ESTÁ VACÍA O FALTANTE");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  family: 4 // Fuerza IPv4
});

module.exports = pool;