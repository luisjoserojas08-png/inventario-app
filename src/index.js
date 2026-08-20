const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const pool = require('./config/db');

const multer = require('multer');
const xlsx = require('xlsx');

// Asegurar que la carpeta uploads exista para evitar que Render colapse
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads', { recursive: true });
}
const upload = multer({ dest: 'uploads/' });

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'secreto_super_seguro';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (req, res) => res.redirect('/login.html'));

// ==========================================
// MIDDLEWARES DE SEGURIDAD Y ROLES
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
            return res.status(403).json({ error: 'Acceso denegado: No tienes permisos para esta acción.' });
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
        
        await client.query('UPDATE entradas SET stock_restante = stock_restante - $1 WHERE id = $2', [aDescontar, lote.id]);
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
        
        await client.query('UPDATE entradas SET stock_restante = stock_restante + $1 WHERE id = $2', [aRestaurar, lote.id]);
        cantADevolver -= aRestaurar;
    }
}

// ==========================================
// RUTAS DE AUTENTICACIÓN Y USUARIOS (SOLO MASTER)
// ==========================================
app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    try {
        const resultado = await pool.query('SELECT * FROM usuarios WHERE usuario = $1', [usuario]);
        if (resultado.rows.length === 0) return res.status(400).json({ error: 'Credenciales incorrectas' });

        const user = resultado.rows[0];
        const passwordValido = await bcrypt.compare(password, user.password);
        if (!passwordValido) return res.status(400).json({ error: 'Credenciales incorrectas' });

        const token = jwt.sign({ id: user.id, usuario: user.usuario, rol: user.rol }, JWT_SECRET, { expiresIn: '8h' });
        res.json({ token, usuario: { id: user.id, nombre: user.nombre, rol: user.rol } });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/usuarios', verificarToken, verificarRol(['Master']), async (req, res) => {
    const { nombre, usuario, password, rol } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO usuarios (nombre, usuario, password, rol) VALUES ($1, $2, $3, $4)', [nombre, usuario, hash, rol]);
        res.status(201).json({ mensaje: 'Usuario creado exitosamente' });
    } catch (error) { res.status(500).json({ error: 'Error al crear usuario' }); }
});

app.get('/api/usuarios', verificarToken, verificarRol(['Master']), async (req, res) => {
    try { res.json((await pool.query('SELECT id, nombre, usuario, rol FROM usuarios ORDER BY nombre ASC')).rows); } 
    catch (error) { res.status(500).json({ error: 'Error al consultar usuarios' }); }
});

app.put('/api/usuarios/:id', verificarToken, verificarRol(['Master']), async (req, res) => {
    const { nombre, usuario, rol, password } = req.body;
    try {
        if (password && password.trim() !== "") {
            const hash = await bcrypt.hash(password, 10);
            await pool.query('UPDATE usuarios SET nombre=$1, usuario=$2, rol=$3, password=$4 WHERE id=$5', [nombre, usuario, rol, hash, req.params.id]);
        } else {
            await pool.query('UPDATE usuarios SET nombre=$1, usuario=$2, rol=$3 WHERE id=$4', [nombre, usuario, rol, req.params.id]);
        }
        res.json({ mensaje: 'Perfil actualizado exitosamente' });
    } catch (error) { res.status(500).json({ error: 'Error al actualizar usuario' }); }
});

app.delete('/api/usuarios/:id', verificarToken, verificarRol(['Master']), async (req, res) => {
    try {
        if (req.params.id == req.user.id) return res.status(400).json({ error: 'No puedes borrar tu propio usuario' });
        await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
        res.json({ mensaje: 'Usuario eliminado correctamente' });
    } catch (error) { res.status(500).json({ error: 'Error al borrar usuario' }); }
});

