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

// --- MIDDLEWARES ---
function verificarToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Token requerido' });
    const token = authHeader.split(' ')[1];
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token inválido' });
        req.user = user;
        next();
    });
}

function verificarRol(rolesPermitidos) {
    return (req, res, next) => {
        if (!req.user || !rolesPermitidos.includes(req.user.rol)) {
            return res.status(403).json({ error: 'Acceso denegado' });
        }
        next();
    };
}

// --- AUTENTICACIÓN ---
app.post('/api/login', async (req, res) => {
    const { correo, password } = req.body;
    try {
        const resdb = await pool.query('SELECT * FROM usuarios WHERE correo = $1', [correo]);
        if (resdb.rows.length === 0) return res.status(400).json({ error: 'Credenciales incorrectas' });
        const user = resdb.rows[0];
        if (!(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Credenciales incorrectas' });
        
        const token = jwt.sign({ id: user.id, rol: user.rol }, JWT_SECRET, { expiresIn: '8h' });
        res.json({ token, usuario: { id: user.id, nombre: user.nombre, rol: user.rol } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- GESTIÓN USUARIOS ---
app.post('/api/usuarios', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    const { nombre, correo, password, rol } = req.body;
    const hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO usuarios (nombre, correo, password, rol) VALUES ($1, $2, $3, $4)', [nombre, correo, hash, rol]);
    res.status(201).json({ mensaje: 'Usuario creado' });
});

app.get('/api/usuarios', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    const resdb = await pool.query('SELECT id, nombre, correo, rol FROM usuarios ORDER BY nombre ASC');
    res.json(resdb.rows);
});

app.put('/api/usuarios/:id', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    const { id } = req.params;
    const { nombre, correo, password, rol } = req.body;
    try {
        if (password && password.trim() !== "") {
            const hashedPassword = await bcrypt.hash(password, 10);
            await pool.query(`UPDATE usuarios SET nombre = $1, correo = $2, password = $3, rol = $4 WHERE id = $5`, [nombre, correo, hashedPassword, rol, id]);
        } else {
            await pool.query(`UPDATE usuarios SET nombre = $1, correo = $2, rol = $3 WHERE id = $4`, [nombre, correo, rol, id]);
        }
        res.json({ mensaje: 'Usuario actualizado con éxito' });
    } catch (error) { res.status(500).json({ error: 'Error al actualizar' }); }
});

app.delete('/api/usuarios/:id', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    const { id } = req.params;
    if (req.user.id == id) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta.' });
    await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
    res.json({ mensaje: 'Usuario eliminado' });
});

// --- CATEGORÍAS Y ALMACENES ---
app.post('/api/categorias', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    const { nombre, almacen } = req.body;
    try {
        const resultado = await pool.query(
            `INSERT INTO categorias (nombre, almacen) VALUES ($1, $2) RETURNING *`, 
            [nombre, almacen || 'Almacén Principal']
        );
        res.status(201).json({ mensaje: 'Categoría registrada', categoria: resultado.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Error al registrar categoría' }); }
});

app.get('/api/categorias', verificarToken, async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM categorias ORDER BY nombre ASC');
        res.json(resultado.rows);
    } catch (error) { res.status(500).json({ error: 'Error al consultar categorías' }); }
});

// --- PRODUCTOS (UNIDAD DE MEDIDA) ---
app.post('/api/productos', verificarToken, verificarRol(['Administrador', 'Supervisor']), async (req, res) => {
    const { sku, nombre, categoria_id, unidad_medida } = req.body;
    try {
        const query = `INSERT INTO productos (sku, nombre, categoria_id, unidad_medida, stock_actual, stock_minimo, precio_costo) VALUES ($1, $2, $3, $4, 0, 5, 0) RETURNING *`;
        const resultado = await pool.query(query, [sku, nombre, categoria_id || 1, unidad_medida || 'uds']);
        res.status(201).json({ mensaje: 'Producto creado', producto: resultado.rows[0] });
    } catch (error) {
        if (error.code === '23505') return res.status(400).json({ error: 'El SKU ya existe.' });
        res.status(500).json({ error: 'Error al crear producto' });
    }
});

app.get('/api/productos', verificarToken, async (req, res) => {
    const resdb = await pool.query('SELECT id, sku, nombre, unidad_medida FROM productos ORDER BY nombre ASC');
    res.json(resdb.rows);
});

// --- INVENTARIO Y LOTES ---
app.get('/api/inventario-lotes', verificarToken, async (req, res) => {
    const query = `
        SELECT e.id AS lote_id, p.sku, p.nombre, p.unidad_medida, c.nombre AS categoria_nombre, c.almacen,
               e.stock_restante, e.costo_unitario
        FROM entradas e
        JOIN productos p ON e.producto_id = p.id
        LEFT JOIN categorias c ON p.categoria_id = c.id
        WHERE e.stock_restante > 0
        ORDER BY p.nombre ASC, e.fecha ASC;
    `;
    const resdb = await pool.query(query);
    res.json(resdb.rows);
});

// --- OPERACIONES: ENTRADAS Y SALIDAS (FIFO) ---
app.post('/api/entradas', verificarToken, verificarRol(['Administrador', 'Supervisor']), async (req, res) => {
    const { producto_id, cantidad, costo_unitario } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [cantidad, producto_id]);
        await client.query('INSERT INTO entradas (producto_id, cantidad, costo_unitario, stock_restante) VALUES ($1, $2, $3, $4)', [producto_id, cantidad, costo_unitario, cantidad]);
        await client.query('COMMIT');
        res.status(201).json({ mensaje: 'Lote registrado' });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

app.post('/api/salidas', verificarToken, verificarRol(['Administrador', 'Supervisor']), async (req, res) => {
    const { producto_id, cantidad, concepto } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let cant = parseInt(cantidad);
        const lotes = await client.query('SELECT id, stock_restante FROM entradas WHERE producto_id = $1 AND stock_restante > 0 ORDER BY fecha ASC FOR UPDATE', [producto_id]);
        
        if (lotes.rows.reduce((acc, l) => acc + l.stock_restante, 0) < cant) throw new Error('Stock insuficiente');

        await client.query('INSERT INTO salidas (producto_id, cantidad, concepto, fecha) VALUES ($1, $2, $3, NOW())', [producto_id, cantidad, concepto]);
        
        for (let lote of lotes.rows) {
            if (cant <= 0) break;
            let aDescontar = Math.min(lote.stock_restante, cant);
            await client.query('UPDATE entradas SET stock_restante = stock_restante - $1 WHERE id = $2', [aDescontar, lote.id]);
            cant -= aDescontar;
        }
        await client.query('COMMIT');
        res.status(201).json({ mensaje: 'Salida registrada' });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ error: e.message }); } finally { client.release(); }
});

// --- ADMIN: ELIMINAR CON LOG ---
app.delete('/api/admin/movimientos/:tipo/:id', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    const { tipo, id } = req.params;
    const tabla = tipo === 'entrada' ? 'entradas' : 'salidas';
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const reg = await client.query(`SELECT * FROM ${tabla} WHERE id = $1`, [id]);
        if (reg.rows.length === 0) throw new Error('Registro no encontrado');
        
        if (tabla === 'salidas') await client.query('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [reg.rows[0].cantidad, reg.rows[0].producto_id]);
        
        await client.query('INSERT INTO logs_auditoria (usuario_id, accion, tabla_afectada, registro_id, detalles) VALUES ($1, $2, $3, $4, $5)', 
            [req.user.id, 'BORRADO', tabla, id, JSON.stringify(reg.rows[0])]);
        
        await client.query(`DELETE FROM ${tabla} WHERE id = $1`, [id]);
        await client.query('COMMIT');
        res.json({ mensaje: 'Eliminado con log' });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

// --- REPORTES Y AUDITORÍA ---
app.get('/api/reporte/logs', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    const resdb = await pool.query('SELECT l.*, u.nombre AS usuario_nombre FROM logs_auditoria l JOIN usuarios u ON l.usuario_id = u.id ORDER BY l.fecha DESC LIMIT 100');
    res.json(resdb.rows);
});

app.get('/api/reporte/entradas', verificarToken, async (req, res) => {
    try {
        const query = `
            SELECT e.id, p.sku, p.nombre AS producto_nombre, p.unidad_medida, 
                   c.almacen, e.cantidad, e.costo_unitario, e.stock_restante, e.fecha
            FROM entradas e
            JOIN productos p ON e.producto_id = p.id
            LEFT JOIN categorias c ON p.categoria_id = c.id
            ORDER BY e.fecha DESC;
        `;
        const resultado = await pool.query(query);
        res.json(resultado.rows);
    } catch (error) { res.status(500).json({ error: 'Error al consultar historial de entradas' }); }
});

app.get('/api/reporte/salidas', verificarToken, async (req, res) => {
    try {
        const query = `
            SELECT s.id, p.sku, p.nombre AS producto_nombre, p.unidad_medida, 
                   c.almacen, s.cantidad, s.concepto, s.fecha
            FROM salidas s
            JOIN productos p ON s.producto_id = p.id
            LEFT JOIN categorias c ON p.categoria_id = c.id
            ORDER BY s.fecha DESC;
        `;
        const resultado = await pool.query(query);
        res.json(resultado.rows);
    } catch (error) { res.status(500).json({ error: 'Error al consultar historial de salidas' }); }
});

app.get('/api/reporte-salidas', verificarToken, async (req, res) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Inventario General');
    ws.columns = [
        { header: 'SKU', key: 'sku', width: 15 }, 
        { header: 'Producto', key: 'nombre', width: 30 }, 
        { header: 'Categoría', key: 'categoria_nombre', width: 20 },
        { header: 'Almacén', key: 'almacen', width: 25 },
        { header: 'Lote ID', key: 'lote_id', width: 15 }, 
        { header: 'Stock Restante', key: 'stock_restante', width: 15 },
        { header: 'UoM (Medida)', key: 'unidad_medida', width: 15 },
        { header: 'Costo Unitario ($)', key: 'costo_unitario', width: 18 }
    ];
    const resdb = await pool.query(`
        SELECT p.sku, p.nombre, p.unidad_medida, c.nombre AS categoria_nombre, c.almacen,
               e.id AS lote_id, e.stock_restante, e.costo_unitario 
        FROM entradas e 
        JOIN productos p ON e.producto_id = p.id 
        LEFT JOIN categorias c ON p.categoria_id = c.id
        WHERE e.stock_restante > 0
        ORDER BY c.almacen ASC, p.nombre ASC
    `);
    ws.addRows(resdb.rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="reporte_inventario_general.xlsx"');
    await wb.xlsx.write(res);
    res.end();
});

app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));