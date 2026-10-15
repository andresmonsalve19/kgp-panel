/**
 * Orquestación de la OIP.
 *
 * Una OIP nace de UNA cotización al aprobar su garantía (popup "Garantía
 * aprobada" -> "OIP" en Gestionar cotización). Una cotización produce una OIS
 * O una OIP, nunca las dos: el popup es una elección única. La OIP NO duplica
 * los datos de la cotización — cliente, solicitante, establecimiento y
 * servicios se leen de la cotización padre por ID COTIZACION, y "Guardar
 * cambios" en Gestionar OIP los reescribe allí mismo
 * (qs_applyQuotationUpdate_ con permitirDecidida). Lo propio de la OIP son
 * sus columnas en la hoja OIP (plazo, vencimiento, estado, trazabilidad), sus
 * tareas (TAREAS_OIP) y su facturación mensual (OIP_FACTURACION).
 *
 * Mismo patrón de 2 fases que la cotización y la OIS: primero la BD dentro
 * del script lock (corto, sin generar documentos), luego los documentos desde
 * el cliente (api_generateOipDocument / api_regenerateOipDocument), fuera del
 * lock.
 *
 * Diferencias deliberadas respecto a la OIS (todas confirmadas con el
 * usuario):
 *   1. PLAZO nace en CFG().OIP_PLAZO_DEFAULT (365 días), no hereda el de la
 *      cotización.
 *   2. El consecutivo NO reinicia cada año (ver oip_codeReserve_, 20_Ids.js).
 *   3. Una OIP Finalizada NO queda de solo lectura: sigue facturando ~1 año.
 *   4. Las tareas no tienen un bloque fijo en la plantilla (se insertan filas)
 *      y la vista las agrupa por mes de FECHA ENTREGA.
 *   5. La facturación se guarda al instante (no espera "Guardar cambios") y
 *      nunca se escribe en el documento.
 */

// ---------------------------------------------------------------------
// Estado derivado
// ---------------------------------------------------------------------

/** CFG() memoizado por ejecución (mismo motivo que ois_cfg_ en 35_OisService.js). */
function oip_cfg_() {
  var memo = repo_memo_();
  return memo.__cfgOip || (memo.__cfgOip = CFG());
}

/**
 * ESTADO de una OIP a partir de sus tareas y su fecha de vencimiento. Misma
 * regla que la OIS ("Finalizada" gana sobre "Vencida"):
 *   1. Hay al menos una tarea y TODAS están finalizadas -> Finalizada.
 *   2. Si no, y hoy ya pasó la FECHA VENCIMIENTO        -> Vencida.
 *   3. Si no                                            -> En curso.
 *
 * A diferencia de la OIS, "Finalizada" aquí es solo una etiqueta informativa:
 * no bloquea la edición (ver oip_updateOip).
 */
function oip_deriveEstado_(tareas, fechaVencISO, hoyISO) {
  var cfg = oip_cfg_();
  if (tareas.length && tareas.every(function (t) { return t.estado === cfg.TAREA_ESTADO_FINALIZADA; })) {
    return cfg.OIP_ESTADO_FINALIZADA;
  }
  if (fechaVencISO && hoyISO > fechaVencISO) return cfg.OIP_ESTADO_VENCIDA;
  return cfg.OIP_ESTADO_INICIAL;
}

/** Tarea de la hoja -> DTO para la UI (fechas en ISO). */
function oip_tareaToDto_(t) {
  var cfg = oip_cfg_();
  return {
    idTarea: t.idTarea,
    tarea: t.tarea,
    responsable: t.responsable,
    idEmpleado: t.idEmpleado,
    tipoResponsable: t.tipoResponsable || '',
    fechaInicio: qs_dateToISO_(t.fechaInicio),
    fechaEntrega: qs_dateToISO_(t.fechaEntrega),
    estado: t.estado === cfg.TAREA_ESTADO_FINALIZADA ? cfg.TAREA_ESTADO_FINALIZADA : cfg.TAREA_ESTADO_INICIAL,
    observacion: t.observacion
  };
}