// ==========================================
// ALMACENES Y CATEGORÍAS
// ==========================================
app.post('/api/almacenes', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    try {
        const resultado = await pool.query(`INSERT INTO almacenes (nombre) VALUES ($1) RETURNING *`, [req.body.nombre]);
        res.status(201).json({ mensaje: 'Almacén registrado', almacen: resultado.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Error al registrar almacén' }); }
});
app.get('/api/almacenes', verificarToken, async (req, res) => {
    try { res.json((await pool.query('SELECT * FROM almacenes ORDER BY nombre ASC')).rows); } catch (e) { res.status(500).json({ error: 'Error' }); }
});
app.put('/api/almacenes/:id', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    try {
        await pool.query('UPDATE almacenes SET nombre = $1 WHERE id = $2', [req.body.nombre, req.params.id]);
        res.json({ mensaje: 'Almacén actualizado' });
    } catch (error) { res.status(500).json({ error: 'Error al actualizar almacén' }); }
});
app.delete('/api/almacenes/:id', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    try {
        await pool.query('DELETE FROM almacenes WHERE id = $1', [req.params.id]);
        res.json({ mensaje: 'Almacén eliminado' });
    } catch (error) { res.status(400).json({ error: 'No se puede eliminar. Verifica que no tenga categorías asignadas.' }); }
});

app.post('/api/categorias', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    try {
        const resultado = await pool.query(`INSERT INTO categorias (nombre, almacen) VALUES ($1, $2) RETURNING *`, [req.body.nombre, req.body.almacen || 'Almacén Principal']);
        res.status(201).json({ mensaje: 'Categoría registrada', categoria: resultado.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Error al registrar categoría' }); }
});
app.get('/api/categorias', verificarToken, async (req, res) => {
    try { res.json((await pool.query('SELECT * FROM categorias ORDER BY nombre ASC')).rows); } catch (e) { res.status(500).json({ error: 'Error' }); }
});
app.put('/api/categorias/:id', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    try {
        await pool.query('UPDATE categorias SET nombre = $1, almacen = $2 WHERE id = $3', [req.body.nombre, req.body.almacen, req.params.id]);
        res.json({ mensaje: 'Categoría actualizada correctamente' });
    } catch (error) { res.status(500).json({ error: 'Error al actualizar' }); }
});
app.delete('/api/categorias/:id', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    try {
        await pool.query('DELETE FROM categorias WHERE id = $1', [req.params.id]);
        res.json({ mensaje: 'Categoría eliminada' });
    } catch (error) { res.status(400).json({ error: 'No se puede eliminar. Probablemente tiene productos asignados.' }); }
});

// ==========================================
// CENTROS DE COSTO
// ==========================================
app.post('/api/centros-costo', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    try {
        const resultado = await pool.query(`INSERT INTO centros_costo (codigo, nombre) VALUES ($1, $2) RETURNING *`, [req.body.codigo, req.body.nombre]);
        res.status(201).json({ mensaje: 'Centro de Costo registrado', centro: resultado.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Error al registrar centro' }); }
});
app.get('/api/centros-costo', verificarToken, async (req, res) => {
    try { res.json((await pool.query('SELECT * FROM centros_costo ORDER BY codigo ASC')).rows); } catch (e) { res.status(500).json({ error: 'Error' }); }
});
app.put('/api/centros-costo/:id', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    try {
        await pool.query('UPDATE centros_costo SET codigo = $1, nombre = $2 WHERE id = $3', [req.body.codigo, req.body.nombre, req.params.id]);
        res.json({ mensaje: 'Centro actualizado' });
    } catch (error) { res.status(500).json({ error: 'Error al actualizar' }); }
});
app.delete('/api/centros-costo/:id', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    try {
        await pool.query('DELETE FROM centros_costo WHERE id = $1', [req.params.id]);
        res.json({ mensaje: 'Centro eliminado' });
    } catch (error) { res.status(400).json({ error: 'No se puede eliminar. Está en uso en el historial contable.' }); }
});

