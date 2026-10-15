/**
 * Repos de OIS y TAREAS_OIS.
 *
 * Modelo de datos: OIS tiene UNA FILA POR OIS (no una por servicio como
 * COTIZACIONES). Todo lo que la OIS comparte con su cotización padre
 * (cliente, solicitante, establecimiento, servicios) NO se copia aquí: vive
 * solo en COTIZACIONES/SERVICIOS y se lee por ID COTIZACION, así que editar
 * la OIS y editar la cotización tocan exactamente los mismos datos (ver
 * 35_OisService.js).
 *
 * TAREAS_OIS: una fila por tarea, FK ID OIS. OBSERVACION es acumulativo
 * (una línea por observación, mismo criterio que SERVICIOS.OBSERVACIONES).
 */

function ois_table_() {
  var t = repo_readTable_(CFG().DB_SHEET_ID, CFG().TABS.OIS);
  repo_requireCols_(t.hmap, CFG().TABS.OIS, SCHEMA().OIS.required);
  return t;
}

function tar_table_() {
  var t = repo_readTable_(CFG().DB_SHEET_ID, CFG().TABS.TAREAS_OIS);
  repo_requireCols_(t.hmap, CFG().TABS.TAREAS_OIS, SCHEMA().TAREAS_OIS.required);
  return t;
}

/** Fila cruda de OIS -> objeto de dominio. Fechas como Date (o '' si la celda está vacía). */
function ois_rowToObj_(row) {
  return {
    idOis: row[normText_('ID OIS')],
    idCotizacion: row[normText_('ID COTIZACION')],
    fechaElaboracion: row[normText_('FECHA ELABORACION')],
    codigo: row[normText_('CODIGO')],
    plazo: row[normText_('PLAZO')],
    fechaVencimiento: row[normText_('FECHA VENCIMIENTO')],
    estado: row[normText_('ESTADO')] || '',
    requestId: row[normText_('REQUEST ID')] || '',
    urlDocumento: row[normText_('URL DOCUMENTO')] || '',
    docEstado: row[normText_('DOC ESTADO')] || '',
    docFileId: row[normText_('DOC FILE ID')] || '',
    actualizadoEn: row[normText_('ACTUALIZADO EN')] || '',
    elaboradoPor: row[normText_('ELABORADO POR')] || '',
    actualizadoPor: row[normText_('ACTUALIZADO POR')] || ''
  };
}

/**
 * Crea la fila de una OIS. ctx: {idOis, idCotizacion, fechaElaboracion
 * (Date), codigo, plazo, fechaVencimiento (Date|''), estado, requestId,
 * elaboradoPor}. Las columnas opcionales que no existan en la hoja se
 * ignoran (repo_appendRows_).
 */
function ois_create_(ctx) {
  return repo_appendRows_(CFG().DB_SHEET_ID, CFG().TABS.OIS, [{
    'ID OIS': ctx.idOis,
    'ID COTIZACION': ctx.idCotizacion,
    'FECHA ELABORACION': ctx.fechaElaboracion,
    'CODIGO': ctx.codigo,
    'PLAZO': ctx.plazo === undefined ? '' : ctx.plazo,
    'FECHA VENCIMIENTO': ctx.fechaVencimiento || '',
    'ESTADO': ctx.estado,
    'REQUEST ID': ctx.requestId || '',
    'URL DOCUMENTO': '',
    'DOC ESTADO': 'PENDIENTE',
    'DOC FILE ID': '',
    'ACTUALIZADO EN': new Date(),
    'ELABORADO POR': ctx.elaboradoPor || '',
    'ACTUALIZADO POR': ctx.elaboradoPor || ''
  }]);
}

/** {rowIndex, obj} de una OIS por ID OIS, o null. obj ya viene como objeto de dominio. */
function ois_findById_(idOis) {
  var match = repo_findRowByCol_(ois_table_(), 'ID OIS', idOis);
  return match ? { rowIndex: match.rowIndex, obj: ois_rowToObj_(match.obj) } : null;
}

/** La OIS de una cotización (una cotización aprobada produce a lo sumo una OIS), o null. */
function ois_findByCotizacion_(idCotizacion) {
  var match = repo_findRowByCol_(ois_table_(), 'ID COTIZACION', idCotizacion);
  return match ? ois_rowToObj_(match.obj) : null;
}

/** Fallback de idempotencia de la creación (si la columna REQUEST ID existe). */
function ois_findByRequestId_(requestId) {
  if (!requestId) return null;
  var table = ois_table_();
  if (!repo_optionalCol_(table.hmap, 'REQUEST ID')) return null;
  var match = repo_findRowByCol_(table, 'REQUEST ID', requestId);
  return match ? ois_rowToObj_(match.obj) : null;
}

/** Todas las OIS (para el listado de "Gestionar OIS"). */
function ois_listAll_() {
  return ois_table_().rows.map(ois_rowToObj_);
}

