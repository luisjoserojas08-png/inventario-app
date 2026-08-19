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

// ==========================================
// MIDDLEWARES DE SEGURIDAD
// ==========================================
function verificarToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Token requerido' });
    const token = authHeader.split(' ')[1];
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token inválido o expirado' });
        req.user = user;
        next();
    });
}

function verificarRol(rolesPermitidos) {
    return (req, res, next) => {
        if (!req.user || !rolesPermitidos.includes(req.user.rol)) {
            return res.status(403).json({ error: 'Acceso denegado: No tienes permisos.' });
        }
        next();
    };
}

// ==========================================
// FUNCIONES MAESTRAS MATEMÁTICAS (FIFO)
// ==========================================
async function descontarStock(client, producto_id, cantidad) {
    let cantPendiente = parseFloat(cantidad);
    const lotes = await client.query(
        'SELECT id, stock_restante FROM entradas WHERE producto_id = $1 AND stock_restante > 0 ORDER BY fecha ASC FOR UPDATE', 
        [producto_id]
    );
    
    const stockTotal = lotes.rows.reduce((acc, l) => acc + parseFloat(l.stock_restante), 0);
    if (stockTotal < cantPendiente) throw new Error('Stock insuficiente para realizar esta operación.');

    for (let lote of lotes.rows) {
        if (cantPendiente <= 0) break;
        let aDescontar = Math.min(parseFloat(lote.stock_restante), cantPendiente);
        
        await client.query(
            'UPDATE entradas SET stock_restante = stock_restante - $1 WHERE id = $2', 
            [aDescontar, lote.id]
        );
        cantPendiente -= aDescontar;
    }
}

async function restaurarStock(client, producto_id, cantidad) {
    let cantADevolver = parseFloat(cantidad);
    const lotes = await client.query(
        'SELECT id, cantidad, stock_restante FROM entradas WHERE producto_id = $1 AND stock_restante < cantidad ORDER BY fecha DESC FOR UPDATE', 
        [producto_id]
    );
    
    for (let lote of lotes.rows) {
        if (cantADevolver <= 0) break;
        let espacioDisponible = parseFloat(lote.cantidad) - parseFloat(lote.stock_restante);
        let aRestaurar = Math.min(espacioDisponible, cantADevolver);
        
        await client.query(
            'UPDATE entradas SET stock_restante = stock_restante + $1 WHERE id = $2', 
            [aRestaurar, lote.id]
        );
        cantADevolver -= aRestaurar;
    }
}

// ==========================================
// RUTAS DE AUTENTICACIÓN Y USUARIOS
// ==========================================
app.post('/api/login', async (req, res) => {
    const { correo, password } = req.body;
    try {
        const resultado = await pool.query('SELECT * FROM usuarios WHERE correo = $1', [correo]);
        if (resultado.rows.length === 0) return res.status(400).json({ error: 'Credenciales incorrectas' });

        const usuario = resultado.rows[0];
        const passwordValido = await bcrypt.compare(password, usuario.password);
        if (!passwordValido) return res.status(400).json({ error: 'Credenciales incorrectas' });

        const token = jwt.sign({ id: usuario.id, correo: usuario.correo, rol: usuario.rol }, JWT_SECRET, { expiresIn: '8h' });
        res.json({ token, usuario: { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol } });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/usuarios', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    const { nombre, correo, password, rol } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO usuarios (nombre, correo, password, rol) VALUES ($1, $2, $3, $4)', [nombre, correo, hash, rol]);
        res.status(201).json({ mensaje: 'Usuario creado exitosamente' });
    } catch (error) { res.status(500).json({ error: 'Error al crear usuario' }); }
});

app.get('/api/usuarios', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    try {
        const resultado = await pool.query('SELECT id, nombre, correo, rol FROM usuarios ORDER BY nombre ASC');
        res.json(resultado.rows);
    } catch (error) { res.status(500).json({ error: 'Error al consultar usuarios' }); }
});

