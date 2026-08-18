const { Pool } = require('pg');
require('dotenv').config();

// Si tienes una variable DATABASE_URL en Render, la usamos; si no, usamos los parámetros individuales
const connectionString = process.env.DATABASE_URL;

const pool = new Pool(
  connectionString 
    ? { 
        connectionString, 
        ssl: { rejectUnauthorized: false },
        family: 4 // Fuerza IPv4
      } 
    : {
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT || 6543,
        ssl: { rejectUnauthorized: false },
        family: 4 // Fuerza IPv4 para evitar el error ENETUNREACH
      }
);

module.exports = pool;