const { Pool } = require('pg');
const path = require('path');
// Le decimos exactamente dónde está el archivo .env (en la carpeta principal)
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  console.error('🚨 ERROR CRÍTICO: No se está leyendo la DATABASE_URL del archivo .env');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on('connect', () => {
  console.log('✅ Base de datos conectada correctamente (con soporte SSL)');
});

pool.on('error', (err) => {
  console.error('❌ Error inesperado en el cliente de base de datos:', err);
});

module.exports = pool;