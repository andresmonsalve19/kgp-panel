/**
 * "Gestionar tareas": una sola vista con TODAS las tareas de todas las órdenes
 * (TAREAS_OIS + TAREAS_OIP).
 *
 * No hay hoja nueva: las tareas siguen viviendo en TAREAS_OIS / TAREAS_OIP y
 * se escriben con los mismos repos que usan "Gestionar OIS/OIP" (a través del
 * adaptador ord_spec_, 41_OrdenComun.js), así que un cambio hecho aquí es el
 * mismo dato que ven esas vistas, y viceversa.
 *
 * A diferencia de "Gestionar OIS/OIP" (que reescriben la lista completa de
 * tareas de UNA orden al "Guardar cambios"), aquí cada acción toca UNA sola
 * tarea y se guarda al instante: crear/editar (tg_saveTarea), finalizar/
 * reabrir (tg_setTareaEstado, solo la celda ESTADO) y eliminar
 * (tg_deleteTarea). Cada una, dentro del lock, recalcula y guarda el ESTADO
 * derivado de la orden.
 *
 * Mismas reglas de negocio que las vistas de cada orden: una OIS Finalizada
 * es de solo lectura (CONFLICT); una OIP Finalizada no (CLAUDE.md §11.3);
 * topes MAX_TAREAS / MAX_TAREAS_OIP por orden; RESPONSABLE se resuelve en el
 * servidor a partir de ID EMPLEADO.
 *
 * Los documentos de la orden se regeneran después, desde el cliente y fuera
 * del lock (api_regenerateOisDocument / api_regenerateOipDocument).
 *
 * Cada cambio real queda en HISTORIAL_TAREAS (quién, cuándo, qué) y sella
 * ACTUALIZADO POR/EN de la tarea, dentro del mismo lock (42_HistorialTareas.js).
 */

// ---------------------------------------------------------------------
// Lectura: snapshot completo
// ---------------------------------------------------------------------

/**
 * Todo lo que necesita la vista en UN solo round-trip (CLAUDE.md §2):
 *   - tareas: todas las de OIS y OIP, con su orden.
 *   - ordenes: todas las OIS/OIP (filtro por orden y selector de "Nueva
 *     tarea"), con su estado derivado y conteo de tareas.
 *   - empleados: internos + terceros (filtro y desplegable de responsable).
 *   - yo: ID EMPLEADO del usuario activo si se pudo resolver por correo.
 *   - hoy: fecha del servidor (CFG_().TZ), para que "vencida" use el mismo
 *     criterio que el estado de las órdenes y no el reloj del navegador.
 *   - limites: tope de tareas por tipo de orden.
 *
 * Filtrado, orden y paginación ocurren en el cliente. Cacheado por
 * dataVersion + día (el estado "Vencida" depende del día).
 *
 * @return {!Object} ok_({hoy, tareas, ordenes, empleados, limites, yo})
 */
function tg_snapshot() {
  var hoy = toISODate_(new Date());
  var key = 'tareas:snap:v' + dataVersion_() + ':' + hoy;
  var snap = cacheGetJson_(key);
  if (!snap) {
    snap = tg_buildSnapshot_(hoy);
    cachePutJson_(key, snap, CFG_().CACHE_TTL.DASHBOARD_S);
  }
  // `yo` depende del usuario, no de los datos: nunca entra en la caché compartida.
  snap.yo = tg_idEmpleadoActivo_();
  return ok_(snap);
}

/**
 * Arma el snapshot de tg_snapshot (sin `yo`). Reutiliza ord_listarDto_, así
 * que si "Gestionar OIS/OIP" ya se abrió en esta versión de datos, las
 * órdenes salen de caché.
 * @param {string} hoy 'yyyy-MM-dd'
 * @return {!Object}
 */
