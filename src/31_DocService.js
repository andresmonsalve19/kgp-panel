/**
 * Fase 2: generación de los documentos (cotización, OIS, OIP) a partir de la
 * plantilla nativa (CFG_().TEMPLATE_SHEET_ID). Se llama desde el cliente DESPUÉS
 * de guardar en la BD y fuera del script lock: puede tardar 10-30 s y no debe
 * bloquear a nadie más.
 *
 * Flujo común (doc_generar_):
 *   copiar la plantilla a un temporal -> escribir celdas -> flush ->
 *   guardar (doc_guardar_: SIEMPRE sobre el mismo archivo si ya existe,
 *   CLAUDE.md §8) -> actualizar URL/ESTADO/ID del documento en la BD ->
 *   borrar el temporal (finally, incluso si algo falla).
 *
 * Las celdas se escriben con un buffer (doc_escritor_): el formato '@' de
 * todos los textos va en UNA llamada (RangeList) y las celdas vacías se
 * limpian en otra, en vez de 2 llamadas por celda. Los valores siguen
 * escribiéndose celda por celda con setValue sobre la celda ancla: la
 * plantilla tiene celdas combinadas y setValues sobre un rango combinado
 * falla ("Cannot use setValues on merged cells").
 *
 * Referencia probada (no se importa nada de ahí): src/otherFunctions.js,
 * Drive.Files.copy(..., {convert:true, supportsAllDrives:true}) +
 * Drive.Files.trash con fallback a Drive.Files.remove.
 */

// ---------------------------------------------------------------------
// Puntos de entrada
// ---------------------------------------------------------------------

/**
 * Genera (o regenera) el documento de una cotización.
 * @param {string} idCotizacion Cotización ya creada (fase 1).
 * @param {?string} requestId Solo en la generación inicial: un reintento con el
 *     mismo requestId devuelve el resultado guardado. null = regeneración
 *     ("Guardar cambios"), que SIEMPRE reescribe el documento.
 * @return {!Object} ok_({docUrl, docFileId, docNombre}) o fail_.
 */
function doc_generateForQuotation_(idCotizacion, requestId) {
  return doc_generar_({
    etapa: 'doc_generateForQuotation_',
    ids: { idCotizacion: idCotizacion },
    idemPrefijo: 'idem:doc:',
    tmpPrefijo: '__TMP_CTZ__',
    cargar: function () { return qs_getCotizacion(idCotizacion); },
    codigo: function (d) { return d.cotizacion.codigo; },
    docPrevio: function (d) { return d.cotizacion; },
    preparar: function (ss, d) {
      var sheet = doc_hojaCotizacion_(ss);
      doc_writeCells_(sheet, doc_buildCtx_(d));
      return { hoja: sheet, baseName: doc_ordenBaseName_(d.cotizacion.codigo, d.cliente) };
    },
    carpeta: function () { return CFG_().OUT_FOLDER_ID; },
    actualizarInfo: function (url, estado, fileId) { qr_updateDocInfo_(idCotizacion, url, estado, fileId); }
  }, requestId);
}

/** Regenera el documento de una cotización (reintento de un ERROR o tras "Guardar cambios"). */
function doc_regenerate_(idCotizacion) {
  return doc_generateForQuotation_(idCotizacion, null);
}

/**
 * Genera (o regenera) el documento de una OIS: un .xlsx con UNA sola hoja (la
 * pestaña CFG_().TEMPLATE_TAB_OIS), en su subcarpeta "OIS-KGP-NNN-YY-<CLIENTE>"
 * dentro de CFG_().OIS_FOLDER_ID.
 * @param {string} idOis
 * @param {?string} requestId Ver doc_generateForQuotation_.
 * @return {!Object} ok_({docUrl, docFileId, docNombre}) o fail_.
 */
function doc_generateForOis_(idOis, requestId) {
  return doc_generarOrden_('OIS', idOis, requestId);
}

/**
 * Igual que doc_generateForOis_ para la OIP (pestaña CFG_().TEMPLATE_TAB_OIP,
 * carpeta CFG_().OIP_FOLDER_ID). Las tareas de la OIP insertan filas (ver
 * doc_writeOipCells_).
 */
function doc_generateForOip_(idOip, requestId) {
  return doc_generarOrden_('OIP', idOip, requestId);
}

