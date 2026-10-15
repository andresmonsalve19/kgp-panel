/**
 * Repos de OIP, TAREAS_OIP y OIP_FACTURACION.
 *
 * Modelo de datos calcado del de la OIS (ver 15_OisRepo.js): OIP tiene UNA
 * FILA POR OIP y no duplica nada de su cotización padre — cliente,
 * solicitante, establecimiento y servicios viven solo en
 * COTIZACIONES/SERVICIOS y se leen por ID COTIZACION, así que editar la OIP y
 * editar la cotización tocan exactamente los mismos datos (36_OipService.js).
 *
 * TAREAS_OIP: una fila por tarea, FK ID OIP. OBSERVACION es acumulativo (una
 * línea por observación), igual que en TAREAS_OIS.
 *
 * OIP_FACTURACION: una fila por mes facturado de la OIP, FK ID OIP. A
 * diferencia de las tareas, estas filas NO esperan al "Guardar cambios" de la
 * vista: el formulario de factura las escribe de inmediato (ver
 * oip_saveFactura). El "# FACTURA" que muestra la UI es el ordinal de la fila
 * dentro de la OIP, no una columna de la hoja.
 */

function oip_table_() {
  var t = repo_readTable_(CFG_().DB_SHEET_ID, CFG_().TABS.OIP);
  repo_requireCols_(t.hmap, CFG_().TABS.OIP, SCHEMA_().OIP.required);
  return t;
}

/** TAREAS_OIP leída (memo) y con sus columnas requeridas verificadas. */
function tarp_table_() {
  var t = repo_readTable_(CFG_().DB_SHEET_ID, CFG_().TABS.TAREAS_OIP);
  repo_requireCols_(t.hmap, CFG_().TABS.TAREAS_OIP, SCHEMA_().TAREAS_OIP.required);
  return t;
}

/** OIP_FACTURACION leída (memo) y con sus columnas requeridas verificadas. */
function fac_table_() {
  var t = repo_readTable_(CFG_().DB_SHEET_ID, CFG_().TABS.OIP_FACTURACION);
  repo_requireCols_(t.hmap, CFG_().TABS.OIP_FACTURACION, SCHEMA_().OIP_FACTURACION.required);
  return t;
}

