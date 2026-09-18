/**
 * Orquestación de la ORDEN INTERNA DE SERVICIO (OIS).
 *
 * Una OIS nace de UNA cotización al aprobar su garantía (popup "Garantía
 * aprobada" -> "Crear OIS" en Gestionar cotización). Una cotización produce a
 * lo sumo una OIS. La OIS NO duplica los datos de la cotización: cliente,
 * solicitante, establecimiento y servicios se leen de la cotización padre por
 * ID COTIZACION, y "Guardar cambios" en Gestionar OIS los reescribe allí
 * mismo (qs_applyQuotationUpdate_ con permitirDecidida). Lo único propio de
 * la OIS son sus columnas en la hoja OIS (plazo, vencimiento, estado,
 * trazabilidad) y sus tareas (TAREAS_OIS).
 *
 * Mismo patrón de 2 fases que la cotización: primero la BD dentro del script
 * lock (corto, sin generar documentos), luego los documentos desde el cliente
 * (api_generateOisDocument / api_regenerateDocument), fuera del lock.
 */

// ---------------------------------------------------------------------
// Estado derivado
// ---------------------------------------------------------------------

/**
 * CFG() memoizado por ejecución: CFG() lee ScriptProperties en cada llamada
 * y el listado deriva el estado de CADA OIS (mismo motivo que el memo de
 * qs_normEstado_ en 30_QuoteService.js).
 */
function ois_cfg_() {
  var memo = repo_memo_();
  return memo.__cfgOis || (memo.__cfgOis = CFG());
}

/**
 * ESTADO de una OIS a partir de sus tareas y su fecha de vencimiento.
 * Regla confirmada con el usuario — "Finalizada" gana:
 *   1. Hay al menos una tarea y TODAS están finalizadas -> Finalizada.
 *   2. Si no, y hoy ya pasó la FECHA VENCIMIENTO        -> Vencida.
 *   3. Si no                                            -> En curso.
 * "Ya pasó" = hoy > fecha de vencimiento (mismo criterio que
 * vencidaSinDecision del Dashboard: el propio día de vencimiento aún no está
 * vencido). Sin tareas nunca es Finalizada (no hay nada que cerrar).
 *
 * tareas: [{estado}], fechaVencISO: 'yyyy-MM-dd' o '', hoyISO: 'yyyy-MM-dd'.
 */
function ois_deriveEstado_(tareas, fechaVencISO, hoyISO) {
  var cfg = ois_cfg_();
  if (tareas.length && tareas.every(function (t) { return t.estado === cfg.TAREA_ESTADO_FINALIZADA; })) {
    return cfg.OIS_ESTADO_FINALIZADA;
  }
  if (fechaVencISO && hoyISO > fechaVencISO) return cfg.OIS_ESTADO_VENCIDA;
  return cfg.OIS_ESTADO_INICIAL;
}

/** Tarea de la hoja -> DTO para la UI (fechas en ISO). */
function ois_tareaToDto_(t) {
  return {
    idTarea: t.idTarea,
    tarea: t.tarea,
    responsable: t.responsable,
    idEmpleado: t.idEmpleado,
    fechaInicio: qs_dateToISO_(t.fechaInicio),
    fechaEntrega: qs_dateToISO_(t.fechaEntrega),
    estado: t.estado === ois_cfg_().TAREA_ESTADO_FINALIZADA ? ois_cfg_().TAREA_ESTADO_FINALIZADA : ois_cfg_().TAREA_ESTADO_INICIAL,
    observacion: t.observacion
  };
}

/** OIS de la hoja + sus tareas (DTO) -> DTO para la UI, con el estado ya derivado para hoy. */
function ois_toDto_(o, tareasDto, hoyISO) {
  var fechaVenc = qs_dateToISO_(o.fechaVencimiento);
  return {
    idOis: o.idOis,
    idCotizacion: o.idCotizacion,
    codigo: o.codigo,
    fechaElaboracion: qs_dateToISO_(o.fechaElaboracion),
    plazo: o.plazo === '' || o.plazo == null ? '' : Number(o.plazo),
    fechaVencimiento: fechaVenc,
    estado: ois_deriveEstado_(tareasDto, fechaVenc, hoyISO),
    urlDocumento: o.urlDocumento,
    docEstado: o.docEstado,
    docFileId: o.docFileId,
    actualizadoEn: o.actualizadoEn ? qs_dateToISO_(o.actualizadoEn) : '',
    elaboradoPor: o.elaboradoPor,
    actualizadoPor: o.actualizadoPor
  };
}