/** Fila de facturación de la hoja -> DTO para la UI. */
function oip_facturaToDto_(f) {
  var cfg = oip_cfg_();
  return {
    idFacturacion: f.idFacturacion,
    mes: f.mes === '' || f.mes == null ? '' : Number(f.mes),
    year: f.year === '' || f.year == null ? '' : Number(f.year),
    cuota: f.cuota === '' || f.cuota == null ? '' : Number(f.cuota),
    numeroFactura: f.numeroFactura || '',
    estado: f.estado === cfg.FACT_ESTADO_FACTURADO ? cfg.FACT_ESTADO_FACTURADO : cfg.FACT_ESTADO_PENDIENTE,
    fechaNotificacion: f.fechaNotificacion ? qs_dateToISO_(f.fechaNotificacion) : ''
  };
}

/** OIP de la hoja + sus tareas (DTO) -> DTO para la UI, con el estado ya derivado para hoy. */
function oip_toDto_(o, tareasDto, hoyISO) {
  var fechaVenc = qs_dateToISO_(o.fechaVencimiento);
  return {
    idOip: o.idOip,
    idCotizacion: o.idCotizacion,
    codigo: o.codigo,
    fechaElaboracion: qs_dateToISO_(o.fechaElaboracion),
    plazo: o.plazo === '' || o.plazo == null ? '' : Number(o.plazo),
    fechaVencimiento: fechaVenc,
    estado: oip_deriveEstado_(tareasDto, fechaVenc, hoyISO),
    urlDocumento: o.urlDocumento,
    docEstado: o.docEstado,
    docFileId: o.docFileId,
    actualizadoEn: o.actualizadoEn ? qs_dateToISO_(o.actualizadoEn) : '',
    elaboradoPor: o.elaboradoPor,
    actualizadoPor: o.actualizadoPor
  };
}

// ---------------------------------------------------------------------
// Aprobar la garantía + crear la OIP (una sola transacción)
// ---------------------------------------------------------------------

/**
 * Popup "Garantía aprobada" -> "OIP". Dentro de UN mismo lock:
 *   1. guarda el formulario de la cotización con ESTADO = Aprobada (mismo
 *      cuerpo que qs_updateQuotation, ver qs_applyQuotationUpdate_), y
 *   2. crea la fila de la OIP (ID, consecutivo OIP-KGP-NNN-YY, fechas).
 * Así nunca queda una cotización Aprobada sin su orden ni una OIP huérfana.
 *
 * payload: el mismo del "Guardar cambios" de Gestionar cotización (estado se
 * fuerza a Aprobada). requestId: UUID del cliente, idempotencia (un reintento
 * tras un timeout devuelve la OIP ya creada en vez de fallar).
 *
 * No genera documentos: el cliente regenera el de la cotización y genera el
 * de la OIP después, fuera del lock.
 */