/**
 * Documento de una orden (OIS/OIP). Sobre el temporal:
 *   1. Escribe la hoja de la cotización con el mismo contexto (por si la hoja
 *      de la orden tiene fórmulas que la referencian).
 *   2. Escribe en la hoja de la orden los datos compartidos SIN la tabla de
 *      tarifas (esas filas son la identificación y las tareas de la orden), su
 *      fila de códigos y sus tareas.
 *   3. Congela como valor toda fórmula de la hoja de la orden que apunte a
 *      OTRA hoja (si no, quedaría en #REF!) y borra las demás hojas.
 * @param {string} tipo 'OIS' | 'OIP'
 * @param {string} idOrden
 * @param {?string} requestId
 * @return {!Object}
 */
function doc_generarOrden_(tipo, idOrden, requestId) {
  var esOis = tipo === 'OIS';
  var ids = esOis ? { idOis: idOrden } : { idOip: idOrden };
  return doc_generar_({
    etapa: esOis ? 'doc_generateForOis_' : 'doc_generateForOip_',
    ids: ids,
    idemPrefijo: esOis ? 'idem:docois:' : 'idem:docoip:',
    tmpPrefijo: esOis ? '__TMP_OIS__' : '__TMP_OIP__',
    cargar: function () { return esOis ? ois_getOis(idOrden) : oip_getOip(idOrden); },
    codigo: function (d) { return (esOis ? d.ois : d.oip).codigo; },
    docPrevio: function (d) { return esOis ? d.ois : d.oip; },
    preparar: function (ss, d) {
      var cfg = CFG_();
      var orden = esOis ? d.ois : d.oip;
      var nombreHoja = esOis ? cfg.TEMPLATE_TAB_OIS : cfg.TEMPLATE_TAB_OIP;
      var hoja = ss.getSheetByName(nombreHoja);
      if (!hoja) {
        throw new AppError_('SCHEMA', 'La plantilla no tiene la hoja "' + nombreHoja + '". Hojas disponibles: [' +
          ss.getSheets().map(function (s) { return s.getName(); }).join(', ') + ']');
      }
      var ctx = doc_buildCtx_(d);
      var ctzSheet = doc_hojaCotizacion_(ss);
      if (ctzSheet.getSheetId() !== hoja.getSheetId()) doc_writeCells_(ctzSheet, ctx);

      doc_writeCells_(hoja, ctx, { sinTarifas: true });
      if (esOis) doc_writeOisCells_(hoja, ctx, orden, d.tareas || []);
      else doc_writeOipCells_(hoja, ctx, orden, d.tareas || []);
      SpreadsheetApp.flush();

      doc_freezeCrossSheetFormulas_(hoja);
      ss.getSheets().forEach(function (s) {
        if (s.getSheetId() !== hoja.getSheetId()) ss.deleteSheet(s);
      });
      return { hoja: hoja, baseName: doc_ordenBaseName_(orden.codigo, d.cliente) };
    },
    carpeta: function (baseName) {
      return doc_ensureFolder_(esOis ? CFG_().OIS_FOLDER_ID : CFG_().OIP_FOLDER_ID, baseName);
    },
    actualizarInfo: function (url, estado, fileId) {
      if (esOis) ois_updateDocInfo_(idOrden, url, estado, fileId);
      else oip_updateDocInfo_(idOrden, url, estado, fileId);
    }
  }, requestId);
}

// ---------------------------------------------------------------------
// Flujo común
// ---------------------------------------------------------------------

/**
 * Flujo común de generación (ver el encabezado del archivo).
 *
 * Si falla, DOC ESTADO = ERROR pero NUNCA se borran URL DOCUMENTO ni DOC FILE
 * ID (actualizarInfo con undefined = no tocar): si se borraran, el siguiente
 * guardado ya no sabría cuál es el documento original y crearía otro.
 *
 * @param {{etapa: string, ids: !Object, idemPrefijo: string,
 *     tmpPrefijo: string, cargar: function(): !Object,
 *     codigo: function(!Object): string, docPrevio: function(!Object): !Object,
 *     preparar: function(!Object, !Object): {hoja: !Object, baseName: string},
 *     carpeta: function(string): string,
 *     actualizarInfo: function((string|undefined), string, (string|undefined))}} spec
 * @param {?string} requestId
 * @return {!Object} ok_({docFileId, docUrl, docNombre}) o fail_.
 */
