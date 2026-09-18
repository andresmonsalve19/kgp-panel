/**
 * Capa genérica de acceso a hojas de Sheets. Resuelve columnas por NOMBRE
 * de encabezado (normalizado, sin acentos), nunca por índice fijo, porque
 * no tenemos certeza del esquema real hasta ejecutar admin_health() desde
 * el editor de Apps Script (ver Fase 2 del plan).
 *
 * Regla de eficiencia: una sola lectura getDataRange().getValues() por hoja
 * por ejecución, memoizada en repo_memo_(). Nunca getRange() dentro de un
 * bucle, nunca getLastRow() iterando.
 */

var repo_memoCache_ = null; // objeto vivo solo durante la ejecución actual del script

function repo_memo_() {
  if (!repo_memoCache_) repo_memoCache_ = {};
  return repo_memoCache_;
}

/** Limpia la memoización local (llamar tras escrituras que deban reflejarse en la misma ejecución). */
function repo_clearMemo_(ssId, tabName) {
  var memo = repo_memo_();
  var key = ssId + '::' + tabName;
  delete memo[key];
}

function repo_openSheet_(ssId, tabName) {
  var ss;
  try {
    ss = SpreadsheetApp.openById(ssId);
  } catch (e) {
    throw new AppError_('SCHEMA', 'No se pudo abrir el spreadsheet ' + ssId + ': ' + errMsg_(e));
  }
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    var names = ss.getSheets().map(function (s) { return s.getName(); });
    throw new AppError_('SCHEMA', 'No se encontró la hoja "' + tabName + '". Hojas disponibles: [' + names.join(', ') + ']');
  }
  return sheet;
}

/** {'FECHA ELABORACION': 3, ...} 1-based, a partir de la fila 1. */
function repo_headerMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var h = normText_(headers[i]);
    if (h) map[h] = i + 1; // 1-based
  }
  return map;
}

/** Lanza SCHEMA con el detalle de qué falta y qué se encontró. */
function repo_requireCols_(hmap, tabName, requiredNames) {
  var missing = [];
  for (var i = 0; i < requiredNames.length; i++) {
    var norm = normText_(requiredNames[i]);
    if (!hmap[norm]) missing.push(requiredNames[i]);
  }
  if (missing.length) {
    var found = Object.keys(hmap);
    throw new AppError_('SCHEMA',
      'Hoja ' + tabName + ': faltan columnas requeridas [' + missing.join(', ') + ']. ' +
      'Encabezados encontrados: [' + found.join(', ') + ']');
  }
}

/** Índice 1-based de una columna opcional, o 0 si no existe. */
function repo_optionalCol_(hmap, name) {
  return hmap[normText_(name)] || 0;
}

/**
 * Lee toda la tabla de una hoja: encabezados, mapa de encabezados, filas
 * crudas (array de arrays) y filas como objetos {NOMBRE_COL: valor}
 * (claves normalizadas). Memoizado por ssId+tabName durante la ejecución.
 *
 * Devuelve { hmap, headers, values, rows, lastRow, width, sheet }
 * rows[i] tiene además __row (número de fila real en el sheet, 1-based).
 */
function repo_readTable_(ssId, tabName) {
  var memo = repo_memo_();
  var key = ssId + '::' + tabName;
  if (memo[key]) return memo[key];

  var sheet = repo_openSheet_(ssId, tabName);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow < 1 || lastCol < 1) {
    var empty = { hmap: {}, headers: [], values: [], rows: [], lastRow: lastRow, width: 0, sheet: sheet };
    memo[key] = empty;
    return empty;
  }

  var allValues = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = allValues[0];
  var hmap = {};
  for (var i = 0; i < headers.length; i++) {
    var h = normText_(headers[i]);
    if (h) hmap[h] = i + 1;
  }

  var dataRows = allValues.slice(1);
  var rows = dataRows.map(function (r, idx) {
    var obj = { __row: idx + 2 };
    for (var colName in hmap) {
      obj[colName] = r[hmap[colName] - 1];
    }
    return obj;
  });

  var result = {
    hmap: hmap,
    headers: headers,
    values: dataRows,
    rows: rows,
    lastRow: lastRow,
    width: headers.length,
    sheet: sheet
  };
  memo[key] = result;
  return result;
}

/**
 * Añade filas a una hoja en un solo setValues(). objRows es un array de
 * objetos {NOMBRE_COL: valor} (nombres tal como aparecen en SCHEMA, no
 * hace falta normalizar). Las columnas del objeto que no existan en el
 * sheet se ignoran; las columnas del sheet que no vengan en el objeto se
 * dejan en blanco ('').
 *
 * Devuelve {firstRow, count}.
 */
