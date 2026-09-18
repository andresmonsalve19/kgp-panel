/**
 * Repos de COTIZACIONES y SERVICIOS.
 *
 * Modelo de datos (decidido y confirmado): COTIZACIONES tiene UNA FILA POR
 * SERVICIO. Una cotización con 3 servicios produce 3 filas, todas con el
 * mismo ID COTIZACION y CODIGO, variando NUMERO SERVICIO (1,2,3) e
 * ID SERVICIO. Todo consumidor de esta tabla (especialmente el dashboard,
 * ver 32_DashboardService.js) DEBE agregar por ID COTIZACION distinto.
 *
 * ACTIVIDADES en SERVICIOS: una sola columna, texto multilínea
 * "<numServicio>.1 texto\n<numServicio>.2 texto\n...".
 */

function qr_tableCotizaciones_() {
  var t = repo_readTable_(CFG().DB_SHEET_ID, CFG().TABS.COTIZACIONES);
  repo_requireCols_(t.hmap, CFG().TABS.COTIZACIONES, SCHEMA().COTIZACIONES.required);
  return t;
}

function qr_tableServicios_() {
  var t = repo_readTable_(CFG().DB_SHEET_ID, CFG().TABS.SERVICIOS);
  repo_requireCols_(t.hmap, CFG().TABS.SERVICIOS, SCHEMA().SERVICIOS.required);
  return t;
}

/**
 * Las columnas de tarifas son opcionales en SCHEMA (para no romper creación
 * ni dashboard en una hoja que aún no las tenga), pero "Guardar cambios" de
 * Gestionar cotización SÍ las necesita: sin ellas repo_updateCells_ las
 * ignoraría en silencio y el usuario creería que su tarifa quedó guardada.
 * Lanza SCHEMA con la lista exacta de columnas que faltan.
 */
function qr_requireTarifaCols_() {
  repo_requireCols_(qr_tableServicios_().hmap, CFG().TABS.SERVICIOS, ['TARIFA', 'CANTIDAD', 'TOTAL', 'OBSERVACIONES']);
  repo_requireCols_(qr_tableCotizaciones_().hmap, CFG().TABS.COTIZACIONES, ['SUBTOTAL', 'IVA', 'TOTAL']);
}

/** Celda numérica de Sheets -> número, o '' si está vacía / no es numérica. */
function qr_num_(v) {
  if (v === '' || v == null) return '';
  var n = Number(v);
  return isFinite(n) ? n : '';
}

/** true si la columna opcional existe en la hoja COTIZACIONES ya leída. */
function qr_hasOptionalCol_(tabla, colName) {
  return !!repo_optionalCol_(tabla.hmap, colName);
}

/** Arma el texto multilínea de actividades: ["a","b"] , numeroServicio=2 -> "2.1 a\n2.2 b" */
function qr_formatActividades_(numeroServicio, actividades) {
  var lines = [];
  (actividades || []).forEach(function (act, idx) {
    var texto = cleanText_(act);
    if (texto) lines.push(numeroServicio + '.' + (idx + 1) + ' ' + texto);
  });
  return lines.join('\n');
}

/**
 * Crea las filas de SERVICIOS para una cotización. servicios: array ya
 * validado [{numero, tipo, codigoUnspsc, descripcion, actividades[],
 * tarifa, cantidad, total, observaciones}] (las 4 últimas pueden venir
 * vacías; si la hoja no tiene esas columnas, repo_appendRows_ las ignora).
 * Devuelve un array paralelo [{numero, idServicio}] en el mismo orden.
 */
function qr_createServicios_(idCotizacion, servicios) {
  var out = [];
  var rows = servicios.map(function (s) {
    var idServicio = id_new_('SRV');
    out.push({ numero: s.numero, idServicio: idServicio });
    return {
      'ID SERVICIO': idServicio,
      'ID COTIZACION': idCotizacion,
      'TIPO': cleanText_(s.tipo),
      'CODIGO UNSPSC': cleanText_(s.codigoUnspsc),
      'DESCRIPCION': cleanText_(s.descripcion),
      'ACTIVIDADES': qr_formatActividades_(s.numero, s.actividades),
      'TARIFA': s.tarifa,
      'CANTIDAD': s.cantidad,
      'TOTAL': s.total,
      'OBSERVACIONES': s.observaciones
    };
  });
  repo_appendRows_(CFG().DB_SHEET_ID, CFG().TABS.SERVICIOS, rows);
  return out;
}

