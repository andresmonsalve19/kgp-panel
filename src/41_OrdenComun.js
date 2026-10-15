/**
 * Lógica COMÚN de las dos órdenes internas: OIS (servicio) y OIP (proyectos).
 *
 * Las dos funcionan igual (CLAUDE.md §10-11): nacen de una cotización al
 * aprobarla, no duplican sus datos (cliente, solicitante, establecimiento y
 * servicios se leen y se reescriben en la cotización padre), tienen tareas y
 * un ESTADO derivado de ellas. Antes cada una tenía su copia de todo esto
 * (~500 líneas casi idénticas en 35_OisService.js y 36_OipService.js); ahora
 * vive aquí una sola vez, parametrizada por ord_spec_(tipo), y los archivos de
 * cada orden solo declaran sus funciones públicas y lo que es propio de ella.
 *
 * Diferencias entre OIS y OIP (todas confirmadas con el usuario; no las
 * "corrijas" por simetría) — están en el spec, no en if/else sueltos:
 *   - cierraAlFinalizar: una OIS Finalizada es de solo lectura; una OIP no
 *     (factura ~1 año).
 *   - plazoInicial: la OIS hereda el plazo de la cotización; la OIP nace con
 *     CFG_().OIP_PLAZO_DEFAULT.
 *   - maxTareas: MAX_TAREAS (la plantilla OIS tiene 20 filas) vs MAX_TAREAS_OIP.
 *   - verificarOis: crear una OIP verifica que la cotización no tenga ya OIS.
 *     Al revés NO (ver el comentario en ord_aprobar_).
 *   - La OIP además tiene facturación (36_OipService.js).
 */

// ---------------------------------------------------------------------
// Adaptador por tipo
// ---------------------------------------------------------------------

/**
 * Todo lo que distingue a una OIS de una OIP: hojas, repos, nombres de los
 * campos del DTO y reglas puntuales. null si el tipo no es OIS ni OIP.
 *
 * @param {string} tipo 'OIS' | 'OIP' (mayúsculas o minúsculas).
 * @return {?Object}
 */
function ord_spec_(tipo) {
  var cfg = CFG_();
  tipo = String(tipo || '').trim().toUpperCase();
  if (tipo === 'OIS') {
    return {
      tipo: 'OIS',
      clave: 'ois',            // claves de caché ('idem:ois:', 'ois:list:') y del DTO de detalle
      idKey: 'idOis',          // FK de la tarea y campo del DTO
      codigoKey: 'codigoOis',  // campo de la respuesta de aprobar
      nombre: cfg.NOMBRE_OIS,
      idPrefijo: cfg.ID_PREFIJO_OIS,
      tabTareas: cfg.TABS.TAREAS_OIS,
      maxTareas: cfg.LIMITS.MAX_TAREAS,
      cierraAlFinalizar: true,
      verificarOis: false,
      estados: { inicial: cfg.OIS_ESTADO_INICIAL, finalizada: cfg.OIS_ESTADO_FINALIZADA, vencida: cfg.OIS_ESTADO_VENCIDA },
      plazoInicial: function (clean) { return clean.plazo; },
      validarHojas: function () { ois_table_(); tar_table_(); },
      findById: ois_findById_,
      findByCotizacion: ois_findByCotizacion_,
      findByRequestId: ois_findByRequestId_,
      listAll: ois_listAll_,
      create: ois_create_,
      update: ois_update_,
      codeReserve: ois_codeReserve_,
      tablaTareas: tar_table_,
      tareaRowToObj: tar_rowToObj_,
      getTareaRows: tar_getRowsByOis_,
      createTareas: tar_createMany_,
      updateTareas: tar_updateMany_,
      deleteTareaRows: tar_deleteRows_,
      extraDetalle: null
    };
  }
  if (tipo === 'OIP') {
    return {
      tipo: 'OIP',
      clave: 'oip',
      idKey: 'idOip',
      codigoKey: 'codigoOip',
      nombre: cfg.NOMBRE_OIP,
      idPrefijo: cfg.ID_PREFIJO_OIP,
      tabTareas: cfg.TABS.TAREAS_OIP,
      maxTareas: cfg.LIMITS.MAX_TAREAS_OIP,
      cierraAlFinalizar: false,
      verificarOis: true,
      estados: { inicial: cfg.OIP_ESTADO_INICIAL, finalizada: cfg.OIP_ESTADO_FINALIZADA, vencida: cfg.OIP_ESTADO_VENCIDA },
      plazoInicial: function () { return CFG_().OIP_PLAZO_DEFAULT; },
      validarHojas: function () { oip_table_(); tarp_table_(); fac_table_(); },
      findById: oip_findById_,
      findByCotizacion: oip_findByCotizacion_,
      findByRequestId: oip_findByRequestId_,
      listAll: oip_listAll_,
      create: oip_create_,
      update: oip_update_,
      codeReserve: oip_codeReserve_,
      tablaTareas: tarp_table_,
      tareaRowToObj: tarp_rowToObj_,
      getTareaRows: tarp_getRowsByOip_,
      createTareas: tarp_createMany_,
      updateTareas: tarp_updateMany_,
      deleteTareaRows: tarp_deleteRows_,
      // La OIP trae además su facturación en el detalle.
      extraDetalle: function (idOip) {
        return { facturacion: fac_getByOip_(idOip).map(oip_facturaToDto_) };
      }
    };
  }
  return null;
}

