const fs = require('fs');
const path = require('path');

const nuevoNav = `      <nav class="flex-1 p-4 space-y-2 overflow-y-auto">
        <a href="index.html" class="block px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition">📊 Dashboard Inventario</a>
        <a href="costeo.html" class="admin-only block px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition">💰 Costeo de Existencias</a>
        <a href="productos.html" class="block px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition">📦 Maestro de Productos</a>
        <a href="entradas.html" class="block px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition">📥 Registro de Compras</a>
        <a href="salidas.html" class="block px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition">📤 Registro de Salidas</a>
        <a href="reportes.html" class="block px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition">📑 Historial y Reportes</a>
        <a href="categorias.html" class="block px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition">🏷️ Categorías y Almacén</a>
        <a href="carga.html" class="block px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition">📂 Carga Masiva</a>
        <a href="usuarios.html" class="master-only block px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition">👥 Gestión de Usuarios</a>
        <a href="auditoria.html" class="admin-only block px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition">🛡️ Auditoría del Sistema</a>
      </nav>`;

const publicDir = path.join(__dirname, 'public');

if (fs.existsSync(publicDir)) {
    fs.readdirSync(publicDir).forEach(file => {
        if (file.endsWith('.html')) {
            const filePath = path.join(publicDir, file);
            let content = fs.readFileSync(filePath, 'utf8');
            
            // Reemplaza cualquier bloque <nav> por este diseño limpio
            if (content.match(/<nav[\s\S]*?<\/nav>/)) {
                content = content.replace(/<nav[\s\S]*?<\/nav>/, nuevoNav);
                fs.writeFileSync(filePath, content, 'utf8');
                console.log(`✅ Menú actualizado en: ${file}`);
            } else {
                console.log(`⚠️ No se encontró etiqueta <nav> en: ${file}`);
            }
        }
    });
    console.log('🎉 ¡Sincronización masiva completada con éxito!');
} else {
    console.log('❌ No se encontró la carpeta public.');
}