/** Actualiza columnas puntuales de una OIS. ACTUALIZADO EN se fija siempre. Debe llamarse dentro del lock. */
function ois_update_(idOis, patch) {
  var found = ois_findById_(idOis);
  if (!found) throw new AppError_('NOT_FOUND', 'No existe la OIS ' + idOis + '.');
  var full = {};
  for (var k in patch) full[k] = patch[k];
  full['ACTUALIZADO EN'] = new Date();
  repo_updateCells_(CFG().DB_SHEET_ID, CFG().TABS.OIS, found.rowIndex, full);
}

/**
 * URL DOCUMENTO / DOC ESTADO / DOC FILE ID de una OIS. Mismo contrato que
 * qr_updateDocInfo_: undefined = no tocar (en la ruta de error nunca se
 * borra el link ni el id del documento, CLAUDE.md §8).
 */
function ois_updateDocInfo_(idOis, docUrl, docEstado, docFileId) {
  var found = ois_findById_(idOis);
  if (!found) return;
  var patch = { 'DOC ESTADO': docEstado };
  if (docUrl !== undefined) patch['URL DOCUMENTO'] = docUrl || '';
  if (docFileId !== undefined) patch['DOC FILE ID'] = docFileId || '';
  repo_updateCells_(CFG().DB_SHEET_ID, CFG().TABS.OIS, found.rowIndex, patch);
}

// ---------------------------------------------------------------------
// TAREAS_OIS
// ---------------------------------------------------------------------

function tar_rowToObj_(row) {
  return {
    idTarea: row[normText_('ID TAREA')],
    idOis: row[normText_('ID OIS')],
    tarea: row[normText_('TAREA')] || '',
    responsable: row[normText_('RESPONSABLE')] || '',
    idEmpleado: row[normText_('ID EMPLEADO')] || '',
    // INTERNO / TERCERO (columna opcional; vacío = se deduce por el ID).
    tipoResponsable: row[normText_('TIPO RESPONSABLE')] || '',
    fechaInicio: row[normText_('FECHA INICIO')] || '',
    fechaEntrega: row[normText_('FECHA ENTREGA')] || '',
    estado: row[normText_('ESTADO')] || '',
    observacion: String(row[normText_('OBSERVACION')] || '')
  };
}

/** Tareas de una OIS, en el orden en que están en la hoja. [{rowIndex, obj}] */
function tar_getRowsByOis_(idOis) {
  return repo_findRowsByCol_(tar_table_(), 'ID OIS', [idOis])
    .sort(function (a, b) { return a.rowIndex - b.rowIndex; })
    .map(function (m) { return { rowIndex: m.rowIndex, obj: tar_rowToObj_(m.obj) }; });
}

/** Solo los objetos de dominio de las tareas de una OIS, en orden. */
function tar_getByOis_(idOis) {
  return tar_getRowsByOis_(idOis).map(function (r) { return r.obj; });
}

/** Mapea una tarea ya validada al objeto de fila de TAREAS_OIS. */
function tar_toRow_(idTarea, idOis, t) {
  return {
    'ID TAREA': idTarea,
    'ID OIS': idOis,
    'TAREA': t.tarea,
    'RESPONSABLE': t.responsable,
    'ID EMPLEADO': t.idEmpleado,
    'TIPO RESPONSABLE': t.tipoResponsable || '',
    'FECHA INICIO': t.fechaInicio,
    'FECHA ENTREGA': t.fechaEntrega,
    'ESTADO': t.estado,
    'OBSERVACION': t.observacion
  };
}

/** Crea varias tareas de una sola vez (un solo setValues). Devuelve los ID TAREA generados, en el mismo orden. */
function tar_createMany_(idOis, tareas) {
  if (!tareas.length) return [];
  var ids = [];
  var rows = tareas.map(function (t) {
    var id = id_new_('TAR');
    ids.push(id);
    return tar_toRow_(id, idOis, t);
  });
  repo_appendRows_(CFG().DB_SHEET_ID, CFG().TABS.TAREAS_OIS, rows);
  return ids;
}

/** Reescribe varias tareas existentes con una sola lectura de la hoja. updates: [{rowIndex, idTarea, tarea}]. */
function tar_updateMany_(idOis, updates) {
  repo_updateCellsMany_(CFG().DB_SHEET_ID, CFG().TABS.TAREAS_OIS, updates.map(function (u) {
    return { rowIndex: u.rowIndex, patch: tar_toRow_(u.idTarea, idOis, u.tarea) };
  }));
}

/** Borra físicamente filas de TAREAS_OIS (de abajo hacia arriba, ver repo_deleteRows_). */
function tar_deleteRows_(rowIndexes) {
  repo_deleteRows_(CFG().DB_SHEET_ID, CFG().TABS.TAREAS_OIS, rowIndexes);
}