// ==========================================
// ALMACENES Y CATEGORÍAS
// ==========================================
app.post('/api/almacenes', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    try {
        const resultado = await pool.query(`INSERT INTO almacenes (nombre) VALUES ($1) RETURNING *`, [req.body.nombre]);
        res.status(201).json({ mensaje: 'Almacén registrado', almacen: resultado.rows[0] });
    } catch (error) {
        if (error.code === '23505') return res.status(400).json({ error: 'Ese almacén ya existe' });
        res.status(500).json({ error: 'Error al registrar almacén' });
    }
});
app.get('/api/almacenes', verificarToken, async (req, res) => {
    try { res.json((await pool.query('SELECT * FROM almacenes ORDER BY nombre ASC')).rows); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/categorias', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    try {
        const resultado = await pool.query(`INSERT INTO categorias (nombre, almacen) VALUES ($1, $2) RETURNING *`, [req.body.nombre, req.body.almacen || 'Almacén Principal']);
        res.status(201).json({ mensaje: 'Categoría registrada', categoria: resultado.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Error al registrar categoría' }); }
});
app.get('/api/categorias', verificarToken, async (req, res) => {
    try { res.json((await pool.query('SELECT * FROM categorias ORDER BY nombre ASC')).rows); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// ==========================================
// PRODUCTOS Y DASHBOARD
// ==========================================
app.post('/api/productos', verificarToken, verificarRol(['Administrador', 'Supervisor']), async (req, res) => {
    try {
        const query = `INSERT INTO productos (sku, nombre, categoria_id, unidad_medida, stock_actual, stock_minimo, precio_costo) VALUES ($1, $2, $3, $4, 0, 5, 0) RETURNING *`;
        const resultado = await pool.query(query, [req.body.sku, req.body.nombre, req.body.categoria_id, req.body.unidad_medida]);
        res.status(201).json({ mensaje: 'Producto creado', producto: resultado.rows[0] });
    } catch (error) {
        if (error.code === '23505') return res.status(400).json({ error: 'El código SKU ya existe.' });
        res.status(500).json({ error: 'Error al crear producto' });
    }
});

app.get('/api/productos', verificarToken, async (req, res) => {
    try { res.json((await pool.query('SELECT id, sku, nombre, unidad_medida FROM productos ORDER BY nombre ASC')).rows); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/inventario-lotes', verificarToken, async (req, res) => {
    try {
        const query = `SELECT e.id AS lote_id, p.sku, p.nombre, p.unidad_medida, c.nombre AS categoria_nombre, c.almacen, e.stock_restante, e.costo_unitario FROM entradas e JOIN productos p ON e.producto_id = p.id LEFT JOIN categorias c ON p.categoria_id = c.id WHERE e.stock_restante > 0 ORDER BY p.nombre ASC, e.fecha ASC;`;
        res.json((await pool.query(query)).rows);
    } catch (error) { res.status(500).json({ error: 'Error al consultar el inventario' }); }
});

// ==========================================
// ENTRADAS Y SALIDAS (FIFO CON DECIMALES Y FECHA REAL)
// ==========================================
app.post('/api/entradas', verificarToken, verificarRol(['Administrador', 'Supervisor']), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const fechaTransaccion = req.body.fecha || new Date().toISOString();
        const cantidadNumerica = parseFloat(req.body.cantidad);
        const costoNumerico = parseFloat(req.body.costo_unitario);

        await client.query('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [cantidadNumerica, req.body.producto_id]);
        await client.query('INSERT INTO entradas (producto_id, cantidad, costo_unitario, stock_restante, fecha) VALUES ($1, $2, $3, $4, $5)', 
            [req.body.producto_id, cantidadNumerica, costoNumerico, cantidadNumerica, fechaTransaccion]);
        
        await client.query('COMMIT'); res.status(201).json({ mensaje: 'Lote registrado con éxito' });
    } catch (error) { await client.query('ROLLBACK'); res.status(500).json({ error: error.message }); } finally { client.release(); }
});

app.post('/api/salidas', verificarToken, verificarRol(['Administrador', 'Supervisor']), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const fechaTransaccion = req.body.fecha || new Date().toISOString();
        const cantidadNumerica = parseFloat(req.body.cantidad);

        await descontarStock(client, req.body.producto_id, cantidadNumerica);
        await client.query('INSERT INTO salidas (producto_id, cantidad, concepto, fecha) VALUES ($1, $2, $3, $4)', 
            [req.body.producto_id, cantidadNumerica, req.body.concepto, fechaTransaccion]);
        
        await client.query('COMMIT'); res.status(201).json({ mensaje: 'Salida registrada correctamente' });
    } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: error.message }); } finally { client.release(); }
});

// ==========================================
// ADMIN: EDICIÓN Y BORRADO (AUDITORÍA MATEMÁTICA)
// ==========================================
app.put('/api/admin/movimientos/:tipo/:id', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    const { tipo, id } = req.params; 
    const nueva_cantidad = parseFloat(req.body.nueva_cantidad);
    const { motivo } = req.body;
    const tabla = tipo === 'entrada' ? 'entradas' : 'salidas';
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        const reg = await client.query(`SELECT * FROM ${tabla} WHERE id = $1`, [id]);
        if (reg.rows.length === 0) throw new Error('Registro no encontrado');
        
        const mov = reg.rows[0]; 
        const diferencia = nueva_cantidad - parseFloat(mov.cantidad);

        if (tipo === 'entrada') {
            await client.query('UPDATE entradas SET cantidad = $1, stock_restante = stock_restante + $2 WHERE id = $3', [nueva_cantidad, diferencia, id]);
        } else {
            if (diferencia > 0) await descontarStock(client, mov.producto_id, diferencia);
            else if (diferencia < 0) await restaurarStock(client, mov.producto_id, Math.abs(diferencia));
            await client.query('UPDATE salidas SET cantidad = $1 WHERE id = $2', [nueva_cantidad, id]);
        }

        await client.query('INSERT INTO logs_auditoria (usuario_id, accion, tabla_afectada, registro_id, detalles) VALUES ($1, $2, $3, $4, $5)', [req.user.id, 'EDICION', tabla, id, JSON.stringify({ cantidad_anterior: mov.cantidad, cantidad_nueva: nueva_cantidad, motivo })]);
        await client.query('COMMIT'); res.json({ mensaje: 'Registro editado y stock ajustado' });
    } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: error.message }); } finally { client.release(); }
});

