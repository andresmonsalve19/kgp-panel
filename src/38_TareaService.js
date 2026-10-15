/**
 * Orquestación de "Gestionar tareas": una sola vista con TODAS las tareas de
 * todas las órdenes (TAREAS_OIS + TAREAS_OIP).
 *
 * No hay hoja nueva: las tareas siguen viviendo en TAREAS_OIS / TAREAS_OIP y
 * se escriben con los mismos repos (15_OisRepo.js / 16_OipRepo.js) que usan
 * "Gestionar OIS" y "Gestionar OIP". Por eso un cambio hecho aquí es el mismo
 * dato que ven esas vistas, y viceversa.
 *
 * A diferencia de "Gestionar OIS/OIP" (que reescriben la lista completa de
 * tareas de UNA orden al "Guardar cambios"), aquí cada acción toca UNA sola
 * tarea y se guarda al instante: crear/editar (tg_saveTarea), finalizar/
 * reabrir (tg_setTareaEstado, solo la celda ESTADO) y eliminar
 * (tg_deleteTarea). Cada una, dentro del lock, recalcula y guarda el ESTADO
 * derivado de la orden (mismas reglas que ois_deriveEstado_ /
 * oip_deriveEstado_), porque depende de sus tareas.
 *
 * Mismas reglas de negocio que las vistas de cada orden:
 *   - Una OIS Finalizada es de solo lectura (CONFLICT), igual que
 *     ois_updateOis. Una OIP Finalizada NO (CLAUDE.md §11.3).
 *   - Topes MAX_TAREAS (OIS) / MAX_TAREAS_OIP (OIP) por orden.
 *   - RESPONSABLE se resuelve en el servidor a partir de ID EMPLEADO.
 *
 * Los documentos de la orden (que sí incluyen sus tareas) se regeneran
 * después, desde el cliente y fuera del lock (api_regenerateOisDocument /
 * api_regenerateOipDocument) — mismo patrón de 2 fases del resto de la app.
 */

/**
 * Adaptador por tipo de orden: las tareas de OIS y OIP tienen exactamente la
 * misma forma, solo cambian la hoja, la FK y las reglas puntuales (tope,
 * cierre por Finalizada). Todo lo demás de este archivo es común a ambas.
 */
function tg_ctx_(tipo) {
  var cfg = CFG();
  if (tipo === 'OIS') {
    return {
      tipo: 'OIS',
      tab: cfg.TABS.TAREAS_OIS,
      max: cfg.LIMITS.MAX_TAREAS,
      cierraAlFinalizar: true,
      estadoFinalizada: cfg.OIS_ESTADO_FINALIZADA,
      findOrden: ois_findById_,
      updateOrden: ois_update_,
      deriveEstado: ois_deriveEstado_,
      getRows: tar_getRowsByOis_,
      createMany: tar_createMany_,
      updateMany: tar_updateMany_,
      deleteRows: tar_deleteRows_,
      tareaToDto: ois_tareaToDto_
    };
  }
  if (tipo === 'OIP') {
    return {
      tipo: 'OIP',
      tab: cfg.TABS.TAREAS_OIP,
      max: cfg.LIMITS.MAX_TAREAS_OIP,
      cierraAlFinalizar: false,
      estadoFinalizada: cfg.OIP_ESTADO_FINALIZADA,
      findOrden: oip_findById_,
      updateOrden: oip_update_,
      deriveEstado: oip_deriveEstado_,
      getRows: tarp_getRowsByOip_,
      createMany: tarp_createMany_,
      updateMany: tarp_updateMany_,
      deleteRows: tarp_deleteRows_,
      tareaToDto: oip_tareaToDto_
    };
  }
  return null;
}

// ---------------------------------------------------------------------
// Lectura: snapshot completo
// ---------------------------------------------------------------------