// ==========================================
// PRODUCTOS Y DASHBOARD
// ==========================================
app.post('/api/productos', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    try {
        const query = `INSERT INTO productos (sku, nombre, categoria_id, unidad_medida, stock_actual, stock_minimo, precio_costo) VALUES ($1, $2, $3, $4, 0, 5, 0) RETURNING *`;
        const resultado = await pool.query(query, [req.body.sku, req.body.nombre, req.body.categoria_id, req.body.unidad_medida]);
        res.status(201).json({ mensaje: 'Producto creado', producto: resultado.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Error al crear producto' }); }
});

app.put('/api/productos/:id', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    try {
        await pool.query('UPDATE productos SET sku = $1, nombre = $2, categoria_id = $3, unidad_medida = $4 WHERE id = $5', 
            [req.body.sku, req.body.nombre, req.body.categoria_id, req.body.unidad_medida, req.params.id]);
        res.json({ mensaje: 'Producto actualizado correctamente' });
    } catch (error) { res.status(500).json({ error: 'Error al actualizar producto' }); }
});

app.get('/api/productos', verificarToken, async (req, res) => {
    try { 
        const query = `SELECT p.id, p.sku, p.nombre, p.unidad_medida, p.categoria_id, c.nombre AS categoria_nombre, 
                       COALESCE((SELECT SUM(stock_restante) FROM entradas WHERE producto_id = p.id), 0) AS stock_actual
                       FROM productos p LEFT JOIN categorias c ON p.categoria_id = c.id ORDER BY p.nombre ASC`;
        res.json((await pool.query(query)).rows); 
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// DASHBOARD: Lotes con Filtros Avanzados
app.get('/api/inventario-lotes', verificarToken, async (req, res) => {
    const { producto, categoria, almacen } = req.query;
    try {
        let query = `SELECT e.id AS lote_id, p.id AS producto_id, p.sku, p.nombre, p.unidad_medida, c.id AS categoria_id, c.nombre AS categoria_nombre, c.almacen, e.stock_restante, e.costo_unitario 
                     FROM entradas e 
                     JOIN productos p ON e.producto_id = p.id 
                     LEFT JOIN categorias c ON p.categoria_id = c.id 
                     WHERE e.stock_restante > 0`;
        let params = [];
        let paramIndex = 1;

        if (producto) {
            query += ` AND p.id = $${paramIndex++}`;
            params.push(producto);
        }
        if (categoria) {
            query += ` AND c.id = $${paramIndex++}`;
            params.push(categoria);
        }
        if (almacen) {
            query += ` AND c.almacen = $${paramIndex++}`;
            params.push(almacen);
        }

        query += ` ORDER BY p.nombre ASC, e.fecha ASC;`;
        res.json((await pool.query(query, params)).rows);
    } catch (error) { res.status(500).json({ error: 'Error al consultar el inventario' }); }
});

// ==========================================
// ENTRADAS (ALMACÉN)
// ==========================================
app.post('/api/entradas', verificarToken, verificarRol(['Master', 'Administrador', 'Operario']), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        let fechaTransaccion = new Date().toISOString();
        if (req.body.fecha) {
            if (req.body.fecha.includes('T')) {
                fechaTransaccion = req.body.fecha;
            } else {
                const ahora = new Date();
                const hora = ahora.toTimeString().split(' ')[0]; 
                fechaTransaccion = `${req.body.fecha}T${hora}-04:00`; 
            }
        }

        const cantidadNumerica = parseFloat(req.body.cantidad);
        const nroDocumento = req.body.nro_documento || 'S/N';
        const costoNumerico = 0;

        await client.query('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [cantidadNumerica, req.body.producto_id]);
        await client.query('INSERT INTO entradas (producto_id, cantidad, costo_unitario, stock_restante, fecha, usuario_id, nro_documento) VALUES ($1, $2, $3, $4, $5, $6, $7)', 
            [req.body.producto_id, cantidadNumerica, costoNumerico, cantidadNumerica, fechaTransaccion, req.user.id, nroDocumento]);
        
        await client.query('COMMIT'); res.status(201).json({ mensaje: 'Lote físico registrado' });
    } catch (error) { await client.query('ROLLBACK'); res.status(500).json({ error: error.message }); } finally { client.release(); }
});

// ==========================================
// SALIDAS (FIFO)
// ==========================================
app.post('/api/salidas', verificarToken, verificarRol(['Master', 'Administrador', 'Operario']), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        let fechaTransaccion = new Date().toISOString();
        if (req.body.fecha) {
            if (req.body.fecha.includes('T')) {
                fechaTransaccion = req.body.fecha;
            } else {
                const ahora = new Date();
                const hora = ahora.toTimeString().split(' ')[0]; 
                fechaTransaccion = `${req.body.fecha}T${hora}-04:00`; 
            }
        }

        const cantidadNumerica = parseFloat(req.body.cantidad);
        const centroCostoId = req.body.centro_costo_id ? parseInt(req.body.centro_costo_id) : null;

        const loteOrigenId = await descontarStock(client, req.body.producto_id, cantidadNumerica);

        await client.query('INSERT INTO salidas (producto_id, cantidad, concepto, fecha, lote_origen_id, centro_costo_id, usuario_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', 
            [req.body.producto_id, cantidadNumerica, req.body.concepto, fechaTransaccion, loteOrigenId, centroCostoId, req.user.id]);
        
        await client.query('COMMIT'); res.status(201).json({ mensaje: 'Salida registrada correctamente' });
    } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: error.message }); } finally { client.release(); }
});