app.delete('/api/admin/movimientos/:tipo/:id', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    const { tipo, id } = req.params; const { motivo } = req.body;
    const tabla = tipo === 'entrada' ? 'entradas' : 'salidas';
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        const reg = await client.query(`SELECT * FROM ${tabla} WHERE id = $1`, [id]);
        if (reg.rows.length === 0) throw new Error('Registro no encontrado');
        
        if (tabla === 'salidas') await restaurarStock(client, reg.rows[0].producto_id, reg.rows[0].cantidad);
        
        await client.query('INSERT INTO logs_auditoria (usuario_id, accion, tabla_afectada, registro_id, detalles) VALUES ($1, $2, $3, $4, $5)', [req.user.id, 'BORRADO', tabla, id, JSON.stringify({ ...reg.rows[0], motivo: motivo || 'No especificado' })]);
        await client.query(`DELETE FROM ${tabla} WHERE id = $1`, [id]);
        await client.query('COMMIT'); res.json({ mensaje: 'Eliminado y stock devuelto' });
    } catch (error) { await client.query('ROLLBACK'); res.status(500).json({ error: error.message }); } finally { client.release(); }
});

// ==========================================
// REPORTES HISTÓRICOS Y EXCEL CON FILTROS
// ==========================================
app.get('/api/reporte/logs', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    try { res.json((await pool.query('SELECT l.*, u.nombre AS usuario_nombre FROM logs_auditoria l JOIN usuarios u ON l.usuario_id = u.id ORDER BY l.fecha DESC LIMIT 100')).rows); } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/reporte/entradas', verificarToken, async (req, res) => {
    const { inicio, fin } = req.query;
    let query = `SELECT e.id, p.sku, p.nombre AS producto_nombre, p.unidad_medida, c.almacen, e.cantidad, e.costo_unitario, e.stock_restante, e.fecha FROM entradas e JOIN productos p ON e.producto_id = p.id LEFT JOIN categorias c ON p.categoria_id = c.id`;
    let params = [];
    if (inicio && fin) {
        query += ` WHERE e.fecha >= $1 AND e.fecha <= $2`;
        params.push(new Date(inicio), new Date(`${fin}T23:59:59.999Z`));
    }
    query += ` ORDER BY e.fecha DESC;`;
    try { res.json((await pool.query(query, params)).rows); } catch (error) { res.status(500).json({ error: 'Error al consultar' }); }
});

app.get('/api/reporte/salidas', verificarToken, async (req, res) => {
    const { inicio, fin } = req.query;
    let query = `SELECT s.id, p.sku, p.nombre AS producto_nombre, p.unidad_medida, c.almacen, s.cantidad, s.concepto, s.fecha FROM salidas s JOIN productos p ON s.producto_id = p.id LEFT JOIN categorias c ON p.categoria_id = c.id`;
    let params = [];
    if (inicio && fin) {
        query += ` WHERE s.fecha >= $1 AND s.fecha <= $2`;
        params.push(new Date(inicio), new Date(`${fin}T23:59:59.999Z`));
    }
    query += ` ORDER BY s.fecha DESC;`;
    try { res.json((await pool.query(query, params)).rows); } catch (error) { res.status(500).json({ error: 'Error al consultar' }); }
});

