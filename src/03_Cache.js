/**
 * Caché de script con invalidación por versión (ver plan: "Invalidación por
 * versión, no por borrado"). dataVersion vive en ScriptProperties y se
 * incrementa tras cada transacción exitosa (crear cotización, cambiar
 * estado, generar documento). Las keys de caché incluyen la versión vigente
 * en el momento de escribirse, así que un cambio de versión deja todas las
 * keys viejas huérfanas: expiran solas, sin necesidad de borrarlas a mano.
 *
 * CacheService limita cada valor a 100 KB y falla en silencio si se excede
 * ese límite (put() simplemente no persiste). cachePutJson_/cacheGetJson_
 * parten el JSON en trozos de <=90 KB para dejar margen.
 */

var CACHE_CHUNK_SIZE_ = 90000; // caracteres, margen bajo el límite de 100KB de CacheService
var DATA_VERSION_PROP_ = 'DATA_VERSION';

function cache_() {
  return CacheService.getScriptCache();
}

/**
 * Guarda un valor JSON-serializable bajo `key`, partiéndolo en chunks si
 * hace falta. Devuelve true si se pudo verificar la escritura completa.
 */
function cachePutJson_(key, value, ttlSeconds) {
  var json = JSON.stringify(value);
  var cache = cache_();

  if (json.length <= CACHE_CHUNK_SIZE_) {
    cache.put(key, json, ttlSeconds);
    return cache.get(key) === json;
  }

  var chunks = [];
  for (var i = 0; i < json.length; i += CACHE_CHUNK_SIZE_) {
    chunks.push(json.slice(i, i + CACHE_CHUNK_SIZE_));
  }

  var map = {};
  map[key] = JSON.stringify({ __chunks: chunks.length });
  for (var c = 0; c < chunks.length; c++) {
    map[key + ':' + c] = chunks[c];
  }
  cache.putAll(map, ttlSeconds);

  // Verificación: releer el índice y el primer/último chunk.
  var idxRaw = cache.get(key);
  if (!idxRaw) return false;
  try {
    var idx = JSON.parse(idxRaw);
    if (!idx || idx.__chunks !== chunks.length) return false;
  } catch (e) {
    return false;
  }
  return cache.get(key + ':0') === chunks[0] &&
    cache.get(key + ':' + (chunks.length - 1)) === chunks[chunks.length - 1];
}

/**
 * Lee un valor guardado con cachePutJson_. Devuelve null si no está en
 * caché, está incompleto, o no se pudo parsear.
 */
function cacheGetJson_(key) {
  var cache = cache_();
  var raw = cache.get(key);
  if (raw == null) return null;

  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // No era el índice de chunks: es el valor directo (caso <= CACHE_CHUNK_SIZE_).
    return null;
  }

  if (!isPlainObject_(parsed) || typeof parsed.__chunks !== 'number') {
    // JSON válido pero no es nuestro formato de índice; tratar como valor directo.
    return parsed;
  }

  var keys = [];
  for (var c = 0; c < parsed.__chunks; c++) keys.push(key + ':' + c);
  var all = cache.getAll(keys);

  var full = '';
  for (var i = 0; i < keys.length; i++) {
    var chunk = all[keys[i]];
    if (chunk == null) return null; // chunk expirado/incompleto -> tratar como cache miss
    full += chunk;
  }

  try {
    return JSON.parse(full);
  } catch (e2) {
    return null;
  }
}

/**
 * Versión de datos vigente. Empieza en 1 si nunca se ha usado.
 * Lectura barata: ScriptProperties, no toca ningún Sheet (~20ms).
 */
function dataVersion_() {
  var props = PropertiesService.getScriptProperties();
  var v = props.getProperty(DATA_VERSION_PROP_);
  return v ? Number(v) : 1;
}

/**
 * Incrementa la versión de datos. Debe llamarse tras cada escritura que
 * afecte lo que ve el dashboard o los dropdowns dependientes (crear
 * cotización, cambiar estado, generar/regenerar documento, crear cliente/
 * contacto/establecimiento).
 */
function bumpDataVersion_() {
  var props = PropertiesService.getScriptProperties();
  var next = dataVersion_() + 1;
  props.setProperty(DATA_VERSION_PROP_, String(next));
  return next;
}