function tg_buildSnapshot_(hoy) {
  var cfg = CFG_();
  var ordenes = [];
  var ordenPorClave = {};
  var tareas = [];

  ['OIS', 'OIP'].forEach(function (tipo) {
    var spec = ord_spec_(tipo);
    ord_listarDto_(spec, hoy).forEach(function (o) {
      var orden = {
        tipo: tipo,
        idOrden: o[spec.idKey],
        codigo: o.codigo || '',
        codigoCotizacion: o.codigoCotizacion || '',
        clienteNombre: o.clienteNombre || '',
        estado: o.estado,
        fechaVencimiento: o.fechaVencimiento || '',
        numTareas: o.numTareas || 0,
        // Solo una OIS Finalizada queda cerrada; la OIP sigue editable.
        cerrada: spec.cierraAlFinalizar && o.estado === spec.estados.finalizada
      };
      ordenes.push(orden);
      ordenPorClave[tipo + ':' + orden.idOrden] = orden;
    });
  });

  ['OIS', 'OIP'].forEach(function (tipo) {
    var spec = ord_spec_(tipo);
    spec.tablaTareas().rows.forEach(function (r) {
      var t = spec.tareaRowToObj(r);
      var orden = ordenPorClave[tipo + ':' + t[spec.idKey]];
      if (!orden || !t.idTarea) return; // tarea huérfana (orden borrada a mano): no se puede gestionar
      var dto = ord_tareaToDto_(t);
      dto.tipo = tipo;
      dto.idOrden = orden.idOrden;
      // Fila en la hoja: las tareas nuevas van al final, sirve de desempate estable.
      dto.fila = r.__row;
      tareas.push(dto);
    });
  });

  return {
    hoy: hoy,
    tareas: tareas,
    ordenes: ordenes,
    empleados: emp_listResponsables_().map(function (e) {
      return { idEmpleado: e.idEmpleado, nombre: e.nombre, cargo: e.cargo, cedula: e.cedula, tipoResponsable: e.tipoResponsable };
    }),
    limites: { OIS: cfg.LIMITS.MAX_TAREAS, OIP: cfg.LIMITS.MAX_TAREAS_OIP }
  };
}

/**
 * ID EMPLEADO (interno) del usuario activo, comparando correos normalizados.
 * '' si no se puede resolver (con executeAs USER_DEPLOYING, getActiveUser()
 * suele venir vacío para usuarios de fuera del dominio).
 * @return {string}
 */