app.get('/api/reporte/descargar-historial', verificarToken, async (req, res) => {
    const { tipo, inicio, fin } = req.query;
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(`Historial de ${tipo}`);
        let query = ''; let params = [];
        
        const fechaInicio = inicio ? new Date(inicio) : new Date('2000-01-01');
        const fechaFin = fin ? new Date(`${fin}T23:59:59.999Z`) : new Date();

        if (tipo === 'entradas') {
            worksheet.columns = [
                { header: 'Lote ID', key: 'id_lote', width: 15 }, { header: 'SKU', key: 'sku', width: 15 }, { header: 'Producto', key: 'producto_nombre', width: 30 },
                { header: 'Almacén', key: 'almacen', width: 25 }, { header: 'Cantidad', key: 'cantidad', width: 15 }, { header: 'UoM', key: 'unidad_medida', width: 10 },
                { header: 'Costo Unitario ($)', key: 'costo_unitario', width: 18 }, { header: 'Fecha', key: 'fecha', width: 20 }
            ];
            query = `SELECT e.id, p.sku, p.nombre AS producto_nombre, p.unidad_medida, c.almacen, e.cantidad, e.costo_unitario, e.fecha FROM entradas e JOIN productos p ON e.producto_id = p.id LEFT JOIN categorias c ON p.categoria_id = c.id WHERE e.fecha >= $1 AND e.fecha <= $2 ORDER BY e.fecha DESC`;
        } else {
            worksheet.columns = [
                { header: 'Salida ID', key: 'id_lote', width: 15 }, { header: 'SKU', key: 'sku', width: 15 }, { header: 'Producto', key: 'producto_nombre', width: 30 },
                { header: 'Almacén', key: 'almacen', width: 25 }, { header: 'Cantidad', key: 'cantidad', width: 15 }, { header: 'UoM', key: 'unidad_medida', width: 10 },
                { header: 'Concepto / Destino', key: 'concepto', width: 30 }, { header: 'Fecha', key: 'fecha', width: 20 }
            ];
            query = `SELECT s.id, p.sku, p.nombre AS producto_nombre, p.unidad_medida, c.almacen, s.cantidad, s.concepto, s.fecha FROM salidas s JOIN productos p ON s.producto_id = p.id LEFT JOIN categorias c ON p.categoria_id = c.id WHERE s.fecha >= $1 AND s.fecha <= $2 ORDER BY s.fecha DESC`;
        }
        
        const resultado = await pool.query(query, [fechaInicio, fechaFin]);
        const rows = resultado.rows.map(r => ({
            ...r, id_lote: tipo === 'entradas' ? `LOT-${String(r.id).padStart(3, '0')}` : `SAL-${String(r.id).padStart(3, '0')}`,
            fecha: new Date(r.fecha).toLocaleString()
        }));

        worksheet.addRows(rows);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); 
        res.setHeader('Content-Disposition', `attachment; filename="historial_${tipo}_${inicio||'todo'}.xlsx"`);
        await workbook.xlsx.write(res); res.end();
    } catch (error) { res.status(500).json({ error: 'Error al generar excel' }); }
});

app.get('/api/reporte-salidas', verificarToken, async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook(); const worksheet = workbook.addWorksheet('Inventario General');
        worksheet.columns = [{ header: 'SKU', key: 'sku', width: 15 }, { header: 'Producto', key: 'nombre', width: 30 }, { header: 'Categoría', key: 'categoria_nombre', width: 20 }, { header: 'Almacén', key: 'almacen', width: 25 }, { header: 'Lote ID', key: 'lote_id', width: 15 }, { header: 'Stock Restante', key: 'stock_restante', width: 15 }, { header: 'UoM', key: 'unidad_medida', width: 10 }, { header: 'Costo', key: 'costo_unitario', width: 15 }];
        worksheet.addRows((await pool.query(`SELECT p.sku, p.nombre, p.unidad_medida, c.nombre AS categoria_nombre, c.almacen, e.id AS lote_id, e.stock_restante, e.costo_unitario FROM entradas e JOIN productos p ON e.producto_id = p.id LEFT JOIN categorias c ON p.categoria_id = c.id WHERE e.stock_restante > 0 ORDER BY c.almacen, p.nombre`)).rows);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', 'attachment; filename="inventario.xlsx"');
        await workbook.xlsx.write(res); res.end();
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));