/**
 * Todo lo que necesita la vista en UN solo round-trip (CLAUDE.md §2):
 *   - tareas: todas las de OIS y OIP, ya con su orden, cotización y cliente.
 *   - ordenes: todas las OIS/OIP (para el filtro por orden y el selector de
 *     "Nueva tarea"), con su estado derivado y conteo de tareas.
 *   - empleados: para el filtro y el desplegable de responsable.
 *   - yo: ID EMPLEADO del usuario activo si se pudo resolver por correo
 *     (vacío si no: con executeAs USER_DEPLOYING, getActiveUser() suele
 *     venir vacío para usuarios externos al dominio).
 *   - hoy: fecha del servidor (CFG().TZ), para que "vencida" use el mismo
 *     criterio que el estado de las órdenes y no el reloj del navegador.
 *
 * Filtrado, orden y paginación ocurren en el cliente (el volumen de tareas es
 * moderado y así cada filtro es instantáneo, mismo criterio que "Gestión de
 * empleados"). Cacheado por dataVersion + día, igual que los listados de
 * OIS/OIP (el estado "Vencida" depende del día, no solo de las escrituras);
 * reutiliza ois_listAllDto_/oip_listAllDto_, así que si "Gestionar OIS/OIP"
 * ya se abrió en esta versión de datos, las órdenes salen de caché.
 */
function tg_snapshot() {
  var hoy = toISODate_(new Date());
  var key = 'tareas:snap:v' + dataVersion_() + ':' + hoy;
  var snap = cacheGetJson_(key);
  if (!snap) {
    snap = tg_buildSnapshot_(hoy);
    cachePutJson_(key, snap, CFG().CACHE_TTL.DASHBOARD_S);
  }
  // `yo` depende del usuario, no de los datos: nunca entra en la caché compartida.
  snap.yo = tg_idEmpleadoActivo_(snap.empleados);
  return ok_(snap);
}

function tg_buildSnapshot_(hoy) {
  var cfg = CFG();
  var ordenes = [];
  var ordenPorClave = {};

  function addOrdenes(tipo, list, idKey) {
    list.forEach(function (o) {
      var orden = {
        tipo: tipo,
        idOrden: o[idKey],
        codigo: o.codigo || '',
        codigoCotizacion: o.codigoCotizacion || '',
        clienteNombre: o.clienteNombre || '',
        estado: o.estado,
        fechaVencimiento: o.fechaVencimiento || '',
        numTareas: o.numTareas || 0,
        // Solo una OIS Finalizada queda cerrada; la OIP sigue editable (CLAUDE.md §11.3).
        cerrada: tipo === 'OIS' && o.estado === cfg.OIS_ESTADO_FINALIZADA
      };
      ordenes.push(orden);
      ordenPorClave[tipo + ':' + orden.idOrden] = orden;
    });
  }
  addOrdenes('OIS', ois_listAllDto_(hoy), 'idOis');
  addOrdenes('OIP', oip_listAllDto_(hoy), 'idOip');

  var tareas = [];
  function addTareas(tipo, table, rowToObj, fkKey, toDto) {
    table.rows.forEach(function (r) {
      var t = rowToObj(r);
      var orden = ordenPorClave[tipo + ':' + t[fkKey]];
      if (!orden || !t.idTarea) return; // tarea huérfana (orden borrada a mano): no se puede gestionar
      var dto = toDto(t);
      dto.tipo = tipo;
      dto.idOrden = orden.idOrden;
      // Orden de la fila en la hoja: las tareas nuevas se agregan al final,
      // así que sirve de desempate estable ("más recientes" dentro de una hoja).
      dto.fila = r.__row;
      tareas.push(dto);
    });
  }
  addTareas('OIS', tar_table_(), tar_rowToObj_, 'idOis', ois_tareaToDto_);
  addTareas('OIP', tarp_table_(), tarp_rowToObj_, 'idOip', oip_tareaToDto_);

  return {
    hoy: hoy,
    tareas: tareas,
    ordenes: ordenes,
    // Internos + terceros: el filtro de responsable y el popup de tarea.
    empleados: emp_listResponsables_().map(function (e) {
      return { idEmpleado: e.idEmpleado, nombre: e.nombre, cargo: e.cargo, cedula: e.cedula, tipoResponsable: e.tipoResponsable };
    }),
    limites: { OIS: cfg.LIMITS.MAX_TAREAS, OIP: cfg.LIMITS.MAX_TAREAS_OIP }
  };
}