function doc_generar_(spec, requestId) {
  var cfg = CFG_();
  if (!cfg.TEMPLATE_SHEET_ID) {
    return fail_('SCHEMA', 'La plantilla aún no se ha preparado. Ejecuta admin_convertTemplate() desde el editor de Apps Script antes de generar documentos.');
  }

  // Idempotencia solo para la generación inicial (con requestId): la
  // regeneración SIEMPRE debe reescribir el documento.
  var idemKey = requestId ? spec.idemPrefijo + requestId : null;
  var cached = idemKey ? cacheGetJson_(idemKey) : null;
  if (cached) return cached;

  var got = spec.cargar();
  if (!got.ok) return got;
  var d = got.data;

  var tmpId = null;
  try {
    var copy = Drive.Files.copy(
      { title: spec.tmpPrefijo + sanitizeFileName_(spec.codigo(d)) + '_' + Date.now(), mimeType: MimeType.GOOGLE_SHEETS },
      cfg.TEMPLATE_SHEET_ID,
      { convert: true, supportsAllDrives: true }
    );
    tmpId = copy.id;

    var prep = spec.preparar(SpreadsheetApp.openById(tmpId), d);
    SpreadsheetApp.flush(); // crítico antes de exportar

    var fileName = prep.baseName + '.xlsx';
    var saved = doc_guardar_(tmpId, prep.hoja, spec.docPrevio(d), fileName, function () { return spec.carpeta(prep.baseName); });

    spec.actualizarInfo(saved.alternateLink, 'OK', saved.id);
    bumpDataVersion_();

    var response = ok_({ docFileId: saved.id, docUrl: saved.alternateLink, docNombre: saved.title || fileName });
    if (idemKey) cachePutJson_(idemKey, response, cfg.CACHE_TTL.IDEMPOTENCIA_S);
    return response;
  } catch (e) {
    logError_(spec.etapa, requestId, spec.ids, null, e);
    try {
      spec.actualizarInfo(undefined, 'ERROR');
      bumpDataVersion_();
    } catch (e2) { /* no ocultar el error original por un fallo secundario */ }
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'DRIVE';
    return fail_(code, errMsg_(e));
  } finally {
    if (tmpId) {
      try {
        doc_cleanupTemp_(tmpId);
      } catch (cleanupErr) {
        logError_('doc_cleanupTemp_', requestId, Object.assign({ tmpId: tmpId }, spec.ids), null, cleanupErr);
      }
    }
  }
}

/**
 * Guarda el documento generado. Si ya existe uno (DOC FILE ID, o el id del
 * link en URL DOCUMENTO), SIEMPRE se actualiza ese mismo archivo:
 *   - hoja nativa de Google: se reemplaza su pestaña (mismo id y link);
 *   - .xlsx: nueva revisión con Drive.Files.update.
 * Solo se crea uno nuevo si no hay documento previo o si fue borrado / está
 * en la papelera. Cualquier otro error de Drive se propaga (no se crean
 * duplicados en silencio).
 *
 * @param {string} tmpId Temporal ya escrito.
 * @param {!Object} hoja Hoja (Sheet) del temporal con el documento.
 * @param {!Object} previo Objeto con docFileId / urlDocumento.
 * @param {string} fileName Nombre para un archivo nuevo.
 * @param {function(): string} carpetaFn Carpeta destino (solo si se crea uno nuevo).
 * @return {!Object} Recurso de Drive (id, alternateLink, title).
 */
function doc_guardar_(tmpId, hoja, previo, fileName, carpetaFn) {
  var existente = doc_findExistingFile_(previo);
  if (existente && existente.mimeType === MimeType.GOOGLE_SHEETS) {
    doc_replaceNativeSheet_(existente.id, hoja);
    return existente;
  }
  if (existente) {
    return Drive.Files.update({}, existente.id, doc_exportXlsx_(tmpId, existente.title || fileName), { supportsAllDrives: true });
  }
  var parentId = carpetaFn();
  return Drive.Files.insert(
    { title: fileName, parents: [{ id: parentId }] },
    doc_exportXlsx_(tmpId, fileName),
    { supportsAllDrives: true }
  );
}

/**
 * Hoja de la cotización dentro de un spreadsheet con la estructura de la
 * plantilla: CFG_().TEMPLATE_TAB_NAME o, si no está configurada, la primera.
 * @param {!Object} ss Spreadsheet.
 * @return {!Object} Sheet.
 */