// ---------------------------------------------------------------------
// Estado y DTOs
// ---------------------------------------------------------------------

/**
 * ESTADO de una orden a partir de sus tareas y su fecha de vencimiento.
 * Regla confirmada con el usuario — "Finalizada" gana:
 *   1. Hay al menos una tarea y TODAS están finalizadas -> Finalizada.
 *   2. Si no, y hoy ya pasó la FECHA VENCIMIENTO        -> Vencida.
 *   3. Si no                                            -> En curso.
 * "Ya pasó" = hoy > vencimiento (el propio día aún no está vencido).
 *
 * @param {!Object} spec ord_spec_(...).
 * @param {!Array<{estado: string}>} tareas
 * @param {string} fechaVencISO 'yyyy-MM-dd' o ''.
 * @param {string} hoyISO 'yyyy-MM-dd'.
 * @return {string}
 */
function ord_derivarEstado_(spec, tareas, fechaVencISO, hoyISO) {
  var finalizada = CFG_().TAREA_ESTADO_FINALIZADA;
  if (tareas.length && tareas.every(function (t) { return t.estado === finalizada; })) return spec.estados.finalizada;
  if (fechaVencISO && hoyISO > fechaVencISO) return spec.estados.vencida;
  return spec.estados.inicial;
}

/**
 * Tarea de la hoja (tar_rowToObj_ / tarp_rowToObj_) -> DTO para la UI, con
 * las fechas en ISO y el estado normalizado a uno de los dos válidos.
 * @param {!Object} t
 * @return {!Object}
 */