/** ID EMPLEADO del usuario activo (comparando correos normalizados), o '' si no se puede resolver. */
function tg_idEmpleadoActivo_(empleadosSnap) {
  var correo = '';
  try { correo = Session.getActiveUser().getEmail() || ''; } catch (e) { correo = ''; }
  if (!correo) return '';
  try {
    var wanted = normText_(correo);
    var emp = emp_listEmpleados_().filter(function (e) { return normText_(e.correo) === wanted; })[0];
    return emp ? String(emp.idEmpleado) : '';
  } catch (e2) {
    return '';
  }
}

// ---------------------------------------------------------------------
// Escritura (una tarea a la vez, dentro del lock)
// ---------------------------------------------------------------------

/**
 * Valida una tarea suelta. Mismas reglas que cada elemento de tareas[] en
 * validateOisUpdatePayload_ / validateOipUpdatePayload_.
 */
function tg_validateTarea_(t) {
  var errors = [];
  var cfg = CFG();
  t = isPlainObject_(t) ? t : {};
  var tarea = cleanText_(t.tarea);
  if (!tarea) errors.push('La tarea es obligatoria.');
  var idEmpleado = String(t.idEmpleado || '').trim();
  if (!idEmpleado) errors.push('El responsable es obligatorio.');
  var fechaInicio = parseISODate_(t.fechaInicio);
  if (!fechaInicio) errors.push('Fecha de inicio inválida.');
  var fechaEntrega = parseISODate_(t.fechaEntrega);
  if (!fechaEntrega) errors.push('Fecha de entrega inválida.');
  if (fechaInicio && fechaEntrega && fechaEntrega.getTime() < fechaInicio.getTime()) {
    errors.push('La fecha de entrega no puede ser anterior a la de inicio.');
  }
  return {
    errors: errors,
    clean: {
      tarea: tarea,
      idEmpleado: idEmpleado,
      tipoResponsable: String(t.tipoResponsable || '').trim(),
      fechaInicio: fechaInicio,
      fechaEntrega: fechaEntrega,
      estado: t.estado === cfg.TAREA_ESTADO_FINALIZADA ? cfg.TAREA_ESTADO_FINALIZADA : cfg.TAREA_ESTADO_INICIAL,
      observacion: cleanMultiline_(t.observacion)
    }
  };
}

/** {ctx, orden} de una orden editable, o lanza AppError_ (NOT_FOUND / CONFLICT). Debe llamarse dentro del lock. */
function tg_ordenEditable_(ctx, idOrden) {
  var found = ctx.findOrden(idOrden);
  if (!found) throw new AppError_('NOT_FOUND', 'No existe la ' + ctx.tipo + ' ' + idOrden + '.');
  var orden = found.obj;
  // Mismo gate que ois_updateOis: lee el ESTADO guardado de la orden.
  if (ctx.cierraAlFinalizar && String(orden.estado) === ctx.estadoFinalizada) {
    throw new AppError_('CONFLICT', 'La ' + ctx.tipo + ' ' + orden.codigo + ' ya está finalizada y no se puede editar.');
  }
  return orden;
}

/**
 * Recalcula el ESTADO derivado de la orden a partir de sus tareas actuales y
 * lo guarda (ESTADO, ACTUALIZADO EN/POR). Devuelve {estado, cerrada}.
 */
function tg_refreshOrdenEstado_(ctx, idOrden, orden) {
  var tareas = ctx.getRows(idOrden).map(function (r) { return r.obj; });
  var estado = ctx.deriveEstado(tareas, qs_dateToISO_(orden.fechaVencimiento), toISODate_(new Date()));
  ctx.updateOrden(idOrden, { 'ESTADO': estado, 'ACTUALIZADO POR': emps_nombreUsuarioActivo_() });
  return { estado: estado, cerrada: ctx.cierraAlFinalizar && estado === ctx.estadoFinalizada };
}