function doc_hojaCotizacion_(ss) {
  var nombre = CFG_().TEMPLATE_TAB_NAME;
  return (nombre && ss.getSheetByName(nombre)) || ss.getSheets()[0];
}

/**
 * Contexto de escritura de la plantilla a partir del detalle de una
 * cotización (o de una orden, que trae el mismo detalle de su cotización).
 * @param {!Object} d qs_getCotizacion().data / ois_getOis().data / oip_getOip().data
 * @return {!Object}
 */
function doc_buildCtx_(d) {
  return {
    codigo: d.cotizacion.codigo,
    fechaElaboracion: parseISODate_(d.cotizacion.fechaElaboracion) || new Date(),
    descripcion: d.cotizacion.descripcion,
    cliente: d.cliente,
    solicitante: d.solicitante,
    establecimiento: d.establecimiento,
    encargado: d.establecimiento ? con_findEncargadoByEstablecimiento_(d.establecimiento.idEstablecimiento) : null,
    servicios: d.servicios || [],
    elaboradoPorNombre: d.cotizacion.elaboradoPorNombre || '',
    cargoElaborador: d.cotizacion.cargoElaborador || '',
    revisadoAprobadoPorNombre: d.cotizacion.revisadoAprobadoPorNombre || '',
    asesorComercialNombre: d.cotizacion.asesorComercialNombre || '',
    tiempoEntrega: d.cotizacion.tiempoEntrega || ''
  };
}

// ---------------------------------------------------------------------
// Documento existente
// ---------------------------------------------------------------------

/**
 * Id de Drive del documento ya generado: DOC FILE ID si existe; si no, el que
 * viene dentro del link de URL DOCUMENTO (".../d/<id>/...", "?id=<id>").
 * @param {Object} registro Cotización u orden con docFileId / urlDocumento.
 * @return {string} '' si no hay ninguno.
 */
function doc_fileIdFromCotizacion_(registro) {
  var id = String((registro && registro.docFileId) || '').trim();
  if (id) return id;
  var url = String((registro && registro.urlDocumento) || '').trim();
  if (!url) return '';
  var m = /\/d\/([a-zA-Z0-9_-]{20,})/.exec(url) || /[?&]id=([a-zA-Z0-9_-]{20,})/.exec(url);
  return m ? m[1] : '';
}

/**
 * Metadatos del documento previo, o null si no tiene uno utilizable (sin id,
 * borrado o en la papelera). Cualquier otro error de Drive (permisos, cuota,
 * red) se propaga: en esos casos NO se debe crear un documento nuevo.
 * @param {Object} registro
 * @return {Object}
 */
function doc_findExistingFile_(registro) {
  var fileId = doc_fileIdFromCotizacion_(registro);
  if (!fileId) return null;
  var file;
  try {
    file = Drive.Files.get(fileId, { supportsAllDrives: true });
  } catch (e) {
    if (/not ?found|404/i.test(errMsg_(e))) return null;
    throw e;
  }
  if (!file || (file.labels && file.labels.trashed)) return null;
  return file;
}

/**
 * Reemplaza, dentro de una hoja de cálculo nativa ya existente, la pestaña
 * del documento por la recién generada. El archivo conserva su id y su link;
 * la pestaña conserva su nombre y su posición.
 * @param {string} targetId
 * @param {!Object} srcSheet Hoja (Sheet) del temporal.
 */
function doc_replaceNativeSheet_(targetId, srcSheet) {
  var dest = SpreadsheetApp.openById(targetId);
  var old = doc_hojaCotizacion_(dest);
  var oldName = old.getName();
  var oldIndex = old.getIndex();

  var copied = srcSheet.copyTo(dest);
  dest.setActiveSheet(copied);
  dest.moveActiveSheet(oldIndex);
  dest.deleteSheet(old);
  copied.setName(oldName);
  SpreadsheetApp.flush();
}

// ---------------------------------------------------------------------
// Escritura de celdas
// ---------------------------------------------------------------------