// ==========================================
// MÓDULO DE COSTEO (Solo Master y Admin)
// ==========================================
app.get('/api/costeo/lotes', verificarToken, async (req, res) => {
    try {
        const query = `SELECT e.id, p.sku, p.nombre, p.unidad_medida, e.cantidad, e.costo_unitario, e.fecha, e.nro_documento 
                       FROM entradas e JOIN productos p ON e.producto_id = p.id ORDER BY e.fecha DESC`;
        res.json((await pool.query(query)).rows);
    } catch (error) { res.status(500).json({ error: 'Error al consultar lotes' }); }
});

app.put('/api/costeo/lotes/:id', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    try {
        const nuevoCosto = parseFloat(req.body.costo_unitario);
        await pool.query('UPDATE entradas SET costo_unitario = $1 WHERE id = $2', [nuevoCosto, req.params.id]);
        res.json({ mensaje: 'Costo actualizado correctamente' });
    } catch (error) { res.status(500).json({ error: 'Error al actualizar costo' }); }
});

// ==========================================
// ADMIN: EDICIÓN Y BORRADO DE TRANSACCIONES
// ==========================================
app.put('/api/admin/movimientos/:tipo/:id', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    const { tipo, id } = req.params; 
    
    // CORRECCIÓN: Reemplazamos la coma por punto para que acepte formatos en español (ej: 187,98)
    const nueva_cantidad = parseFloat(String(req.body.nueva_cantidad).replace(',', '.'));
    
    const { motivo } = req.body; 
    const tabla = tipo === 'entrada' ? 'entradas' : 'salidas';
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        const reg = await client.query(`SELECT * FROM ${tabla} WHERE id = $1`, [id]);
        if (reg.rows.length === 0) throw new Error('Registro no encontrado');
        const mov = reg.rows[0]; const diferencia = nueva_cantidad - parseFloat(mov.cantidad);

        if (tipo === 'entrada') {
            const consumido = parseFloat(mov.cantidad) - parseFloat(mov.stock_restante);
            if (nueva_cantidad < consumido) throw new Error(`Este lote ya tiene consumido ${consumido}`);
            await client.query('UPDATE entradas SET cantidad = $1, stock_restante = $1 - $2 WHERE id = $3', [nueva_cantidad, consumido, id]);
            await client.query('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [diferencia, mov.producto_id]);
        } else {
            if (diferencia > 0) await descontarStock(client, mov.producto_id, diferencia);
            else if (diferencia < 0) await restaurarStock(client, mov.producto_id, Math.abs(diferencia));
            await client.query('UPDATE salidas SET cantidad = $1 WHERE id = $2', [nueva_cantidad, id]);
        }
        await client.query('INSERT INTO logs_auditoria (usuario_id, accion, tabla_afectada, registro_id, detalles) VALUES ($1, $2, $3, $4, $5)', [req.user.id, 'EDICION', tabla, id, JSON.stringify({ cantidad_anterior: mov.cantidad, cantidad_nueva: nueva_cantidad, motivo })]);
        await client.query('COMMIT'); res.json({ mensaje: 'Editado con éxito' });
    } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: error.message }); } finally { client.release(); }
});

app.delete('/api/admin/movimientos/:tipo/:id', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    const { tipo, id } = req.params; const { motivo } = req.body; const tabla = tipo === 'entrada' ? 'entradas' : 'salidas';
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        const reg = await client.query(`SELECT * FROM ${tabla} WHERE id = $1`, [id]);
        if (reg.rows.length === 0) throw new Error('Registro no encontrado');
        const mov = reg.rows[0];

        if (tabla === 'entradas') {
            if (parseFloat(mov.cantidad) > parseFloat(mov.stock_restante)) throw new Error('Este lote ya fue consumido parcialmente.');
            await client.query('UPDATE productos SET stock_actual = stock_actual - $1 WHERE id = $2', [mov.cantidad, mov.producto_id]);
        }
        if (tabla === 'salidas') await restaurarStock(client, mov.producto_id, mov.cantidad);
        
        await client.query('INSERT INTO logs_auditoria (usuario_id, accion, tabla_afectada, registro_id, detalles) VALUES ($1, $2, $3, $4, $5)', [req.user.id, 'BORRADO', tabla, id, JSON.stringify({ ...mov, motivo: motivo || 'N/A' })]);
        await client.query(`DELETE FROM ${tabla} WHERE id = $1`, [id]);
        await client.query('COMMIT'); res.json({ mensaje: 'Eliminado con éxito' });
    } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: error.message }); } finally { client.release(); }
});

