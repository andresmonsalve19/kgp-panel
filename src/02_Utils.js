/**
 * Utilidades genéricas compartidas por toda la webapp nueva.
 * No se comparte nada con src/otherFunctions.js (respaldo aislado).
 */

function errMsg_(error) {
  return error && error.message ? error.message : String(error);
}

/** Quita acentos/diacríticos: "Descripción" -> "Descripcion". */
function stripAccents_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Caché de normText_ (vive solo durante la ejecución actual del script). */
var NORM_TEXT_CACHE_ = null;
var NORM_TEXT_CACHE_MAX_ = 20000;

/**
 * Normaliza texto para comparar encabezados de columna de forma tolerante:
 * sin acentos, mayúsculas, espacios colapsados, sin espacios en los bordes.
 * "Fecha Elaboración " -> "FECHA ELABORACION"
 *
 * Memoizada: se llama con los mismos nombres de columna miles de veces por
 * ejecución (una por campo y por fila en los *_rowToObj_), y normalize('NFD')
 * + 3 regex no son gratis. Si la caché crece demasiado se reinicia.
 *
 * @param {*} s Texto (o valor de celda) a normalizar.
 * @return {string}
 */
function normText_(s) {
  var key = String(s == null ? '' : s);
  var cache = NORM_TEXT_CACHE_ || (NORM_TEXT_CACHE_ = new Map());
  var hit = cache.get(key);
  if (hit !== undefined) return hit;
  var out = stripAccents_(key).toUpperCase().replace(/\s+/g, ' ').trim();
  if (cache.size >= NORM_TEXT_CACHE_MAX_) cache.clear();
  cache.set(key, out);
  return out;
}

/** Entero con 2 dígitos: 7 -> "07". */
function pad2_(n) {
  var v = Math.trunc(Math.abs(Number(n) || 0));
  return (v < 10 ? '0' : '') + v;
}

/** Entero con 3 dígitos: 7 -> "007" (consecutivos NNN). */
function pad3_(n) {
  var v = Math.trunc(Math.abs(Number(n) || 0));
  if (v < 10) return '00' + v;
  if (v < 100) return '0' + v;
  return String(v);
}

/** Formatea una Date en la zona horaria de CFG_().TZ. pattern estilo Utilities.formatDate. */
function fmtDate_(date, pattern) {
  return Utilities.formatDate(date, CFG_().TZ, pattern);
}

/** Parsea una fecha ISO 'yyyy-MM-dd' a Date, en la zona horaria de CFG_().TZ (mediodía para evitar bordes de DST). */
function parseISODate_(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return null;
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  var dt = new Date(y, mo - 1, d, 12, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/** Devuelve 'yyyy-MM-dd' de una Date, en CFG_().TZ. */
function toISODate_(date) {
  return fmtDate_(date, 'yyyy-MM-dd');
}

/** Suma días (entero, puede ser 0) a una Date y devuelve una nueva Date. */
function addDays_(date, days) {
  var d = new Date(date.getTime());
  d.setDate(d.getDate() + Math.trunc(days));
  return d;
}

/** Trunca un string a maxLen caracteres (por defecto CFG_().LIMITS.CELL_MAX). */
function truncate_(s, maxLen) {
  var str = String(s == null ? '' : s);
  var limit = maxLen || CFG_().LIMITS.CELL_MAX;
  return str.length > limit ? str.slice(0, limit) : str;
}

/** trim + colapsar espacios internos + truncar a CELL_MAX. Para todo texto libre que entra a un Sheet. */
function cleanText_(s) {
  var str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return truncate_(str, CFG_().LIMITS.CELL_MAX);
}

/**
 * Como cleanText_, pero conserva los saltos de línea (cada línea se limpia
 * por separado y se descartan las vacías). Para campos acumulativos como
 * SERVICIOS.OBSERVACIONES, donde cada observación nueva va en su propia línea.
 */
function cleanMultiline_(s) {
  var lines = String(s == null ? '' : s).split(/\r?\n/)
    .map(function (l) { return l.replace(/\s+/g, ' ').trim(); })
    .filter(function (l) { return l; });
  return truncate_(lines.join('\n'), CFG_().LIMITS.CELL_MAX);
}

/** Redondeo a 2 decimales (montos en pesos: IVA, totales). */
function round2_(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Une partes no vacías con un separador, sin dejar separadores colgando. joinNonEmpty_(['Bogotá','',''], ', ') -> 'Bogotá' */
function joinNonEmpty_(parts, sep) {
  var clean = [];
  for (var i = 0; i < parts.length; i++) {
    var v = String(parts[i] == null ? '' : parts[i]).trim();
    if (v) clean.push(v);
  }
  return clean.join(sep);
}

/** Convierte un nombre de archivo/código a algo seguro para Drive (sin caracteres problemáticos). */
function sanitizeFileName_(name) {
  return String(name || '').replace(/[\/:*?"<>|]/g, '-').trim();
}

/** Número acotado a [min, max]; un valor no numérico devuelve min. */
function clamp_(n, min, max) {
  var v = Number(n);
  if (isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}

/** true si v es un objeto plano (no null, no array). */
function isPlainObject_(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
