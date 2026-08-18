const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('./config/db'); // Importa la conexión blindada con SSL

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'secreto_super_seguro';

app.use(cors());
app.use(express.json());

// Servir archivos estáticos desde la carpeta public
app.use(express.static(path.join(__dirname, '../public')));

// === NUEVA REGLA: Redirigir al login automáticamente al entrar a localhost:3000 ===
app.get('/', (req, res) => {
    res.redirect('/login.html');
});
// =================================================================================

// Middleware de autenticación por Token
function verificarToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Token requerido' });
    
    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Formato de token inválido' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token inválido o expirado' });
        req.user = user;
        next();
    });
}

// 1. REGISTRO DE USUARIOS
app.post('/api/usuarios', async (req, res) => {
    const { nombre, correo, password, rol } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const query = `INSERT INTO usuarios (nombre, correo, password, rol) VALUES ($1, $2, $3, $4) RETURNING id, nombre, correo, rol`;
        const values = [nombre, correo, hashedPassword, rol || 'Administrador'];
        const nuevoUsuario = await pool.query(query, values);
        
        res.status(201).json({ mensaje: 'Usuario registrado con éxito', usuario: nuevoUsuario.rows[0] });
    } catch (error) {
        console.error("Error en registro:", error);
        res.status(500).json({ error: 'El correo ya está registrado o hubo un error en la base de datos' });
    }
});

// 2. LOGIN DE USUARIOS
app.post('/api/login', async (req, res) => {
    const { correo, password } = req.body;
    try {
        const resultado = await pool.query('SELECT * FROM usuarios WHERE correo = $1', [correo]);
        if (resultado.rows.length === 0) {
            return res.status(400).json({ error: 'Credenciales incorrectas' });
        }

        const usuario = resultado.rows[0];
        const passwordValido = await bcrypt.compare(password, usuario.password);
        if (!passwordValido) {
            return res.status(400).json({ error: 'Credenciales incorrectas' });
        }

        const token = jwt.sign({ id: usuario.id, correo: usuario.correo, rol: usuario.rol }, JWT_SECRET, { expiresIn: '8h' });
        
        res.json({
            token,
            usuario: {
                id: usuario.id,
                nombre: usuario.nombre,
                correo: usuario.correo,
                rol: usuario.rol
            }
        });
    } catch (error) {
        console.error("ERROR EN LOGIN:", error);
        res.status(500).json({ error: error.message });
    }
});

// 3. OBTENER INVENTARIO ACTUAL POR LOTES (Dashboard)
app.get('/api/inventario-lotes', verificarToken, async (req, res) => {
    try {
        const query = `
            SELECT p.sku, p.nombre, c.nombre AS categoria_nombre, 
                   COALESCE(SUM(e.stock_restante), 0) AS stock_restante, 
                   COALESCE(e.costo_unitario, 0) AS costo_unitario
            FROM productos p
            LEFT JOIN categorias c ON p.categoria_id = c.id
            LEFT JOIN entradas e ON p.id = e.producto_id AND e.stock_restante > 0
            GROUP BY p.id, p.sku, p.nombre, c.nombre, e.costo_unitario
            ORDER BY p.nombre ASC;
        `;
        const resultado = await pool.query(query);
        res.json(resultado.rows);
    } catch (error) {
        console.error("Error al obtener inventario:", error);
        res.status(500).json({ error: 'Error al consultar las existencias' });
    }
});

// 4. REGISTRAR ENTRADA (Módulo de Compras tipo CM303)
app.post('/api/entradas', verificarToken, async (req, res) => {
    const { sku, nombre, categoria_id, cantidad, costo_unitario } = req.body;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Verificar si el producto ya existe o crearlo
        let prodResult = await client.query('SELECT id FROM productos WHERE sku = $1', [sku]);
        let productoId;

        if (prodResult.rows.length === 0) {
            const nuevoProd = await client.query(
                `INSERT INTO productos (sku, nombre, categoria_id, stock_actual, stock_minimo, precio_costo) 
                 VALUES ($1, $2, $3, $4, 5, $5) RETURNING id`,
                [sku, nombre, categoria_id || 1, cantidad, costo_unitario]
            );
            productoId = nuevoProd.rows[0].id;
        } else {
            productoId = prodResult.rows[0].id;
            await client.query(
                `UPDATE productos SET stock_actual = stock_actual + $1, precio_costo = $2 WHERE id = $3`,
                [cantidad, costo_unitario, productoId]
            );
        }

        // Registrar la entrada de lote
        const entradaResult = await client.query(
            `INSERT INTO entradas (producto_id, cantidad, costo_unitario, stock_restante) 
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [productoId, cantidad, costo_unitario, cantidad]
        );

        await client.query('COMMIT');
        res.status(201).json({ mensaje: 'Lote de entrada registrado con éxito', entradaId: entradaResult.rows[0].id });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error al registrar entrada:", error);
        res.status(500).json({ error: 'No se pudo procesar la entrada de inventario' });
    } finally {
        client.release();
    }
});

// Iniciar servidor local / nube
app.listen(PORT, () => {
    console.log(`Servidor en puerto ${PORT} blindado y seguro`);
});// 5. REGISTRAR NUEVA CATEGORÍA
app.post('/api/categorias', verificarToken, async (req, res) => {
    const { nombre } = req.body;
    try {
        const query = `INSERT INTO categorias (nombre) VALUES ($1) RETURNING *`;
        const resultado = await pool.query(query, [nombre]);
        res.status(201).json({ mensaje: 'Categoría registrada con éxito', categoria: resultado.rows[0] });
    } catch (error) {
        console.error("Error al registrar categoría:", error);
        res.status(500).json({ error: 'No se pudo registrar la categoría' });
    }
});

// 6. OBTENER TODAS LAS CATEGORÍAS (Para verlas en pantalla)
app.get('/api/categorias', verificarToken, async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM categorias ORDER BY nombre ASC');
        res.json(resultado.rows);
    } catch (error) {
        console.error("Error al obtener categorías:", error);
        res.status(500).json({ error: 'Error al consultar categorías' });
    }
});