/** Respuesta común de las 3 escrituras: lo que el cliente necesita para actualizar su fila y su orden sin releer todo. */
function tg_writeResult_(ctx, idOrden, orden, ordenInfo, tareaDto) {
  return ok_({
    tipo: ctx.tipo,
    idOrden: idOrden,
    codigoOrden: orden.codigo,
    ordenEstado: ordenInfo.estado,
    ordenCerrada: ordenInfo.cerrada,
    tarea: tareaDto || null
  });
}

/**
 * Crea (idTarea vacío) o edita una tarea. payload: {tipo: 'OIS'|'OIP',
 * idOrden, idTarea, tarea, idEmpleado, fechaInicio, fechaEntrega, estado,
 * observacion}. La orden de una tarea existente no se puede cambiar (para
 * moverla, se elimina y se crea en la otra orden).
 */
function tg_saveTarea(payload) {
  payload = isPlainObject_(payload) ? payload : {};
  var tipo = String(payload.tipo || '').trim().toUpperCase();
  var idOrden = String(payload.idOrden || '').trim();
  var idTarea = String(payload.idTarea || '').trim();
  var ctx = tg_ctx_(tipo);
  if (!ctx) return fail_('VALIDATION', 'Selecciona si la tarea es de una OIS o de una OIP.');
  if (!idOrden) return fail_('VALIDATION', 'Selecciona el código de la ' + tipo + '.');

  var validation = tg_validateTarea_(payload);
  if (validation.errors.length) return fail_('VALIDATION', 'La tarea tiene errores.', validation.errors);
  var clean = validation.clean;

  var esNueva = !idTarea;
  var resultado;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    var orden = tg_ordenEditable_(ctx, idOrden);

    // Interno (PERSONAL_KGP) o tercero (PERSONAL_TERCEROS), ver emp_buscarResponsable_.
    var emp = emp_buscarResponsable_(emp_listResponsables_(), clean.idEmpleado, clean.tipoResponsable);
    if (!emp) return fail_('NOT_FOUND', 'No existe el responsable ' + clean.idEmpleado + '.');
    clean.responsable = emp.nombre;
    clean.tipoResponsable = emp.tipoResponsable;

    var filas = ctx.getRows(idOrden);
    if (idTarea) {
      var fila = filas.filter(function (f) { return String(f.obj.idTarea) === idTarea; })[0];
      if (!fila) return fail_('NOT_FOUND', 'La tarea ya no existe en la ' + ctx.tipo + ' ' + orden.codigo + ' (puede que la hayan eliminado desde otra vista). Actualiza el listado.');
      ctx.updateMany(idOrden, [{ rowIndex: fila.rowIndex, idTarea: idTarea, tarea: clean }]);
    } else {
      if (filas.length >= ctx.max) {
        return fail_('VALIDATION', 'La ' + ctx.tipo + ' ' + orden.codigo + ' ya tiene el máximo de ' + ctx.max + ' tareas.');
      }
      idTarea = ctx.createMany(idOrden, [clean])[0];
    }

    var ordenInfo = tg_refreshOrdenEstado_(ctx, idOrden, orden);
    SpreadsheetApp.flush();
    bumpDataVersion_();

    var dto = ctx.tareaToDto(Object.assign({ idTarea: idTarea }, clean));
    resultado = tg_writeResult_(ctx, idOrden, orden, ordenInfo, dto);
  } catch (e) {
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    // Los rechazos esperados (orden cerrada, inexistente) no son errores del sistema.
    if (['CONFLICT', 'NOT_FOUND', 'VALIDATION'].indexOf(code) === -1) logError_('tg_saveTarea', null, { tipo: tipo, idOrden: idOrden, idTarea: idTarea }, payload, e);
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }

  // Ya fuera del lock: aviso por correo al responsable de una tarea NUEVA
  // (editar una existente no avisa). Nunca lanza (39_NotifyService.js).
  if (esNueva) ntf_tareasCreadas_(ctx.tipo, orden, [clean]);
  return resultado;
}