/**
 * Buffer de escritura de celdas de una hoja. Se acumulan las escrituras
 * (la última sobre una misma celda gana) y aplicar() las manda a Sheets con
 * el mínimo de llamadas:
 *   1. formato '@' a todas las celdas de texto (1 llamada, RangeList);
 *   2. celdas que quedan vacías: clearContent (1 llamada);
 *   3. el resto, setValue celda por celda (celdas combinadas).
 * Tipos: texto (formato '@': preserva ceros a la izquierda y NITs largos),
 * numero y fecha (sin tocar el formato de la plantilla: moneda, fechas y
 * fórmulas que dependen de esas celdas siguen funcionando).
 *
 * IMPORTANTE: aplicar() antes de insertar o borrar filas (ver
 * doc_writeOipCells_), porque las direcciones A1 se fijan al acumular.
 *
 * @param {!Object} sheet Sheet.
 * @return {{texto: function(string, *), numero: function(string, *),
 *     fecha: function(string, *), aplicar: function()}}
 */
function doc_escritor_(sheet) {
  var celdas = {};
  var orden = [];
  function poner(a1, tipo, valor) {
    if (!celdas[a1]) orden.push(a1);
    celdas[a1] = { tipo: tipo, valor: valor };
  }
  return {
    texto: function (a1, value) { poner(a1, 'texto', value == null ? '' : String(value)); },
    numero: function (a1, value) {
      var n = (value === '' || value == null) ? '' : Number(value);
      poner(a1, 'numero', n === '' || isNaN(n) ? '' : n);
    },
    fecha: function (a1, iso) { poner(a1, 'fecha', parseISODate_(iso) || ''); },
    aplicar: function () {
      var textos = orden.filter(function (a1) { return celdas[a1].tipo === 'texto'; });
      if (textos.length) sheet.getRangeList(textos).setNumberFormat('@');
      var vacias = orden.filter(function (a1) { return celdas[a1].valor === ''; });
      if (vacias.length) sheet.getRangeList(vacias).clearContent();
      orden.forEach(function (a1) {
        if (celdas[a1].valor !== '') sheet.getRange(a1).setValue(celdas[a1].valor);
      });
      celdas = {};
      orden = [];
    }
  };
}

/**
 * Escribe todos los datos compartidos de la plantilla (encabezado, cliente,
 * solicitante, establecimiento, encargado, servicios, personal).
 * @param {!Object} sheet Sheet.
 * @param {!Object} ctx doc_buildCtx_.
 * @param {{sinTarifas: (boolean|undefined)}=} opts sinTarifas: no escribir la
 *     tabla de tarifas (hojas de OIS/OIP: esas filas son la identificación y
 *     las tareas de la orden).
 */
function doc_writeCells_(sheet, ctx, opts) {
  opts = opts || {};
  var cm = CELLMAP_();
  var w = doc_escritor_(sheet);
  var cli = ctx.cliente || {};
  var sol = ctx.solicitante || {};
  var est = ctx.establecimiento || {};
  var enc = ctx.encargado || {};

  doc_escribirFecha_(w, cm.FECHA_ANIO, cm.FECHA_MES, cm.FECHA_DIA, ctx.fechaElaboracion);
  w.texto(cm.CODIGO, ctx.codigo);

  w.texto(cm.CLIENTE_RAZON_SOCIAL, cli.razonSocial);
  w.texto(cm.CLIENTE_NUMERO_ID, cli.numeroIdentificacion);
  w.texto(cm.CLIENTE_DIRECCION, cli.direccion);
  w.texto(cm.CLIENTE_CIUDAD_DEPTO_PAIS, joinNonEmpty_([cli.ciudad, cli.departamento, cli.pais], ', '));
  w.texto(cm.CLIENTE_TELEFONO, cli.telefono);

  w.texto(cm.SOLICITANTE_NOMBRE, sol.nombre);
  w.texto(cm.SOLICITANTE_CARGO, sol.cargo);
  w.texto(cm.SOLICITANTE_TELEFONO, sol.telefono);
  w.texto(cm.SOLICITANTE_CORREO, sol.correo);

  w.texto(cm.CLIENTE_CIIU, cli.codigoCiiu);
  w.texto(cm.CLIENTE_ACTIVIDAD_PRINCIPAL, cli.actividadPrincipal);

  w.texto(cm.COTIZACION_DESCRIPCION, ctx.descripcion);

  w.texto(cm.ESTABLECIMIENTO_NOMBRE, est.nombre);
  w.texto(cm.ESTABLECIMIENTO_DIRECCION, est.direccion);
  w.texto(cm.ESTABLECIMIENTO_CIUDAD_DEPTO_PAIS, joinNonEmpty_([est.ciudad, est.departamento, est.pais], ', '));

  w.texto(cm.ENCARGADO_NOMBRE, enc.nombre);
  w.texto(cm.ENCARGADO_CARGO, enc.cargo);
  w.texto(cm.ENCARGADO_TELEFONO, enc.telefono);
  w.texto(cm.ENCARGADO_CORREO, enc.correo);

  (ctx.servicios || []).slice(0, CFG_().LIMITS.MAX_SERVICIOS).forEach(function (srv, indice) {
    doc_writeServicioCells_(w, cm, indice, srv, !opts.sinTarifas);
  });

  // Personal: NOMBRE del empleado (no el ID). Vacíos si aún no corresponden,
  // para no dejar el valor de una revisión anterior al regenerar.
  w.texto(cm.ELABORADO_POR, ctx.elaboradoPorNombre);
  w.texto(cm.CARGO_ELABORADO_POR, ctx.cargoElaborador);
  w.texto(cm.APROBADO_POR, ctx.revisadoAprobadoPorNombre);
  w.texto(cm.ASESOR_COMERCIAL, ctx.asesorComercialNombre);
  w.texto(cm.TIEMPO_ENTREGA, ctx.tiempoEntrega);

  w.aplicar();
}

