const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const pool = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'secreto_super_seguro';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (req, res) => res.redirect('/login.html'));

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

// Middleware de control de roles (RBAC)
function verificarRol(rolesPermitidos) {
    return (req, res, next) => {
        if (!req.user || !rolesPermitidos.includes(req.user.rol)) {
            return res.status(403).json({ error: 'Acceso denegado: No tienes permisos suficientes.' });
        }
        next();
    };
}

// 1. REGISTRO DE USUARIOS (Solo Admin)
app.post('/api/usuarios', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    const { nombre, correo, password, rol } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const query = `INSERT INTO usuarios (nombre, correo, password, rol) VALUES ($1, $2, $3, $4) RETURNING id, nombre, correo, rol`;
        const nuevoUsuario = await pool.query(query, [nombre, correo, hashedPassword, rol || 'Consulta']);
        res.status(201).json({ mensaje: 'Usuario registrado con éxito', usuario: nuevoUsuario.rows[0] });
    } catch (error) {
        res.status(500).json({ error: 'El correo ya está registrado o hubo un error' });
    }
});

// LISTAR USUARIOS (Solo Admin)
app.get('/api/usuarios', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    try {
        const resultado = await pool.query('SELECT id, nombre, correo, rol FROM usuarios ORDER BY nombre ASC');
        res.json(resultado.rows);
    } catch (error) {
        res.status(500).json({ error: 'Error al consultar usuarios' });
    }
});

// EDITAR USUARIO / RESTABLECER CLAVE (Solo Admin)
app.put('/api/usuarios/:id', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    const { id } = req.params;
    const { nombre, correo, password, rol } = req.body;
    try {
        if (password && password.trim() !== "") {
            const hashedPassword = await bcrypt.hash(password, 10);
            await pool.query(
                `UPDATE usuarios SET nombre = $1, correo = $2, password = $3, rol = $4 WHERE id = $5`,
                [nombre, correo, hashedPassword, rol, id]
            );
        } else {
            await pool.query(
                `UPDATE usuarios SET nombre = $1, correo = $2, rol = $3 WHERE id = $4`,
                [nombre, correo, rol, id]
            );
        }
        res.json({ mensaje: 'Usuario actualizado con éxito' });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar el usuario' });
    }
});

// ELIMINAR USUARIO (Solo Admin)
app.delete('/api/usuarios/:id', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    const { id } = req.params;
    try {
        if (req.user.id == id) {
            return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta de administrador.' });
        }
        await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
        res.json({ mensaje: 'Usuario eliminado correctamente' });
    } catch (error) {
        res.status(500).json({ error: 'Error al eliminar el usuario' });
    }
});

// 2. LOGIN
app.post('/api/login', async (req, res) => {
    const { correo, password } = req.body;
    try {
        const resultado = await pool.query('SELECT * FROM usuarios WHERE correo = $1', [correo]);
        if (resultado.rows.length === 0) return res.status(400).json({ error: 'Credenciales incorrectas' });

        const usuario = resultado.rows[0];
        const passwordValido = await bcrypt.compare(password, usuario.password);
        if (!passwordValido) return res.status(400).json({ error: 'Credenciales incorrectas' });

        const token = jwt.sign({ id: usuario.id, correo: usuario.correo, rol: usuario.rol }, JWT_SECRET, { expiresIn: '8h' });
        res.json({ token, usuario: { id: usuario.id, nombre: usuario.nombre, correo: usuario.correo, rol: usuario.rol } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. DASHBOARD - INVENTARIO POR LOTES
app.get('/api/inventario-lotes', verificarToken, async (req, res) => {
    try {
        const query = `
            SELECT e.id AS lote_id, p.sku, p.nombre, c.nombre AS categoria_nombre, 
                   e.stock_restante, e.costo_unitario
            FROM entradas e
            JOIN productos p ON e.producto_id = p.id
            LEFT JOIN categorias c ON p.categoria_id = c.id
            WHERE e.stock_restante > 0
            ORDER BY p.nombre ASC, e.fecha ASC;
        `;
        const resultado = await pool.query(query);
        res.json(resultado.rows);
    } catch (error) {
        res.status(500).json({ error: 'Error al consultar las existencias' });
    }
});

// 4. CREAR PRODUCTO
app.post('/api/productos', verificarToken, verificarRol(['Administrador', 'Supervisor']), async (req, res) => {
    const { sku, nombre, categoria_id } = req.body;
    try {
        const query = `INSERT INTO productos (sku, nombre, categoria_id, stock_actual, stock_minimo, precio_costo) VALUES ($1, $2, $3, 0, 5, 0) RETURNING *`;
        const resultado = await pool.query(query, [sku, nombre, categoria_id || 1]);
        res.status(201).json({ mensaje: 'Producto creado', producto: resultado.rows[0] });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(400).json({ error: 'El código SKU ya está registrado en otro producto.' });
        }
        res.status(500).json({ error: 'Error al crear el producto' });
    }
});

// 5. LISTAR PRODUCTOS
app.get('/api/productos', verificarToken, async (req, res) => {
    try {
        const resultado = await pool.query('SELECT id, sku, nombre FROM productos ORDER BY nombre ASC');
        res.json(resultado.rows);
    } catch (error) {
        res.status(500).json({ error: 'Error al listar productos' });
    }
});

// 6. REGISTRAR LOTE (ENTRADAS)
app.post('/api/entradas', verificarToken, verificarRol(['Administrador', 'Supervisor']), async (req, res) => {
    const { producto_id, cantidad, costo_unitario } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await client.query(
            `UPDATE productos SET stock_actual = stock_actual + $1, precio_costo = $2 WHERE id = $3`,
            [cantidad, costo_unitario, producto_id]
        );

        const entradaResult = await client.query(
            `INSERT INTO entradas (producto_id, cantidad, costo_unitario, stock_restante) VALUES ($1, $2, $3, $4) RETURNING id`,
            [producto_id, cantidad, costo_unitario, cantidad]
        );

        await client.query('COMMIT');
        res.status(201).json({ mensaje: 'Lote registrado con éxito', entradaId: entradaResult.rows[0].id });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error al procesar la entrada' });
    } finally {
        client.release();
    }
});

// 6.1 REGISTRAR SALIDAS (FIFO - Descontando lotes activos)
app.post('/api/salidas', verificarToken, verificarRol(['Administrador', 'Supervisor']), async (req, res) => {
    const { producto_id, cantidad, concepto } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        let cantidadPendiente = parseInt(cantidad);

        const lotesRes = await client.query(
            `SELECT id, stock_restante FROM entradas WHERE producto_id = $1 AND stock_restante > 0 ORDER BY fecha ASC FOR UPDATE`,
            [producto_id]
        );

        const stockTotalDisponible = lotesRes.rows.reduce((acc, lote) => acc + lote.stock_restante, 0);

        if (stockTotalDisponible < cantidadPendiente) {
            throw new Error(`Stock insuficiente. Stock disponible: ${stockTotalDisponible}, solicitado: ${cantidadPendiente}`);
        }

        await client.query(
            `INSERT INTO salidas (producto_id, cantidad, concepto, fecha) VALUES ($1, $2, $3, NOW())`,
            [producto_id, cantidad, concepto]
        );

        for (const lote of lotesRes.rows) {
            if (cantidadPendiente <= 0) break;

            if (lote.stock_restante >= cantidadPendiente) {
                await client.query(
                    `UPDATE entradas SET stock_restante = stock_restante - $1 WHERE id = $2`,
                    [cantidadPendiente, lote.id]
                );
                cantidadPendiente = 0;
            } else {
                cantidadPendiente -= lote.stock_restante;
                await client.query(
                    `UPDATE entradas SET stock_restante = 0 WHERE id = $1`,
                    [lote.id]
                );
            }
        }

        await client.query('COMMIT');
        res.status(201).json({ mensaje: 'Salida registrada y lotes descontados correctamente' });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: error.message || 'Error al procesar salida' });
    } finally {
        client.release();
    }
});

