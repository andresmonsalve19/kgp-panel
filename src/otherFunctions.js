var FOLDER_ID = '1f-3EUW_uUyPqUQtMCG8dow16u27bV-xY';
var DEST_SHEET_ID = '1yvrRWcRMq8WZCMq60J_bzkD_LB1uOjgM_TIZ42xv3jw';
var DEST_TAB_NAME = 'Cotizaciones';
var SOURCE_TAB_NAME = 'CTZ-V-4';
// El límite se mide por filas realmente insertadas, no por archivos recorridos.
var MAX_ROWS_ADDED_PER_RUN = 20;

/**
 * Lee los archivos Excel .xlsx del folder indicado y añade una
 * fila por archivo a la pestaña de destino. Cada fila se persiste antes de
 * procesar el siguiente archivo, por lo que un error aislado no borra avances.
 */
function fillCotizaciones() {
  var lock = LockService.getScriptLock();
  var lockAcquired = false;
  var summary = {
    added: 0,
    duplicates: 0,
    ignored: 0,
    examined: 0,
    skipped: [],
    cleanupErrors: []
  };

  try {
    lock.waitLock(30000);
    lockAcquired = true;

    var folder = DriveApp.getFolderById(FOLDER_ID);
    var files = folder.getFiles();
    var destSs = SpreadsheetApp.openById(DEST_SHEET_ID);
    var destSheet = destSs.getSheetByName(DEST_TAB_NAME);
    if (!destSheet) {
      throw new Error('No se encontro la hoja destino: ' + DEST_TAB_NAME);
    }

    var existingCodes = getExistingCodes_(destSheet);
    var existingFileUrls = getExistingFileUrls_(destSheet);
    var currentYear = new Date().getFullYear();

    while (files.hasNext()) {
      var file = files.next();
      var name = file.getName();
      var fileId = file.getId();
      summary.examined++;

      // Solo se procesan archivos Excel .xlsx; cualquier otra extensión se omite.
      if (!/\.xlsx$/i.test(name)) {
        summary.ignored++;
        continue;
      }

      var fileUrl = file.getUrl();
      var codigo = getCodigo_(name);
      if (existingFileUrls[fileUrl]) {
        summary.duplicates++;
        continue;
      }
      if (existingCodes[codigo]) {
        summary.duplicates++;
        continue;
      }

      var temporaryFileId = null;
      try {
        var source = openSourceSpreadsheet_(file);
        temporaryFileId = source.temporaryFileId;

        var srcSs = SpreadsheetApp.openById(source.spreadsheetId);
        var srcSheet = srcSs.getSheetByName(SOURCE_TAB_NAME);
        if (!srcSheet) {
          addSkipped_(summary, name + ' (sin hoja ' + SOURCE_TAB_NAME + ')');
          continue;
        }

        // Las celdas pueden estar combinadas: se usa su celda superior izquierda.
        var fechaCreacion = buildFechaCreacion_(
          srcSheet.getRange('A7').getDisplayValue(),
          srcSheet.getRange('B7').getDisplayValue(),
          srcSheet.getRange('C7').getDisplayValue()
        );
        var nitCliente = srcSheet.getRange('C11').getDisplayValue();
        var nombreCliente = srcSheet.getRange('C10').getDisplayValue();

        // Persiste esta cotizacion antes de continuar con el siguiente archivo.
        var nextRow = destSheet.getLastRow() + 1;
        destSheet.getRange(nextRow, 1, 1, 7).setValues([[
          currentYear,
          codigo,
          fechaCreacion,
          nitCliente,
          nombreCliente,
          name,
          '=HYPERLINK("' + fileUrl + '","' + fileUrl + '")'
        ]]);
        SpreadsheetApp.flush();

        existingCodes[codigo] = true;
        existingFileUrls[fileUrl] = true;
        summary.added++;
      } catch (e) {
        addSkipped_(summary, name + ' [archivo: ' + fileId + '] (' + getErrorMessage_(e) + ')');
      } finally {
        if (temporaryFileId) {
          try {
            cleanupTemporaryFile_(temporaryFileId);
          } catch (cleanupError) {
            var cleanupMessage = name + ' [temporal: ' + temporaryFileId + '] (no se pudo eliminar: ' + getErrorMessage_(cleanupError) + ')';
            summary.cleanupErrors.push(cleanupMessage);
          }
        }
      }

      // Solo se llega aquí después de insertar una fila y actualizar summary.added.
      if (summary.added >= MAX_ROWS_ADDED_PER_RUN) {
        break;
      }
    }

    return summary;
  } catch (e) {
    throw e;
  } finally {
    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}

/**
 * Convierte temporalmente un Excel .xlsx para poder leerlo.
 * Requiere el servicio avanzado de Drive (v2).
 */
function openSourceSpreadsheet_(file) {
  var fileId = file.getId();
  var sourceFileId = file.getMimeType() === MimeType.SHORTCUT
    ? file.getTargetId()
    : fileId;
  if (!sourceFileId) {
    throw new Error('El acceso directo no tiene un archivo destino disponible');
  }

  var converted = Drive.Files.copy({
    title: '__TEMP_COTIZACION__' + new Date().getTime() + '_' + file.getName(),
    mimeType: MimeType.GOOGLE_SHEETS
  }, sourceFileId, {
    convert: true,
    supportsAllDrives: true
  });

  return {
    spreadsheetId: converted.id,
    temporaryFileId: converted.id
  };
}

/**
 * Elimina el archivo temporal aun cuando enviarlo a la papelera falle.
 * Se usa eliminación definitiva como último recurso para evitar temporales huérfanos.
 */
function cleanupTemporaryFile_(temporaryFileId) {
  try {
    Drive.Files.trash(temporaryFileId, { supportsAllDrives: true });
  } catch (trashError) {
    try {
      Drive.Files.remove(temporaryFileId, { supportsAllDrives: true });
    } catch (removeError) {
      throw new Error(
        'Papelera: ' + getErrorMessage_(trashError) +
        '. Eliminación definitiva: ' + getErrorMessage_(removeError)
      );
    }
  }
}

function getErrorMessage_(error) {
  return error && error.message ? error.message : String(error);
}

function addSkipped_(summary, message) {
  summary.skipped.push(message);
  Logger.log(message);
}

function getCodigo_(fileName) {
  var base = fileName.replace(/\.(xlsx|xls)$/i, '');
  var parts = base.split('-');
  return parts.slice(0, 4).join('-');
}

/**
 * Construye la fecha a partir de las celdas Año (A7), Mes (B7) y Día (C7).
 */
function buildFechaCreacion_(yearValue, monthValue, dayValue) {
  var year = Number(String(yearValue).trim());
  var month = Number(String(monthValue).trim());
  var day = Number(String(dayValue).trim());
  var date = new Date(year, month - 1, day);

  if (!year || !month || !day ||
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day) {
    throw new Error('Fecha inválida en A7 (año), B7 (mes) y C7 (día)');
  }

  return ('0' + day).slice(-2) + '/' + ('0' + month).slice(-2) + '/' + year;
}

function getExistingCodes_(sheet) {
  var lastRow = sheet.getLastRow();
  var map = {};
  if (lastRow < 2) return map;
  var codes = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  codes.forEach(function (r) {
    if (r[0]) map[String(r[0]).trim()] = true;
  });
  return map;
}

/**
 * Obtiene los enlaces de archivos ya registrados para no insertar el mismo
 * archivo otra vez, incluso si se vuelve a ejecutar un lote.
 */
function getExistingFileUrls_(sheet) {
  var lastRow = sheet.getLastRow();
  var map = {};
  if (lastRow < 2) return map;

  var formulas = sheet.getRange(2, 7, lastRow - 1, 1).getFormulas();
  formulas.forEach(function (row) {
    var match = String(row[0] || '').match(/^=HYPERLINK\("([^"]+)"/i);
    if (match) map[match[1]] = true;
  });
  return map;
}
