const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Ruta de bienvenida
app.get('/', (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});// Ruta para registrar un nuevo producto
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
});// Servir archivos estáticos de la carpeta public
app.use(express.static('public'));