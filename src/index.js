const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 1. PRIMERO: Servir archivos estáticos (para que cargue tu index.html al entrar a la raíz)
app.use(express.static('public'));

// 2. SEGUNDO: Cambiamos la ruta raíz o la movemos a '/api/status' para no chocar con el HTML
app.get('/api/status', (req, res) => {
  res.json({ mensaje: '¡El servidor del sistema de inventario está en línea!' });
});

// Ruta para probar la base de datos y consultar el usuario administrador
app.get('/api/usuarios', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT id, nombre, correo, rol FROM usuarios');
    res.json(resultado.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al consultar la base de datos' });
  }
});

// Ruta para registrar un nuevo producto
app.post('/api/productos', async (req, res) => {
  try {
    const { sku, nombre, categoria_id, stock_actual, stock_minimo, precio_costo } = req.body;
    
    const nuevoProducto = await pool.query(
      `INSERT INTO productos (sku, nombre, categoria_id, stock_actual, stock_minimo, precio_costo) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [sku, nombre, categoria_id, stock_actual, stock_minimo, precio_costo]
    );

    res.status(201).json(nuevoProducto.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al registrar el producto (verifica que el SKU sea único y la categoría exista)' });
  }
});

// Ruta para listar todos los productos del inventario
app.get('/api/productos', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM productos ORDER BY id ASC');
    res.json(resultado.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener los productos' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});// Ruta para listar todas las categorías
app.get('/api/categorias', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM categorias ORDER BY id ASC');
    res.json(resultado.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener las categorías' });
  }
});

// Ruta para registrar una entrada de inventario (y sumar stock al producto)
app.post('/api/entradas', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // Iniciar transacción segura

    const { producto_id, cantidad, costo_unitario } = req.body;

    // 1. Registrar la entrada
    const nuevaEntrada = await client.query(
      `INSERT INTO entradas (producto_id, cantidad, costo_unitario) 
       VALUES ($1, $2, $3) RETURNING *`,
      [producto_id, cantidad, costo_unitario]
    );

    // 2. Actualizar el stock actual del producto sumando la cantidad entrante
    await client.query(
      `UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2`,
      [cantidad, producto_id]
    );

    await client.query('COMMIT'); // Confirmar transacción
    res.status(201).json(nuevaEntrada.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK'); // Revertir si hay error
    console.error(error);
    res.status(500).json({ error: 'Error al registrar la entrada de inventario' });
  }
});

// Ruta para listar el historial de entradas
app.get('/api/entradas', async (req, res) => {
  try {
    const resultado = await pool.query(`
      SELECT e.id, p.nombre AS producto, e.cantidad, e.costo_unitario, e.fecha 
      FROM entradas e 
      JOIN productos p ON e.producto_id = p.id 
      ORDER BY e.id DESC
    `);
    res.json(resultado.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener el historial de entradas' });
  }
});// Ruta para registrar una nueva categoría
app.post('/api/categorias', async (req, res) => {
  try {
    const { nombre } = req.body;
    const nuevaCategoria = await pool.query(
      `INSERT INTO categorias (nombre) VALUES ($1) RETURNING *`,
      [nombre]
    );
    res.status(201).json(nuevaCategoria.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al registrar la categoría' });
  }
});