// ==========================================
// EXCEL DE REPORTES HISTÓRICOS (CON FORMATO Y 200 OK PARA RENDER)
// ==========================================
app.get('/api/reporte/descargar-historial', verificarToken, async (req, res) => {
    const { tipo, inicio, fin, centro_costo } = req.query; 
    try {
        const userQuery = await pool.query('SELECT nombre, rol FROM usuarios WHERE id = $1', [req.user.id]);
        const userName = userQuery.rows.length > 0 ? userQuery.rows[0].nombre : 'Usuario Sistema';
        const userRol = userQuery.rows.length > 0 ? userQuery.rows[0].rol : 'Operario';
        const puedeVerCostos = ['Master', 'Administrador', 'Consulta'].includes(userRol);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(`Reporte de ${tipo.toUpperCase()}`);
        
        let query = ''; 
        const fechaInicio = inicio ? new Date(inicio + 'T00:00:00') : new Date('2000-01-01'); 
        const fechaFin = fin ? new Date(`${fin}T23:59:59.999Z`) : new Date();
        let params = [fechaInicio, fechaFin]; let paramIndex = 3;

        let cols = [ 
            { header: tipo === 'entradas' ? 'Lote' : 'Salida', key: 'id_lote', width: 12 }, 
            { header: 'SKU', key: 'sku', width: 15 }, 
            { header: 'Producto', key: 'producto_nombre', width: 35 }, 
            { header: 'Cant.', key: 'cantidad', width: 15 }
        ];

        if (puedeVerCostos) cols.push({ header: 'Costo Unit.', key: 'costo_unitario', width: 15 }, { header: 'Costo Total ($)', key: 'costo_total', width: 18 });

        if (tipo === 'entradas') {
            cols.push({ header: 'Doc.', key: 'nro_documento', width: 15 }, { header: 'Usuario', key: 'usuario_nombre', width: 20 }, { header: 'Fecha', key: 'fecha', width: 22 });
            query = `SELECT e.id, p.sku, p.nombre AS producto_nombre, e.cantidad, e.costo_unitario, e.nro_documento, e.fecha, u.nombre AS usuario_nombre 
                     FROM entradas e JOIN productos p ON e.producto_id = p.id LEFT JOIN usuarios u ON e.usuario_id = u.id 
                     WHERE e.fecha >= $1 AND e.fecha <= $2 ORDER BY e.fecha DESC`;
        } else {
            cols.push({ header: 'Centro de Costo', key: 'centro_costo_nombre', width: 25 }, { header: 'Concepto', key: 'concepto', width: 35 }, { header: 'Usuario', key: 'usuario_nombre', width: 20 }, { header: 'Fecha', key: 'fecha', width: 22 });
            query = `SELECT s.id, p.sku, p.nombre AS producto_nombre, s.cantidad, s.concepto, s.fecha, u.nombre AS usuario_nombre, e.costo_unitario, cc.nombre AS centro_costo_nombre 
                     FROM salidas s JOIN productos p ON s.producto_id = p.id LEFT JOIN entradas e ON s.lote_origen_id = e.id LEFT JOIN usuarios u ON s.usuario_id = u.id LEFT JOIN centros_costo cc ON s.centro_costo_id = cc.id 
                     WHERE s.fecha >= $1 AND s.fecha <= $2`;
            if (centro_costo) { query += ` AND s.centro_costo_id = $${paramIndex++}`; params.push(centro_costo); }
            query += ` ORDER BY s.fecha DESC`;
        }

        worksheet.columns = cols;
        worksheet.spliceRows(1, 0, [], [], [], []);
        
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const lastCol = alphabet[cols.length - 1];
        const fechaActual = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

        worksheet.getCell('A1').value = `HISTORIAL DE ${tipo.toUpperCase()}`;
        worksheet.getCell('A1').font = { size: 14, bold: true, color: { argb: 'FF1E40AF' } };

        worksheet.mergeCells(`A2:${lastCol}2`);
        const cellFecha = worksheet.getCell('A2');
        cellFecha.value = `Fecha de emisión: ${fechaActual}`;
        cellFecha.font = { bold: true };
        cellFecha.alignment = { horizontal: 'right', vertical: 'middle' };

        worksheet.mergeCells(`A3:${lastCol}3`);
        const cellUsuario = worksheet.getCell('A3');
        cellUsuario.value = `Generado por: ${userName}`;
        cellUsuario.alignment = { horizontal: 'right', vertical: 'middle' };

        const headerRow = worksheet.getRow(5);
        headerRow.eachCell({ includeEmpty: false }, (cell) => { 
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; 
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } }; 
            cell.alignment = { vertical: 'middle', horizontal: 'center' }; 
        });

        const resultado = await pool.query(query, params);
        resultado.rows.forEach(r => {
            let fila = { ...r, id_lote: tipo === 'entradas' ? `LOT-${String(r.id).padStart(3, '0')}` : `SAL-${String(r.id).padStart(3, '0')}`, cantidad: parseFloat(r.cantidad), usuario_nombre: r.usuario_nombre || 'Sistema', fecha: new Date(r.fecha).toLocaleString('es-VE', { timeZone: 'America/Caracas' }) };
            if (puedeVerCostos) { fila.costo_unitario = parseFloat(r.costo_unitario) || 0; fila.costo_total = fila.cantidad * fila.costo_unitario; }
            if (tipo === 'salidas') fila.centro_costo_nombre = r.centro_costo_nombre || 'General';
            
            const newRow = worksheet.addRow(fila);
            newRow.getCell('cantidad').numFmt = '#,##0.00';
            if (puedeVerCostos) { newRow.getCell('costo_unitario').numFmt = '"$"#,##0.00'; newRow.getCell('costo_total').numFmt = '"$"#,##0.00'; }
        });
        
        res.status(200);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Historial_${tipo}.xlsx"`);
        await workbook.xlsx.write(res); res.end();
    } catch (error) { res.status(500).json({ error: 'Error al generar Excel: ' + error.message }); }
});

