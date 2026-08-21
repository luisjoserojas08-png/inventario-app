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
// MIDDLEWARES
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
// FUNCIONES FIFO
// ==========================================
async function descontarStock(client, producto_id, cantidad) {
    let cantPendiente = parseFloat(cantidad);
    const lotes = await client.query(
        "SELECT id, stock_restante FROM entradas WHERE producto_id = $1 AND stock_restante > 0 AND estado = 'DISPONIBLE' ORDER BY fecha ASC FOR UPDATE", 
        [producto_id]
    );
    
    const stockTotal = lotes.rows.reduce((acc, l) => acc + parseFloat(l.stock_restante), 0);
    if (stockTotal < cantPendiente) throw new Error('Stock DISPONIBLE insuficiente. Verifica si hay inventario en tránsito.');

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
// USUARIOS
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

// ELIMINAR ALMACÉN CON VALIDACIÓN ESTRICTA DE PRODUCTOS
app.delete('/api/almacenes/:id', verificarToken, async (req, res) => {
    const { id } = req.params;
    
    try {
        // Obtener el almacén para saber su nombre
        const almRes = await pool.query('SELECT * FROM almacenes WHERE id = $1', [id]);
        if (almRes.rows.length === 0) {
            return res.status(404).json({ error: 'Almacén no encontrado.' });
        }
        const nombreAlmacen = almRes.rows[0].nombre;

        // VALIDACIÓN CRÍTICA: ¿Hay productos en este almacén a través de sus categorías?
        const productosEnUso = await pool.query(
            `SELECT COUNT(*) FROM productos p 
             JOIN categorias c ON p.categoria_id = c.id 
             WHERE c.almacen = $1`, 
            [nombreAlmacen]
        );

        if (parseInt(productosEnUso.rows[0].count) > 0) {
            return res.status(400).json({ 
                error: '⚠️ DENEGADO: Este almacén contiene productos asociados. Debe reubicarlos o eliminarlos primero.' 
            });
        }

        // Si pasa la validación, procedemos a borrar
        await pool.query('DELETE FROM almacenes WHERE id = $1', [id]);
        res.json({ mensaje: 'Almacén eliminado correctamente.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al intentar eliminar el almacén.' });
    }
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

app.delete('/api/productos/:id', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    const { id } = req.params;

    try {
        // 1. Verificar si el producto existe
        const prodCheck = await pool.query('SELECT * FROM productos WHERE id = $1', [id]);
        if (prodCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Producto no encontrado.' });
        }
        
        const producto = prodCheck.rows[0];

        // 2. REGLA DE CONTABILIDAD: No se puede borrar si tiene stock físico
        if (parseFloat(producto.stock_actual) > 0) {
            return res.status(400).json({ 
                error: `⚠️ No se puede eliminar "${producto.nombre}" porque tiene stock activo (${producto.stock_actual} ${producto.unidad_medida}). Debe agotarlo o dejarlo en cero primero.` 
            });
        }

        // 3. REGLA DE AUDITORÍA: Verificar si tiene historial de entradas o salidas
        const historialEntradas = await pool.query('SELECT COUNT(*) FROM entradas WHERE producto_id = $1', [id]);
        const historialSalidas = await pool.query('SELECT COUNT(*) FROM salidas WHERE producto_id = $1', [id]);

        if (parseInt(historialEntradas.rows[0].count) > 0 || parseInt(historialSalidas.rows[0].count) > 0) {
            return res.status(400).json({ 
                error: `⚠️ ACCIÓN DENEGADA: "${producto.nombre}" posee registros históricos en el libro de compras o salidas. Por normativas de auditoría, los productos con transacciones pasadas no deben borrarse.` 
            });
        }

        // 4. Si está limpio, se permite la eliminación
        await pool.query('DELETE FROM productos WHERE id = $1', [id]);
        res.json({ mensaje: 'Producto eliminado correctamente del maestro.' });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al intentar eliminar el producto.' });
    }
});

app.get('/api/productos', verificarToken, async (req, res) => {
    try { 
        const query = `SELECT p.id, p.sku, p.nombre, p.unidad_medida, p.categoria_id, c.nombre AS categoria_nombre, 
                       COALESCE((SELECT SUM(stock_restante) FROM entradas WHERE producto_id = p.id), 0) AS stock_actual
                       FROM productos p LEFT JOIN categorias c ON p.categoria_id = c.id ORDER BY p.nombre ASC`;
        res.json((await pool.query(query)).rows); 
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// DASHBOARD: Forzando actualización en Render 21/08
app.get('/api/inventario-lotes', verificarToken, async (req, res) => {
    const { producto, categoria, almacen, estado } = req.query; 
    try {
        let query = `SELECT e.id AS lote_id, p.id AS producto_id, p.sku, p.nombre, p.unidad_medida, c.id AS categoria_id, c.nombre AS categoria_nombre, c.almacen, e.stock_restante, e.costo_unitario, e.estado, e.lote_origen_id 
                     FROM entradas e 
                     JOIN productos p ON e.producto_id = p.id 
                     LEFT JOIN categorias c ON p.categoria_id = c.id 
                     WHERE e.stock_restante > 0`;
        let params = [];
        let paramIndex = 1;

        if (producto) { query += ` AND p.id = $${paramIndex++}`; params.push(producto); }
        if (categoria) { query += ` AND c.id = $${paramIndex++}`; params.push(categoria); }
        if (almacen) { query += ` AND c.almacen = $${paramIndex++}`; params.push(almacen); }
        if (estado) { query += ` AND e.estado = $${paramIndex++}`; params.push(estado); } 

        query += ` ORDER BY p.nombre ASC, e.fecha ASC;`;
        res.json((await pool.query(query, params)).rows);
    } catch (error) { res.status(500).json({ error: 'Error al consultar el inventario' }); }
});

// ==========================================
// ENTRADAS (ALMACÉN O TRÁNSITO)
// ==========================================

// VERIFICAR SI UN PRODUCTO TIENE STOCK EN TRÁNSITO
app.get('/api/productos/verificar-transito/:id', verificarToken, async (req, res) => {
    const { id } = req.params;
    try {
        const transitoRes = await pool.query(
            `SELECT COUNT(*), SUM(stock_restante) as total_transito 
             FROM entradas 
             WHERE producto_id = $1 AND estado = 'TRANSITO'`,
            [id]
        );
        
        const count = parseInt(transitoRes.rows[0].count) || 0;
        const total = parseFloat(transitoRes.rows[0].total_transito) || 0;

        res.json({ enTransito: count > 0, cantidadTransito: total });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al verificar tránsito' });
    }
});

app.post('/api/entradas', verificarToken, verificarRol(['Master', 'Administrador', 'Operario']), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        let fechaTransaccion = new Date().toISOString();
        if (req.body.fecha) {
            fechaTransaccion = req.body.fecha.includes('T') ? req.body.fecha : `${req.body.fecha}T${new Date().toTimeString().split(' ')[0]}-04:00`; 
        }

        const cantidadNumerica = parseFloat(req.body.cantidad);
        const nroDocumento = req.body.nro_documento || 'S/N';
        const costoNumerico = parseFloat(req.body.costo_unitario) || 0; 
        const estado = req.body.estado || 'DISPONIBLE'; 

        await client.query('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [cantidadNumerica, req.body.producto_id]);
        
        await client.query('INSERT INTO entradas (producto_id, cantidad, costo_unitario, stock_restante, fecha, usuario_id, nro_documento, estado) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', 
            [req.body.producto_id, cantidadNumerica, costoNumerico, cantidadNumerica, fechaTransaccion, req.user.id, nroDocumento, estado]);
        
        await client.query('COMMIT'); 
        res.status(201).json({ mensaje: `Lote registrado exitosamente como ${estado === 'DISPONIBLE' ? 'Disponible' : 'En Tránsito'}` });
    } catch (error) { 
        await client.query('ROLLBACK'); res.status(500).json({ error: error.message }); 
    } finally { client.release(); }
});

// ==========================================
// RECIBIR INVENTARIO EN TRÁNSITO
// ==========================================
app.post('/api/entradas/recibir-transito/:id', verificarToken, verificarRol(['Master', 'Administrador', 'Operario']), async (req, res) => {
    const loteId = req.params.id;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const rawCantidad = req.body.cantidad_recibida;
        const cantidad_recibida = parseFloat(String(rawCantidad).replace(',', '.'));
        const nroDocumento = req.body.nro_documento || 'S/N';
        
        let fechaRecepcion = new Date().toISOString();
        if (req.body.fecha) {
            fechaRecepcion = req.body.fecha.includes('T') ? req.body.fecha : `${req.body.fecha}T${new Date().toTimeString().split(' ')[0]}-04:00`; 
        }

        if (isNaN(cantidad_recibida) || cantidad_recibida <= 0) throw new Error('La cantidad recibida debe ser un número mayor a cero.');

        const reg = await client.query(`SELECT * FROM entradas WHERE id = $1 AND estado = 'TRANSITO' FOR UPDATE`, [loteId]);
        if (reg.rows.length === 0) throw new Error('Lote en tránsito no encontrado o ya fue recibido totalmente.');
        const loteOriginal = reg.rows[0];

        if (cantidad_recibida > parseFloat(loteOriginal.stock_restante)) {
            throw new Error(`No puedes recibir más de lo que está pendiente en tránsito (${loteOriginal.stock_restante}).`);
        }

        await client.query('UPDATE entradas SET cantidad = cantidad - $1, stock_restante = stock_restante - $1 WHERE id = $2', [cantidad_recibida, loteId]);

        // AL RECIBIR, GUARDAMOS EL ID DEL LOTE PADRE PARA PODER ANULARLO DESPUÉS
        const nuevoLote = await client.query(
            `INSERT INTO entradas (producto_id, cantidad, costo_unitario, stock_restante, fecha, usuario_id, nro_documento, estado, lote_origen_id) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'DISPONIBLE', $8) RETURNING id`, 
            [loteOriginal.producto_id, cantidad_recibida, loteOriginal.costo_unitario, cantidad_recibida, fechaRecepcion, req.user.id, nroDocumento, loteId]
        );

        const detallesAudit = `Recepción de Tránsito. Doc: ${nroDocumento}. Cantidad recibida: ${cantidad_recibida}. Origen ID: ${loteId}`;
        await client.query('INSERT INTO logs_auditoria (usuario_id, accion, tabla_afectada, registro_id, detalles) VALUES ($1, $2, $3, $4, $5)', 
            [req.user.id, 'RECEPCION_TRANSITO', 'entradas', nuevoLote.rows[0].id, detallesAudit]);

        await client.query('COMMIT'); 
        res.status(200).json({ mensaje: 'Recepción registrada con éxito. Ya está disponible en inventario.' });
    } catch (error) { 
        await client.query('ROLLBACK'); 
        res.status(400).json({ error: error.message }); 
    } finally { 
        client.release(); 
    }
});

// ==========================================
// ANULAR RECEPCIÓN DE TRÁNSITO (SOLO ADMIN Y MASTER)
// ==========================================
app.post('/api/entradas/anular-recepcion/:id', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    const loteId = req.params.id;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Verificamos el lote disponible a anular
        const reg = await client.query(`SELECT * FROM entradas WHERE id = $1 FOR UPDATE`, [loteId]);
        if (reg.rows.length === 0) throw new Error('El lote que intentas anular no existe.');
        const loteAnular = reg.rows[0];

        if (loteAnular.estado !== 'DISPONIBLE' || !loteAnular.lote_origen_id) {
            throw new Error('Este registro no corresponde a una recepción de tránsito anulable.');
        }
        
        if (parseFloat(loteAnular.cantidad) !== parseFloat(loteAnular.stock_restante)) {
            throw new Error(`Imposible anular. De los ${loteAnular.cantidad} recibidos, ya se han consumido y solo quedan ${loteAnular.stock_restante}.`);
        }

        // 2. Devolvemos la cantidad al lote de tránsito original
        await client.query('UPDATE entradas SET cantidad = cantidad + $1, stock_restante = stock_restante + $1 WHERE id = $2', [loteAnular.cantidad, loteAnular.lote_origen_id]);

        // 3. Borramos el lote disponible. No restamos de productos.stock_actual porque nunca sumó al recibir (ya sumó al comprarse en tránsito)
        await client.query(`DELETE FROM entradas WHERE id = $1`, [loteId]);

        // 4. Dejamos huella en auditoría
        const detallesAudit = `Anulación de Recepción. Cantidad devuelta al tránsito: ${loteAnular.cantidad}. Origen restaurado ID: ${loteAnular.lote_origen_id}`;
        await client.query('INSERT INTO logs_auditoria (usuario_id, accion, tabla_afectada, registro_id, detalles) VALUES ($1, $2, $3, $4, $5)', 
            [req.user.id, 'ANULAR_RECEPCION', 'entradas', loteId, detallesAudit]);

        await client.query('COMMIT'); 
        res.status(200).json({ mensaje: 'Recepción anulada exitosamente. El inventario ha retornado al camión/tránsito.' });
    } catch (error) { 
        await client.query('ROLLBACK'); 
        res.status(400).json({ error: error.message }); 
    } finally { 
        client.release(); 
    }
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
    
    let rawCantidad = req.body.nueva_cantidad ?? req.body.cantidad ?? req.body.cantidad_nueva;
    const nueva_cantidad = parseFloat(String(rawCantidad).replace(',', '.'));
    
    if (isNaN(nueva_cantidad)) {
        return res.status(400).json({ error: 'Cantidad inválida. Verifica que el campo no esté vacío o mal formateado.' });
    }

    const motivo = req.body.motivo || 'Ajuste manual de inventario'; 
    const tabla = (tipo === 'entrada' || tipo === 'entradas') ? 'entradas' : 'salidas';
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        const reg = await client.query(`SELECT * FROM ${tabla} WHERE id = $1`, [id]);
        if (reg.rows.length === 0) throw new Error('Registro no encontrado en la base de datos');
        
        const mov = reg.rows[0]; 
        const cantOriginal = parseFloat(mov.cantidad) || 0;
        const diferencia = nueva_cantidad - cantOriginal;

        if (tabla === 'entradas') {
            const stockRestanteOriginal = parseFloat(mov.stock_restante) || 0;
            const consumido = cantOriginal - stockRestanteOriginal;

            if (nueva_cantidad < consumido) {
                throw new Error(`Este lote ya tiene consumido ${consumido}. No puedes reducirlo a un valor menor.`);
            }
            
            const nuevo_stock_restante = nueva_cantidad - consumido;

            await client.query('UPDATE entradas SET cantidad = $1, stock_restante = $2 WHERE id = $3', [nueva_cantidad, nuevo_stock_restante, id]);
            await client.query('UPDATE productos SET stock_actual = stock_actual + $1::numeric WHERE id = $2', [diferencia, mov.producto_id]);
        } else {
            if (diferencia > 0) await descontarStock(client, mov.producto_id, diferencia);
            else if (diferencia < 0) await restaurarStock(client, mov.producto_id, Math.abs(diferencia));
            await client.query('UPDATE salidas SET cantidad = $1 WHERE id = $2', [nueva_cantidad, id]);
        }
        
        await client.query('INSERT INTO logs_auditoria (usuario_id, accion, tabla_afectada, registro_id, detalles) VALUES ($1, $2, $3, $4, $5)', 
            [req.user.id, 'EDICION', tabla, id, JSON.stringify({ cantidad_anterior: cantOriginal, cantidad_nueva: nueva_cantidad, motivo })]);
            
        await client.query('COMMIT'); 
        res.status(200).json({ mensaje: 'Editado con éxito' });
    } catch (error) { 
        await client.query('ROLLBACK'); 
        console.error("Error en edición:", error);
        res.status(400).json({ error: error.message }); 
    } finally { 
        client.release(); 
    }
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
            
            // BLINDAJE CONTRA ERRORES ADMINISTRATIVOS
            if (mov.lote_origen_id) {
                throw new Error('Este registro proviene de un camión en tránsito. Para eliminarlo, ve al Dashboard y presiona el botón rojo "Anular".');
            }

            await client.query('UPDATE productos SET stock_actual = stock_actual - $1 WHERE id = $2', [mov.cantidad, mov.producto_id]);
        }
        if (tabla === 'salidas') await restaurarStock(client, mov.producto_id, mov.cantidad);
        
        await client.query('INSERT INTO logs_auditoria (usuario_id, accion, tabla_afectada, registro_id, detalles) VALUES ($1, $2, $3, $4, $5)', [req.user.id, 'BORRADO', tabla, id, JSON.stringify({ ...mov, motivo: motivo || 'N/A' })]);
        await client.query(`DELETE FROM ${tabla} WHERE id = $1`, [id]);
        await client.query('COMMIT'); res.json({ mensaje: 'Eliminado con éxito' });
    } catch (error) { await client.query('ROLLBACK'); res.status(400).json({ error: error.message }); } finally { client.release(); }
});

