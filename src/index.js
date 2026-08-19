const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const pool = require('./config/db');

const multer = require('multer');
const xlsx = require('xlsx');
const upload = multer({ dest: 'uploads/' });

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

    let primerLoteAfectado = null;

    for (let lote of lotes.rows) {
        if (cantPendiente <= 0) break;
        if (!primerLoteAfectado) primerLoteAfectado = lote.id;

        let aDescontar = Math.min(parseFloat(lote.stock_restante), cantPendiente);
        
        await client.query(
            'UPDATE entradas SET stock_restante = stock_restante - $1 WHERE id = $2', 
            [aDescontar, lote.id]
        );
        cantPendiente -= aDescontar;
    }
    return primerLoteAfectado;
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
// CENTROS DE COSTO
// ==========================================
app.post('/api/centros-costo', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    try {
        const resultado = await pool.query(`INSERT INTO centros_costo (codigo, nombre) VALUES ($1, $2) RETURNING *`, [req.body.codigo, req.body.nombre]);
        res.status(201).json({ mensaje: 'Centro de Costo registrado', centro: resultado.rows[0] });
    } catch (error) {
        if (error.code === '23505') return res.status(400).json({ error: 'Ese código ya existe' });
        res.status(500).json({ error: 'Error al registrar centro de costo' });
    }
});
app.get('/api/centros-costo', verificarToken, async (req, res) => {
    try { res.json((await pool.query('SELECT * FROM centros_costo ORDER BY codigo ASC')).rows); } catch (e) { res.status(500).json({ error: 'Error' }); }
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
    try { 
        // BLINDAJE: Ahora el stock_actual se calcula en tiempo real sumando los lotes reales (entradas)
        const query = `
            SELECT p.id, p.sku, p.nombre, p.unidad_medida, p.categoria_id, c.nombre AS categoria_nombre, 
                   COALESCE((SELECT SUM(stock_restante) FROM entradas WHERE producto_id = p.id), 0) AS stock_actual
            FROM productos p 
            LEFT JOIN categorias c ON p.categoria_id = c.id 
            ORDER BY p.nombre ASC
        `;
        res.json((await pool.query(query)).rows); 
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    }
});

app.get('/api/inventario-lotes', verificarToken, async (req, res) => {
    try {
        const query = `SELECT e.id AS lote_id, p.sku, p.nombre, p.unidad_medida, c.nombre AS categoria_nombre, c.almacen, e.stock_restante, e.costo_unitario FROM entradas e JOIN productos p ON e.producto_id = p.id LEFT JOIN categorias c ON p.categoria_id = c.id WHERE e.stock_restante > 0 ORDER BY p.nombre ASC, e.fecha ASC;`;
        res.json((await pool.query(query)).rows);
    } catch (error) { res.status(500).json({ error: 'Error al consultar el inventario' }); }
});

// ==========================================
// EDICIÓN DE CATÁLOGOS (PRODUCTOS Y CATEGORÍAS)
// ==========================================
app.put('/api/categorias/:id', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    try {
        await pool.query('UPDATE categorias SET nombre = $1, almacen = $2 WHERE id = $3', [req.body.nombre, req.body.almacen, req.params.id]);
        res.json({ mensaje: 'Categoría actualizada correctamente' });
    } catch (error) { res.status(500).json({ error: 'Error al actualizar categoría' }); }
});

app.put('/api/productos/:id', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    try {
        await pool.query('UPDATE productos SET sku = $1, nombre = $2, categoria_id = $3, unidad_medida = $4 WHERE id = $5', 
            [req.body.sku, req.body.nombre, req.body.categoria_id, req.body.unidad_medida, req.params.id]);
        res.json({ mensaje: 'Producto actualizado correctamente' });
    } catch (error) { 
        if (error.code === '23505') return res.status(400).json({ error: 'Este código SKU ya está asignado a otro producto' });
        res.status(500).json({ error: 'Error al actualizar producto' }); 
    }
});