// 7. CATEGORÍAS
app.post('/api/categorias', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    const { nombre } = req.body;
    try {
        const resultado = await pool.query(`INSERT INTO categorias (nombre) VALUES ($1) RETURNING *`, [nombre]);
        res.status(201).json({ mensaje: 'Categoría registrada', categoria: resultado.rows[0] });
    } catch (error) {
        res.status(500).json({ error: 'Error al registrar categoría' });
    }
});

app.get('/api/categorias', verificarToken, async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM categorias ORDER BY nombre ASC');
        res.json(resultado.rows);
    } catch (error) {
        res.status(500).json({ error: 'Error al consultar categorías' });
    }
});

// 8. REPORTES HISTORIALES
app.get('/api/reporte/entradas', verificarToken, async (req, res) => {
    try {
        const query = `
            SELECT e.id, p.sku, p.nombre AS producto_nombre, e.cantidad, e.costo_unitario, e.stock_restante, e.fecha
            FROM entradas e
            JOIN productos p ON e.producto_id = p.id
            ORDER BY e.fecha DESC;
        `;
        const resultado = await pool.query(query);
        res.json(resultado.rows);
    } catch (error) {
        res.status(500).json({ error: 'Error al consultar el historial de entradas' });
    }
});

app.get('/api/reporte/salidas', verificarToken, async (req, res) => {
    try {
        const query = `
            SELECT s.id, p.sku, p.nombre AS producto_nombre, s.cantidad, s.concepto, s.fecha
            FROM salidas s
            JOIN productos p ON s.producto_id = p.id
            ORDER BY s.fecha DESC;
        `;
        const resultado = await pool.query(query);
        res.json(resultado.rows);
    } catch (error) {
        res.status(500).json({ error: 'Error al consultar el historial de salidas' });
    }
});

// 9. DESCARGAR REPORTE EXCEL (Con ID de Lote)
app.get('/api/reporte-salidas', verificarToken, async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Inventario por Lotes');
        worksheet.columns = [
            { header: 'SKU', key: 'sku', width: 15 },
            { header: 'Producto', key: 'nombre', width: 30 },
            { header: 'Lote ID', key: 'lote_id', width: 15 },
            { header: 'Categoría', key: 'categoria_nombre', width: 20 },
            { header: 'Stock Restante', key: 'stock_restante', width: 15 },
            { header: 'Costo Unitario ($)', key: 'costo_unitario', width: 18 }
        ];

        const query = `
            SELECT p.sku, p.nombre, e.id AS lote_id, c.nombre AS categoria_nombre, 
                   e.stock_restante, e.costo_unitario
            FROM entradas e
            JOIN productos p ON e.producto_id = p.id
            LEFT JOIN categorias c ON p.categoria_id = c.id
            WHERE e.stock_restante > 0
            ORDER BY p.nombre ASC;
        `;
        const resultado = await pool.query(query);
        worksheet.addRows(resultado.rows);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="reporte_inventario_lotes.xlsx"');
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        res.status(500).json({ error: 'Error al generar reporte' });
    }
});

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT} blindado y seguro`));