/**
 * Fase 2: generación del documento Excel de una cotización ya persistida.
 * Se llama por separado desde el cliente (api_generateDocument), fuera del
 * script lock — puede tardar 10-30s y no debe bloquear la creación de
 * otras cotizaciones.
 *
 * Flujo: copiar plantilla nativa -> escribir celdas -> flush -> exportar a
 * .xlsx -> guardar en la carpeta destino -> borrar el temporal (finally,
 * incluso si la exportación falla).
 *
 * Referencia probada en este entorno (no se importa nada de ahí, solo se
 * reimplementa el patrón): src/otherFunctions.js, Drive.Files.copy(...,
 * {convert:true, supportsAllDrives:true}) + Drive.Files.trash con fallback
 * a Drive.Files.remove.
 */

/**
 * idCotizacion: cotización ya creada (Fase 1). requestId: mismo UUID del
 * formulario, para que un reintento tras timeout no regenere el documento
 * si ya se generó (idempotencia de la fase 2, separada de la fase 1).
 * Devuelve ok_({docUrl, docFileId, docNombre}) o fail_(...).
 */
function doc_generateForQuotation_(idCotizacion, requestId) {
  if (!CFG().TEMPLATE_SHEET_ID) {
    return fail_('SCHEMA', 'La plantilla aún no se ha preparado. Ejecuta admin_convertTemplate() desde el editor de Apps Script antes de generar documentos.');
  }

  // Idempotencia solo para la generación inicial (con requestId). La
  // regeneración (requestId null, "Guardar cambios" de Gestión) SIEMPRE debe
  // reescribir el documento: antes usaba la clave 'idem:doc:<idCotizacion>'
  // y un segundo guardado dentro de las 6h devolvía el resultado cacheado
  // sin volver a escribir la plantilla.
  var idemKey = requestId ? 'idem:doc:' + requestId : null;
  var cached = idemKey ? cacheGetJson_(idemKey) : null;
  if (cached) return cached;

  var got = qs_getCotizacion(idCotizacion);
  if (!got.ok) return got;

  var d = got.data;
  var ctx = doc_buildCtx_(d);

  var tmpId = null;
  try {
    var copy = Drive.Files.copy(
      { title: '__TMP_CTZ__' + sanitizeFileName_(ctx.codigo) + '_' + Date.now(), mimeType: MimeType.GOOGLE_SHEETS },
      CFG().TEMPLATE_SHEET_ID,
      { convert: true, supportsAllDrives: true }
    );
    tmpId = copy.id;

    var ss = SpreadsheetApp.openById(tmpId);
    var sheet = (CFG().TEMPLATE_TAB_NAME && ss.getSheetByName(CFG().TEMPLATE_TAB_NAME)) || ss.getSheets()[0];

    doc_writeCells_(sheet, ctx);
    SpreadsheetApp.flush(); // crítico antes de exportar

    var fileName = sanitizeFileName_(ctx.codigo) + '.xlsx';

    // Si la cotización ya tiene documento (DOC FILE ID, o el id sacado del
    // link en URL DOCUMENTO), SIEMPRE se actualiza ese mismo archivo: nunca
    // se crea uno por cada "Guardar cambios". Solo se crea uno nuevo si no
    // hay documento previo, o si el previo ya no existe / está en la
    // papelera. Cualquier otro error al actualizar se propaga (DOC ESTADO =
    // ERROR, con reintento) en vez de caer en silencio a crear un duplicado.
    var existente = doc_findExistingFile_(d.cotizacion);
    var saved;
    if (existente && existente.mimeType === MimeType.GOOGLE_SHEETS) {
      // Hoja nativa de Google: se reemplaza la pestaña de la cotización
      // dentro del mismo archivo (mismo id y mismo link).
      doc_replaceNativeSheet_(existente.id, sheet);
      saved = existente;
    } else if (existente) {
      // .xlsx: se reemplaza el contenido del mismo archivo (nueva revisión).
      var blobUpd = doc_exportXlsx_(tmpId, existente.title || fileName);
      saved = Drive.Files.update({}, existente.id, blobUpd, { supportsAllDrives: true });
    } else {
      var blob = doc_exportXlsx_(tmpId, fileName);
      saved = Drive.Files.insert(
        { title: fileName, parents: [{ id: CFG().OUT_FOLDER_ID }] },
        blob,
        { supportsAllDrives: true }
      );
    }

    qr_updateDocInfo_(idCotizacion, saved.alternateLink, 'OK', saved.id);
    bumpDataVersion_();

    var response = ok_({ docFileId: saved.id, docUrl: saved.alternateLink, docNombre: saved.title || fileName });
    if (idemKey) cachePutJson_(idemKey, response, 21600);
    return response;
  } catch (e) {
    logError_('doc_generateForQuotation_', requestId, { idCotizacion: idCotizacion }, null, e);
    try {
      // undefined = no tocar URL DOCUMENTO ni DOC FILE ID: si se borraran, el
      // siguiente guardado ya no sabría cuál es el documento original y
      // crearía otro.
      qr_updateDocInfo_(idCotizacion, undefined, 'ERROR');
      bumpDataVersion_();
    } catch (e2) { /* no ocultar el error original por un fallo secundario */ }
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'DRIVE';
    return fail_(code, errMsg_(e));
  } finally {
    if (tmpId) {
      try {
        doc_cleanupTemp_(tmpId);
      } catch (cleanupErr) {
        logError_('doc_cleanupTemp_', requestId, { idCotizacion: idCotizacion, tmpId: tmpId }, null, cleanupErr);
      }
    }
  }
}