function repo_appendRows_(ssId, tabName, objRows) {
  if (!objRows || !objRows.length) return { firstRow: -1, count: 0 };

  var table = repo_readTable_(ssId, tabName);
  var sheet = table.sheet;
  var width = table.width;
  if (width < 1) {
    throw new AppError_('SCHEMA', 'Hoja ' + tabName + ' no tiene encabezados definidos en la fila 1.');
  }

  // Invertir hmap: índice 1-based -> nombre normalizado de columna.
  var colNameByIndex = [];
  for (var name in table.hmap) colNameByIndex[table.hmap[name]] = name;

  var matrix = objRows.map(function (obj) {
    var row = new Array(width).fill('');
    for (var col = 1; col <= width; col++) {
      var colName = colNameByIndex[col];
      if (!colName) continue;
      var value = repo_lookupByNormName_(obj, colName);
      row[col - 1] = value === undefined || value === null ? '' : value;
    }
    return row;
  });

  var firstRow = table.lastRow + 1;
  sheet.getRange(firstRow, 1, matrix.length, width).setValues(matrix);

  repo_clearMemo_(ssId, tabName);
  return { firstRow: firstRow, count: matrix.length };
}

/** Busca en un objeto una clave que normalice igual a normColName (tolera variantes de mayúsculas/acentos en las claves del objeto de entrada). */
function repo_lookupByNormName_(obj, normColName) {
  for (var k in obj) {
    if (normText_(k) === normColName) return obj[k];
  }
  return undefined;
}

/**
 * Busca filas de una tabla ya leída (repo_readTable_) cuyo valor en colName
 * (nombre sin normalizar, se normaliza internamente) esté en valueSet
 * (array o Set-like de valores). Devuelve [{rowIndex, obj}] donde rowIndex
 * es __row (1-based real en el sheet).
 */
function repo_findRowsByCol_(table, colName, values) {
  var norm = normText_(colName);
  var wanted = {};
  (values || []).forEach(function (v) { wanted[String(v)] = true; });

  var out = [];
  table.rows.forEach(function (row) {
    var v = row[norm];
    if (v != null && wanted[String(v)]) {
      out.push({ rowIndex: row.__row, obj: row });
    }
  });
  return out;
}

/** Igual que repo_findRowsByCol_ pero para un único valor; devuelve la primera coincidencia o null. */
function repo_findRowByCol_(table, colName, value) {
  var matches = repo_findRowsByCol_(table, colName, [value]);
  return matches.length ? matches[0] : null;
}

/**
 * Actualiza celdas puntuales de una fila ya existente, por nombre de
 * columna. patchObj: {NOMBRE_COL: nuevoValor}. rowIndex es el número de
 * fila real (1-based) en el sheet (viene de row.__row).
 */
function repo_updateCells_(ssId, tabName, rowIndex, patchObj) {
  var table = repo_readTable_(ssId, tabName);
  var sheet = table.sheet;

  for (var key in patchObj) {
    var norm = normText_(key);
    var col = table.hmap[norm];
    if (!col) continue; // columna no gestionada: se ignora en silencio (es opcional por diseño)
    var value = patchObj[key];
    sheet.getRange(rowIndex, col).setValue(value === undefined ? '' : value);
  }
  repo_clearMemo_(ssId, tabName);
}

/**
 * Igual que repo_updateCells_ pero para varias filas de la misma hoja con
 * UNA sola lectura: repo_updateCells_ limpia la memo tras cada llamada, así
 * que llamarlo en un bucle relee la hoja completa una vez por fila (p. ej.
 * las hasta 20 tareas de una OIS). updates: [{rowIndex, patch}].
 */
function repo_updateCellsMany_(ssId, tabName, updates) {
  if (!updates || !updates.length) return;
  var table = repo_readTable_(ssId, tabName);
  var sheet = table.sheet;
  updates.forEach(function (u) {
    for (var key in u.patch) {
      var col = table.hmap[normText_(key)];
      if (!col) continue; // columna no gestionada: se ignora (mismo criterio que repo_updateCells_)
      var value = u.patch[key];
      sheet.getRange(u.rowIndex, col).setValue(value === undefined ? '' : value);
    }
  });
  repo_clearMemo_(ssId, tabName);
}

/**
 * Elimina filas físicas de una hoja (p. ej. al quitar un servicio de una
 * cotización en edición). Borra de abajo hacia arriba para que eliminar una
 * fila no corra los índices de las que faltan por borrar. Limpia la memo
 * para que la siguiente lectura en esta misma ejecución vea el sheet real.
 */
function repo_deleteRows_(ssId, tabName, rowIndexes) {
  if (!rowIndexes || !rowIndexes.length) return;
  var sheet = repo_openSheet_(ssId, tabName);
  var sorted = rowIndexes.slice().sort(function (a, b) { return b - a; });
  sorted.forEach(function (r) { sheet.deleteRow(r); });
  repo_clearMemo_(ssId, tabName);
}

/**
 * Error tipado para distinguir SCHEMA/VALIDATION/etc. de excepciones
 * genéricas. code coincide con los códigos de 01_Result.js.
 */
function AppError_(code, message, details) {
  this.name = 'AppError_';
  this.code = code;
  this.message = message;
  this.details = details || null;
  this.stack = (new Error()).stack;
}
AppError_.prototype = Object.create(Error.prototype);
AppError_.prototype.constructor = AppError_;
