// Genera precios.json a partir de datos/catalogo.json, datos/precios.csv y scripts/fuentes/*.mjs
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const avisos = [];
const num = s => { const n = parseFloat(String(s ?? '').trim().replace(',', '.')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };

function partir(linea, sep) {
  const out = []; let cur = '', q = false;
  for (const ch of linea) {
    if (ch === '"') { q = !q; continue; }
    if (ch === sep && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur); return out.map(s => s.trim());
}
function leerCSV(txt) {
  const lineas = txt.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  if (!lineas.length) return [];
  const sep = lineas[0].includes(';') ? ';' : ',';
  const cab = partir(lineas[0], sep).map(h => h.toLowerCase());
  return lineas.slice(1).map(l => { const c = partir(l, sep); return Object.fromEntries(cab.map((h, i) => [h, c[i] ?? ''])); });
}

// 1) Catálogo
const catalogo = JSON.parse(await readFile(path.join(ROOT, 'datos', 'catalogo.json'), 'utf8'));
const idsProductos = new Set(catalogo.productos.map(p => p.id));

// 1b) Calcular qué supermercados hay en cada ciudad a partir de las "zonas" de cada cadena
const coincide = (lista, c) => (lista || []).some(z => z === '*' || z === c.provincia || z === c.comunidad);
for (const [nombre, c] of Object.entries(catalogo.ciudades)) {
  if (!Array.isArray(c.supers)) {
    c.supers = Object.keys(catalogo.supers).filter(sid => {
      const s = catalogo.supers[sid];
      return coincide(s.zonas || ['*'], c) && !(s.excepto || []).some(z => z === c.provincia || z === c.comunidad);
    });
  }
  if (!c.supers.length) avisos.push(`${nombre} no tiene ningún supermercado asignado`);
}

// 2) Precios manuales (CSV)
const manuales = [];
const csvPath = path.join(ROOT, 'datos', 'precios.csv');
if (existsSync(csvPath)) {
  for (const fila of leerCSV(await readFile(csvPath, 'utf8'))) {
    for (const sid of Object.keys(catalogo.supers)) {
      const v = fila[sid]; if (!v) continue;
      const [a, b] = v.split('/');
      const regular = num(a), oferta = num(b);
      if (!regular) { avisos.push(`Precio no válido "${v}" (${fila.producto}, ${sid})`); continue; }
      manuales.push({ ciudad: fila.ciudad || '*', super: sid, producto: fila.producto, regular, precio: oferta && oferta < regular ? oferta : regular });
    }
  }
  console.log(`✔ precios.csv: ${manuales.length} precios`);
}

// 3) Fuentes automáticas opcionales (fase 2): cada archivo exporta  default async ({catalogo}) => [{ciudad, super, producto, precio, regular?}]
const automaticas = [];
const dirFuentes = path.join(ROOT, 'scripts', 'fuentes');
if (existsSync(dirFuentes)) {
  for (const archivo of (await readdir(dirFuentes)).filter(a => a.endsWith('.mjs'))) {
    try {
      const mod = await import(pathToFileURL(path.join(dirFuentes, archivo)).href);
      const filas = (await mod.default({ catalogo })) || [];
      for (const f of filas) {
        const precio = num(f.precio), regular = num(f.regular ?? f.precio);
        if (precio && regular) automaticas.push({ ciudad: f.ciudad || '*', super: f.super, producto: f.producto, precio: Math.min(precio, regular), regular });
      }
      console.log(`✔ ${archivo}: ${filas.length} precios`);
    } catch (e) { console.warn(`✖ ${archivo} falló: ${e.message} (se usan el resto de datos)`); }
  }
}

// 4) Combinar. Orden de prioridad (la última gana): auto "*" < auto ciudad < manual "*" < manual ciudad
const porOrden = arr => [...arr.filter(f => f.ciudad === '*'), ...arr.filter(f => f.ciudad !== '*')];
const precios = {};
for (const [ciudad, c] of Object.entries(catalogo.ciudades)) {
  precios[ciudad] = {};
  for (const sid of c.supers) precios[ciudad][sid] = {};
}
for (const f of [...porOrden(automaticas), ...porOrden(manuales)]) {
  if (!catalogo.supers[f.super]) { avisos.push(`Súper desconocido: ${f.super}`); continue; }
  if (!idsProductos.has(f.producto)) { avisos.push(`Producto desconocido: ${f.producto}`); continue; }
  if (f.ciudad !== '*' && !catalogo.ciudades[f.ciudad]) { avisos.push(`Ciudad desconocida: ${f.ciudad}`); continue; }
  const destinos = f.ciudad === '*' ? Object.keys(catalogo.ciudades) : [f.ciudad];
  for (const ciudad of destinos) {
    const tienda = precios[ciudad][f.super];
    if (tienda) tienda[f.producto] = { p: f.precio, r: f.regular };
  }
}

// 5) Guardar
const salida = { actualizado: new Date().toISOString(), supers: catalogo.supers, ciudades: catalogo.ciudades, productos: catalogo.productos, precios };
await writeFile(path.join(ROOT, 'precios.json'), JSON.stringify(salida));
const total = Object.values(precios).reduce((t, c) => t + Object.values(c).reduce((u, s) => u + Object.keys(s).length, 0), 0);
console.log(`✔ precios.json generado: ${total} precios en ${Object.keys(precios).length} ciudades`);
[...new Set(avisos)].forEach(a => console.warn('⚠ ' + a));
