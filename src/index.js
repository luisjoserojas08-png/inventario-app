const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./config/db');
const ExcelJS = require('exceljs');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'clave_super_secreta_erp'; // Llave maestra para los tokens

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==========================================
// MÓDULO DE SEGURIDAD Y AUTENTICACIÓN
// ==========================================

// 1. Candado de Seguridad (Middleware)
const verificarToken = (req, res, next) => {
    // Busca el token en los encabezados de la petición
    const token = req.headers['authorization'];
    
    if (!token) {
        return res.status(403).json({ error: 'Acceso denegado: No enviaste un token de seguridad' });
    }

    try {
        // Quita la palabra "Bearer " si viene en el texto
        const tokenLimpio = token.split(" ")[1] || token;
        const decodificado = jwt.verify(tokenLimpio, JWT_SECRET);
        req.usuario = decodificado; // Guarda los datos del usuario para usarlos en la ruta
        next(); // Deja pasar la petición
    } catch (error) {
        return res.status(401).json({ error: 'Token inválido o expirado. Por favor inicia sesión de nuevo.' });
    }
};

// 2. Ruta para Crear un Usuario (Registro)
app.post('/api/usuarios', async (req, res) => {
    try {
        const { nombre, correo, password, rol } = req.body;

        // Encriptar la contraseña (10 rondas de seguridad)
        const salt = await bcrypt.genSalt(10);
        const passwordEncriptada = await bcrypt.hash(password, salt);

        const nuevoUsuario = await pool.query(
            `INSERT INTO usuarios (nombre, correo, password, rol) VALUES ($1, $2, $3, $4) RETURNING id, nombre, correo, rol`,
            [nombre, correo, passwordEncriptada, rol || 'Administrador']
        );

        res.status(201).json({ mensaje: 'Usuario creado con éxito', usuario: nuevoUsuario.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al registrar el usuario. Es posible que el correo ya exista.' });
    }
});

// 3. Ruta para Iniciar Sesión (Login)
app.post('/api/login', async (req, res) => {
    try {
        const { correo, password } = req.body;

        // Buscar al usuario por su correo
        const userRes = await pool.query('SELECT * FROM usuarios WHERE correo = $1', [correo]);
        if (userRes.rows.length === 0) {
            return res.status(400).json({ error: 'Correo o contraseña incorrectos' });
        }

        const usuario = userRes.rows[0];

        // Comparar la contraseña enviada con la encriptada en la base de datos
        const passwordValida = await bcrypt.compare(password, usuario.password);
        if (!passwordValida) {
            return res.status(400).json({ error: 'Correo o contraseña incorrectos' });
        }

        // Crear el Token (Gafete virtual)
        const token = jwt.sign(
            { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol }, 
            JWT_SECRET, 
            { expiresIn: '8h' } // Expira en 8 horas por seguridad
        );

        res.json({ mensaje: 'Bienvenido', token, usuario: { nombre: usuario.nombre, rol: usuario.rol } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al intentar iniciar sesión' });
    }
});

// ==========================================
// RUTAS DEL ERP (Ahora protegidas con "verificarToken")
// ==========================================

// Para proteger una ruta, solo agregamos "verificarToken" antes de la función (req, res).
// Aquí protegí la creación de categorías como ejemplo.

app.get('/api/categorias', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM categorias ORDER BY nombre ASC');
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener las categorías' });
  }
});

app.post('/api/categorias', verificarToken, async (req, res) => {
  try {
    const { nombre } = req.body;
    const nueva = await pool.query('INSERT INTO categorias (nombre) VALUES ($1) RETURNING *', [nombre]);
    res.status(201).json(nueva.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al registrar la categoría' });
  }
});

app.get('/api/productos', async (req, res) => {
  try {
    const query = `
      SELECT p.*, c.nombre as categoria_nombre 
      FROM productos p LEFT JOIN categorias c ON p.categoria_id = c.id 
      ORDER BY p.nombre ASC`;
    const resultado = await pool.query(query);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener los productos' });
  }
});

app.post('/api/productos', verificarToken, async (req, res) => {
  try {
    const { sku, nombre, categoria_id, stock_actual, stock_minimo, precio_costo } = req.body;
    const nuevo = await pool.query(
      `INSERT INTO productos (sku, nombre, categoria_id, stock_actual, stock_minimo, precio_costo) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [sku, nombre, categoria_id, stock_actual, stock_minimo, precio_costo]
    );
    res.status(201).json(nuevo.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al registrar el producto.' });
  }
});

app.get('/api/inventario-lotes', async (req, res) => {
  try {
    const query = `
      SELECT e.id as lote_id, p.sku, p.nombre, c.nombre as categoria_nombre, 
             e.stock_restante, e.costo_unitario, e.fecha, p.stock_minimo
      FROM entradas e JOIN productos p ON e.producto_id = p.id
      LEFT JOIN categorias c ON p.categoria_id = c.id
      WHERE e.stock_restante > 0 ORDER BY p.nombre ASC, e.fecha ASC
    `;
    const resultado = await pool.query(query);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener lotes' });
  }
});

app.post('/api/entradas', verificarToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); 
    const { producto_id, cantidad, costo_unitario } = req.body;
    await client.query('INSERT INTO entradas (producto_id, cantidad, costo_unitario, stock_restante) VALUES ($1, $2, $3, $4)', [producto_id, cantidad, costo_unitario, cantidad]);
    await client.query('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [cantidad, producto_id]);
    await client.query('COMMIT');
    res.status(201).json({ mensaje: 'Lote registrado con éxito' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Error al procesar la entrada' });
  } finally {
    client.release();
  }
});

app.post('/api/salidas', verificarToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let { producto_id, cantidad, motivo } = req.body;
    let cantidadFaltante = cantidad;

    const stockRes = await client.query('SELECT stock_actual FROM productos WHERE id = $1', [producto_id]);
    if (stockRes.rows[0].stock_actual < cantidad) throw new Error('Stock insuficiente.');

    const lotes = await client.query('SELECT id, stock_restante FROM entradas WHERE producto_id = $1 AND stock_restante > 0 ORDER BY fecha ASC', [producto_id]);

    for (let lote of lotes.rows) {
      if (cantidadFaltante === 0) break;
      let descontar = Math.min(lote.stock_restante, cantidadFaltante);
      cantidadFaltante -= descontar;
      await client.query('UPDATE entradas SET stock_restante = stock_restante - $1 WHERE id = $2', [descontar, lote.id]);
    }

    await client.query('INSERT INTO salidas (producto_id, cantidad, motivo) VALUES ($1, $2, $3)', [producto_id, cantidad, motivo]);
    await client.query('UPDATE productos SET stock_actual = stock_actual - $1 WHERE id = $2', [cantidad, producto_id]);

    await client.query('COMMIT');
    res.status(201).json({ mensaje: 'Salida registrada (FIFO)' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: error.message || 'Error en la salida' });
  } finally {
    client.release();
  }
});

app.get('/api/reporte-salidas', async (req, res) => {
  // Aquí mantengo libre el reporte para que puedas probar la descarga, pero luego podemos protegerlo.
  try {
    const query = `SELECT s.id, p.sku, p.nombre, s.cantidad, s.motivo, s.fecha FROM salidas s JOIN productos p ON s.producto_id = p.id ORDER BY s.fecha DESC`;
    const resultado = await pool.query(query);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Reporte');
    worksheet.columns = [
      { header: 'ID Movimiento', key: 'id', width: 15 }, { header: 'SKU', key: 'sku', width: 15 },
      { header: 'Producto', key: 'nombre', width: 30 }, { header: 'Cant. Retirada', key: 'cantidad', width: 15 },
      { header: 'Motivo / Documento', key: 'motivo', width: 35 }, { header: 'Fecha y Hora', key: 'fecha', width: 25 },
    ];
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF007BFF' } };
    
    resultado.rows.forEach(row => worksheet.addRow({ ...row, fecha: new Date(row.fecha).toLocaleString('es-VE') }));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Reporte_Salidas_Inventario.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ error: 'Error al generar Excel' });
  }
});

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT} blindado y seguro`));