/**
 * Bloque de un servicio (tipo/UNSPSC/descripción/actividades) en su fila
 * ancla: el #1 (indice 0) usa SERVICIOS_FILA_BASE y cada siguiente repite el
 * layout SERVICIOS_FILA_PASO filas más abajo. Con conTarifas, además su fila
 * de la tabla de tarifas (TARIFAS_FILA_BASE + indice). El TOTAL del servicio
 * no va a la plantilla, solo a la BD.
 * @param {!Object} w doc_escritor_.
 * @param {!Object} cm CELLMAP_().
 * @param {number} indice 0-based.
 * @param {!Object} srv
 * @param {boolean} conTarifas
 */
function doc_writeServicioCells_(w, cm, indice, srv, conTarifas) {
  srv = srv || {};
  var filaBase = cm.SERVICIOS_FILA_BASE + indice * cm.SERVICIOS_FILA_PASO;

  w.texto(cm.SERVICIOS_COL_TIPO + filaBase, srv.tipo);
  w.texto(cm.SERVICIOS_COL_UNSPSC + filaBase, srv.codigoUnspsc);
  w.texto(cm.SERVICIOS_COL_DESCRIPCION + filaBase, srv.descripcion);

  var filaActInicio = filaBase + cm.SERVICIOS_ACT_OFFSET_FILA;
  (srv.actividades || []).slice(0, cm.SERVICIOS_ACT_MAX).forEach(function (act, i) {
    w.texto(cm.SERVICIOS_ACT_COL + (filaActInicio + i), doc_stripActividadPrefix_(act));
  });

  if (!conTarifas) return;
  var filaTarifa = cm.TARIFAS_FILA_BASE + indice;
  w.numero(cm.TARIFAS_COL_TARIFA + filaTarifa, srv.tarifa);
  w.numero(cm.TARIFAS_COL_CANTIDAD + filaTarifa, srv.cantidad);
  w.texto(cm.TARIFAS_COL_OBSERVACIONES + filaTarifa, srv.observaciones);
}

/** Año / mes / día de `fecha` (TZ de la app) en tres celdas de texto. */
function doc_escribirFecha_(w, a1Anio, a1Mes, a1Dia, fecha) {
  w.texto(a1Anio, fmtDate_(fecha, 'yyyy'));
  w.texto(a1Mes, fmtDate_(fecha, 'MM'));
  w.texto(a1Dia, fmtDate_(fecha, 'dd'));
}

/**
 * Celdas propias de la hoja OIS: el código de la OIS en la celda del código
 * (doc_writeCells_ dejó ahí el de la cotización), la fila de identificación
 * (código de la cotización, de la OIS y año/mes/día) y las tareas (una por
 * fila desde OIS_TAREAS_FILA_BASE, máx. MAX_TAREAS). Solo TAREA /
 * RESPONSABLE / FECHAS / OBSERVACION: ni el estado ni el ID van al documento.
 * @param {!Object} sheet Sheet.
 * @param {!Object} ctx
 * @param {!Object} ois DTO de la OIS.
 * @param {!Array<!Object>} tareas DTOs.
 */