// ==========================================
// REPORTES HISTÓRICOS (JSON PARA LAS TABLAS CON FILTROS Y SEGURIDAD)
// ==========================================
app.get('/api/reporte/entradas', verificarToken, async (req, res) => {
    const { inicio, fin, producto, categoria, almacen } = req.query;
    let query = `SELECT e.id, p.sku, p.nombre AS producto_nombre, p.unidad_medida, c.almacen, e.cantidad, e.costo_unitario, e.fecha 
                 FROM entradas e JOIN productos p ON e.producto_id = p.id LEFT JOIN categorias c ON p.categoria_id = c.id WHERE 1=1`;
    let params = []; let paramIndex = 1;

    if (inicio && fin) { query += ` AND e.fecha >= $${paramIndex++} AND e.fecha <= $${paramIndex++}`; params.push(new Date(inicio), new Date(`${fin}T23:59:59.999Z`)); }
    if (producto) { query += ` AND p.id = $${paramIndex++}`; params.push(producto); }
    if (categoria) { query += ` AND p.categoria_id = $${paramIndex++}`; params.push(categoria); }
    if (almacen) { query += ` AND c.almacen = $${paramIndex++}`; params.push(almacen); }
    query += ` ORDER BY e.fecha DESC;`;
    
    try { 
        let datos = (await pool.query(query, params)).rows;
        if (!['Master', 'Administrador', 'Consulta'].includes(req.user.rol)) {
            datos = datos.map(({ costo_unitario, ...resto }) => resto);
        }
        res.json(datos); 
    } catch (error) { res.status(500).json({ error: 'Error al consultar entradas' }); }
});