function oip_aprobarConOip(idCotizacion, payload, requestId) {
  idCotizacion = String(idCotizacion || '').trim();
  requestId = String(requestId || '').trim();
  if (!idCotizacion) return fail_('VALIDATION', 'Falta idCotizacion.');
  if (!requestId) return fail_('VALIDATION', 'Falta requestId (identificador de solicitud).');

  var early = oip_checkIdempotency_(requestId);
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
    var early2 = oip_checkIdempotency_(requestId);
    if (early2) return early2;

    // Validar el esquema de las 3 hojas de la OIP ANTES de escribir nada en
    // la cotización: si falta una columna, fallar sin dejarla Aprobada.
    oip_table_();
    tarp_table_();
    fac_table_();

    var previa = oip_findByCotizacion_(idCotizacion);
    if (previa) {
      return fail_('CONFLICT', 'Esta cotización ya tiene la OIP ' + previa.codigo + '.');
    }
    // Tampoco puede tener ya una OIS: la orden es una elección única.
    var previaOis = ois_findByCotizacion_(idCotizacion);
    if (previaOis) {
      return fail_('CONFLICT', 'Esta cotización ya tiene la OIS ' + previaOis.codigo + ', no se le puede crear una OIP.');
    }

    var res = qs_applyQuotationUpdate_(idCotizacion, clean, {});
    if (!res.ok) return res;

    var fechaElaboracion = new Date();
    var codigo = oip_codeReserve_(fechaElaboracion);
    var idOip = id_new_('OIP');
    // A diferencia de la OIS, la OIP NO hereda el plazo de la cotización:
    // nace con 365 días (1 año) y el usuario lo ajusta en Gestionar OIP.
    var plazo = CFG().OIP_PLAZO_DEFAULT;

    oip_create_({
      idOip: idOip,
      idCotizacion: idCotizacion,
      fechaElaboracion: fechaElaboracion,
      codigo: codigo,
      plazo: plazo,
      fechaVencimiento: addDays_(fechaElaboracion, plazo),
      estado: CFG().OIP_ESTADO_INICIAL,
      requestId: requestId,
      elaboradoPor: emps_nombreUsuarioActivo_()
    });

    SpreadsheetApp.flush();
    bumpDataVersion_();

    var response = ok_({ cotizacion: res.data, idOip: idOip, codigoOip: codigo });
    cachePutJson_('idem:oip:' + requestId, response, 21600);
    return response;
  } catch (e) {
    logError_('oip_aprobarConOip', requestId, { idCotizacion: idCotizacion }, payload, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

function oip_checkIdempotency_(requestId) {
  if (!requestId) return null;
  var cached = cacheGetJson_('idem:oip:' + requestId);
  if (cached) return cached;
  var found = oip_findByRequestId_(requestId);
  if (found) {
    return ok_({ cotizacion: null, idOip: found.idOip, codigoOip: found.codigo, repetida: true });
  }
  return null;
}

// ---------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------

/**
 * Detalle completo de una OIP para "Gestionar OIP": la OIP, sus tareas, su
 * facturación, y TODO el detalle de la cotización padre (qs_getCotizacion:
 * cliente, solicitante, establecimiento, servicios) — la vista pinta los
 * datos compartidos desde ahí.
 */
function oip_getOip(idOip) {
  idOip = String(idOip || '').trim();
  if (!idOip) return fail_('VALIDATION', 'Falta idOip.');
  var found = oip_findById_(idOip);
  if (!found) return fail_('NOT_FOUND', 'No existe la OIP ' + idOip + '.');

  var cot = qs_getCotizacion(found.obj.idCotizacion);
  if (!cot.ok) return cot;

  var tareas = tarp_getByOip_(idOip).map(oip_tareaToDto_);
  var facturacion = fac_getByOip_(idOip).map(oip_facturaToDto_);
  var oip = oip_toDto_(found.obj, tareas, toISODate_(new Date()));
  oip.codigoCotizacion = cot.data.cotizacion.codigo;

  return ok_({
    oip: oip,
    tareas: tareas,
    facturacion: facturacion,
    cotizacion: cot.data.cotizacion,
    servicios: cot.data.servicios,
    cliente: cot.data.cliente,
    solicitante: cot.data.solicitante,
    establecimiento: cot.data.establecimiento
  });
}

/**
 * Listado de "Gestionar OIP": mismo contrato de params/respuesta que
 * api_listOis (la tabla de la vista es la misma, solo cambia el origen).
 *
 * Cacheado por dataVersion + fecha de hoy: el ESTADO "Vencida" depende del
 * día, no solo de las escrituras, así que la clave cambia sola a medianoche.
 */
function oip_listOip(params) {
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

  var all = oip_listAllDto_(hoy);

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

/** Todas las OIP con cliente, código de cotización, conteo de tareas y estado derivado. Memo por versión+día. */
function oip_listAllDto_(hoy) {
  var key = 'oip:list:v' + dataVersion_() + ':' + hoy;
  var cached = cacheGetJson_(key);
  if (cached) return cached;

  var tareasPorOip = {};
  tarp_table_().rows.forEach(function (r) {
    var t = tarp_rowToObj_(r);
    (tareasPorOip[t.idOip] = tareasPorOip[t.idOip] || []).push({ estado: t.estado });
  });

  var cotPorId = {};
  qr_tableCotizaciones_().rows.forEach(function (r) {
    var id = r[normText_('ID COTIZACION')];
    if (id && !cotPorId[id]) cotPorId[id] = { codigo: r[normText_('CODIGO')], idCliente: r[normText_('ID CLIENTE')] };
  });

  var clientePorId = ds_indexarPorId_(cli_table_(), 'ID CLIENTE', function (r) { return r[normText_('RAZON SOCIAL')]; });

  var list = oip_listAll_().map(function (o) {
    var tareas = tareasPorOip[o.idOip] || [];
    var dto = oip_toDto_(o, tareas, hoy);
    var cot = cotPorId[o.idCotizacion] || {};
    dto.codigoCotizacion = cot.codigo || '';
    dto.clienteNombre = (cot.idCliente && clientePorId[cot.idCliente]) || '';
    dto.numTareas = tareas.length;
    dto.numTareasFinalizadas = tareas.filter(function (t) { return t.estado === oip_cfg_().TAREA_ESTADO_FINALIZADA; }).length;
    return dto;
  });

  cachePutJson_(key, list, CFG().CACHE_TTL.DASHBOARD_S);
  return list;
}

// ---------------------------------------------------------------------
// Guardar cambios de una OIP
// ---------------------------------------------------------------------

/**
 * Valida el payload de "Guardar cambios" de Gestionar OIP. Mismo contrato que
 * validateOisUpdatePayload_ (plazo, cliente/solicitante/establecimiento,
 * servicios sin tarifas, tareas) con el tope de tareas propio de la OIP.
 * La facturación NO viaja en este payload: se guarda aparte y al instante
 * (ver oip_saveFactura).
 */
function validateOipUpdatePayload_(payload) {
  var errors = [];
  if (!isPlainObject_(payload)) return { clean: null, errors: ['El payload de la OIP es inválido.'] };
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
  if (tareasRaw.length > cfg.LIMITS.MAX_TAREAS_OIP) {
    errors.push('No se permiten más de ' + cfg.LIMITS.MAX_TAREAS_OIP + ' tareas por OIP.');
  }
  var tareas = tareasRaw.slice(0, cfg.LIMITS.MAX_TAREAS_OIP).map(function (t, idx) {
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
      // INTERNO / TERCERO; se valida contra la hoja al guardar (emp_buscarResponsable_).
      tipoResponsable: String(t.tipoResponsable || '').trim(),
      fechaInicio: fechaInicio,
      fechaEntrega: fechaEntrega,
      estado: estado,
      observacion: cleanMultiline_(t.observacion)
    };
  });

  // Servicios: se reutiliza la validación de la cotización. Sin tarifas: el
  // llamador las rellena con las ya guardadas antes de escribir.
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
 * "Guardar cambios" de Gestionar OIP. Dentro de UN lock:
 *   1. Si cambió algo compartido con la cotización (cliente/solicitante/
 *      establecimiento, servicios, o se editó una entidad desde el modal),
 *      reescribe la cotización padre con qs_applyQuotationUpdate_
 *      (permitirDecidida: ya está Aprobada). El plazo/descripción/tiempo de
 *      entrega/asesor de la COTIZACIÓN y las tarifas de sus servicios se
 *      conservan tal cual (la vista de OIP no los muestra). Si solo cambiaron
 *      tareas/plazo de la OIP, la cotización NO se toca (nota 2 del usuario:
 *      evitar procesos innecesarios).
 *   2. Tareas: actualiza las que siguen, borra las quitadas, crea las nuevas.
 *   3. Fila de la OIP: PLAZO, FECHA VENCIMIENTO, ESTADO (derivado),
 *      ACTUALIZADO EN/POR.
 * Devuelve {cotizacionCambio}: el cliente regenera el documento de la
 * cotización solo si es true; el de la OIP siempre.
 *
 * A diferencia de ois_updateOis, NO hay bloqueo por estado: una OIP
 * Finalizada se sigue pudiendo editar (decisión confirmada con el usuario —
 * una OIP factura durante ~1 año y cerrar las tareas de un mes no puede
 * dejarla congelada).
 */
function oip_updateOip(idOip, payload) {
  idOip = String(idOip || '').trim();
  if (!idOip) return fail_('VALIDATION', 'Falta idOip.');

  var validation = validateOipUpdatePayload_(payload);
  if (validation.errors.length) return fail_('VALIDATION', 'El formulario tiene errores.', validation.errors);
  var clean = validation.clean;

  var resultado;
  var nuevas = [];
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    var found = oip_findById_(idOip);
    if (!found) return fail_('NOT_FOUND', 'No existe la OIP ' + idOip + '.');
    var oip = found.obj;

    // Responsables: cada uno debe existir en PERSONAL_KGP (interno) o en
    // PERSONAL_TERCEROS (tercero); RESPONSABLE = su nombre y TIPO RESPONSABLE
    // = la hoja donde está (emp_buscarResponsable_, 14_EmpleadoRepo.js).
    var responsables = emp_listResponsables_();
    for (var i = 0; i < clean.tareas.length; i++) {
      var emp = emp_buscarResponsable_(responsables, clean.tareas[i].idEmpleado, clean.tareas[i].tipoResponsable);
      if (!emp) return fail_('NOT_FOUND', 'Tarea ' + (i + 1) + ': no existe el responsable ' + clean.tareas[i].idEmpleado + '.');
      clean.tareas[i].responsable = emp.nombre;
      clean.tareas[i].tipoResponsable = emp.tipoResponsable;
    }

    // ---- 1. Cotización padre (solo si cambió algo compartido) ----
    var cot = qs_getCotizacion(oip.idCotizacion);
    if (!cot.ok) return cot;
    var c = cot.data.cotizacion;
    var serviciosActuales = cot.data.servicios || [];

    var cotizacionCambio = clean.entidadesEditadas ||
      clean.idCliente !== c.idCliente ||
      clean.idSolicitante !== c.idSolicitante ||
      clean.idEstablecimiento !== c.idEstablecimiento ||
      qs_serviciosFirma_(clean.servicios) !== qs_serviciosFirma_(serviciosActuales);

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
      var resCot = qs_applyQuotationUpdate_(oip.idCotizacion, cleanCot, { permitirDecidida: true });
      if (!resCot.ok) return resCot;
    }

    // ---- 2. Tareas: actualizar -> borrar -> crear (en ese orden, para que
    // los rowIndex de las actualizaciones sigan siendo válidos) ----
    var filasActuales = tarp_getRowsByOip_(idOip);
    var filaPorId = {};
    filasActuales.forEach(function (f) { filaPorId[f.obj.idTarea] = f; });
    var enviadas = {};
    var actualizaciones = [];
    clean.tareas.forEach(function (t) {
      if (t.idTarea && filaPorId[t.idTarea]) {
        enviadas[t.idTarea] = true;
        actualizaciones.push({ rowIndex: filaPorId[t.idTarea].rowIndex, idTarea: t.idTarea, tarea: t });
      } else {
        nuevas.push(t);
      }
    });
    tarp_updateMany_(idOip, actualizaciones);
    var aBorrar = filasActuales
      .filter(function (f) { return !enviadas[f.obj.idTarea]; })
      .map(function (f) { return f.rowIndex; });
    tarp_deleteRows_(aBorrar);
    tarp_createMany_(idOip, nuevas);

    // ---- 3. Fila de la OIP ----
    var fechaElab = Object.prototype.toString.call(oip.fechaElaboracion) === '[object Date]'
      ? oip.fechaElaboracion
      : parseISODate_(oip.fechaElaboracion);
    var fechaVenc = fechaElab ? addDays_(fechaElab, clean.plazo) : '';
    var estado = oip_deriveEstado_(clean.tareas, fechaVenc ? toISODate_(fechaVenc) : '', toISODate_(new Date()));
    oip_update_(idOip, {
      'PLAZO': clean.plazo,
      'FECHA VENCIMIENTO': fechaVenc,
      'ESTADO': estado,
      'ACTUALIZADO POR': emps_nombreUsuarioActivo_()
    });

    SpreadsheetApp.flush();
    bumpDataVersion_();

    resultado = ok_({
      idOip: idOip,
      codigo: oip.codigo,
      estado: estado,
      fechaVencimiento: fechaVenc ? toISODate_(fechaVenc) : '',
      cotizacionCambio: !!cotizacionCambio,
      tareas: tarp_getByOip_(idOip).map(oip_tareaToDto_)
    });
  } catch (e) {
    logError_('oip_updateOip', null, { idOip: idOip }, payload, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }

  // Ya fuera del lock: un correo al responsable de cada tarea nueva (sin ID
  // en el payload). Nunca lanza (39_NotifyService.js).
  ntf_tareasCreadas_('OIP', oip, nuevas);
  return resultado;
}

// ---------------------------------------------------------------------
// Facturación (se guarda al instante, no espera "Guardar cambios")
// ---------------------------------------------------------------------

/**
 * Valida una fila del formulario de factura.
 * MES se guarda como NÚMERO de mes (1-12), no como nombre: la UI muestra la
 * etiqueta y el recordatorio mensual compara mes/año sin depender de acentos
 * ni de cómo esté escrito el nombre en la hoja.
 */
function validateFacturaPayload_(payload) {
  var errors = [];
  if (!isPlainObject_(payload)) return { clean: null, errors: ['El payload de la factura es inválido.'] };
  var cfg = CFG();

  var mes = Math.trunc(Number(payload.mes));
  if (!mes || isNaN(mes) || mes < 1 || mes > 12) errors.push('Selecciona un mes válido.');

  var year = Math.trunc(Number(payload.year));
  if (!year || isNaN(year) || year < 2000 || year > 2100) errors.push('Selecciona un año válido.');

  // CUOTA: entero sin formato, igual que TARIFA (el "$10.000" es solo visual).
  var cuota = '';
  if (payload.cuota !== '' && payload.cuota != null) {
    cuota = Math.trunc(Number(payload.cuota));
    if (isNaN(cuota) || cuota < 0 || cuota > cfg.TARIFA_MAX) {
      errors.push('La cuota debe ser un número entre 0 y ' + cfg.TARIFA_MAX + '.');
      cuota = '';
    }
  }

  var numeroFactura = cleanText_(payload.numeroFactura);
  var estado = cfg.ESTADOS_FACTURACION.indexOf(payload.estado) !== -1 ? payload.estado : cfg.FACT_ESTADO_PENDIENTE;

  if (errors.length) return { clean: null, errors: errors };
  return {
    clean: { mes: mes, year: year, cuota: cuota, numeroFactura: numeroFactura, estado: estado },
    errors: []
  };
}

/**
 * Crea o edita una fila de OIP_FACTURACION y la persiste de inmediato
 * (el formulario de factura no espera al "Guardar cambios" de la vista —
 * decisión del usuario: "una vez se guarde debe quedar guardado en la base de
 * datos"). No toca la cotización ni regenera documentos: la facturación solo
 * vive en la BD, nunca en la plantilla.
 *
 * idFacturacion: '' / null = crear; con valor = editar esa fila.
 */
function oip_saveFactura(idOip, idFacturacion, payload) {
  idOip = String(idOip || '').trim();
  idFacturacion = String(idFacturacion || '').trim();
  if (!idOip) return fail_('VALIDATION', 'Falta idOip.');

  var validation = validateFacturaPayload_(payload);
  if (validation.errors.length) return fail_('VALIDATION', 'El formulario de la factura tiene errores.', validation.errors);
  var clean = validation.clean;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    if (!oip_findById_(idOip)) return fail_('NOT_FOUND', 'No existe la OIP ' + idOip + '.');

    var filas = fac_getRowsByOip_(idOip);
    if (idFacturacion) {
      var fila = filas.filter(function (f) { return f.obj.idFacturacion === idFacturacion; })[0];
      if (!fila) return fail_('NOT_FOUND', 'No existe la fila de facturación ' + idFacturacion + '.');
      fac_update_(fila.rowIndex, idFacturacion, idOip, clean);
    } else {
      if (filas.length >= CFG().LIMITS.MAX_FACTURAS_OIP) {
        return fail_('VALIDATION', 'Esta OIP ya tiene el máximo de ' + CFG().LIMITS.MAX_FACTURAS_OIP + ' filas de facturación.');
      }
      idFacturacion = fac_create_(idOip, clean);
    }

    SpreadsheetApp.flush();
    bumpDataVersion_();

    return ok_({ idFacturacion: idFacturacion, facturacion: fac_getByOip_(idOip).map(oip_facturaToDto_) });
  } catch (e) {
    logError_('oip_saveFactura', null, { idOip: idOip, idFacturacion: idFacturacion }, payload, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/** Elimina una fila de facturación de una OIP. */
function oip_deleteFactura(idOip, idFacturacion) {
  idOip = String(idOip || '').trim();
  idFacturacion = String(idFacturacion || '').trim();
  if (!idOip) return fail_('VALIDATION', 'Falta idOip.');
  if (!idFacturacion) return fail_('VALIDATION', 'Falta idFacturacion.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    var fila = fac_getRowsByOip_(idOip).filter(function (f) { return f.obj.idFacturacion === idFacturacion; })[0];
    if (!fila) return fail_('NOT_FOUND', 'No existe la fila de facturación ' + idFacturacion + '.');
    fac_deleteRows_([fila.rowIndex]);

    SpreadsheetApp.flush();
    bumpDataVersion_();

    return ok_({ idFacturacion: idFacturacion, facturacion: fac_getByOip_(idOip).map(oip_facturaToDto_) });
  } catch (e) {
    logError_('oip_deleteFactura', null, { idOip: idOip, idFacturacion: idFacturacion }, null, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}