/**
 * Nombre del empleado del usuario activo (PERSONAL_KGP, buscado por correo)
 * para ELABORADO POR / ACTUALIZADO POR. '' si el correo no corresponde a
 * ningún empleado (no bloquea la operación, mismo criterio que la cotización).
 */
function ois_nombreUsuarioActivo_() {
  var correo = '';
  try { correo = Session.getActiveUser().getEmail() || ''; } catch (e) { correo = ''; }
  if (!correo) return '';
  try {
    var emp = emp_findByCorreo_(correo);
    return emp ? emp.nombre : '';
  } catch (e2) {
    return '';
  }
}

// ---------------------------------------------------------------------
// Aprobar la garantía + crear la OIS (una sola transacción)
// ---------------------------------------------------------------------

/**
 * Popup "Garantía aprobada" -> "Crear OIS". Dentro de UN mismo lock:
 *   1. guarda el formulario de la cotización con ESTADO = Aprobada (mismo
 *      cuerpo que qs_updateQuotation, ver qs_applyQuotationUpdate_), y
 *   2. crea la fila de la OIS (ID, consecutivo OIS-KGP-NNN-YY, fechas).
 * Así nunca queda una cotización Aprobada sin su OIS ni una OIS huérfana.
 *
 * payload: el mismo del "Guardar cambios" de Gestionar cotización (estado se
 * fuerza a Aprobada). requestId: UUID del cliente, idempotencia (un
 * reintento tras un timeout devuelve la OIS ya creada en vez de fallar).
 *
 * No genera documentos: el cliente regenera el de la cotización y genera el
 * de la OIS después, fuera del lock.
 */
