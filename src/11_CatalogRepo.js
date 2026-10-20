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
 *
 * Se edita desde la vista "Configuración" (cat_guardarTipo_ /
 * cat_eliminarTipo_, abajo) o a mano en la hoja.
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

// ---------------------------------------------------------------------
// Edición desde la vista "Configuración" (CLAUDE.md §15)
// ---------------------------------------------------------------------

/**
 * Filas del catálogo con su número de fila real en la hoja (para editar o
 * borrar esa fila): [{fila, tipo, codigoUnspsc}]. Siempre fresco (sin memo).
 */
function cat_listarConFila_() {
  var sheet = cat_getTiposServicioSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, 2).getValues().map(function (r, i) {
    return { fila: i + 2, tipo: String(r[0] || '').trim(), codigoUnspsc: String(r[1] == null ? '' : r[1]).trim() };
  }).filter(function (p) { return p.tipo; });
}

/**
 * Verifica que la fila `fila` siga teniendo el tipo `tipoAnterior` (otra
 * persona pudo haber editado o borrado la hoja mientras tanto). DEBE
 * llamarse dentro del lock.
 * @throws {AppError_} VALIDATION / CONFLICT.
 */
function cat_verificarFila_(sheet, fila, tipoAnterior) {
  fila = Math.trunc(Number(fila));
  if (!fila || fila < 2 || fila > sheet.getLastRow()) {
    throw new AppError_('CONFLICT', 'Ese tipo de servicio ya no está en la hoja. Actualiza la lista.');
  }
  var actual = String(sheet.getRange(fila, 1).getValue() || '').trim();
  if (normText_(actual) !== normText_(tipoAnterior)) {
    throw new AppError_('CONFLICT', 'La hoja de tipos de servicio cambió mientras editabas. Actualiza la lista e inténtalo de nuevo.');
  }
  return fila;
}

/**
 * Crea (datos.fila vacío) o edita un tipo de servicio: columna A = tipo,
 * columna B = código UNSPSC de la MISMA fila (§2.1). Rechaza tipos repetidos
 * (comparados con normText_). Renombrar o borrar un tipo no cambia los
 * servicios ya guardados: conservan su texto.
 * @param {{fila: (number|undefined), tipoAnterior: (string|undefined),
 *     tipo: string, codigoUnspsc: string}} datos
 * @return {!Object} ok_([{fila, tipo, codigoUnspsc}]) con la lista completa, o fail_.
 */
function cat_guardarTipo_(datos) {
  datos = isPlainObject_(datos) ? datos : {};
  var tipo = cleanText_(datos.tipo);
  var codigo = cleanText_(datos.codigoUnspsc);
  var errores = {};
  if (!tipo) errores.tipo = 'El tipo de servicio es obligatorio.';
  else if (tipo.length > 200) errores.tipo = 'Máximo 200 caracteres.';
  if (!codigo) errores.codigoUnspsc = 'El código UNSPSC es obligatorio.';
  else if (codigo.length > 40) errores.codigoUnspsc = 'Máximo 40 caracteres.';
  if (Object.keys(errores).length) return fail_('VALIDATION', 'Revisa los campos marcados.', errores);
  var esNuevo = !datos.fila;

  return tx_conLock_('cat_guardarTipo_', function () {
    var sheet = cat_getTiposServicioSheet_();
    var fila = esNuevo ? 0 : cat_verificarFila_(sheet, datos.fila, datos.tipoAnterior);
    var repetido = cat_listarConFila_().filter(function (p) {
      return p.fila !== fila && normText_(p.tipo) === normText_(tipo);
    })[0];
    if (repetido) return fail_('VALIDATION', 'Ya existe el tipo de servicio "' + repetido.tipo + '".', { tipo: 'Ya existe ese tipo de servicio.' });

    if (esNuevo) fila = Math.max(sheet.getLastRow(), 1) + 1;
    // Texto plano: un código UNSPSC con ceros a la izquierda no debe volverse número.
    sheet.getRange(fila, 1, 1, 2).setNumberFormat('@').setValues([[tipo, codigo]]);
    delete repo_memo_().catTiposServicios;
    return ok_(cat_listarConFila_());
  }, { payload: datos });
}

/**
 * Elimina la fila de un tipo de servicio (verificando que siga siendo el
 * mismo). Las cotizaciones que ya lo usan conservan su texto.
 * @return {!Object} ok_([{fila, tipo, codigoUnspsc}]) o fail_.
 */
function cat_eliminarTipo_(fila, tipoAnterior) {
  return tx_conLock_('cat_eliminarTipo_', function () {
    var sheet = cat_getTiposServicioSheet_();
    var f = cat_verificarFila_(sheet, fila, tipoAnterior);
    if (cat_listarConFila_().length <= 1) {
      return fail_('VALIDATION', 'Debe quedar al menos un tipo de servicio.');
    }
    sheet.deleteRow(f);
    delete repo_memo_().catTiposServicios;
    return ok_(cat_listarConFila_());
  }, { payload: { fila: fila, tipoAnterior: tipoAnterior } });
}