app.get('/api/reporte/salidas', verificarToken, async (req, res) => {
    const { inicio, fin, producto, categoria, almacen, centro_costo } = req.query;
    let query = `SELECT s.id, p.sku, p.nombre AS producto_nombre, p.unidad_medida, c.almacen, s.cantidad, s.concepto, s.fecha, s.lote_origen_id, cc.nombre AS centro_costo_nombre, e.costo_unitario 
                 FROM salidas s JOIN productos p ON s.producto_id = p.id LEFT JOIN categorias c ON p.categoria_id = c.id LEFT JOIN centros_costo cc ON s.centro_costo_id = cc.id LEFT JOIN entradas e ON s.lote_origen_id = e.id WHERE 1=1`;
    let params = []; let paramIndex = 1;

    if (inicio && fin) { query += ` AND s.fecha >= $${paramIndex++} AND s.fecha <= $${paramIndex++}`; params.push(new Date(inicio), new Date(`${fin}T23:59:59.999Z`)); }
    if (producto) { query += ` AND p.id = $${paramIndex++}`; params.push(producto); }
    if (categoria) { query += ` AND p.categoria_id = $${paramIndex++}`; params.push(categoria); }
    if (almacen) { query += ` AND c.almacen = $${paramIndex++}`; params.push(almacen); }
    if (centro_costo) { query += ` AND s.centro_costo_id = $${paramIndex++}`; params.push(centro_costo); }
    query += ` ORDER BY s.fecha DESC;`;
    
    try { 
        let datos = (await pool.query(query, params)).rows;
        if (!['Master', 'Administrador', 'Consulta'].includes(req.user.rol)) {
            datos = datos.map(({ costo_unitario, ...resto }) => resto);
        }
        res.json(datos); 
    } catch (error) { res.status(500).json({ error: 'Error al consultar salidas' }); }
});