/**
 * Contexto de escritura de la plantilla a partir del detalle de una
 * cotización (salida de qs_getCotizacion().data). Compartido por el
 * documento de la cotización y el de su OIS: ambos pintan los MISMOS datos
 * de cliente/solicitante/establecimiento/servicios/personal.
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

/**
 * Id de Drive del documento ya generado de una cotización: DOC FILE ID si
 * existe, si no el que viene dentro del link de URL DOCUMENTO
 * (".../d/<id>/...", "?id=<id>"). '' si no hay ninguno.
 */
function doc_fileIdFromCotizacion_(cotizacion) {
  var id = String((cotizacion && cotizacion.docFileId) || '').trim();
  if (id) return id;
  var url = String((cotizacion && cotizacion.urlDocumento) || '').trim();
  if (!url) return '';
  var m = /\/d\/([a-zA-Z0-9_-]{20,})/.exec(url) || /[?&]id=([a-zA-Z0-9_-]{20,})/.exec(url);
  return m ? m[1] : '';
}

/**
 * Metadatos del documento previo de la cotización, o null si no tiene uno
 * utilizable (sin id, borrado, o en la papelera). Cualquier otro error de
 * Drive (permisos, cuota, red) se propaga: en esos casos NO se debe crear
 * un documento nuevo, porque el original sigue existiendo.
 */