/** Fila cruda de OIP -> objeto de dominio. Fechas como Date (o '' si la celda está vacía). */
function oip_rowToObj_(row) {
  return {
    idOip: row[normText_('ID OIP')],
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
 * Crea la fila de una OIP. ctx: {idOip, idCotizacion, fechaElaboracion
 * (Date), codigo, plazo, fechaVencimiento (Date|''), estado, requestId,
 * elaboradoPor}. Las columnas opcionales que no existan en la hoja se
 * ignoran (repo_appendRows_).
 */
function oip_create_(ctx) {
  return repo_appendRows_(CFG_().DB_SHEET_ID, CFG_().TABS.OIP, [{
    'ID OIP': ctx.idOip,
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

/** {rowIndex, obj} de una OIP por ID OIP, o null. obj ya viene como objeto de dominio. */
function oip_findById_(idOip) {
  var match = repo_findRowByCol_(oip_table_(), 'ID OIP', idOip);
  return match ? { rowIndex: match.rowIndex, obj: oip_rowToObj_(match.obj) } : null;
}

/** La OIP de una cotización (una cotización aprobada produce a lo sumo una OIP), o null. */
function oip_findByCotizacion_(idCotizacion) {
  var match = repo_findRowByCol_(oip_table_(), 'ID COTIZACION', idCotizacion);
  return match ? oip_rowToObj_(match.obj) : null;
}

/** Fallback de idempotencia de la creación (si la columna REQUEST ID existe). */
function oip_findByRequestId_(requestId) {
  if (!requestId) return null;
  var table = oip_table_();
  if (!repo_optionalCol_(table.hmap, 'REQUEST ID')) return null;
  var match = repo_findRowByCol_(table, 'REQUEST ID', requestId);
  return match ? oip_rowToObj_(match.obj) : null;
}

/** Todas las OIP (para el listado de "Gestionar OIP" y el recordatorio mensual). */
function oip_listAll_() {
  return oip_table_().rows.map(oip_rowToObj_);
}

/** Actualiza columnas puntuales de una OIP. ACTUALIZADO EN se fija siempre. Debe llamarse dentro del lock. */
function oip_update_(idOip, patch) {
  var found = oip_findById_(idOip);
  if (!found) throw new AppError_('NOT_FOUND', 'No existe la OIP ' + idOip + '.');
  var full = {};
  for (var k in patch) full[k] = patch[k];
  full['ACTUALIZADO EN'] = new Date();
  repo_updateCells_(CFG_().DB_SHEET_ID, CFG_().TABS.OIP, found.rowIndex, full);
}

/**
 * URL DOCUMENTO / DOC ESTADO / DOC FILE ID de una OIP. Mismo contrato que
 * qr_updateDocInfo_ / ois_updateDocInfo_: undefined = no tocar (en la ruta de
 * error nunca se borra el link ni el id del documento, CLAUDE.md §8).
 */
function oip_updateDocInfo_(idOip, docUrl, docEstado, docFileId) {
  var found = oip_findById_(idOip);
  if (!found) return;
  var patch = { 'DOC ESTADO': docEstado };
  if (docUrl !== undefined) patch['URL DOCUMENTO'] = docUrl || '';
  if (docFileId !== undefined) patch['DOC FILE ID'] = docFileId || '';
  repo_updateCells_(CFG_().DB_SHEET_ID, CFG_().TABS.OIP, found.rowIndex, patch);
}

// ---------------------------------------------------------------------
// TAREAS_OIP
// ---------------------------------------------------------------------

/** Fila cruda de TAREAS_OIP -> objeto de dominio (FK en idOip). */
function tarp_rowToObj_(row) {
  return {
    idTarea: row[normText_('ID TAREA')],
    idOip: row[normText_('ID OIP')],
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

/** Tareas de una OIP, en el orden en que están en la hoja. [{rowIndex, obj}] */
function tarp_getRowsByOip_(idOip) {
  return repo_findRowsByCol_(tarp_table_(), 'ID OIP', [idOip])
    .sort(function (a, b) { return a.rowIndex - b.rowIndex; })
    .map(function (m) { return { rowIndex: m.rowIndex, obj: tarp_rowToObj_(m.obj) }; });
}


/** Mapea una tarea ya validada al objeto de fila de TAREAS_OIP. */
function tarp_toRow_(idTarea, idOip, t) {
  return {
    'ID TAREA': idTarea,
    'ID OIP': idOip,
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
function tarp_createMany_(idOip, tareas) {
  if (!tareas.length) return [];
  var ids = [];
  var rows = tareas.map(function (t) {
    var id = id_new_(CFG_().ID_PREFIJO_TAREA_OIP);
    ids.push(id);
    return tarp_toRow_(id, idOip, t);
  });
  repo_appendRows_(CFG_().DB_SHEET_ID, CFG_().TABS.TAREAS_OIP, rows);
  return ids;
}

/** Reescribe varias tareas existentes con una sola lectura de la hoja. updates: [{rowIndex, idTarea, tarea}]. */
function tarp_updateMany_(idOip, updates) {
  repo_updateCellsMany_(CFG_().DB_SHEET_ID, CFG_().TABS.TAREAS_OIP, updates.map(function (u) {
    return { rowIndex: u.rowIndex, patch: tarp_toRow_(u.idTarea, idOip, u.tarea) };
  }));
}

/** Borra físicamente filas de TAREAS_OIP (de abajo hacia arriba, ver repo_deleteRows_). */
function tarp_deleteRows_(rowIndexes) {
  repo_deleteRows_(CFG_().DB_SHEET_ID, CFG_().TABS.TAREAS_OIP, rowIndexes);
}

// ---------------------------------------------------------------------
// OIP_FACTURACION
// ---------------------------------------------------------------------

/** Fila cruda de OIP_FACTURACION -> objeto de dominio. */
function fac_rowToObj_(row) {
  return {
    idFacturacion: row[normText_('ID FACTURACION OIP')],
    idOip: row[normText_('ID OIP')],
    mes: row[normText_('MES')],
    year: row[normText_('YEAR')],
    cuota: row[normText_('CUOTA')],
    numeroFactura: String(row[normText_('NUMERO FACTURA')] == null ? '' : row[normText_('NUMERO FACTURA')]),
    estado: row[normText_('ESTADO')] || '',
    fechaNotificacion: row[normText_('FECHA NOTIFICACION')] || ''
  };
}

/** Filas de facturación de una OIP, en el orden de la hoja. [{rowIndex, obj}] */
function fac_getRowsByOip_(idOip) {
  return repo_findRowsByCol_(fac_table_(), 'ID OIP', [idOip])
    .sort(function (a, b) { return a.rowIndex - b.rowIndex; })
    .map(function (m) { return { rowIndex: m.rowIndex, obj: fac_rowToObj_(m.obj) }; });
}

/** Solo los objetos de dominio de la facturación de una OIP, en orden. */
function fac_getByOip_(idOip) {
  return fac_getRowsByOip_(idOip).map(function (r) { return r.obj; });
}

/**
 * Toda la facturación agrupada por ID OIP, con UNA sola lectura de la hoja.
 * Lo usa el recordatorio mensual (37_OipNotify.js), que necesita saber de
 * todas las OIP a la vez si ya tienen fila del mes anterior.
 */
function fac_getAllByOip_() {
  var porOip = {};
  fac_table_().rows.forEach(function (r) {
    var f = fac_rowToObj_(r);
    (porOip[f.idOip] = porOip[f.idOip] || []).push({ rowIndex: r.__row, obj: f });
  });
  return porOip;
}

/** Mapea una fila de facturación ya validada al objeto de fila de OIP_FACTURACION. */
function fac_toRow_(idFacturacion, idOip, f) {
  return {
    'ID FACTURACION OIP': idFacturacion,
    'ID OIP': idOip,
    'MES': f.mes,
    'YEAR': f.year,
    'CUOTA': f.cuota,
    'NUMERO FACTURA': f.numeroFactura,
    'ESTADO': f.estado
  };
}

/** Crea una fila de facturación. Devuelve el ID FACTURACION OIP generado. */
function fac_create_(idOip, f) {
  var id = id_new_(CFG_().ID_PREFIJO_FACTURA_OIP);
  var row = fac_toRow_(id, idOip, f);
  // FECHA NOTIFICACION solo la escribe el recordatorio mensual: en una
  // creación manual desde el formulario queda vacía (undefined = '' en
  // repo_appendRows_), y en la automática el llamador la pasa explícita.
  if (f.fechaNotificacion !== undefined) row['FECHA NOTIFICACION'] = f.fechaNotificacion;
  repo_appendRows_(CFG_().DB_SHEET_ID, CFG_().TABS.OIP_FACTURACION, [row]);
  return id;
}

/** Crea varias filas de facturación de una sola vez (un solo setValues). Devuelve los ids generados. */
function fac_createMany_(rows) {
  if (!rows.length) return [];
  var ids = [];
  var objRows = rows.map(function (r) {
    var id = id_new_(CFG_().ID_PREFIJO_FACTURA_OIP);
    ids.push(id);
    var row = fac_toRow_(id, r.idOip, r.factura);
    if (r.factura.fechaNotificacion !== undefined) row['FECHA NOTIFICACION'] = r.factura.fechaNotificacion;
    return row;
  });
  repo_appendRows_(CFG_().DB_SHEET_ID, CFG_().TABS.OIP_FACTURACION, objRows);
  return ids;
}

/** Reescribe una fila de facturación existente (sin tocar FECHA NOTIFICACION). */
function fac_update_(rowIndex, idFacturacion, idOip, f) {
  repo_updateCells_(CFG_().DB_SHEET_ID, CFG_().TABS.OIP_FACTURACION, rowIndex, fac_toRow_(idFacturacion, idOip, f));
}

/** Sella FECHA NOTIFICACION en varias filas con una sola lectura. updates: [{rowIndex, fecha}]. */
function fac_stampNotificacionMany_(updates) {
  if (!updates.length) return;
  repo_updateCellsMany_(CFG_().DB_SHEET_ID, CFG_().TABS.OIP_FACTURACION, updates.map(function (u) {
    return { rowIndex: u.rowIndex, patch: { 'FECHA NOTIFICACION': u.fecha } };
  }));
}

/** Borra físicamente filas de OIP_FACTURACION. */
function fac_deleteRows_(rowIndexes) {
  repo_deleteRows_(CFG_().DB_SHEET_ID, CFG_().TABS.OIP_FACTURACION, rowIndexes);
}
