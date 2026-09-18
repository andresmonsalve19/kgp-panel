/**
 * Registro de errores en la hoja _ERRORES (se crea sola si no existe).
 * Se usa desde safeCall_ (01_Result.js) y desde cualquier punto de
 * 30_QuoteService.js / 31_DocService.js que necesite dejar rastro de un
 * fallo recuperable (p.ej. DOC ESTADO = ERROR).
 */

var ERROR_LOG_HEADERS_ = [
  'TIMESTAMP', 'REQUEST ID', 'ETAPA', 'USUARIO', 'ID COTIZACION',
  'IDS GENERADOS', 'MENSAJE', 'STACK', 'PAYLOAD'
];

function errlog_sheet_() {
  var ss = SpreadsheetApp.openById(CFG().DB_SHEET_ID);
  var tabName = CFG().TABS.ERRORES;
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.getRange(1, 1, 1, ERROR_LOG_HEADERS_.length).setValues([ERROR_LOG_HEADERS_]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * stage: nombre de la operación/etapa donde ocurrió el error.
 * requestId: string o null.
 * ids: objeto plano con los IDs generados hasta el momento del fallo (o null).
 * payloadResumen: objeto/valor a truncar y guardar como contexto (o null).
 * err: el objeto Error o string capturado.
 */
function logError_(stage, requestId, ids, payloadResumen, err) {
  try {
    var sheet = errlog_sheet_();
    var user = '';
    try { user = Session.getActiveUser().getEmail() || ''; } catch (u) { user = ''; }

    var idCotizacion = '';
    if (ids && typeof ids === 'object' && ids.idCotizacion) idCotizacion = ids.idCotizacion;

    var payloadStr = '';
    try { payloadStr = payloadResumen == null ? '' : JSON.stringify(payloadResumen); } catch (p) { payloadStr = String(payloadResumen); }

    sheet.appendRow([
      new Date(),
      requestId || '',
      stage || '',
      user,
      idCotizacion,
      ids ? JSON.stringify(ids) : '',
      errMsg_(err),
      (err && err.stack) ? String(err.stack) : '',
      truncate_(payloadStr, 20000)
    ]);
  } catch (loggingError) {
    // Si ni siquiera se puede loguear, se deja constancia en Stackdriver
    // (exceptionLogging: STACKDRIVER en appsscript.json) y no se relanza:
    // un fallo de logging nunca debe tapar la respuesta original al cliente.
    Logger.log('logError_ failed: ' + errMsg_(loggingError) + ' | original: ' + errMsg_(err));
  }
}