function ois_aprobarConOis(idCotizacion, payload, requestId) {
  idCotizacion = String(idCotizacion || '').trim();
  requestId = String(requestId || '').trim();
  if (!idCotizacion) return fail_('VALIDATION', 'Falta idCotizacion.');
  if (!requestId) return fail_('VALIDATION', 'Falta requestId (identificador de solicitud).');

  var early = ois_checkIdempotency_(requestId);
  if (early) return early;

  var validation = validateUpdatePayload_(Object.assign({}, payload || {}, { estado: CFG().ESTADO_APROBADA }));
  if (validation.errors.length) {
    return fail_('VALIDATION', 'El formulario tiene errores.', validation.errors);
  }
  var clean = validation.clean;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    var early2 = ois_checkIdempotency_(requestId);
    if (early2) return early2;

    // Validar el esquema de OIS/TAREAS_OIS ANTES de escribir nada en la
    // cotización: si faltan columnas, fallar sin dejarla Aprobada.
    ois_table_();
    tar_table_();

    var previa = ois_findByCotizacion_(idCotizacion);
    if (previa) {
      return fail_('CONFLICT', 'Esta cotización ya tiene la OIS ' + previa.codigo + '.');
    }

    var res = qs_applyQuotationUpdate_(idCotizacion, clean, {});
    if (!res.ok) return res;

    var fechaElaboracion = new Date();
    var codigo = ois_codeReserve_(fechaElaboracion);
    var idOis = id_new_('OIS');
    // PLAZO inicial = el de la cotización (el usuario lo ajusta después en
    // Gestionar OIS). FECHA VENCIMIENTO = FECHA ELABORACION + PLAZO.
    var plazo = clean.plazo;

    ois_create_({
      idOis: idOis,
      idCotizacion: idCotizacion,
      fechaElaboracion: fechaElaboracion,
      codigo: codigo,
      plazo: plazo,
      fechaVencimiento: addDays_(fechaElaboracion, plazo),
      estado: CFG().OIS_ESTADO_INICIAL,
      requestId: requestId,
      elaboradoPor: ois_nombreUsuarioActivo_()
    });

    SpreadsheetApp.flush();
    bumpDataVersion_();

    var response = ok_({ cotizacion: res.data, idOis: idOis, codigoOis: codigo });
    cachePutJson_('idem:ois:' + requestId, response, 21600);
    return response;
  } catch (e) {
    logError_('ois_aprobarConOis', requestId, { idCotizacion: idCotizacion }, payload, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

function ois_checkIdempotency_(requestId) {
  if (!requestId) return null;
  var cached = cacheGetJson_('idem:ois:' + requestId);
  if (cached) return cached;
  var found = ois_findByRequestId_(requestId);
  if (found) {
    return ok_({ cotizacion: null, idOis: found.idOis, codigoOis: found.codigo, repetida: true });
  }
  return null;
}

// ---------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------

/**
 * Detalle completo de una OIS para "Gestionar OIS": la OIS, sus tareas, y
 * TODO el detalle de la cotización padre (qs_getCotizacion: cliente,
 * solicitante, establecimiento, servicios) — la vista pinta los datos
 * compartidos desde ahí.
 */
function ois_getOis(idOis) {
  idOis = String(idOis || '').trim();
  if (!idOis) return fail_('VALIDATION', 'Falta idOis.');
  var found = ois_findById_(idOis);
  if (!found) return fail_('NOT_FOUND', 'No existe la OIS ' + idOis + '.');

  var cot = qs_getCotizacion(found.obj.idCotizacion);
  if (!cot.ok) return cot;

  var tareas = tar_getByOis_(idOis).map(ois_tareaToDto_);
  var ois = ois_toDto_(found.obj, tareas, toISODate_(new Date()));
  ois.codigoCotizacion = cot.data.cotizacion.codigo;

  return ok_({
    ois: ois,
    tareas: tareas,
    cotizacion: cot.data.cotizacion,
    servicios: cot.data.servicios,
    cliente: cot.data.cliente,
    solicitante: cot.data.solicitante,
    establecimiento: cot.data.establecimiento
  });
}

/**
 * Listado de "Gestionar OIS": filtra por año/estado/texto, ordena y pagina
 * en el servidor (mismo contrato de params/respuesta que api_getDashboard,
 * para que la vista calque la de Gestionar cotización).
 *
 * Cacheado por dataVersion + fecha de hoy: el ESTADO "Vencida" depende del
 * día, no solo de las escrituras, así que la clave cambia sola a medianoche.
 */
function ois_listOis(params) {
  params = params || {};
  var hoy = toISODate_(new Date());
  var filters = {
    anio: params.anio ? Number(params.anio) : null,
    estado: params.estado || null,
    q: normText_(params.q || ''),
    page: clamp_(params.page || 1, 1, 100000),
    pageSize: clamp_(params.pageSize || 20, 1, 200),
    sortBy: ['codigo', 'codigoCotizacion', 'cliente', 'fechaElaboracion', 'fechaVencimiento', 'estado', 'tareas'].indexOf(params.sortBy) !== -1 ? params.sortBy : 'codigo',
    sortDir: params.sortDir === 'desc' ? 'desc' : 'asc'
  };

  var all = ois_listAllDto_(hoy);

  var filtered = all.filter(function (o) {
    if (filters.anio && Number(String(o.fechaElaboracion).slice(0, 4)) !== filters.anio) return false;
    if (filters.estado && o.estado !== filters.estado) return false;
    if (filters.q) {
      var hay = normText_(o.codigo + ' ' + o.codigoCotizacion + ' ' + o.clienteNombre);
      if (hay.indexOf(filters.q) === -1) return false;
    }
    return true;
  });

  var dir = filters.sortDir === 'desc' ? -1 : 1;
  filtered.sort(function (a, b) {
    var va, vb;
    switch (filters.sortBy) {
      case 'tareas': return dir * ((a.numTareas || 0) - (b.numTareas || 0));
      case 'cliente': va = a.clienteNombre; vb = b.clienteNombre; break;
      default: va = a[filters.sortBy]; vb = b[filters.sortBy];
    }
    return dir * String(va || '').localeCompare(String(vb || ''));
  });

  var start = (filters.page - 1) * filters.pageSize;
  return ok_({
    rows: filtered.slice(start, start + filters.pageSize),
    total: filtered.length,
    page: filters.page,
    pageSize: filters.pageSize
  });
}

/** Todas las OIS con cliente, código de cotización, conteo de tareas y estado derivado. 3 lecturas de hoja como máximo, memo por versión+día. */
function ois_listAllDto_(hoy) {
  var key = 'ois:list:v' + dataVersion_() + ':' + hoy;
  var cached = cacheGetJson_(key);
  if (cached) return cached;

  var tareasPorOis = {};
  tar_table_().rows.forEach(function (r) {
    var t = tar_rowToObj_(r);
    (tareasPorOis[t.idOis] = tareasPorOis[t.idOis] || []).push({ estado: t.estado });
  });

  var cotPorId = {};
  qr_tableCotizaciones_().rows.forEach(function (r) {
    var id = r[normText_('ID COTIZACION')];
    if (id && !cotPorId[id]) cotPorId[id] = { codigo: r[normText_('CODIGO')], idCliente: r[normText_('ID CLIENTE')] };
  });

  var clientePorId = ds_indexarPorId_(cli_table_(), 'ID CLIENTE', function (r) { return r[normText_('RAZON SOCIAL')]; });

  var list = ois_listAll_().map(function (o) {
    var tareas = tareasPorOis[o.idOis] || [];
    var dto = ois_toDto_(o, tareas, hoy);
    var cot = cotPorId[o.idCotizacion] || {};
    dto.codigoCotizacion = cot.codigo || '';
    dto.clienteNombre = (cot.idCliente && clientePorId[cot.idCliente]) || '';
    dto.numTareas = tareas.length;
    dto.numTareasFinalizadas = tareas.filter(function (t) { return t.estado === ois_cfg_().TAREA_ESTADO_FINALIZADA; }).length;
    return dto;
  });

  cachePutJson_(key, list, CFG().CACHE_TTL.DASHBOARD_S);
  return list;
}

// ---------------------------------------------------------------------
// Guardar cambios de una OIS
// ---------------------------------------------------------------------

/**
 * Valida el payload de "Guardar cambios" de Gestionar OIS:
 *   {plazo, cliente:{idCliente}, solicitante:{idContacto},
 *    establecimiento:{idEstablecimiento},
 *    servicios:[{idServicio, tipo, codigoUnspsc, descripcion, actividades[]}],
 *    tareas:[{idTarea|null, tarea, idEmpleado, fechaInicio, fechaEntrega,
 *             estado, observacion}],
 *    entidadesEditadas: bool}
 * Los servicios NO traen tarifas (la vista de OIS no las muestra): se
 * conservan las de la cotización en ois_updateOis. Tareas: RESPONSABLE e
 * ID EMPLEADO se resuelven en el servidor a partir de idEmpleado.
 */
function validateOisUpdatePayload_(payload) {
  var errors = [];
  if (!isPlainObject_(payload)) return { clean: null, errors: ['El payload de la OIS es inválido.'] };
  var cfg = CFG();

  var plazo = Math.trunc(Number(payload.plazo));
  if (!plazo || isNaN(plazo) || plazo < 1 || plazo > cfg.LIMITS.MAX_PLAZO_DIAS) {
    errors.push('plazo debe ser un entero entre 1 y ' + cfg.LIMITS.MAX_PLAZO_DIAS + ' días.');
  }

  var idCliente = String((payload.cliente && payload.cliente.idCliente) || '').trim();
  if (!idCliente) errors.push('cliente es obligatorio.');
  var idSolicitante = String((payload.solicitante && payload.solicitante.idContacto) || '').trim();
  if (!idSolicitante) errors.push('solicitante es obligatorio.');
  var idEstablecimiento = String((payload.establecimiento && payload.establecimiento.idEstablecimiento) || '').trim();
  if (!idEstablecimiento) errors.push('establecimiento es obligatorio.');

  var tareasRaw = Array.isArray(payload.tareas) ? payload.tareas : [];
  if (tareasRaw.length > cfg.LIMITS.MAX_TAREAS) {
    errors.push('No se permiten más de ' + cfg.LIMITS.MAX_TAREAS + ' tareas por OIS.');
  }
  var tareas = tareasRaw.slice(0, cfg.LIMITS.MAX_TAREAS).map(function (t, idx) {
    t = isPlainObject_(t) ? t : {};
    var label = 'tareas[' + (idx + 1) + ']';
    var tarea = cleanText_(t.tarea);
    if (!tarea) errors.push(label + ': la tarea es obligatoria.');
    var idEmpleado = String(t.idEmpleado || '').trim();
    if (!idEmpleado) errors.push(label + ': el responsable es obligatorio.');
    var fechaInicio = parseISODate_(t.fechaInicio);
    if (!fechaInicio) errors.push(label + ': fecha de inicio inválida.');
    var fechaEntrega = parseISODate_(t.fechaEntrega);
    if (!fechaEntrega) errors.push(label + ': fecha de entrega inválida.');
    if (fechaInicio && fechaEntrega && fechaEntrega.getTime() < fechaInicio.getTime()) {
      errors.push(label + ': la fecha de entrega no puede ser anterior a la de inicio.');
    }
    var estado = t.estado === cfg.TAREA_ESTADO_FINALIZADA ? cfg.TAREA_ESTADO_FINALIZADA : cfg.TAREA_ESTADO_INICIAL;
    return {
      idTarea: String(t.idTarea || '').trim() || null,
      tarea: tarea,
      idEmpleado: idEmpleado,
      fechaInicio: fechaInicio,
      fechaEntrega: fechaEntrega,
      estado: estado,
      observacion: cleanMultiline_(t.observacion)
    };
  });

  // Servicios: se reutiliza la validación de la cotización (tipo en el
  // catálogo, descripción obligatoria, máx. 10). Sin tarifas: el llamador
  // las rellena con las ya guardadas antes de escribir.
  var serviciosRaw = (Array.isArray(payload.servicios) ? payload.servicios : []).map(function (s) {
    s = isPlainObject_(s) ? s : {};
    return { idServicio: s.idServicio, tipo: s.tipo, codigoUnspsc: s.codigoUnspsc, descripcion: s.descripcion, actividades: s.actividades };
  });
  var servicios = validateServiciosArray_(serviciosRaw, errors);

  if (errors.length) return { clean: null, errors: errors };
  return {
    clean: {
      plazo: plazo,
      idCliente: idCliente,
      idSolicitante: idSolicitante,
      idEstablecimiento: idEstablecimiento,
      servicios: servicios,
      tareas: tareas,
      entidadesEditadas: payload.entidadesEditadas === true
    },
    errors: []
  };
}

/**
 * "Guardar cambios" de Gestionar OIS. Dentro de UN lock:
 *   1. Si cambió algo compartido con la cotización (cliente/solicitante/
 *      establecimiento, servicios, o se editó un cliente/contacto/
 *      establecimiento desde el modal), reescribe la cotización padre con
 *      qs_applyQuotationUpdate_ (permitirDecidida: ya está Aprobada). El
 *      plazo/descripción/tiempo de entrega/asesor de la COTIZACIÓN y las
 *      tarifas de sus servicios se conservan tal cual (la vista de OIS no
 *      los muestra). Si solo cambiaron tareas/plazo de la OIS, la cotización
 *      NO se toca (nota 3 del usuario: evitar procesos innecesarios).
 *   2. Tareas: actualiza las que siguen, borra las quitadas, crea las nuevas.
 *   3. Fila de la OIS: PLAZO, FECHA VENCIMIENTO, ESTADO (derivado),
 *      ACTUALIZADO EN/POR.
 * Devuelve {cotizacionCambio}: el cliente regenera el documento de la
 * cotización solo si es true; el de la OIS siempre.
 *
 * Una OIS ya Finalizada queda cerrada (solo lectura): CONFLICT.
 */
function ois_updateOis(idOis, payload) {
  idOis = String(idOis || '').trim();
  if (!idOis) return fail_('VALIDATION', 'Falta idOis.');

  var validation = validateOisUpdatePayload_(payload);
  if (validation.errors.length) return fail_('VALIDATION', 'El formulario tiene errores.', validation.errors);
  var clean = validation.clean;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    var cfg = CFG();
    var found = ois_findById_(idOis);
    if (!found) return fail_('NOT_FOUND', 'No existe la OIS ' + idOis + '.');
    var ois = found.obj;
    if (String(ois.estado) === cfg.OIS_ESTADO_FINALIZADA) {
      return fail_('CONFLICT', 'La OIS ' + ois.codigo + ' ya está finalizada y no se puede editar.');
    }

    // Responsables: cada idEmpleado debe existir; RESPONSABLE = su nombre.
    var empleadosPorId = {};
    emp_listEmpleados_().forEach(function (e) { empleadosPorId[e.idEmpleado] = e; });
    for (var i = 0; i < clean.tareas.length; i++) {
      var emp = empleadosPorId[clean.tareas[i].idEmpleado];
      if (!emp) return fail_('NOT_FOUND', 'Tarea ' + (i + 1) + ': no existe el empleado ' + clean.tareas[i].idEmpleado + '.');
      clean.tareas[i].responsable = emp.nombre;
    }

    // ---- 1. Cotización padre (solo si cambió algo compartido) ----
    var cot = qs_getCotizacion(ois.idCotizacion);
    if (!cot.ok) return cot;
    var c = cot.data.cotizacion;
    var serviciosActuales = cot.data.servicios || [];

    var cotizacionCambio = clean.entidadesEditadas ||
      clean.idCliente !== c.idCliente ||
      clean.idSolicitante !== c.idSolicitante ||
      clean.idEstablecimiento !== c.idEstablecimiento ||
      ois_serviciosFirma_(clean.servicios) !== ois_serviciosFirma_(serviciosActuales);

    if (cotizacionCambio) {
      var tarifasPorId = {};
      serviciosActuales.forEach(function (s) { tarifasPorId[s.idServicio] = s; });
      var cleanCot = {
        plazo: Number(c.plazo) || 1,
        descripcion: c.descripcion,
        estado: '',
        idCliente: clean.idCliente,
        idSolicitante: clean.idSolicitante,
        idEstablecimiento: clean.idEstablecimiento,
        asesorComercial: c.asesorComercial || '',
        tiempoEntrega: c.tiempoEntrega || '',
        servicios: clean.servicios.map(function (s) {
          var prev = (s.idServicio && tarifasPorId[s.idServicio]) || {};
          return Object.assign({}, s, {
            tarifa: prev.tarifa === undefined ? '' : prev.tarifa,
            cantidad: prev.cantidad === undefined ? '' : prev.cantidad,
            total: prev.total === undefined ? '' : prev.total,
            observaciones: prev.observaciones || ''
          });
        })
      };
      var resCot = qs_applyQuotationUpdate_(ois.idCotizacion, cleanCot, { permitirDecidida: true });
      if (!resCot.ok) return resCot;
    }

    // ---- 2. Tareas: actualizar -> borrar -> crear (en ese orden, para
    // que los rowIndex de las actualizaciones sigan siendo válidos) ----
    var filasActuales = tar_getRowsByOis_(idOis);
    var filaPorId = {};
    filasActuales.forEach(function (f) { filaPorId[f.obj.idTarea] = f; });
    var enviadas = {};
    var nuevas = [];
    var actualizaciones = [];
    clean.tareas.forEach(function (t) {
      if (t.idTarea && filaPorId[t.idTarea]) {
        enviadas[t.idTarea] = true;
        actualizaciones.push({ rowIndex: filaPorId[t.idTarea].rowIndex, idTarea: t.idTarea, tarea: t });
      } else {
        nuevas.push(t);
      }
    });
    tar_updateMany_(idOis, actualizaciones);
    var aBorrar = filasActuales
      .filter(function (f) { return !enviadas[f.obj.idTarea]; })
      .map(function (f) { return f.rowIndex; });
    tar_deleteRows_(aBorrar);
    tar_createMany_(idOis, nuevas);

    // ---- 3. Fila de la OIS ----
    var fechaElab = Object.prototype.toString.call(ois.fechaElaboracion) === '[object Date]'
      ? ois.fechaElaboracion
      : parseISODate_(ois.fechaElaboracion);
    var fechaVenc = fechaElab ? addDays_(fechaElab, clean.plazo) : '';
    var estado = ois_deriveEstado_(clean.tareas, fechaVenc ? toISODate_(fechaVenc) : '', toISODate_(new Date()));
    ois_update_(idOis, {
      'PLAZO': clean.plazo,
      'FECHA VENCIMIENTO': fechaVenc,
      'ESTADO': estado,
      'ACTUALIZADO POR': ois_nombreUsuarioActivo_()
    });

    SpreadsheetApp.flush();
    bumpDataVersion_();

    return ok_({
      idOis: idOis,
      codigo: ois.codigo,
      estado: estado,
      fechaVencimiento: fechaVenc ? toISODate_(fechaVenc) : '',
      cotizacionCambio: !!cotizacionCambio,
      tareas: tar_getByOis_(idOis).map(ois_tareaToDto_)
    });
  } catch (e) {
    logError_('ois_updateOis', null, { idOis: idOis }, payload, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/**
 * Firma comparable de una lista de servicios (orden + id + tipo + UNSPSC +
 * descripción + actividades SIN el prefijo "N.M " con que se guardan en la
 * hoja). Sirve para decidir si la OIS cambió algo de los servicios de la
 * cotización. Tarifas excluidas a propósito (la OIS no las edita).
 */
function ois_serviciosFirma_(servicios) {
  return JSON.stringify((servicios || []).map(function (s) {
    return [
      s.idServicio || '',
      cleanText_(s.tipo),
      cleanText_(s.codigoUnspsc),
      cleanText_(s.descripcion),
      (s.actividades || []).map(function (a) { return cleanText_(doc_stripActividadPrefix_(a)); }).filter(function (a) { return a; })
    ];
  }));
}