/**
 * Crea las N filas de COTIZACIONES (una por servicio) que representan una
 * misma cotización. ctx: {idCotizacion, codigo, fechaElaboracion (Date),
 * plazo (int), fechaVencimiento (Date), idCliente, idSolicitante,
 * idEstablecimiento, descripcion, estado, requestId, creadoPor,
 * elaboradoPor, cargoElaborador}
 * serviciosConId: [{numero, idServicio}] (salida de qr_createServicios_).
 *
 * elaboradoPor/cargoElaborador: fijados una sola vez (creación) y nunca
 * tocados por qr_updateCamposCompartidos_; qs_updateQuotation los vuelve a
 * pasar aquí (leídos de la fila base ya existente) cuando esta función se
 * usa para agregar un servicio nuevo a una cotización ya creada, para que
 * TODAS las filas de una misma cotización queden con el mismo valor.
 */
function qr_createCotizaciones_(ctx, serviciosConId) {
  var tabla = qr_tableCotizaciones_();
  var hasReq = qr_hasOptionalCol_(tabla, 'REQUEST ID');
  var hasDocUrl = qr_hasOptionalCol_(tabla, 'URL DOCUMENTO');
  var hasDocEstado = qr_hasOptionalCol_(tabla, 'DOC ESTADO');
  var hasCreadoPor = qr_hasOptionalCol_(tabla, 'CREADO POR');
  var hasActualizadoEn = qr_hasOptionalCol_(tabla, 'ACTUALIZADO EN');
  var hasElaboradoPor = qr_hasOptionalCol_(tabla, 'ELABORADO POR');
  var hasCargo = qr_hasOptionalCol_(tabla, 'CARGO');
  var hasRevisadoPor = qr_hasOptionalCol_(tabla, 'REVISADO Y APROBADO POR');
  var hasAsesor = qr_hasOptionalCol_(tabla, 'ASESOR COMERCIAL');
  var hasTiempoEntrega = qr_hasOptionalCol_(tabla, 'TIEMPO DE ENTREGA');

  var rows = serviciosConId.map(function (s) {
    var row = {
      'ID COTIZACION': ctx.idCotizacion,
      'CODIGO': ctx.codigo,
      'FECHA ELABORACION': ctx.fechaElaboracion,
      'PLAZO': ctx.plazo,
      'FECHA VENCIMIENTO': ctx.fechaVencimiento,
      'ID CLIENTE': ctx.idCliente,
      'ID SOLICITANTE': ctx.idSolicitante,
      'ID ESTABLECIMIENTO': ctx.idEstablecimiento,
      'NUMERO SERVICIO': s.numero,
      'ID SERVICIO': s.idServicio,
      'DESCRIPCION': cleanText_(ctx.descripcion),
      'ESTADO': ctx.estado
    };
    if (hasReq) row['REQUEST ID'] = ctx.requestId || '';
    if (hasDocUrl) row['URL DOCUMENTO'] = '';
    if (hasDocEstado) row['DOC ESTADO'] = 'PENDIENTE';
    if (hasCreadoPor) row['CREADO POR'] = ctx.creadoPor || '';
    if (hasActualizadoEn) row['ACTUALIZADO EN'] = new Date();
    if (hasElaboradoPor) row['ELABORADO POR'] = ctx.elaboradoPor || '';
    if (hasCargo) row['CARGO'] = ctx.cargoElaborador || '';
    if (hasRevisadoPor) row['REVISADO Y APROBADO POR'] = ctx.revisadoAprobadoPor || '';
    if (hasAsesor) row['ASESOR COMERCIAL'] = ctx.asesorComercial || '';
    // TIEMPO DE ENTREGA nunca llega informado desde qs_createQuotation (el
    // formulario de creación no tiene este campo): queda '' hasta la
    // primera edición desde "Gestionar cotización". Sí se propaga aquí
    // cuando esta función se usa para agregar un servicio nuevo a una
    // cotización YA editada (qs_updateQuotation reenvía ctx.tiempoEntrega
    // con el valor vigente para que todas las filas queden iguales).
    if (hasTiempoEntrega) row['TIEMPO DE ENTREGA'] = ctx.tiempoEntrega || '';
    return row;
  });

  return repo_appendRows_(CFG().DB_SHEET_ID, CFG().TABS.COTIZACIONES, rows);
}