function ord_tareaToDto_(t) {
  var cfg = CFG_();
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

/**
 * Orden de la hoja + sus tareas (DTO) -> DTO para la UI, con el estado ya
 * derivado para `hoyISO`.
 * @param {!Object} spec
 * @param {!Object} o Objeto de dominio (ois_rowToObj_ / oip_rowToObj_).
 * @param {!Array<!Object>} tareasDto
 * @param {string} hoyISO
 * @return {!Object}
 */
function ord_toDto_(spec, o, tareasDto, hoyISO) {
  var fechaVenc = qs_dateToISO_(o.fechaVencimiento);
  var dto = {};
  dto[spec.idKey] = o[spec.idKey];
  dto.idCotizacion = o.idCotizacion;
  dto.codigo = o.codigo;
  dto.fechaElaboracion = qs_dateToISO_(o.fechaElaboracion);
  dto.plazo = o.plazo === '' || o.plazo == null ? '' : Number(o.plazo);
  dto.fechaVencimiento = fechaVenc;
  dto.estado = ord_derivarEstado_(spec, tareasDto, fechaVenc, hoyISO);
  dto.urlDocumento = o.urlDocumento;
  dto.docEstado = o.docEstado;
  dto.docFileId = o.docFileId;
  dto.actualizadoEn = o.actualizadoEn ? qs_dateToISO_(o.actualizadoEn) : '';
  dto.elaboradoPor = o.elaboradoPor;
  dto.actualizadoPor = o.actualizadoPor;
  return dto;
}

// ---------------------------------------------------------------------
// Índices en memoria (una lectura de hoja, memoizados por ejecución)
// ---------------------------------------------------------------------

/**
 * {ID COTIZACION: {codigo, idCliente}} a partir de COTIZACIONES (una fila por
 * servicio: se toma la primera). Memoizado mientras la tabla en memoria sea
 * la misma (una escritura que la descarte provoca reconstruirlo).
 * @return {!Object<string, {codigo: string, idCliente: string}>}
 */
function ord_indiceCotizaciones_() {
  var table = qr_tableCotizaciones_();
  var memo = repo_memo_();
  if (memo.__ordCot && memo.__ordCot.table === table) return memo.__ordCot.idx;
  var colId = normText_('ID COTIZACION'), colCodigo = normText_('CODIGO'), colCliente = normText_('ID CLIENTE');
  var idx = {};
  table.rows.forEach(function (r) {
    var id = r[colId];
    if (id && !idx[id]) idx[id] = { codigo: r[colCodigo], idCliente: r[colCliente] };
  });
  memo.__ordCot = { table: table, idx: idx };
  return idx;
}

/**
 * {ID CLIENTE: RAZON SOCIAL}. Mismo criterio de memo que ord_indiceCotizaciones_.
 * @return {!Object<string, string>}
 */
function ord_indiceClientes_() {
  var table = cli_table_();
  var memo = repo_memo_();
  if (memo.__ordCli && memo.__ordCli.table === table) return memo.__ordCli.idx;
  var idx = ds_indexarPorId_(table, 'ID CLIENTE', function (r) { return r[normText_('RAZON SOCIAL')]; });
  memo.__ordCli = { table: table, idx: idx };
  return idx;
}

/**
 * Tareas de TODAS las órdenes de un tipo, agrupadas por la FK de la orden y
 * ya convertidas con `mapFn` (una sola lectura de la hoja de tareas).
 * @param {!Object} spec
 * @param {function(!Object, !Object): *} mapFn (tareaDominio, filaCruda) -> valor.
 * @return {!Object<string, !Array<*>>}
 */
function ord_tareasPorOrden_(spec, mapFn) {
  var por = {};
  spec.tablaTareas().rows.forEach(function (r) {
    var t = spec.tareaRowToObj(r);
    var fk = t[spec.idKey];
    if (!fk) return;
    (por[fk] = por[fk] || []).push(mapFn(t, r));
  });
  return por;
}

// ---------------------------------------------------------------------
// Listado (Gestionar OIS / Gestionar OIP)
// ---------------------------------------------------------------------

/**
 * Todas las órdenes de un tipo con cliente, código de cotización, conteo de
 * tareas y estado derivado. Cacheado por dataVersion + día (el estado
 * "Vencida" depende del día, no solo de las escrituras).
 * @param {!Object} spec
 * @param {string} hoy 'yyyy-MM-dd'
 * @return {!Array<!Object>}
 */
function ord_listarDto_(spec, hoy) {
  var key = spec.clave + ':list:v' + dataVersion_() + ':' + hoy;
  var cached = cacheGetJson_(key);
  if (cached) return cached;

  var finalizada = CFG_().TAREA_ESTADO_FINALIZADA;
  var tareasPorOrden = ord_tareasPorOrden_(spec, function (t) { return { estado: t.estado }; });
  var cotPorId = ord_indiceCotizaciones_();
  var clientePorId = ord_indiceClientes_();

  var list = spec.listAll().map(function (o) {
    var tareas = tareasPorOrden[o[spec.idKey]] || [];
    var dto = ord_toDto_(spec, o, tareas, hoy);
    var cot = cotPorId[o.idCotizacion] || {};
    dto.codigoCotizacion = cot.codigo || '';
    dto.clienteNombre = (cot.idCliente && clientePorId[cot.idCliente]) || '';
    dto.numTareas = tareas.length;
    dto.numTareasFinalizadas = tareas.filter(function (t) { return t.estado === finalizada; }).length;
    return dto;
  });

  cachePutJson_(key, list, CFG_().CACHE_TTL.DASHBOARD_S);
  return list;
}

/**
 * Listado filtrado, ordenado y paginado en el servidor (mismo contrato de
 * params/respuesta que api_getDashboard).
 * @param {!Object} spec
 * @param {{anio: (number|undefined), estado: (string|undefined),
 *     q: (string|undefined), page: (number|undefined),
 *     pageSize: (number|undefined), sortBy: (string|undefined),
 *     sortDir: (string|undefined)}} params
 * @return {!Object} ok_({rows, total, page, pageSize})
 */
function ord_listar_(spec, params) {
  params = params || {};
  var hoy = toISODate_(new Date());
  var campos = ['codigo', 'codigoCotizacion', 'cliente', 'fechaElaboracion', 'fechaVencimiento', 'estado', 'tareas'];
  var filters = {
    anio: params.anio ? Number(params.anio) : null,
    estado: params.estado || null,
    q: normText_(params.q || ''),
    page: clamp_(params.page || 1, 1, 100000),
    pageSize: clamp_(params.pageSize || 20, 1, 200),
    sortBy: campos.indexOf(params.sortBy) !== -1 ? params.sortBy : 'codigo',
    sortDir: params.sortDir === 'desc' ? 'desc' : 'asc'
  };

  var filtered = ord_listarDto_(spec, hoy).filter(function (o) {
    if (filters.anio && Number(String(o.fechaElaboracion).slice(0, 4)) !== filters.anio) return false;
    if (filters.estado && o.estado !== filters.estado) return false;
    if (filters.q && normText_(o.codigo + ' ' + o.codigoCotizacion + ' ' + o.clienteNombre).indexOf(filters.q) === -1) return false;
    return true;
  });

  var dir = filters.sortDir === 'desc' ? -1 : 1;
  filtered.sort(function (a, b) {
    if (filters.sortBy === 'tareas') return dir * ((a.numTareas || 0) - (b.numTareas || 0));
    var campo = filters.sortBy === 'cliente' ? 'clienteNombre' : filters.sortBy;
    return dir * String(a[campo] || '').localeCompare(String(b[campo] || ''));
  });

  var start = (filters.page - 1) * filters.pageSize;
  return ok_({
    rows: filtered.slice(start, start + filters.pageSize),
    total: filtered.length,
    page: filters.page,
    pageSize: filters.pageSize
  });
}

// ---------------------------------------------------------------------
// Detalle
// ---------------------------------------------------------------------

/**
 * Detalle completo de una orden: la orden, sus tareas, lo propio del tipo
 * (facturación de la OIP) y TODO el detalle de la cotización padre.
 * @param {!Object} spec
 * @param {string} idOrden
 * @return {!Object} ok_({<clave>, tareas, [facturacion], cotizacion,
 *     servicios, cliente, solicitante, establecimiento}) o fail_.
 */
function ord_obtener_(spec, idOrden) {
  idOrden = String(idOrden || '').trim();
  if (!idOrden) return fail_('VALIDATION', 'Falta ' + spec.idKey + '.');
  var found = spec.findById(idOrden);
  if (!found) return fail_('NOT_FOUND', 'No existe la ' + spec.tipo + ' ' + idOrden + '.');

  var cot = qs_getCotizacion(found.obj.idCotizacion);
  if (!cot.ok) return cot;

  var tareas = spec.getTareaRows(idOrden).map(function (r) { return ord_tareaToDto_(r.obj); });
  var orden = ord_toDto_(spec, found.obj, tareas, toISODate_(new Date()));
  orden.codigoCotizacion = cot.data.cotizacion.codigo;

  var data = {};
  data[spec.clave] = orden;
  data.tareas = tareas;
  if (spec.extraDetalle) Object.assign(data, spec.extraDetalle(idOrden));
  data.cotizacion = cot.data.cotizacion;
  data.servicios = cot.data.servicios;
  data.cliente = cot.data.cliente;
  data.solicitante = cot.data.solicitante;
  data.establecimiento = cot.data.establecimiento;
  return ok_(data);
}

// ---------------------------------------------------------------------
// Aprobar la cotización + crear la orden (una sola transacción)
// ---------------------------------------------------------------------

/**
 * Popup de aprobación -> "OIS" u "OIP". Dentro de UN mismo lock:
 *   1. guarda el formulario de la cotización con ESTADO = Aprobada
 *      (qs_applyQuotationUpdate_), y
 *   2. crea la fila de la orden (ID, consecutivo, fechas, plazo inicial).
 * Así nunca queda una cotización Aprobada sin su orden ni una orden huérfana.
 * No genera documentos: el cliente los pide después, fuera del lock.
 *
 * Idempotente por requestId: un reintento tras un timeout devuelve la orden
 * ya creada (repetida: true) en vez de fallar.
 *
 * @param {!Object} spec
 * @param {string} etapa Nombre de la operación para _ERRORES.
 * @param {string} idCotizacion
 * @param {!Object} payload El mismo del "Guardar cambios" de Gestionar
 *     cotización (el estado se fuerza a Aprobada).
 * @param {string} requestId UUID del cliente.
 * @return {!Object} ok_({cotizacion, <idKey>, <codigoKey>}) o fail_.
 */
function ord_aprobar_(spec, etapa, idCotizacion, payload, requestId) {
  idCotizacion = String(idCotizacion || '').trim();
  requestId = String(requestId || '').trim();
  if (!idCotizacion) return fail_('VALIDATION', 'Falta idCotizacion.');
  if (!requestId) return fail_('VALIDATION', 'Falta requestId (identificador de solicitud).');

  var early = ord_checkIdempotency_(spec, requestId);
  if (early) return early;

  var cfg = CFG_();
  var validation = validateUpdatePayload_(Object.assign({}, payload || {}, { estado: cfg.ESTADO_APROBADA }));
  if (validation.errors.length) {
    return fail_('VALIDATION', 'El formulario tiene errores.', validation.errors);
  }
  var clean = validation.clean;

  return tx_conLock_(etapa, function () {
    var early2 = ord_checkIdempotency_(spec, requestId);
    if (early2) return early2;

    // Esquema de las hojas de la orden ANTES de escribir nada en la
    // cotización: si falta una columna, fallar sin dejarla Aprobada.
    spec.validarHojas();

    var previa = spec.findByCotizacion(idCotizacion);
    if (previa) return fail_('CONFLICT', 'Esta cotización ya tiene la ' + spec.tipo + ' ' + previa.codigo + '.');
    // La orden es una elección única. Crear una OIP verifica que no haya OIS;
    // crear una OIS NO consulta la hoja OIP a propósito: una cotización con
    // OIP ya está Aprobada y qs_applyQuotationUpdate_ la rechaza igual, y
    // consultarla haría depender la OIS de que las hojas de la OIP existan.
    if (spec.verificarOis) {
      var previaOis = ois_findByCotizacion_(idCotizacion);
      if (previaOis) return fail_('CONFLICT', 'Esta cotización ya tiene la OIS ' + previaOis.codigo + ', no se le puede crear una ' + spec.tipo + '.');
    }

    var res = qs_applyQuotationUpdate_(idCotizacion, clean, {});
    if (!res.ok) return res;

    var fechaElaboracion = new Date();
    var codigo = spec.codeReserve(fechaElaboracion);
    var idOrden = id_new_(spec.idPrefijo);
    var plazo = spec.plazoInicial(clean);
    var ctx = {
      idCotizacion: idCotizacion,
      fechaElaboracion: fechaElaboracion,
      codigo: codigo,
      plazo: plazo,
      fechaVencimiento: addDays_(fechaElaboracion, plazo),
      estado: spec.estados.inicial,
      requestId: requestId,
      elaboradoPor: emps_nombreUsuarioActivo_()
    };
    ctx[spec.idKey] = idOrden;
    spec.create(ctx);

    var data = { cotizacion: res.data };
    data[spec.idKey] = idOrden;
    data[spec.codigoKey] = codigo;
    var response = ok_(data);
    cachePutJson_('idem:' + spec.clave + ':' + requestId, response, cfg.CACHE_TTL.IDEMPOTENCIA_S);
    return response;
  }, { requestId: requestId, ids: { idCotizacion: idCotizacion }, payload: payload });
}

/**
 * Respuesta ya guardada de una aprobación con este requestId (caché o la fila
 * con esa REQUEST ID), o null si es nueva.
 * @param {!Object} spec
 * @param {string} requestId
 * @return {Object}
 */
function ord_checkIdempotency_(spec, requestId) {
  if (!requestId) return null;
  var cached = cacheGetJson_('idem:' + spec.clave + ':' + requestId);
  if (cached) return cached;
  var found = spec.findByRequestId(requestId);
  if (!found) return null;
  var data = { cotizacion: null };
  data[spec.idKey] = found[spec.idKey];
  data[spec.codigoKey] = found.codigo;
  data.repetida = true;
  return ok_(data);
}

// ---------------------------------------------------------------------
// Guardar cambios de una orden
// ---------------------------------------------------------------------

/**
 * Valida el payload de "Guardar cambios" de Gestionar OIS/OIP:
 *   {plazo, cliente:{idCliente}, solicitante:{idContacto},
 *    establecimiento:{idEstablecimiento},
 *    servicios:[{idServicio, tipo, codigoUnspsc, descripcion, actividades[]}],
 *    tareas:[{idTarea|null, tarea, idEmpleado, tipoResponsable, fechaInicio,
 *             fechaEntrega, estado, observacion}],
 *    entidadesEditadas: bool}
 * Los servicios NO traen tarifas (las órdenes no las muestran): el llamador
 * conserva las ya guardadas.
 *
 * @param {*} payload
 * @param {!Object} spec Define el tope de tareas y el nombre en los mensajes.
 * @return {{clean: ?Object, errors: !Array<string>}}
 */
function ord_validarPayload_(payload, spec) {
  var errors = [];
  if (!isPlainObject_(payload)) return { clean: null, errors: ['El payload de la ' + spec.tipo + ' es inválido.'] };
  var cfg = CFG_();

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
  if (tareasRaw.length > spec.maxTareas) {
    errors.push('No se permiten más de ' + spec.maxTareas + ' tareas por ' + spec.tipo + '.');
  }
  var tareas = tareasRaw.slice(0, spec.maxTareas).map(function (t, idx) {
    var label = 'tareas[' + (idx + 1) + ']: ';
    return validateTarea_(t, function (msg) { errors.push(label + msg); });
  });

  // Servicios: misma validación que la cotización (sin tarifas).
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
 * "Guardar cambios" de Gestionar OIS/OIP. Dentro de UN lock:
 *   1. Cotización padre: solo si cambió algo compartido
 *      (ord_actualizarCotizacionPadre_).
 *   2. Tareas: actualiza las que siguen, borra las quitadas, crea las nuevas.
 *   3. Fila de la orden: PLAZO, FECHA VENCIMIENTO, ESTADO (derivado),
 *      ACTUALIZADO EN/POR.
 * Ya fuera del lock, avisa por correo al responsable de cada tarea nueva.
 *
 * @param {!Object} spec
 * @param {string} etapa Nombre de la operación para _ERRORES.
 * @param {string} idOrden
 * @param {!Object} payload Ver ord_validarPayload_.
 * @return {!Object} ok_({<idKey>, codigo, estado, fechaVencimiento,
 *     cotizacionCambio, tareas}) o fail_. Con cotizacionCambio el cliente
 *     regenera también el documento de la cotización.
 */
function ord_actualizar_(spec, etapa, idOrden, payload) {
  idOrden = String(idOrden || '').trim();
  if (!idOrden) return fail_('VALIDATION', 'Falta ' + spec.idKey + '.');

  var validation = ord_validarPayload_(payload, spec);
  if (validation.errors.length) return fail_('VALIDATION', 'El formulario tiene errores.', validation.errors);
  var clean = validation.clean;

  var orden = null;
  var nuevas = [];
  var ids = {};
  ids[spec.idKey] = idOrden;

  var resultado = tx_conLock_(etapa, function () {
    var found = spec.findById(idOrden);
    if (!found) return fail_('NOT_FOUND', 'No existe la ' + spec.tipo + ' ' + idOrden + '.');
    orden = found.obj;
    if (spec.cierraAlFinalizar && String(orden.estado) === spec.estados.finalizada) {
      return fail_('CONFLICT', 'La ' + spec.tipo + ' ' + orden.codigo + ' ya está finalizada y no se puede editar.');
    }

    var errResp = ord_resolverResponsables_(clean.tareas);
    if (errResp) return errResp;

    var padre = ord_actualizarCotizacionPadre_(orden.idCotizacion, clean);
    if (padre.error) return padre.error;

    nuevas = ord_sincronizarTareas_(spec, idOrden, clean.tareas);

    var fechaElab = qs_aFecha_(orden.fechaElaboracion);
    var fechaVenc = fechaElab ? addDays_(fechaElab, clean.plazo) : '';
    var estado = ord_derivarEstado_(spec, clean.tareas, fechaVenc ? toISODate_(fechaVenc) : '', toISODate_(new Date()));
    spec.update(idOrden, {
      'PLAZO': clean.plazo,
      'FECHA VENCIMIENTO': fechaVenc,
      'ESTADO': estado,
      'ACTUALIZADO POR': emps_nombreUsuarioActivo_()
    });

    var data = {};
    data[spec.idKey] = idOrden;
    data.codigo = orden.codigo;
    data.estado = estado;
    data.fechaVencimiento = fechaVenc ? toISODate_(fechaVenc) : '';
    data.cotizacionCambio = padre.cambio;
    data.tareas = spec.getTareaRows(idOrden).map(function (r) { return ord_tareaToDto_(r.obj); });
    return ok_(data);
  }, { ids: ids, payload: payload });

  // Fuera del lock: correo a cada responsable de una tarea nueva. Nunca lanza.
  if (resultado.ok) ntf_tareasCreadas_(spec.tipo, orden, nuevas);
  return resultado;
}

/**
 * Resuelve el responsable de cada tarea contra PERSONAL_KGP (interno) o
 * PERSONAL_TERCEROS (tercero) y completa RESPONSABLE (nombre) y TIPO
 * RESPONSABLE (la hoja donde está). Modifica las tareas recibidas.
 * @param {!Array<!Object>} tareas Tareas ya validadas.
 * @return {Object} fail_('NOT_FOUND') si alguno no existe; null si todo bien.
 */
function ord_resolverResponsables_(tareas) {
  var responsables = emp_listResponsables_();
  for (var i = 0; i < tareas.length; i++) {
    var emp = emp_buscarResponsable_(responsables, tareas[i].idEmpleado, tareas[i].tipoResponsable);
    if (!emp) return fail_('NOT_FOUND', 'Tarea ' + (i + 1) + ': no existe el responsable ' + tareas[i].idEmpleado + '.');
    tareas[i].responsable = emp.nombre;
    tareas[i].tipoResponsable = emp.tipoResponsable;
  }
  return null;
}

/**
 * Reescribe la cotización padre SOLO si cambió algo que comparte con la orden:
 * cliente/solicitante/establecimiento, servicios, o una entidad editada desde
 * el modal (entidadesEditadas). Si solo cambiaron tareas/plazo de la orden, la
 * cotización no se toca (requisito del usuario: evitar procesos innecesarios).
 * Se conservan tal cual el plazo/descripción/tiempo de entrega/asesor de la
 * cotización y las tarifas de sus servicios (las órdenes no los muestran).
 * DEBE llamarse dentro del lock.
 *
 * @param {string} idCotizacion
 * @param {!Object} clean Salida de ord_validarPayload_.
 * @return {{cambio: boolean, error: (Object|undefined)}}
 */
function ord_actualizarCotizacionPadre_(idCotizacion, clean) {
  var cot = qs_getCotizacion(idCotizacion);
  if (!cot.ok) return { cambio: false, error: cot };
  var c = cot.data.cotizacion;
  var serviciosActuales = cot.data.servicios || [];

  var cambio = clean.entidadesEditadas ||
    clean.idCliente !== c.idCliente ||
    clean.idSolicitante !== c.idSolicitante ||
    clean.idEstablecimiento !== c.idEstablecimiento ||
    qs_serviciosFirma_(clean.servicios) !== qs_serviciosFirma_(serviciosActuales);
  if (!cambio) return { cambio: false };

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
  var res = qs_applyQuotationUpdate_(idCotizacion, cleanCot, { permitirDecidida: true });
  return res.ok ? { cambio: true } : { cambio: false, error: res };
}

/**
 * Deja las tareas de la orden iguales a `tareas`: actualiza las que siguen
 * (por ID TAREA), borra las que ya no vienen y crea las nuevas, en ese orden
 * (así los rowIndex de las actualizaciones siguen siendo válidos).
 * DEBE llamarse dentro del lock.
 * @param {!Object} spec
 * @param {string} idOrden
 * @param {!Array<!Object>} tareas Tareas validadas con responsable resuelto.
 * @return {!Array<!Object>} Las tareas creadas (para avisar a su responsable).
 */
function ord_sincronizarTareas_(spec, idOrden, tareas) {
  var filasActuales = spec.getTareaRows(idOrden);
  var filaPorId = {};
  filasActuales.forEach(function (f) { filaPorId[f.obj.idTarea] = f; });

  var enviadas = {};
  var actualizaciones = [];
  var nuevas = [];
  tareas.forEach(function (t) {
    if (t.idTarea && filaPorId[t.idTarea]) {
      enviadas[t.idTarea] = true;
      actualizaciones.push({ rowIndex: filaPorId[t.idTarea].rowIndex, idTarea: t.idTarea, tarea: t });
    } else {
      nuevas.push(t);
    }
  });

  spec.updateTareas(idOrden, actualizaciones);
  spec.deleteTareaRows(filasActuales
    .filter(function (f) { return !enviadas[f.obj.idTarea]; })
    .map(function (f) { return f.rowIndex; }));
  spec.createTareas(idOrden, nuevas);
  return nuevas;
}