// ==========================================
// CARGA MASIVA EXCEL (CON SOPORTE DE FECHAS)
// ==========================================
app.post('/api/cargar-masiva/:tipo', verificarToken, verificarRol(['Master', 'Administrador']), upload.single('file'), async (req, res) => {
    const { tipo } = req.params; 
    const workbook = xlsx.readFile(req.file.path); 
    const sheet = workbook.Sheets[workbook.SheetNames[0]]; 
    const data = xlsx.utils.sheet_to_json(sheet, { raw: false }); 
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        for (let row of data) {
            if (tipo === 'productos') {
                await client.query('INSERT INTO productos (sku, nombre, categoria_id, unidad_medida) VALUES ($1, $2, $3, $4)', [row.SKU, row.NOMBRE, row.CATEGORIA_ID, row.UOM]);
            }
            else if (tipo === 'categorias') {
                await client.query('INSERT INTO categorias (nombre, almacen) VALUES ($1, $2)', [row.NOMBRE, row.ALMACEN]);
            }
            else if (tipo === 'inventario') {
                let fechaEntrada = new Date().toISOString();
                if (row.FECHA) {
                    const partes = String(row.FECHA).split('/');
                    if (partes.length === 3) {
                        const dia = partes[0].padStart(2, '0');
                        const mes = partes[1].padStart(2, '0');
                        const anio = partes[2];
                        fechaEntrada = `${anio}-${mes}-${dia}T12:00:00-04:00`; 
                    }
                }
                await client.query('INSERT INTO entradas (producto_id, cantidad, costo_unitario, stock_restante, fecha, usuario_id) VALUES ($1, $2, $3, $4, $5, $6)', 
                    [row.PRODUCTO_ID, row.CANTIDAD, row.COSTO, row.CANTIDAD, fechaEntrada, req.user.id]);
                await client.query('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [row.CANTIDAD, row.PRODUCTO_ID]);
            }
        }
        await client.query('COMMIT'); res.json({ mensaje: `Carga masiva de ${tipo} completada` });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

// ==========================================
// EXCEL DE STOCK (DESCARGA DESDE DASHBOARD) (CON FORMATO Y 200 OK PARA RENDER)
// ==========================================
app.get('/api/reporte/descargar-stock', verificarToken, async (req, res) => {
    const { producto, categoria, almacen } = req.query;
    try {
        const userQuery = await pool.query('SELECT nombre, rol FROM usuarios WHERE id = $1', [req.user.id]);
        const userName = userQuery.rows.length > 0 ? userQuery.rows[0].nombre : 'Usuario Sistema';
        const userRol = userQuery.rows.length > 0 ? userQuery.rows[0].rol : 'Operario';
        const puedeVerCostos = ['Master', 'Administrador', 'Consulta'].includes(userRol);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Stock de Inventario');
        
        let cols = [
            { header: 'Lote ID', key: 'id_lote', width: 12 }, { header: 'SKU', key: 'sku', width: 15 },
            { header: 'Producto', key: 'producto_nombre', width: 35 }, { header: 'Categoría', key: 'categoria_nombre', width: 25 },
            { header: 'Almacén', key: 'almacen', width: 20 }, { header: 'Stock', key: 'stock_restante', width: 15 },
            { header: 'Unidad', key: 'unidad_medida', width: 10 }
        ];

        if (puedeVerCostos) {
            cols.push({ header: 'Costo Unit. ($)', key: 'costo_unitario', width: 15 }, { header: 'Costo Total ($)', key: 'costo_total', width: 18 });
        }
        worksheet.columns = cols;

        worksheet.spliceRows(1, 0, [], [], [], []); 
        const fechaActual = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });
        const lastCol = puedeVerCostos ? 'I' : 'G'; 

        worksheet.getCell('A1').value = 'REPORTE DE EXISTENCIAS (STOCK ACTUAL)';
        worksheet.getCell('A1').font = { size: 14, bold: true, color: { argb: 'FF1E40AF' } };

        worksheet.mergeCells(`A2:${lastCol}2`);
        const cellFecha = worksheet.getCell('A2');
        cellFecha.value = `Fecha de emisión: ${fechaActual}`;
        cellFecha.font = { bold: true };
        cellFecha.alignment = { horizontal: 'right', vertical: 'middle' };

        worksheet.mergeCells(`A3:${lastCol}3`);
        const cellUsuario = worksheet.getCell('A3');
        cellUsuario.value = `Generado por: ${userName}`;
        cellUsuario.alignment = { horizontal: 'right', vertical: 'middle' };

        const headerRow = worksheet.getRow(5);
        headerRow.eachCell({ includeEmpty: false }, (cell) => { 
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; 
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } }; 
            cell.alignment = { vertical: 'middle', horizontal: 'center' }; 
        });

        let query = `SELECT e.id, p.sku, p.nombre AS producto_nombre, p.unidad_medida, c.nombre AS categoria_nombre, c.almacen, e.stock_restante, e.costo_unitario 
                     FROM entradas e JOIN productos p ON e.producto_id = p.id LEFT JOIN categorias c ON p.categoria_id = c.id WHERE e.stock_restante > 0`;
        let params = []; let paramIndex = 1;

        if (producto) { query += ` AND p.id = $${paramIndex++}`; params.push(producto); }
        if (categoria) { query += ` AND c.id = $${paramIndex++}`; params.push(categoria); }
        if (almacen) { query += ` AND c.almacen = $${paramIndex++}`; params.push(almacen); }
        query += ` ORDER BY p.nombre ASC, e.fecha ASC`;

        const resultado = await pool.query(query, params);
        resultado.rows.forEach(r => {
            let fila = { ...r, id_lote: `LOT-${String(r.id).padStart(3, '0')}`, stock_restante: parseFloat(r.stock_restante) };
            if (puedeVerCostos) {
                fila.costo_unitario = parseFloat(r.costo_unitario) || 0;
                fila.costo_total = fila.stock_restante * fila.costo_unitario;
            }
            const newRow = worksheet.addRow(fila);
            newRow.getCell('stock_restante').numFmt = '#,##0.00';
            if (puedeVerCostos) {
                newRow.getCell('costo_unitario').numFmt = '"$"#,##0.00';
                newRow.getCell('costo_total').numFmt = '"$"#,##0.00';
            }
        });

        res.status(200);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Stock_Inventario.xlsx"`);
        await workbook.xlsx.write(res); res.end();
    } catch (error) { console.error("Error al generar Excel de stock:", error); res.status(500).json({ error: 'Error al generar Excel' }); }
});

// ==========================================
// LOGS DE AUDITORÍA DEL SISTEMA
// ==========================================
// ==========================================
// LOGS DE AUDITORÍA DEL SISTEMA
// ==========================================
app.get('/api/reporte/logs', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    try {
        const query = `SELECT l.id, l.accion, l.tabla_afectada, l.registro_id, l.detalles, l.fecha, u.nombre AS admin, u.nombre AS admin_nombre 
                       FROM logs_auditoria l 
                       LEFT JOIN usuarios u ON l.usuario_id = u.id 
                       ORDER BY l.fecha DESC LIMIT 100`;
        const resultado = await pool.query(query);
        res.json(resultado.rows);
    } catch (error) { 
        console.error("Error al consultar logs:", error);
        res.status(500).json({ error: 'Error al consultar logs de auditoría' }); 
    }
});

app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));