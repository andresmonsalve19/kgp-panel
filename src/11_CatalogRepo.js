/**
 * Catálogo TIPOS DE SERVICIOS: sheet 1n87Kj1wgP7PQ3jZXunHgiR7EK2MqG7zcDzhHwCCkaqM,
 * hoja "TIPOS DE SERVICIOS": columna A desde A2 (tipos) y columna B desde B2
 * (código UNSPSC correspondiente, MISMA FILA — no son dos listas
 * independientes). Sin encabezado formal garantizado en la fila 1, así que
 * se lee por posición explícita, no por repo_readTable_.
 *
 * Sin caché a propósito: el usuario espera ver cualquier valor agregado a
 * la hoja reflejado de inmediato la próxima vez que se abra el formulario
 * (bootstrap), y la lectura es una sola llamada barata (2 columnas).
 */

function cat_getTiposServicioSheet_() {
  var ss = SpreadsheetApp.openById(CFG_().CAT_SHEET_ID);
  var sheet = ss.getSheetByName(CFG_().TABS.TIPOS_SERVICIO);
  if (!sheet) {
    var names = ss.getSheets().map(function (s) { return s.getName(); });
    throw new AppError_('SCHEMA', 'No se encontró la hoja "' + CFG_().TABS.TIPOS_SERVICIO + '" en el catálogo. Hojas disponibles: [' + names.join(', ') + ']');
  }
  return sheet;
}

/**
 * Lee columnas A y B (desde la fila 2) en una sola llamada a Sheets,
 * preservando la correspondencia por fila: pares[i] = {tipo, codigoUnspsc}
 * viene de la misma fila del sheet. Memoizado con repo_memo_() (ver
 * 10_SheetRepo.js) para no repetir la lectura si algo más la pide dentro de
 * la misma ejecución del script.
 */
function cat_readCatalogo_() {
  var memo = repo_memo_();
  var key = 'catTiposServicios';
  if (memo[key]) return memo[key];

  var sheet = cat_getTiposServicioSheet_();
  var lastRow = sheet.getLastRow();
  var pares = [];
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    values.forEach(function (r) {
      var tipo = String(r[0] || '').trim();
      var codigo = String(r[1] || '').trim();
      if (tipo) pares.push({ tipo: tipo, codigoUnspsc: codigo });
    });
  }

  var result = { pares: pares };
  memo[key] = result;
  return result;
}

/** Columna A desde A2: nombres de tipo de servicio, en orden de aparición. */
function cat_getTiposServicio_() {
  return cat_readCatalogo_().pares.map(function (p) { return p.tipo; });
}

/** Pares {tipo, codigoUnspsc} alineados por fila — para que el cliente arme el mapa tipo -> código. */
function cat_getCatalogoPares_() {
  return cat_readCatalogo_().pares;
}


/** true si `tipo` coincide (normalizado) con alguna entrada del catálogo. */
function cat_isTipoValido_(tipo) {
  var norm = normText_(tipo);
  if (!norm) return false;
  var tipos = cat_getTiposServicio_();
  return tipos.some(function (t) { return normText_(t) === norm; });
}