// ==========================================
// EXCEL Y REPORTES OMITIDOS PARA AHORRAR ESPACIO VISUAL, PERO YA LOS TIENES ABAJO IGUAL
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

app.get('/api/reporte/descargar-stock', verificarToken, async (req, res) => {
    const { producto, categoria, almacen, estado } = req.query;
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
            { header: 'Almacén', key: 'almacen', width: 20 }, { header: 'Estado', key: 'estado', width: 15 }, { header: 'Stock', key: 'stock_restante', width: 15 },
            { header: 'Unidad', key: 'unidad_medida', width: 10 }
        ];

        if (puedeVerCostos) {
            cols.push({ header: 'Costo Unit. ($)', key: 'costo_unitario', width: 15 }, { header: 'Costo Total ($)', key: 'costo_total', width: 18 });
        }
        worksheet.columns = cols;

        worksheet.spliceRows(1, 0, [], [], [], []); 
        const fechaActual = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });
        const lastCol = puedeVerCostos ? 'J' : 'H'; 

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

        let query = `SELECT e.id, p.sku, p.nombre AS producto_nombre, p.unidad_medida, c.nombre AS categoria_nombre, c.almacen, e.estado, e.stock_restante, e.costo_unitario 
                     FROM entradas e JOIN productos p ON e.producto_id = p.id LEFT JOIN categorias c ON p.categoria_id = c.id WHERE e.stock_restante > 0`;
        let params = []; let paramIndex = 1;

        if (producto) { query += ` AND p.id = $${paramIndex++}`; params.push(producto); }
        if (categoria) { query += ` AND c.id = $${paramIndex++}`; params.push(categoria); }
        if (almacen) { query += ` AND c.almacen = $${paramIndex++}`; params.push(almacen); }
        if (estado) { query += ` AND e.estado = $${paramIndex++}`; params.push(estado); }

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
                    if (partes.length === 3) fechaEntrada = `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}T12:00:00-04:00`; 
                }
                const estado = row.ESTADO || 'DISPONIBLE';
                await client.query('INSERT INTO entradas (producto_id, cantidad, costo_unitario, stock_restante, fecha, usuario_id, estado) VALUES ($1, $2, $3, $4, $5, $6, $7)', 
                    [row.PRODUCTO_ID, row.CANTIDAD, row.COSTO, row.CANTIDAD, fechaEntrada, req.user.id, estado]);
                await client.query('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [row.CANTIDAD, row.PRODUCTO_ID]);
            }
        }
        await client.query('COMMIT'); res.json({ mensaje: `Carga masiva de ${tipo} completada` });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

app.get('/api/reporte/logs', verificarToken, verificarRol(['Master', 'Administrador']), async (req, res) => {
    try {
        const query = `SELECT l.id, l.accion, l.tabla_afectada, l.registro_id, l.detalles, l.fecha, 
                              u.nombre AS admin, 
                              u.nombre AS admin_nombre, 
                              u.nombre AS usuario, 
                              u.nombre AS usuario_nombre 
                       FROM logs_auditoria l 
                       LEFT JOIN usuarios u ON l.usuario_id = u.id 
                       ORDER BY l.fecha DESC LIMIT 100`;
        const resultado = await pool.query(query);
        res.status(200).json(resultado.rows);
    } catch (error) { 
        console.error("Error al consultar logs:", error);
        res.status(500).json({ error: 'Error al consultar logs de auditoría' }); 
    }
});

app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));