function doc_findExistingFile_(cotizacion) {
  var fileId = doc_fileIdFromCotizacion_(cotizacion);
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
 * de la cotización por la recién generada (srcSheet, en el temporal). El
 * archivo conserva su id y su link; la pestaña conserva su nombre.
 */
function doc_replaceNativeSheet_(targetId, srcSheet) {
  var dest = SpreadsheetApp.openById(targetId);
  var old = (CFG().TEMPLATE_TAB_NAME && dest.getSheetByName(CFG().TEMPLATE_TAB_NAME)) || dest.getSheets()[0];
  var oldName = old.getName();
  var oldIndex = old.getIndex();

  var copied = srcSheet.copyTo(dest);
  dest.setActiveSheet(copied);
  dest.moveActiveSheet(oldIndex);
  dest.deleteSheet(old);
  copied.setName(oldName);
  SpreadsheetApp.flush();
}

/** Regenerar el documento de una cotización cuyo DOC ESTADO quedó en ERROR (o para refrescarlo). Sin límite de reintentos, no toca la BD de negocio. */
function doc_regenerate_(idCotizacion) {
  return doc_generateForQuotation_(idCotizacion, null);
}

/**
 * Escribe todas las celdas de la plantilla. Siempre setValue sobre la
 * celda ancla (nunca setValues sobre un rango): algunas celdas del layout
 * pueden estar combinadas horizontalmente y setValues sobre un rango con
 * combinaciones lanza "Cannot use setValues on merged cells".
 *
 * opts.sinTarifas: true = no escribir la tabla de tarifas (E/F/H 223..232).
 * La usa la hoja OIS V-4, donde esas filas están ocupadas por la fila de
 * códigos (225) y las tareas (229..248), y que no lleva tarifas.
 */
function doc_writeCells_(sheet, ctx, opts) {
  opts = opts || {};
  var cm = CELLMAP();
  var cli = ctx.cliente || {};
  var sol = ctx.solicitante || {};
  var est = ctx.establecimiento || {};
  var enc = ctx.encargado || {};

  doc_setText_(sheet, cm.FECHA_ANIO, fmtDate_(ctx.fechaElaboracion, 'yyyy'));
  doc_setText_(sheet, cm.FECHA_MES, fmtDate_(ctx.fechaElaboracion, 'MM'));
  doc_setText_(sheet, cm.FECHA_DIA, fmtDate_(ctx.fechaElaboracion, 'dd'));
  doc_setText_(sheet, cm.CODIGO, ctx.codigo);

  doc_setText_(sheet, cm.CLIENTE_RAZON_SOCIAL, cli.razonSocial);
  doc_setText_(sheet, cm.CLIENTE_NUMERO_ID, cli.numeroIdentificacion);
  doc_setText_(sheet, cm.CLIENTE_DIRECCION, cli.direccion);
  doc_setText_(sheet, cm.CLIENTE_CIUDAD_DEPTO_PAIS, joinNonEmpty_([cli.ciudad, cli.departamento, cli.pais], ', '));
  doc_setText_(sheet, cm.CLIENTE_TELEFONO, cli.telefono);

  doc_setText_(sheet, cm.SOLICITANTE_NOMBRE, sol.nombre);
  doc_setText_(sheet, cm.SOLICITANTE_CARGO, sol.cargo);
  doc_setText_(sheet, cm.SOLICITANTE_TELEFONO, sol.telefono);
  doc_setText_(sheet, cm.SOLICITANTE_CORREO, sol.correo);

  doc_setText_(sheet, cm.CLIENTE_CIIU, cli.codigoCiiu);
  doc_setText_(sheet, cm.CLIENTE_ACTIVIDAD_PRINCIPAL, cli.actividadPrincipal);

  doc_setText_(sheet, cm.COTIZACION_DESCRIPCION, ctx.descripcion);

  doc_setText_(sheet, cm.ESTABLECIMIENTO_NOMBRE, est.nombre);
  doc_setText_(sheet, cm.ESTABLECIMIENTO_DIRECCION, est.direccion);
  doc_setText_(sheet, cm.ESTABLECIMIENTO_CIUDAD_DEPTO_PAIS, joinNonEmpty_([est.ciudad, est.departamento, est.pais], ', '));

  doc_setText_(sheet, cm.ENCARGADO_NOMBRE, enc.nombre);
  doc_setText_(sheet, cm.ENCARGADO_CARGO, enc.cargo);
  doc_setText_(sheet, cm.ENCARGADO_TELEFONO, enc.telefono);
  doc_setText_(sheet, cm.ENCARGADO_CORREO, enc.correo);

  var servicios = (ctx.servicios || []).slice(0, CFG().LIMITS.MAX_SERVICIOS);
  servicios.forEach(function (srv, indice) {
    doc_writeServicioCells_(sheet, cm, indice, srv, !opts.sinTarifas);
  });

  // Trazabilidad de personal: NOMBRE del empleado (no el ID). APROBADO_POR y
  // ASESOR_COMERCIAL se escriben vacíos si aún no corresponden (garantía sin
  // decidir / sin asesor asignado) para no dejar un valor de una revisión
  // anterior si "Guardar cambios" regenera el documento.
  doc_setText_(sheet, cm.ELABORADO_POR, ctx.elaboradoPorNombre);
  doc_setText_(sheet, cm.CARGO_ELABORADO_POR, ctx.cargoElaborador);
  doc_setText_(sheet, cm.APROBADO_POR, ctx.revisadoAprobadoPorNombre);
  doc_setText_(sheet, cm.ASESOR_COMERCIAL, ctx.asesorComercialNombre);

  // TIEMPO DE ENTREGA: en blanco hasta la primera edición desde "Gestionar
  // cotización" (mismo criterio que ASESOR_COMERCIAL arriba) — doc_setText_
  // con '' limpia la celda en vez de dejar un valor de un guardado anterior.
  doc_setText_(sheet, cm.TIEMPO_ENTREGA, ctx.tiempoEntrega);
}

/**
 * Escribe el bloque de un servicio (tipo/UNSPSC/descripción/actividades) en
 * su fila ancla: el servicio #1 (indice 0) usa SERVICIOS_FILA_BASE, y cada
 * uno siguiente repite el mismo layout SERVICIOS_FILA_PASO filas más abajo.
 */
function doc_writeServicioCells_(sheet, cm, indice, srv, conTarifas) {
  srv = srv || {};
  var filaBase = cm.SERVICIOS_FILA_BASE + indice * cm.SERVICIOS_FILA_PASO;

  doc_setText_(sheet, cm.SERVICIOS_COL_TIPO + filaBase, srv.tipo);
  doc_setText_(sheet, cm.SERVICIOS_COL_UNSPSC + filaBase, srv.codigoUnspsc);
  doc_setText_(sheet, cm.SERVICIOS_COL_DESCRIPCION + filaBase, srv.descripcion);

  var filaActInicio = filaBase + cm.SERVICIOS_ACT_OFFSET_FILA;
  var actividades = (srv.actividades || []).slice(0, cm.SERVICIOS_ACT_MAX);
  for (var i = 0; i < actividades.length; i++) {
    var a1 = cm.SERVICIOS_ACT_COL + (filaActInicio + i);
    doc_setText_(sheet, a1, doc_stripActividadPrefix_(actividades[i]));
  }

  // Tabla de tarifas: una fila por servicio (E/F/H 223..232). TOTAL del
  // servicio no va a la plantilla, solo a la BD. No aplica a la hoja OIS.
  if (!conTarifas) return;
  var filaTarifa = cm.TARIFAS_FILA_BASE + indice;
  doc_setNumber_(sheet, cm.TARIFAS_COL_TARIFA + filaTarifa, srv.tarifa);
  doc_setNumber_(sheet, cm.TARIFAS_COL_CANTIDAD + filaTarifa, srv.cantidad);
  doc_setText_(sheet, cm.TARIFAS_COL_OBSERVACIONES + filaTarifa, srv.observaciones);
}

/**
 * setValue numérico SIN tocar el formato de la celda: la plantilla ya trae
 * su formato de moneda/cantidad (y posibles fórmulas que dependen de estas
 * celdas), que el '@' de doc_setText_ rompería. '' deja la celda vacía.
 */
function doc_setNumber_(sheet, a1, value) {
  var n = (value === '' || value == null) ? '' : Number(value);
  sheet.getRange(a1).setValue(n === '' || isNaN(n) ? '' : n);
}

/**
 * SERVICIOS guarda las actividades con un prefijo de numeración interna
 * ("1.1 texto", "1.2 texto", ...) para que la columna sea legible de un
 * vistazo en el sheet. La plantilla solo debe llevar el texto que la
 * persona escribió en el textarea, sin ese prefijo.
 */
function doc_stripActividadPrefix_(texto) {
  return String(texto || '').replace(/^\d+\.\d+\s+/, '');
}

/** setValue como texto plano (formato '@'), preserva ceros a la izquierda y NITs largos que la coerción numérica de Sheets destruiría. */
function doc_setText_(sheet, a1, value) {
  sheet.getRange(a1).setNumberFormat('@').setValue(value == null ? '' : String(value));
}

/**
 * Exporta un Google Sheet a .xlsx probando, en cascada: (1) Drive API v3
 * export vía UrlFetchApp [oficial, límite 10MB, requiere scope
 * script.external_request], (2) docs.google.com/export [sin ese límite,
 * no oficial: se valida Content-Type porque puede devolver el HTML de
 * login con código 200], (3) Drive.Files.export del servicio avanzado.
 * NUNCA DriveApp.getFileById(id).getBlob(): en un Google Sheet devuelve
 * PDF, no xlsx.
 */
function doc_exportXlsx_(fileId, name) {
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var token = ScriptApp.getOAuthToken();
  var urls = [
    'https://www.googleapis.com/drive/v3/files/' + fileId + '/export?mimeType=' + encodeURIComponent(XLSX_MIME) + '&supportsAllDrives=true',
    'https://docs.google.com/spreadsheets/d/' + fileId + '/export?format=xlsx&id=' + fileId
  ];
  var opts = { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };

  for (var u = 0; u < urls.length; u++) {
    for (var attempt = 0; attempt < 3; attempt++) {
      var resp;
      try {
        resp = UrlFetchApp.fetch(urls[u], opts);
      } catch (fetchErr) {
        break; // error de red/DNS: no reintentar esta URL, pasar a la siguiente
      }
      var code = resp.getResponseCode();
      var contentType = String(resp.getHeaders()['Content-Type'] || resp.getHeaders()['content-type'] || '');

      if (code === 200 && contentType.indexOf('text/html') === -1) {
        return resp.getBlob().setName(name);
      }
      if (code === 429 || code >= 500) {
        Utilities.sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      break; // 4xx no transitorio (o HTML de login): siguiente método
    }
  }

  // Fallback final: servicio avanzado Drive v2 (no pasa por UrlFetchApp).
  var exported = Drive.Files.export(fileId, XLSX_MIME);
  return exported.setName(name);
}

/** Borra el archivo temporal; si falla la papelera, intenta eliminación definitiva. Se llama siempre desde un finally. */
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

// ---------------------------------------------------------------------
// Documento de la OIS
// ---------------------------------------------------------------------

/**
 * Genera (o regenera, SIEMPRE sobre el mismo archivo — CLAUDE.md §8) el
 * spreadsheet de una OIS: un .xlsx con UNA sola hoja, la pestaña
 * CFG().TEMPLATE_TAB_OIS ("OIS V-4") de la plantilla, guardado en su propia
 * subcarpeta "OIS-KGP-NNN-YY-<RAZÓN SOCIAL>" dentro de CFG().OIS_FOLDER_ID.
 *
 * Flujo (sobre un temporal, igual que la cotización):
 *   1. Copia la plantilla completa y escribe la hoja de cotización con el
 *      mismo contexto (por si la hoja OIS tiene fórmulas que la referencian).
 *   2. Escribe en la hoja OIS los mismos datos compartidos (sin la tabla de
 *      tarifas), la fila de códigos (A225..E225) y las tareas (A229..E248).
 *   3. Congela como valor toda fórmula de la hoja OIS que apunte a OTRA hoja
 *      (si no, quedaría en #REF! al borrar las demás), y borra las demás.
 *   4. Exporta a .xlsx y crea / actualiza el archivo.
 *
 * requestId: solo en la generación inicial (idempotencia ante reintentos);
 * null = regeneración desde "Guardar cambios", que SIEMPRE reescribe.
 */
function doc_generateForOis_(idOis, requestId) {
  if (!CFG().TEMPLATE_SHEET_ID) {
    return fail_('SCHEMA', 'La plantilla aún no se ha preparado. Ejecuta admin_convertTemplate() desde el editor de Apps Script antes de generar documentos.');
  }
  var idemKey = requestId ? 'idem:docois:' + requestId : null;
  var cached = idemKey ? cacheGetJson_(idemKey) : null;
  if (cached) return cached;

  var got = ois_getOis(idOis);
  if (!got.ok) return got;
  var d = got.data;
  var ctx = doc_buildCtx_(d);

  var tmpId = null;
  try {
    var copy = Drive.Files.copy(
      { title: '__TMP_OIS__' + sanitizeFileName_(d.ois.codigo) + '_' + Date.now(), mimeType: MimeType.GOOGLE_SHEETS },
      CFG().TEMPLATE_SHEET_ID,
      { convert: true, supportsAllDrives: true }
    );
    tmpId = copy.id;

    var ss = SpreadsheetApp.openById(tmpId);
    var oisSheet = ss.getSheetByName(CFG().TEMPLATE_TAB_OIS);
    if (!oisSheet) {
      throw new AppError_('SCHEMA', 'La plantilla no tiene la hoja "' + CFG().TEMPLATE_TAB_OIS + '". Hojas disponibles: [' +
        ss.getSheets().map(function (s) { return s.getName(); }).join(', ') + ']');
    }
    var ctzSheet = (CFG().TEMPLATE_TAB_NAME && ss.getSheetByName(CFG().TEMPLATE_TAB_NAME)) || ss.getSheets()[0];
    if (ctzSheet.getSheetId() !== oisSheet.getSheetId()) doc_writeCells_(ctzSheet, ctx);

    doc_writeCells_(oisSheet, ctx, { sinTarifas: true });
    doc_writeOisCells_(oisSheet, ctx, d.ois, d.tareas || []);
    SpreadsheetApp.flush();

    doc_freezeCrossSheetFormulas_(oisSheet);
    ss.getSheets().forEach(function (s) {
      if (s.getSheetId() !== oisSheet.getSheetId()) ss.deleteSheet(s);
    });
    SpreadsheetApp.flush(); // crítico antes de exportar

    var baseName = doc_ordenBaseName_(d.ois.codigo, d.cliente);
    var fileName = baseName + '.xlsx';

    var existente = doc_findExistingFile_(d.ois);
    var saved;
    if (existente && existente.mimeType === MimeType.GOOGLE_SHEETS) {
      doc_replaceNativeSheet_(existente.id, oisSheet);
      saved = existente;
    } else if (existente) {
      saved = Drive.Files.update({}, existente.id, doc_exportXlsx_(tmpId, existente.title || fileName), { supportsAllDrives: true });
    } else {
      var folderId = doc_ensureFolder_(CFG().OIS_FOLDER_ID, baseName);
      saved = Drive.Files.insert(
        { title: fileName, parents: [{ id: folderId }] },
        doc_exportXlsx_(tmpId, fileName),
        { supportsAllDrives: true }
      );
    }

    ois_updateDocInfo_(idOis, saved.alternateLink, 'OK', saved.id);
    bumpDataVersion_();

    var response = ok_({ docFileId: saved.id, docUrl: saved.alternateLink, docNombre: saved.title || fileName });
    if (idemKey) cachePutJson_(idemKey, response, 21600);
    return response;
  } catch (e) {
    logError_('doc_generateForOis_', requestId, { idOis: idOis }, null, e);
    try {
      ois_updateDocInfo_(idOis, undefined, 'ERROR'); // undefined = no tocar link ni id (§8)
      bumpDataVersion_();
    } catch (e2) { /* no ocultar el error original */ }
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'DRIVE';
    return fail_(code, errMsg_(e));
  } finally {
    if (tmpId) {
      try {
        doc_cleanupTemp_(tmpId);
      } catch (cleanupErr) {
        logError_('doc_cleanupTemp_', requestId, { idOis: idOis, tmpId: tmpId }, null, cleanupErr);
      }
    }
  }
}

/**
 * Celdas propias de la hoja OIS V-4 (ver CELLMAP): fila 225 (código de la
 * cotización padre, código de la OIS, y año/mes/día iguales a A7/B7/C7) y
 * la tabla de tareas desde la fila 229 (una por fila, máx. MAX_TAREAS).
 * Solo se escriben TAREA / RESPONSABLE / FECHA INICIO / FECHA ENTREGA /
 * OBSERVACION (ni estado ni ID EMPLEADO van a la plantilla).
 */
function doc_writeOisCells_(sheet, ctx, ois, tareas) {
  var cm = CELLMAP();
  // E7 (cm.CODIGO): doc_writeCells_ ya escribió ahí el código de la
  // COTIZACIÓN (mismo layout que CTZ-V-4). En la hoja OIS, esa celda debe
  // mostrar el código de la OIS — se sobrescribe después de doc_writeCells_.
  doc_setText_(sheet, cm.CODIGO, ois.codigo);
  doc_setText_(sheet, cm.OIS_COT_CODIGO, ctx.codigo);
  doc_setText_(sheet, cm.OIS_CODIGO, ois.codigo);
  // Mismos valores que A7/B7/C7 (doc_writeCells_ los escribe con esta misma fecha).
  doc_setText_(sheet, cm.OIS_FECHA_ANIO, fmtDate_(ctx.fechaElaboracion, 'yyyy'));
  doc_setText_(sheet, cm.OIS_FECHA_MES, fmtDate_(ctx.fechaElaboracion, 'MM'));
  doc_setText_(sheet, cm.OIS_FECHA_DIA, fmtDate_(ctx.fechaElaboracion, 'dd'));

  tareas.slice(0, CFG().LIMITS.MAX_TAREAS).forEach(function (t, i) {
    var fila = cm.OIS_TAREAS_FILA_BASE + i;
    doc_setText_(sheet, cm.OIS_TAREAS_COL_TAREA + fila, t.tarea);
    doc_setText_(sheet, cm.OIS_TAREAS_COL_RESPONSABLE + fila, t.responsable);
    doc_setDate_(sheet, cm.OIS_TAREAS_COL_FECHA_INICIO + fila, t.fechaInicio);
    doc_setDate_(sheet, cm.OIS_TAREAS_COL_FECHA_ENTREGA + fila, t.fechaEntrega);
    doc_setText_(sheet, cm.OIS_TAREAS_COL_OBSERVACION + fila, t.observacion);
  });
}

/**
 * Fecha ISO ('yyyy-MM-dd') como Date real, SIN tocar el formato de la celda
 * (mismo criterio que doc_setNumber_: la plantilla decide cómo se ve). ''
 * o una fecha inválida dejan la celda vacía.
 */
function doc_setDate_(sheet, a1, iso) {
  var d = parseISODate_(iso);
  sheet.getRange(a1).setValue(d || '');
}

/**
 * Reemplaza por su valor actual toda fórmula de la hoja que referencie OTRA
 * hoja (contiene "!"): el documento de la OIS solo conserva esta hoja, y esas
 * referencias quedarían en #REF!. Las fórmulas internas de la hoja se dejan
 * intactas. Se escribe celda por celda (solo las afectadas) por las celdas
 * combinadas, igual que doc_writeCells_.
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
// Documento de la OIP
// ---------------------------------------------------------------------

/**
 * Genera (o regenera, SIEMPRE sobre el mismo archivo — CLAUDE.md §8) el
 * spreadsheet de una OIP: un .xlsx con UNA sola hoja, la pestaña
 * CFG().TEMPLATE_TAB_OIP ("OIP V-4") de la plantilla, guardado en su propia
 * subcarpeta "OIP-KGP-NNN-YY-<RAZÓN SOCIAL>" dentro de CFG().OIP_FOLDER_ID.
 *
 * Idéntico a doc_generateForOis_ salvo en las celdas propias de la hoja
 * (doc_writeOipCells_). Igual que en la OIS se escribe con sinTarifas: la
 * fila de identificación de la OIP es la 231, que choca con la tabla de
 * tarifas de CTZ-V-4 (223..232), así que esas filas no son tarifas en esta
 * hoja — y el usuario pidió explícitamente quitar las tarifas de la OIP.
 *
 * requestId: solo en la generación inicial (idempotencia ante reintentos);
 * null = regeneración desde "Guardar cambios", que SIEMPRE reescribe.
 */
function doc_generateForOip_(idOip, requestId) {
  if (!CFG().TEMPLATE_SHEET_ID) {
    return fail_('SCHEMA', 'La plantilla aún no se ha preparado. Ejecuta admin_convertTemplate() desde el editor de Apps Script antes de generar documentos.');
  }
  var idemKey = requestId ? 'idem:docoip:' + requestId : null;
  var cached = idemKey ? cacheGetJson_(idemKey) : null;
  if (cached) return cached;

  var got = oip_getOip(idOip);
  if (!got.ok) return got;
  var d = got.data;
  var ctx = doc_buildCtx_(d);

  var tmpId = null;
  try {
    var copy = Drive.Files.copy(
      { title: '__TMP_OIP__' + sanitizeFileName_(d.oip.codigo) + '_' + Date.now(), mimeType: MimeType.GOOGLE_SHEETS },
      CFG().TEMPLATE_SHEET_ID,
      { convert: true, supportsAllDrives: true }
    );
    tmpId = copy.id;

    var ss = SpreadsheetApp.openById(tmpId);
    var oipSheet = ss.getSheetByName(CFG().TEMPLATE_TAB_OIP);
    if (!oipSheet) {
      throw new AppError_('SCHEMA', 'La plantilla no tiene la hoja "' + CFG().TEMPLATE_TAB_OIP + '". Hojas disponibles: [' +
        ss.getSheets().map(function (s) { return s.getName(); }).join(', ') + ']');
    }
    var ctzSheet = (CFG().TEMPLATE_TAB_NAME && ss.getSheetByName(CFG().TEMPLATE_TAB_NAME)) || ss.getSheets()[0];
    if (ctzSheet.getSheetId() !== oipSheet.getSheetId()) doc_writeCells_(ctzSheet, ctx);

    doc_writeCells_(oipSheet, ctx, { sinTarifas: true });
    doc_writeOipCells_(oipSheet, ctx, d.oip, d.tareas || []);
    SpreadsheetApp.flush();

    doc_freezeCrossSheetFormulas_(oipSheet);
    ss.getSheets().forEach(function (s) {
      if (s.getSheetId() !== oipSheet.getSheetId()) ss.deleteSheet(s);
    });
    SpreadsheetApp.flush(); // crítico antes de exportar

    var baseName = doc_ordenBaseName_(d.oip.codigo, d.cliente);
    var fileName = baseName + '.xlsx';

    var existente = doc_findExistingFile_(d.oip);
    var saved;
    if (existente && existente.mimeType === MimeType.GOOGLE_SHEETS) {
      doc_replaceNativeSheet_(existente.id, oipSheet);
      saved = existente;
    } else if (existente) {
      saved = Drive.Files.update({}, existente.id, doc_exportXlsx_(tmpId, existente.title || fileName), { supportsAllDrives: true });
    } else {
      var folderId = doc_ensureFolder_(CFG().OIP_FOLDER_ID, baseName);
      saved = Drive.Files.insert(
        { title: fileName, parents: [{ id: folderId }] },
        doc_exportXlsx_(tmpId, fileName),
        { supportsAllDrives: true }
      );
    }

    oip_updateDocInfo_(idOip, saved.alternateLink, 'OK', saved.id);
    bumpDataVersion_();

    var response = ok_({ docFileId: saved.id, docUrl: saved.alternateLink, docNombre: saved.title || fileName });
    if (idemKey) cachePutJson_(idemKey, response, 21600);
    return response;
  } catch (e) {
    logError_('doc_generateForOip_', requestId, { idOip: idOip }, null, e);
    try {
      oip_updateDocInfo_(idOip, undefined, 'ERROR'); // undefined = no tocar link ni id (§8)
      bumpDataVersion_();
    } catch (e2) { /* no ocultar el error original */ }
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'DRIVE';
    return fail_(code, errMsg_(e));
  } finally {
    if (tmpId) {
      try {
        doc_cleanupTemp_(tmpId);
      } catch (cleanupErr) {
        logError_('doc_cleanupTemp_', requestId, { idOip: idOip, tmpId: tmpId }, null, cleanupErr);
      }
    }
  }
}

/**
 * Celdas propias de la hoja OIP V-4 (ver CELLMAP): fila 231 (código de la
 * cotización padre, código de la OIP, y año/mes/día iguales a A7/B7/C7) y la
 * tabla de tareas desde la fila 235.
 *
 * Diferencia clave con la OIS: la plantilla NO reserva un bloque fijo de
 * filas para las tareas. La #1 va en OIP_TAREAS_FILA_BASE y, si hay más, se
 * INSERTAN las filas que falten justo debajo (una por tarea extra, en una
 * sola llamada) antes de escribir — así nunca se sobreescribe lo que haya
 * más abajo en la hoja, por muchas tareas que tenga la OIP.
 *
 * Solo se escriben TAREA / RESPONSABLE / FECHA INICIO / FECHA ENTREGA /
 * OBSERVACION (ni estado ni ID EMPLEADO van a la plantilla).
 */
function doc_writeOipCells_(sheet, ctx, oip, tareas) {
  var cm = CELLMAP();
  // E7 (cm.CODIGO): doc_writeCells_ ya escribió ahí el código de la
  // COTIZACIÓN (mismo layout que CTZ-V-4). En la hoja OIP esa celda debe
  // mostrar el código de la OIP, igual que se hace en la hoja OIS.
  doc_setText_(sheet, cm.CODIGO, oip.codigo);
  doc_setText_(sheet, cm.OIP_COT_CODIGO, ctx.codigo);
  doc_setText_(sheet, cm.OIP_CODIGO, oip.codigo);
  // Mismos valores que A7/B7/C7 (doc_writeCells_ los escribe con esta misma fecha).
  doc_setText_(sheet, cm.OIP_FECHA_ANIO, fmtDate_(ctx.fechaElaboracion, 'yyyy'));
  doc_setText_(sheet, cm.OIP_FECHA_MES, fmtDate_(ctx.fechaElaboracion, 'MM'));
  doc_setText_(sheet, cm.OIP_FECHA_DIA, fmtDate_(ctx.fechaElaboracion, 'dd'));

  var lista = tareas.slice(0, CFG().LIMITS.MAX_TAREAS_OIP);
  if (!lista.length) return;

  // Una fila nueva por cada tarea a partir de la segunda: la fila base ya
  // existe en la plantilla. Se insertan todas de una vez (insertRowsAfter
  // hereda el formato de la fila de arriba) para no hacer N llamadas.
  var filaBase = cm.OIP_TAREAS_FILA_BASE;
  if (lista.length > 1) sheet.insertRowsAfter(filaBase, lista.length - 1);

  lista.forEach(function (t, i) {
    var fila = filaBase + i;
    doc_setText_(sheet, cm.OIP_TAREAS_COL_TAREA + fila, t.tarea);
    doc_setText_(sheet, cm.OIP_TAREAS_COL_RESPONSABLE + fila, t.responsable);
    doc_setDate_(sheet, cm.OIP_TAREAS_COL_FECHA_INICIO + fila, t.fechaInicio);
    doc_setDate_(sheet, cm.OIP_TAREAS_COL_FECHA_ENTREGA + fila, t.fechaEntrega);
    doc_setText_(sheet, cm.OIP_TAREAS_COL_OBSERVACION + fila, t.observacion);
  });
}

/** "<CODIGO ORDEN>-<RAZÓN SOCIAL>" (nombre de la carpeta y, + ".xlsx", del archivo de la OIS/OIP). */
function doc_ordenBaseName_(codigoOrden, cliente) {
  var razon = cliente && cliente.razonSocial ? String(cliente.razonSocial).trim() : '';
  return sanitizeFileName_(razon ? codigoOrden + '-' + razon : codigoOrden);
}

/**
 * Id de la subcarpeta `title` dentro de `parentId`, creándola si no existe
 * (si una generación anterior falló después de crearla, se reutiliza en vez
 * de duplicarla). Drive avanzado con supportsAllDrives, por si la carpeta
 * raíz vive en una unidad compartida.
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