// ==========================================
// ENTRADAS (ALMACÉN - SIN COSTOS)
// ==========================================
app.post('/api/entradas', verificarToken, verificarRol(['Administrador', 'Supervisor']), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const fechaTransaccion = req.body.fecha || new Date().toISOString();
        const cantidadNumerica = parseFloat(req.body.cantidad);
        const nroDocumento = req.body.nro_documento || 'S/N';
        const costoNumerico = 0; // El costo entra en 0, lo asigna Administración después

        await client.query('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [cantidadNumerica, req.body.producto_id]);
        
        await client.query('INSERT INTO entradas (producto_id, cantidad, costo_unitario, stock_restante, fecha, usuario_id, nro_documento) VALUES ($1, $2, $3, $4, $5, $6, $7)', 
            [req.body.producto_id, cantidadNumerica, costoNumerico, cantidadNumerica, fechaTransaccion, req.user.id, nroDocumento]);
        
        await client.query('COMMIT'); res.status(201).json({ mensaje: 'Lote físico registrado con éxito' });
    } catch (error) { await client.query('ROLLBACK'); res.status(500).json({ error: error.message }); } finally { client.release(); }
});

// ==========================================
// MÓDULO DE COSTEO (SOLO ADMINISTRACIÓN)
// ==========================================
app.get('/api/costeo/lotes', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    try {
        const query = `SELECT e.id, p.sku, p.nombre, p.unidad_medida, e.cantidad, e.costo_unitario, e.fecha, e.nro_documento 
                       FROM entradas e JOIN productos p ON e.producto_id = p.id 
                       ORDER BY e.fecha DESC`;
        res.json((await pool.query(query)).rows);
    } catch (error) { res.status(500).json({ error: 'Error al consultar lotes para costeo' }); }
});

