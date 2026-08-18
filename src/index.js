const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 1. Servir archivos estáticos (Frontend)
app.use(express.static('public'));

// --- RUTAS DE CATEGORÍAS ---
app.get('/api/categorias', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM categorias ORDER BY nombre ASC');
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener las categorías' });
  }
});

app.post('/api/categorias', async (req, res) => {
  try {
    const { nombre } = req.body;
    const nueva = await pool.query('INSERT INTO categorias (nombre) VALUES ($1) RETURNING *', [nombre]);
    res.status(201).json(nueva.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al registrar la categoría' });
  }
});

// --- RUTAS DE PRODUCTOS ---
app.get('/api/productos', async (req, res) => {
  try {
    // Traemos el producto junto con el nombre de su categoría
    const query = `
      SELECT p.*, c.nombre as categoria_nombre 
      FROM productos p 
      LEFT JOIN categorias c ON p.categoria_id = c.id 
      ORDER BY p.id ASC`;
    const resultado = await pool.query(query);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener los productos' });
  }
});

app.post('/api/productos', async (req, res) => {
  try {
    const { sku, nombre, categoria_id, stock_actual, stock_minimo, precio_costo } = req.body;
    const nuevo = await pool.query(
      `INSERT INTO productos (sku, nombre, categoria_id, stock_actual, stock_minimo, precio_costo) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [sku, nombre, categoria_id, stock_actual, stock_minimo, precio_costo]
    );
    res.status(201).json(nuevo.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al registrar el producto. Verifica que el SKU no esté repetido.' });
  }
});

// --- MÓDULO DE ENTRADAS (COMPRAS/INGRESOS) ---
app.post('/api/entradas', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); 
    const { producto_id, cantidad, costo_unitario } = req.body;

    // 1. Registrar el movimiento
    await client.query(
      'INSERT INTO entradas (producto_id, cantidad, costo_unitario) VALUES ($1, $2, $3)',
      [producto_id, cantidad, costo_unitario]
    );
    // 2. Aumentar stock
    await client.query('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [cantidad, producto_id]);

    await client.query('COMMIT');
    res.status(201).json({ mensaje: 'Entrada registrada y stock actualizado' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Error al procesar la entrada' });
  } finally {
    client.release();
  }
});

// --- MÓDULO DE SALIDAS (VENTAS/MERMAS) ---
app.post('/api/salidas', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { producto_id, cantidad, motivo } = req.body;

    // 1. Validar que exista stock suficiente (Lógica SAP)
    const stockRes = await client.query('SELECT stock_actual FROM productos WHERE id = $1', [producto_id]);
    const stockActual = stockRes.rows[0].stock_actual;

    if (stockActual < cantidad) {
      throw new Error(`Stock insuficiente. Tienes ${stockActual} y quieres sacar ${cantidad}.`);
    }

    // 2. Registrar la salida
    await client.query(
      'INSERT INTO salidas (producto_id, cantidad, motivo) VALUES ($1, $2, $3)',
      [producto_id, cantidad, motivo]
    );
    // 3. Descontar stock
    await client.query('UPDATE productos SET stock_actual = stock_actual - $1 WHERE id = $2', [cantidad, producto_id]);

    await client.query('COMMIT');
    res.status(201).json({ mensaje: 'Salida registrada y stock actualizado' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: error.message || 'Error al procesar la salida' });
  } finally {
    client.release();
  }
});

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));