/** Todas las filas (una por servicio) de una cotización. */
function qr_getCotizacionRows_(idCotizacion) {
  var table = qr_tableCotizaciones_();
  var matches = repo_findRowsByCol_(table, 'ID COTIZACION', [idCotizacion]);
  return matches; // [{rowIndex, obj}]
}

/** Filas de SERVICIOS asociadas a una cotización, ordenadas por su posición original en el sheet. */
function qr_getServiciosByCotizacion_(idCotizacion) {
  var table = qr_tableServicios_();
  var matches = repo_findRowsByCol_(table, 'ID COTIZACION', [idCotizacion]);
  return matches
    .sort(function (a, b) { return a.rowIndex - b.rowIndex; })
    .map(function (m) {
      return {
        idServicio: m.obj[normText_('ID SERVICIO')],
        idCotizacion: m.obj[normText_('ID COTIZACION')],
        tipo: m.obj[normText_('TIPO')],
        codigoUnspsc: m.obj[normText_('CODIGO UNSPSC')],
        descripcion: m.obj[normText_('DESCRIPCION')],
        actividades: String(m.obj[normText_('ACTIVIDADES')] || '').split('\n').filter(function (l) { return l.trim(); }),
        tarifa: qr_num_(m.obj[normText_('TARIFA')]),
        cantidad: qr_num_(m.obj[normText_('CANTIDAD')]),
        total: qr_num_(m.obj[normText_('TOTAL')]),
        observaciones: String(m.obj[normText_('OBSERVACIONES')] || '')
      };
    });
}

/** Fallback de idempotencia: busca cotización ya creada con este requestId (si la columna existe). */
function qr_findByRequestId_(requestId) {
  if (!requestId) return null;
  var table = qr_tableCotizaciones_();
  if (!qr_hasOptionalCol_(table, 'REQUEST ID')) return null;
  var match = repo_findRowByCol_(table, 'REQUEST ID', requestId);
  if (!match) return null;
  return {
    idCotizacion: match.obj[normText_('ID COTIZACION')],
    codigo: match.obj[normText_('CODIGO')]
  };
}

/**
 * Actualiza los campos compartidos por TODAS las filas de una cotización
 * (plazo, fecha vencimiento, FKs, descripción, estado) — usado al editar
 * desde la vista "Gestionar cotización". NO toca NUMERO SERVICIO/ID
 * SERVICIO (esas son por-fila). Debe llamarse dentro del script lock.
 */
function qr_updateCamposCompartidos_(idCotizacion, patch) {
  var table = qr_tableCotizaciones_();
  var hasActualizadoEn = qr_hasOptionalCol_(table, 'ACTUALIZADO EN');
  var matches = repo_findRowsByCol_(table, 'ID COTIZACION', [idCotizacion]);
  if (!matches.length) {
    throw new AppError_('NOT_FOUND', 'No existe la cotización ' + idCotizacion);
  }
  var now = new Date();
  matches.forEach(function (m) {
    var full = {};
    for (var k in patch) full[k] = patch[k];
    if (hasActualizadoEn) full['ACTUALIZADO EN'] = now;
    repo_updateCells_(CFG().DB_SHEET_ID, CFG().TABS.COTIZACIONES, m.rowIndex, full);
  });
  return now;
}