/**
 * Finalizar / reabrir una tarea desde la tabla. Solo escribe la celda ESTADO
 * de esa fila (no reescribe la tarea completa), para no pisar una edición
 * concurrente de su texto u observaciones desde otra vista.
 */
function tg_setTareaEstado(tipo, idOrden, idTarea, estado) {
  tipo = String(tipo || '').trim().toUpperCase();
  idOrden = String(idOrden || '').trim();
  idTarea = String(idTarea || '').trim();
  var ctx = tg_ctx_(tipo);
  if (!ctx) return fail_('VALIDATION', 'Tipo de orden inválido.');
  if (!idOrden || !idTarea) return fail_('VALIDATION', 'Falta la orden o la tarea.');
  var cfg = CFG();
  if (estado !== cfg.TAREA_ESTADO_FINALIZADA && estado !== cfg.TAREA_ESTADO_INICIAL) {
    return fail_('VALIDATION', 'Estado de tarea inválido.');
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    var orden = tg_ordenEditable_(ctx, idOrden);
    var fila = ctx.getRows(idOrden).filter(function (f) { return String(f.obj.idTarea) === idTarea; })[0];
    if (!fila) return fail_('NOT_FOUND', 'La tarea ya no existe (puede que la hayan eliminado desde otra vista). Actualiza el listado.');

    repo_updateCells_(cfg.DB_SHEET_ID, ctx.tab, fila.rowIndex, { 'ESTADO': estado });

    var ordenInfo = tg_refreshOrdenEstado_(ctx, idOrden, orden);
    SpreadsheetApp.flush();
    bumpDataVersion_();

    var dto = ctx.tareaToDto(Object.assign({}, fila.obj, { estado: estado }));
    return tg_writeResult_(ctx, idOrden, orden, ordenInfo, dto);
  } catch (e) {
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    // Los rechazos esperados (orden cerrada, inexistente) no son errores del sistema.
    if (['CONFLICT', 'NOT_FOUND', 'VALIDATION'].indexOf(code) === -1) logError_('tg_setTareaEstado', null, { tipo: tipo, idOrden: idOrden, idTarea: idTarea, estado: estado }, null, e);
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/** Elimina físicamente una tarea de su hoja (TAREAS_OIS / TAREAS_OIP). */
function tg_deleteTarea(tipo, idOrden, idTarea) {
  tipo = String(tipo || '').trim().toUpperCase();
  idOrden = String(idOrden || '').trim();
  idTarea = String(idTarea || '').trim();
  var ctx = tg_ctx_(tipo);
  if (!ctx) return fail_('VALIDATION', 'Tipo de orden inválido.');
  if (!idOrden || !idTarea) return fail_('VALIDATION', 'Falta la orden o la tarea.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    var orden = tg_ordenEditable_(ctx, idOrden);
    var fila = ctx.getRows(idOrden).filter(function (f) { return String(f.obj.idTarea) === idTarea; })[0];
    if (!fila) return fail_('NOT_FOUND', 'La tarea ya no existe (puede que la hayan eliminado desde otra vista). Actualiza el listado.');

    ctx.deleteRows([fila.rowIndex]);

    var ordenInfo = tg_refreshOrdenEstado_(ctx, idOrden, orden);
    SpreadsheetApp.flush();
    bumpDataVersion_();

    return tg_writeResult_(ctx, idOrden, orden, ordenInfo, null);
  } catch (e) {
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    // Los rechazos esperados (orden cerrada, inexistente) no son errores del sistema.
    if (['CONFLICT', 'NOT_FOUND', 'VALIDATION'].indexOf(code) === -1) logError_('tg_deleteTarea', null, { tipo: tipo, idOrden: idOrden, idTarea: idTarea }, null, e);
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}