function tg_idEmpleadoActivo_() {
  var correo = qs_correoUsuarioActivo_();
  if (!correo) return '';
  try {
    // emp_listEmpleados_ (con caché por dataVersion) en vez de emp_findByCorreo_:
    // así un snapshot servido desde caché no abre la hoja de personal.
    var wanted = normText_(correo);
    var emp = emp_listEmpleados_().filter(function (e) { return normText_(e.correo) === wanted; })[0];
    return emp ? String(emp.idEmpleado) : '';
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------
// Escritura (una tarea a la vez, dentro del lock)
// ---------------------------------------------------------------------

/**
 * Valida una tarea suelta (mismas reglas que cada tarea del "Guardar cambios"
 * de una orden, ver validateTarea_).
 * @param {*} t
 * @return {{errors: !Array<string>, clean: !Object}}
 */
function tg_validateTarea_(t) {
  var errors = [];
  var clean = validateTarea_(t, function (msg) { errors.push(msg.charAt(0).toUpperCase() + msg.slice(1)); });
  delete clean.idTarea; // el ID lo maneja tg_saveTarea aparte
  return { errors: errors, clean: clean };
}

/**
 * La orden, si existe y se puede editar. DEBE llamarse dentro del lock.
 * @param {!Object} spec
 * @param {string} idOrden
 * @return {!Object} Objeto de dominio de la orden.
 * @throws {AppError_} NOT_FOUND / CONFLICT (OIS finalizada).
 */
function tg_ordenEditable_(spec, idOrden) {
  var found = spec.findById(idOrden);
  if (!found) throw new AppError_('NOT_FOUND', 'No existe la ' + spec.tipo + ' ' + idOrden + '.');
  var orden = found.obj;
  if (spec.cierraAlFinalizar && String(orden.estado) === spec.estados.finalizada) {
    throw new AppError_('CONFLICT', 'La ' + spec.tipo + ' ' + orden.codigo + ' ya está finalizada y no se puede editar.');
  }
  return orden;
}

/**
 * Fila de una tarea dentro de su orden, o lanza NOT_FOUND.
 * @param {!Object} spec
 * @param {string} idOrden
 * @param {string} idTarea
 * @param {string} mensaje Texto del NOT_FOUND.
 * @return {{rowIndex: number, obj: !Object}}
 */
function tg_filaTarea_(spec, idOrden, idTarea, mensaje) {
  var fila = spec.getTareaRows(idOrden).filter(function (f) { return String(f.obj.idTarea) === idTarea; })[0];
  if (!fila) throw new AppError_('NOT_FOUND', mensaje);
  return fila;
}

/**
 * Recalcula el ESTADO derivado de la orden a partir de sus tareas actuales y
 * lo guarda (ESTADO, ACTUALIZADO EN/POR).
 * @return {{estado: string, cerrada: boolean, finalizada: boolean}} finalizada:
 *     la orden ACABA de pasar a Finalizada y avisa a contabilidad (OIS).
 */
function tg_refreshOrdenEstado_(spec, idOrden, orden) {
  var tareas = spec.getTareaRows(idOrden).map(function (r) { return r.obj; });
  var estado = ord_derivarEstado_(spec, tareas, qs_dateToISO_(orden.fechaVencimiento), toISODate_(new Date()));
  spec.update(idOrden, { 'ESTADO': estado, 'ACTUALIZADO POR': emps_nombreUsuarioActivo_() });
  return {
    estado: estado,
    cerrada: spec.cierraAlFinalizar && estado === spec.estados.finalizada,
    finalizada: !!spec.avisaFinalizada && String(orden.estado) !== spec.estados.finalizada && estado === spec.estados.finalizada
  };
}

/**
 * Respuesta común de las 3 escrituras: lo que el cliente necesita para
 * actualizar su fila y su orden sin releer todo.
 * @return {!Object} ok_({tipo, idOrden, codigoOrden, ordenEstado, ordenCerrada,
 *     ordenFinalizada, tarea}) — ordenFinalizada: la OIS acaba de quedar
 *     Finalizada (el cliente pide el aviso a contabilidad).
 */
function tg_writeResult_(spec, idOrden, orden, ordenInfo, tareaDto) {
  return ok_({
    tipo: spec.tipo,
    idOrden: idOrden,
    codigoOrden: orden.codigo,
    ordenEstado: ordenInfo.estado,
    ordenCerrada: ordenInfo.cerrada,
    ordenFinalizada: ordenInfo.finalizada,
    tarea: tareaDto || null
  });
}

/**
 * Crea (idTarea vacío) o edita una tarea. La orden de una tarea existente no
 * se puede cambiar (para moverla, se elimina y se crea en la otra orden). Ya
 * fuera del lock, una tarea NUEVA avisa por correo a su responsable.
 * @param {!Object} payload {tipo: 'OIS'|'OIP', idOrden, idTarea, tarea,
 *     idEmpleado, tipoResponsable, fechaInicio, fechaEntrega, estado, observacion,
 *     cc: [correos en copia del aviso, solo si es una tarea nueva]}
 * @return {!Object} Ver tg_writeResult_.
 */
function tg_saveTarea(payload) {
  payload = isPlainObject_(payload) ? payload : {};
  var tipo = String(payload.tipo || '').trim().toUpperCase();
  var idOrden = String(payload.idOrden || '').trim();
  var idTarea = String(payload.idTarea || '').trim();
  var spec = ord_spec_(tipo);
  if (!spec) return fail_('VALIDATION', 'Selecciona si la tarea es de una OIS o de una OIP.');
  if (!idOrden) return fail_('VALIDATION', 'Selecciona el código de la ' + tipo + '.');

  var validation = tg_validateTarea_(payload);
  if (validation.errors.length) return fail_('VALIDATION', 'La tarea tiene errores.', validation.errors);
  var clean = validation.clean;
  var esNueva = !idTarea;
  var orden = null;

  var resultado = tx_conLock_('tg_saveTarea', function () {
    orden = tg_ordenEditable_(spec, idOrden);

    var errResp = ord_resolverResponsables_([clean]);
    if (errResp) return fail_('NOT_FOUND', 'No existe el responsable ' + clean.idEmpleado + '.');

    var entrada;
    if (idTarea) {
      var fila = tg_filaTarea_(spec, idOrden, idTarea,
        'La tarea ya no existe en la ' + spec.tipo + ' ' + orden.codigo + ' (puede que la hayan eliminado desde otra vista). Actualiza el listado.');
      var diff = htar_diff_(fila.obj, clean);
      // Guardar sin cambios visibles conserva el sello anterior (y no deja historial).
      Object.assign(clean, diff.lineas.length ? htar_sello_() : { actualizadoPor: fila.obj.actualizadoPor, actualizadoEn: fila.obj.actualizadoEn });
      if (diff.escribir) spec.updateTareas(idOrden, [{ rowIndex: fila.rowIndex, idTarea: idTarea, tarea: clean }]);
      entrada = htar_entradaEdicion_(spec, orden, idOrden, idTarea, diff, clean.tarea, clean.estado);
    } else {
      if (spec.getTareaRows(idOrden).length >= spec.maxTareas) {
        return fail_('VALIDATION', 'La ' + spec.tipo + ' ' + orden.codigo + ' ya tiene el máximo de ' + spec.maxTareas + ' tareas.');
      }
      Object.assign(clean, htar_sello_());
      idTarea = spec.createTareas(idOrden, [clean])[0];
      entrada = htar_entrada_(spec, orden, idOrden, idTarea, clean.tarea, htar_acciones_().CREADA, htar_resumen_(clean, false));
    }
    htar_registrar_([entrada]);

    var ordenInfo = tg_refreshOrdenEstado_(spec, idOrden, orden);
    var dto = ord_tareaToDto_(Object.assign({ idTarea: idTarea }, clean));
    return tg_writeResult_(spec, idOrden, orden, ordenInfo, dto);
  }, { ids: { tipo: tipo, idOrden: idOrden, idTarea: idTarea }, payload: payload });

  // Fuera del lock: aviso al responsable de una tarea NUEVA (editar no avisa).
  if (esNueva && resultado.ok) ntf_tareasCreadas_(spec.tipo, orden, [clean], payload.cc);
  return resultado;
}

/**
 * Finaliza / reabre una tarea. Solo escribe la celda ESTADO de esa fila (no
 * reescribe la tarea completa), para no pisar una edición concurrente de su
 * texto u observaciones desde otra vista.
 * @param {string} tipo 'OIS' | 'OIP'
 * @param {string} idOrden
 * @param {string} idTarea
 * @param {string} estado CFG_().TAREA_ESTADO_FINALIZADA o _INICIAL.
 * @return {!Object} Ver tg_writeResult_.
 */
function tg_setTareaEstado(tipo, idOrden, idTarea, estado) {
  idOrden = String(idOrden || '').trim();
  idTarea = String(idTarea || '').trim();
  var spec = ord_spec_(tipo);
  if (!spec) return fail_('VALIDATION', 'Tipo de orden inválido.');
  if (!idOrden || !idTarea) return fail_('VALIDATION', 'Falta la orden o la tarea.');
  var cfg = CFG_();
  if (estado !== cfg.TAREA_ESTADO_FINALIZADA && estado !== cfg.TAREA_ESTADO_INICIAL) {
    return fail_('VALIDATION', 'Estado de tarea inválido.');
  }

  return tx_conLock_('tg_setTareaEstado', function () {
    var orden = tg_ordenEditable_(spec, idOrden);
    var fila = tg_filaTarea_(spec, idOrden, idTarea, 'La tarea ya no existe (puede que la hayan eliminado desde otra vista). Actualiza el listado.');
    var cambios = { estado: estado };
    if (htar_estado_(fila.obj.estado) !== estado) {
      // Solo un cambio real sella la tarea y deja historial (un doble clic que
      // repite el estado actual no).
      Object.assign(cambios, htar_sello_());
      repo_updateCells_(cfg.DB_SHEET_ID, spec.tabTareas, fila.rowIndex,
        { 'ESTADO': estado, 'ACTUALIZADO POR': cambios.actualizadoPor, 'ACTUALIZADO EN': cambios.actualizadoEn });
      var acc = htar_acciones_();
      htar_registrar_([htar_entrada_(spec, orden, idOrden, idTarea, fila.obj.tarea,
        estado === cfg.TAREA_ESTADO_FINALIZADA ? acc.FINALIZADA : acc.REABIERTA,
        'Estado: ' + htar_estado_(fila.obj.estado) + ' → ' + estado)]);
    }
    var ordenInfo = tg_refreshOrdenEstado_(spec, idOrden, orden);
    var dto = ord_tareaToDto_(Object.assign({}, fila.obj, cambios));
    return tg_writeResult_(spec, idOrden, orden, ordenInfo, dto);
  }, { ids: { tipo: spec.tipo, idOrden: idOrden, idTarea: idTarea, estado: estado } });
}

/**
 * Elimina físicamente una tarea de su hoja (TAREAS_OIS / TAREAS_OIP).
 * @param {string} tipo 'OIS' | 'OIP'
 * @param {string} idOrden
 * @param {string} idTarea
 * @return {!Object} Ver tg_writeResult_ (tarea: null).
 */
function tg_deleteTarea(tipo, idOrden, idTarea) {
  idOrden = String(idOrden || '').trim();
  idTarea = String(idTarea || '').trim();
  var spec = ord_spec_(tipo);
  if (!spec) return fail_('VALIDATION', 'Tipo de orden inválido.');
  if (!idOrden || !idTarea) return fail_('VALIDATION', 'Falta la orden o la tarea.');

  return tx_conLock_('tg_deleteTarea', function () {
    var orden = tg_ordenEditable_(spec, idOrden);
    var fila = tg_filaTarea_(spec, idOrden, idTarea, 'La tarea ya no existe (puede que la hayan eliminado desde otra vista). Actualiza el listado.');
    spec.deleteTareaRows([fila.rowIndex]);
    htar_registrar_([htar_entrada_(spec, orden, idOrden, idTarea, fila.obj.tarea, htar_acciones_().ELIMINADA, htar_resumen_(fila.obj, true))]);
    var ordenInfo = tg_refreshOrdenEstado_(spec, idOrden, orden);
    return tg_writeResult_(spec, idOrden, orden, ordenInfo, null);
  }, { ids: { tipo: spec.tipo, idOrden: idOrden, idTarea: idTarea } });
}