app.put('/api/costeo/lotes/:id', verificarToken, verificarRol(['Administrador']), async (req, res) => {
    try {
        const nuevoCosto = parseFloat(req.body.costo_unitario);
        await pool.query('UPDATE entradas SET costo_unitario = $1 WHERE id = $2', [nuevoCosto, req.params.id]);
        res.json({ mensaje: 'Costo actualizado y valorizado correctamente' });
    } catch (error) { res.status(500).json({ error: 'Error al actualizar costo' }); }
});
// ==========================================
// ADMIN: EDICIÓN Y BORRADO (CON BLINDAJE CONTABLE)
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
            const consumido = parseFloat(mov.cantidad) - parseFloat(mov.stock_restante);
            if (nueva_cantidad < consumido) {
                throw new Error(`BLINDAJE CONTABLE: Este lote ya tiene ${consumido.toFixed(2)} unidades consumidas en salidas. No puedes reducir su cantidad a menos de eso.`);
            }
            await client.query('UPDATE entradas SET cantidad = $1, stock_restante = $1 - $2 WHERE id = $3', [nueva_cantidad, consumido, id]);
            await client.query('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [diferencia, mov.producto_id]);
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
        
        const mov = reg.rows[0];

        if (tabla === 'entradas') {
            if (parseFloat(mov.cantidad) > parseFloat(mov.stock_restante)) {
                throw new Error('BLINDAJE CONTABLE: Este lote ya fue utilizado en una o varias salidas. Debes ubicar y eliminar las salidas asociadas a este producto antes de poder borrar la entrada.');
            }
            await client.query('UPDATE productos SET stock_actual = stock_actual - $1 WHERE id = $2', [mov.cantidad, mov.producto_id]);
        }

        if (tabla === 'salidas') {
            await restaurarStock(client, mov.producto_id, mov.cantidad);
        }
        
        await client.query('INSERT INTO logs_auditoria (usuario_id, accion, tabla_afectada, registro_id, detalles) VALUES ($1, $2, $3, $4, $5)', [req.user.id, 'BORRADO', tabla, id, JSON.stringify({ ...mov, motivo: motivo || 'No especificado' })]);
        await client.query(`DELETE FROM ${tabla} WHERE id = $1`, [id]);
        
        await client.query('COMMIT'); res.json({ mensaje: 'Eliminado y stock devuelto/descontado' });
    } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: error.message }); } finally { client.release(); }
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
    let query = `SELECT s.id, p.sku, p.nombre AS producto_nombre, p.unidad_medida, c.almacen, s.cantidad, s.concepto, s.fecha, s.lote_origen_id FROM salidas s JOIN productos p ON s.producto_id = p.id LEFT JOIN categorias c ON p.categoria_id = c.id`;
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
        const worksheet = workbook.addWorksheet(`Reporte de ${tipo.toUpperCase()}`);
        let query = ''; let params = [];
        
        const fechaInicio = inicio ? new Date(inicio) : new Date('2000-01-01');
        const fechaFin = fin ? new Date(`${fin}T23:59:59.999Z`) : new Date();

        if (tipo === 'entradas') {
            worksheet.columns = [
                { header: 'Lote ID', key: 'id_lote', width: 12 }, { header: 'SKU', key: 'sku', width: 15 }, 
                { header: 'Producto', key: 'producto_nombre', width: 35 }, { header: 'Categoría', key: 'categoria_nombre', width: 20 },
                { header: 'Almacén', key: 'almacen', width: 25 }, { header: 'Cant. Ingresada', key: 'cantidad', width: 18 }, 
                { header: 'UoM', key: 'unidad_medida', width: 10 }, { header: 'Costo Unitario ($)', key: 'costo_unitario', width: 20 }, 
                { header: 'Stock Restante', key: 'stock_restante', width: 18 }, { header: 'Fecha Real Ingreso', key: 'fecha', width: 25 },
                { header: 'Registrado Por', key: 'usuario_nombre', width: 25 }
            ];
            query = `SELECT e.id, p.sku, p.nombre AS producto_nombre, c.nombre AS categoria_nombre, c.almacen, e.cantidad, p.unidad_medida, e.costo_unitario, e.stock_restante, e.fecha, u.nombre AS usuario_nombre 
                     FROM entradas e JOIN productos p ON e.producto_id = p.id LEFT JOIN categorias c ON p.categoria_id = c.id LEFT JOIN usuarios u ON e.usuario_id = u.id
                     WHERE e.fecha >= $1 AND e.fecha <= $2 ORDER BY e.fecha DESC`;
        } else {
            worksheet.columns = [
                { header: 'Salida ID', key: 'id_lote', width: 12 }, { header: 'Lote Origen', key: 'lote_origen', width: 15 },
                { header: 'SKU', key: 'sku', width: 15 }, { header: 'Producto', key: 'producto_nombre', width: 35 }, 
                { header: 'Categoría', key: 'categoria_nombre', width: 20 }, { header: 'Almacén', key: 'almacen', width: 25 }, 
                { header: 'Cant. Consumida', key: 'cantidad', width: 18 }, { header: 'UoM', key: 'unidad_medida', width: 10 },
                { header: 'Concepto / Destino', key: 'concepto', width: 35 }, { header: 'Cod. CC', key: 'cc_codigo', width: 10 },
                { header: 'Centro de Costo', key: 'cc_nombre', width: 25 }, { header: 'Fecha de Salida', key: 'fecha', width: 25 },
                { header: 'Registrado Por', key: 'usuario_nombre', width: 25 }
            ];
            query = `SELECT s.id, s.lote_origen_id, p.sku, p.nombre AS producto_nombre, c.nombre AS categoria_nombre, c.almacen, s.cantidad, p.unidad_medida, s.concepto, cc.codigo AS cc_codigo, cc.nombre AS cc_nombre, s.fecha, u.nombre AS usuario_nombre 
                     FROM salidas s JOIN productos p ON s.producto_id = p.id LEFT JOIN categorias c ON p.categoria_id = c.id LEFT JOIN centros_costo cc ON s.centro_costo_id = cc.id LEFT JOIN usuarios u ON s.usuario_id = u.id
                     WHERE s.fecha >= $1 AND s.fecha <= $2 ORDER BY s.fecha DESC`;
        }
        
        const resultado = await pool.query(query, [fechaInicio, fechaFin]);
        
        resultado.rows.forEach(r => {
            worksheet.addRow({
                ...r,
                id_lote: tipo === 'entradas' ? `LOT-${String(r.id).padStart(3, '0')}` : `SAL-${String(r.id).padStart(3, '0')}`,
                lote_origen: r.lote_origen_id ? `LOT-${String(r.lote_origen_id).padStart(3, '0')}` : 'N/A',
                categoria_nombre: r.categoria_nombre || 'Sin Categoría',
                cc_codigo: r.cc_codigo || 'N/A',
                cc_nombre: r.cc_nombre || 'Sin Centro',
                usuario_nombre: r.usuario_nombre || 'Sistema / Previo',
                fecha: new Date(r.fecha).toLocaleString('es-VE', { timeZone: 'America/Caracas' }) 
            });
        });

        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } }; 
        worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
        worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: worksheet.columns.length } };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); 
        res.setHeader('Content-Disposition', `attachment; filename="Historial_${tipo}_${inicio||'General'}.xlsx"`);
        await workbook.xlsx.write(res); res.end();
    } catch (error) { res.status(500).json({ error: 'Error al generar excel' }); }
});