/** Actualiza TIPO/CODIGO UNSPSC/DESCRIPCION/ACTIVIDADES y las tarifas de un servicio existente (por ID SERVICIO). */
function qr_updateServicio_(idServicio, numero, datos) {
  var table = qr_tableServicios_();
  var match = repo_findRowByCol_(table, 'ID SERVICIO', idServicio);
  if (!match) throw new AppError_('NOT_FOUND', 'No existe el servicio ' + idServicio + '.');
  repo_updateCells_(CFG().DB_SHEET_ID, CFG().TABS.SERVICIOS, match.rowIndex, {
    'TIPO': cleanText_(datos.tipo),
    'CODIGO UNSPSC': cleanText_(datos.codigoUnspsc),
    'DESCRIPCION': cleanText_(datos.descripcion),
    'ACTIVIDADES': qr_formatActividades_(numero, datos.actividades),
    'TARIFA': datos.tarifa,
    'CANTIDAD': datos.cantidad,
    'TOTAL': datos.total,
    'OBSERVACIONES': datos.observaciones
  });
}

/** Actualiza solo NUMERO SERVICIO en la fila de COTIZACIONES de un servicio (tras agregar/quitar servicios y renumerar). */
function qr_updateNumeroServicio_(idCotizacion, idServicio, numero) {
  var table = qr_tableCotizaciones_();
  var matches = repo_findRowsByCol_(table, 'ID COTIZACION', [idCotizacion]);
  var match = matches.filter(function (m) { return m.obj[normText_('ID SERVICIO')] === idServicio; })[0];
  if (match) {
    repo_updateCells_(CFG().DB_SHEET_ID, CFG().TABS.COTIZACIONES, match.rowIndex, { 'NUMERO SERVICIO': numero });
  }
}

/** Elimina la fila de COTIZACIONES y la de SERVICIOS de un servicio dado dentro de una cotización (al quitarlo en edición). */
function qr_deleteServicio_(idCotizacion, idServicio) {
  var tablaC = qr_tableCotizaciones_();
  var matchC = repo_findRowsByCol_(tablaC, 'ID COTIZACION', [idCotizacion])
    .filter(function (m) { return m.obj[normText_('ID SERVICIO')] === idServicio; })[0];
  if (matchC) repo_deleteRows_(CFG().DB_SHEET_ID, CFG().TABS.COTIZACIONES, [matchC.rowIndex]);

  var tablaS = qr_tableServicios_();
  var matchS = repo_findRowByCol_(tablaS, 'ID SERVICIO', idServicio);
  if (matchS) repo_deleteRows_(CFG().DB_SHEET_ID, CFG().TABS.SERVICIOS, [matchS.rowIndex]);
}

/**
 * Actualiza URL DOCUMENTO, DOC ESTADO y (si se provee) DOC FILE ID en todas
 * las filas de la cotización (columnas opcionales, cada una si existe). Se
 * usa tras generar/regenerar el documento (30/31_*Service.js), fuera del
 * script lock (la fase 2 no bloquea el lock, ver plan).
 *
 * docFileId: pasar el id de Drive del archivo recién guardado/actualizado
 * para que la próxima regeneración pueda sobrescribirlo en vez de crear uno
 * nuevo (ver doc_generateForQuotation_). Omitirlo (undefined) dentro de una
 * ruta de error para no perder el id de un archivo previo aún válido.
 * docUrl: mismo criterio — undefined = no tocar URL DOCUMENTO (el link es
 * la otra forma de saber cuál es el documento original a actualizar).
 */
function qr_updateDocInfo_(idCotizacion, docUrl, docEstado, docFileId) {
  var table = qr_tableCotizaciones_();
  var hasDocUrl = qr_hasOptionalCol_(table, 'URL DOCUMENTO');
  var hasDocEstado = qr_hasOptionalCol_(table, 'DOC ESTADO');
  var hasDocFileId = qr_hasOptionalCol_(table, 'DOC FILE ID');
  if (!hasDocUrl && !hasDocEstado && !hasDocFileId) return;

  var matches = repo_findRowsByCol_(table, 'ID COTIZACION', [idCotizacion]);
  matches.forEach(function (m) {
    var patch = {};
    if (hasDocUrl && docUrl !== undefined) patch['URL DOCUMENTO'] = docUrl || '';
    if (hasDocEstado) patch['DOC ESTADO'] = docEstado;
    if (hasDocFileId && docFileId !== undefined) patch['DOC FILE ID'] = docFileId || '';
    repo_updateCells_(CFG().DB_SHEET_ID, CFG().TABS.COTIZACIONES, m.rowIndex, patch);
  });
}