function doc_writeOisCells_(sheet, ctx, ois, tareas) {
  var cm = CELLMAP_();
  var w = doc_escritor_(sheet);
  w.texto(cm.CODIGO, ois.codigo);
  w.texto(cm.OIS_COT_CODIGO, ctx.codigo);
  w.texto(cm.OIS_CODIGO, ois.codigo);
  doc_escribirFecha_(w, cm.OIS_FECHA_ANIO, cm.OIS_FECHA_MES, cm.OIS_FECHA_DIA, ctx.fechaElaboracion);

  tareas.slice(0, CFG_().LIMITS.MAX_TAREAS).forEach(function (t, i) {
    var fila = cm.OIS_TAREAS_FILA_BASE + i;
    w.texto(cm.OIS_TAREAS_COL_TAREA + fila, t.tarea);
    w.texto(cm.OIS_TAREAS_COL_RESPONSABLE + fila, t.responsable);
    w.fecha(cm.OIS_TAREAS_COL_FECHA_INICIO + fila, t.fechaInicio);
    w.fecha(cm.OIS_TAREAS_COL_FECHA_ENTREGA + fila, t.fechaEntrega);
    w.texto(cm.OIS_TAREAS_COL_OBSERVACION + fila, t.observacion);
  });
  w.aplicar();
}

/**
 * Celdas propias de la hoja OIP. Como la OIS, salvo que la plantilla NO
 * reserva un bloque fijo para las tareas: la #1 va en OIP_TAREAS_FILA_BASE y,
 * si hay más, se INSERTAN las filas que falten justo debajo (una sola llamada)
 * antes de escribirlas — así nunca se sobreescribe lo que haya más abajo.
 * @param {!Object} sheet Sheet.
 * @param {!Object} ctx
 * @param {!Object} oip DTO de la OIP.
 * @param {!Array<!Object>} tareas DTOs.
 */
function doc_writeOipCells_(sheet, ctx, oip, tareas) {
  var cm = CELLMAP_();
  var w = doc_escritor_(sheet);
  w.texto(cm.CODIGO, oip.codigo);
  w.texto(cm.OIP_COT_CODIGO, ctx.codigo);
  w.texto(cm.OIP_CODIGO, oip.codigo);
  doc_escribirFecha_(w, cm.OIP_FECHA_ANIO, cm.OIP_FECHA_MES, cm.OIP_FECHA_DIA, ctx.fechaElaboracion);
  w.aplicar(); // antes de insertar filas: estas direcciones no deben correrse

  var lista = tareas.slice(0, CFG_().LIMITS.MAX_TAREAS_OIP);
  if (!lista.length) return;

  var filaBase = cm.OIP_TAREAS_FILA_BASE;
  if (lista.length > 1) sheet.insertRowsAfter(filaBase, lista.length - 1); // heredan el formato de la fila base

  lista.forEach(function (t, i) {
    var fila = filaBase + i;
    w.texto(cm.OIP_TAREAS_COL_TAREA + fila, t.tarea);
    w.texto(cm.OIP_TAREAS_COL_RESPONSABLE + fila, t.responsable);
    w.fecha(cm.OIP_TAREAS_COL_FECHA_INICIO + fila, t.fechaInicio);
    w.fecha(cm.OIP_TAREAS_COL_FECHA_ENTREGA + fila, t.fechaEntrega);
    w.texto(cm.OIP_TAREAS_COL_OBSERVACION + fila, t.observacion);
  });
  w.aplicar();
}

/**
 * SERVICIOS guarda las actividades con un prefijo de numeración interna
 * ("1.1 texto"); la plantilla solo lleva el texto que escribió la persona.
 * @param {*} texto
 * @return {string}
 */
function doc_stripActividadPrefix_(texto) {
  return String(texto || '').replace(/^\d+\.\d+\s+/, '');
}

/**
 * Reemplaza por su valor actual toda fórmula de la hoja que referencie OTRA
 * hoja (contiene "!"): el documento de una orden solo conserva su hoja y esas
 * referencias quedarían en #REF!. Las fórmulas internas se dejan intactas. Se
 * escribe celda por celda (solo las afectadas) por las celdas combinadas.
 * @param {!Object} sheet Sheet.
 */