app.get('/api/reporte-salidas', verificarToken, async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook(); const worksheet = workbook.addWorksheet('Stock General');
        
        worksheet.columns = [
            { header: 'Lote ID', key: 'lote_id', width: 12 }, { header: 'SKU', key: 'sku', width: 15 }, 
            { header: 'Producto', key: 'nombre', width: 35 }, { header: 'Categoría', key: 'categoria_nombre', width: 20 }, 
            { header: 'Almacén', key: 'almacen', width: 25 }, { header: 'Stock Restante', key: 'stock_restante', width: 18 }, 
            { header: 'UoM', key: 'unidad_medida', width: 10 }, { header: 'Costo Unitario ($)', key: 'costo_unitario', width: 18 },
            { header: 'Valorización Total ($)', key: 'valor_total', width: 20 }, { header: 'Fecha de Ingreso', key: 'fecha', width: 25 }
        ];

        const query = `SELECT e.id, p.sku, p.nombre, p.unidad_medida, c.nombre AS categoria_nombre, c.almacen, e.stock_restante, e.costo_unitario, e.fecha 
                       FROM entradas e JOIN productos p ON e.producto_id = p.id LEFT JOIN categorias c ON p.categoria_id = c.id 
                       WHERE e.stock_restante > 0 ORDER BY c.almacen, p.nombre`;
        
        const resultado = await pool.query(query);

        resultado.rows.forEach(r => {
            worksheet.addRow({
                ...r,
                lote_id: `LOT-${String(r.id).padStart(3, '0')}`,
                categoria_nombre: r.categoria_nombre || 'Sin Categoría',
                valor_total: (parseFloat(r.stock_restante) * parseFloat(r.costo_unitario)).toFixed(2),
                fecha: new Date(r.fecha).toLocaleString('es-VE', { timeZone: 'America/Caracas' })
            });
        });

        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } }; 
        worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
        worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: worksheet.columns.length } };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); 
        res.setHeader('Content-Disposition', 'attachment; filename="Inventario_Actual_Genetica.xlsx"');
        await workbook.xlsx.write(res); res.end();
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

// ==========================================
// CARGA MASIVA EXCEL
// ==========================================
app.post('/api/cargar-masiva/:tipo', verificarToken, verificarRol(['Administrador']), upload.single('file'), async (req, res) => {
    const { tipo } = req.params;
    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet);
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        for (let row of data) {
            if (tipo === 'productos') {
                await client.query('INSERT INTO productos (sku, nombre, categoria_id, unidad_medida) VALUES ($1, $2, $3, $4)', [row.SKU, row.NOMBRE, row.CATEGORIA_ID, row.UOM]);
            } else if (tipo === 'categorias') {
                await client.query('INSERT INTO categorias (nombre, almacen) VALUES ($1, $2)', [row.NOMBRE, row.ALMACEN]);
            } else if (tipo === 'inventario') {
                await client.query('INSERT INTO entradas (producto_id, cantidad, costo_unitario, stock_restante, fecha, usuario_id) VALUES ($1, $2, $3, $4, NOW(), $5)', [row.PRODUCTO_ID, row.CANTIDAD, row.COSTO, row.CANTIDAD, req.user.id]);
                await client.query('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [row.CANTIDAD, row.PRODUCTO_ID]);
            }
        }
        await client.query('COMMIT');
        res.json({ mensaje: `Carga masiva de ${tipo} completada` });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

// ESTA ES LA LÍNEA QUE FALTABA (LA QUE MANTIENE EL SERVIDOR ENCENDIDO)
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));