function doc_freezeCrossSheetFormulas_(sheet) {
  var range = sheet.getDataRange();
  var formulas = range.getFormulas();
  var values = null;
  for (var r = 0; r < formulas.length; r++) {
    for (var c = 0; c < formulas[r].length; c++) {
      if (formulas[r][c] && formulas[r][c].indexOf('!') !== -1) {
        if (!values) values = range.getValues();
        sheet.getRange(r + 1, c + 1).setValue(values[r][c]);
      }
    }
  }
}

// ---------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------

/**
 * Exporta un Google Sheet a .xlsx probando, en cascada:
 *   1. Drive API v3 export vía UrlFetchApp (oficial, límite 10 MB);
 *   2. docs.google.com/export (sin ese límite, no oficial: se valida el
 *      Content-Type porque puede devolver el HTML de login con código 200);
 *   3. Drive.Files.export del servicio avanzado.
 * Reintenta con espera exponencial ante 429/5xx. NUNCA
 * DriveApp.getFileById(id).getBlob(): en un Google Sheet devuelve PDF.
 * @param {string} fileId
 * @param {string} name Nombre del blob.
 * @return {!Object} Blob.
 */
function doc_exportXlsx_(fileId, name) {
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var opts = { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true };
  var urls = [
    'https://www.googleapis.com/drive/v3/files/' + fileId + '/export?mimeType=' + encodeURIComponent(XLSX_MIME) + '&supportsAllDrives=true',
    'https://docs.google.com/spreadsheets/d/' + fileId + '/export?format=xlsx&id=' + fileId
  ];

  for (var u = 0; u < urls.length; u++) {
    for (var attempt = 0; attempt < 3; attempt++) {
      var resp;
      try {
        resp = UrlFetchApp.fetch(urls[u], opts);
      } catch (fetchErr) {
        break; // error de red/DNS: pasar a la siguiente URL
      }
      var code = resp.getResponseCode();
      var headers = resp.getHeaders();
      var contentType = String(headers['Content-Type'] || headers['content-type'] || '');
      if (code === 200 && contentType.indexOf('text/html') === -1) return resp.getBlob().setName(name);
      if (code === 429 || code >= 500) {
        Utilities.sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      break; // 4xx no transitorio (o HTML de login): siguiente método
    }
  }
  return Drive.Files.export(fileId, XLSX_MIME).setName(name);
}

/**
 * Borra un temporal: papelera y, si falla, eliminación definitiva.
 * @param {string} tempFileId
 * @throws {Error} si fallan las dos.
 */
function doc_cleanupTemp_(tempFileId) {
  try {
    Drive.Files.trash(tempFileId, { supportsAllDrives: true });
  } catch (trashError) {
    try {
      Drive.Files.remove(tempFileId, { supportsAllDrives: true });
    } catch (removeError) {
      throw new Error('Papelera: ' + errMsg_(trashError) + '. Eliminación definitiva: ' + errMsg_(removeError));
    }
  }
}

/**
 * "<CODIGO>-<RAZÓN SOCIAL>": nombre de la carpeta y (+ ".xlsx") del
 * archivo de una cotización, OIS u OIP.
 * @param {string} codigoOrden
 * @param {Object} cliente
 * @return {string}
 */
function doc_ordenBaseName_(codigoOrden, cliente) {
  var razon = cliente && cliente.razonSocial ? String(cliente.razonSocial).trim() : '';
  return sanitizeFileName_(razon ? codigoOrden + '-' + razon : codigoOrden);
}

/**
 * Id de la subcarpeta `title` dentro de `parentId`, creándola si no existe
 * (si una generación anterior falló después de crearla, se reutiliza en vez
 * de duplicarla). Con supportsAllDrives por si la raíz es una unidad compartida.
 * @param {string} parentId
 * @param {string} title
 * @return {string}
 */
function doc_ensureFolder_(parentId, title) {
  var FOLDER_MIME = 'application/vnd.google-apps.folder';
  var escaped = String(title).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  var found = Drive.Files.list({
    q: "title = '" + escaped + "' and '" + parentId + "' in parents and mimeType = '" + FOLDER_MIME + "' and trashed = false",
    maxResults: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  if (found.items && found.items.length) return found.items[0].id;
  var created = Drive.Files.insert({ title: title, mimeType: FOLDER_MIME, parents: [{ id: parentId }] }, null, { supportsAllDrives: true });
  return created.id;
}
