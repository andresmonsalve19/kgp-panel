/**
 * Casos de uso de la COTIZACIÓN: crear, editar (incluida la decisión única
 * Aprobada/Rechazada), leer el detalle, y las altas/ediciones rápidas de
 * cliente, contacto y establecimiento.
 *
 * Patrón de 2 fases: aquí solo se escribe la BD (dentro del script lock, con
 * tx_conLock_, 07_Transaccion.js). La generación del documento (31_DocService.js)
 * es una llamada aparte del cliente, ya fuera del lock: puede tardar 10-30 s y
 * no debe bloquear a nadie más.
 *
 * Sección crítica de la creación: validar -> resolver/crear FKs -> reservar
 * CODIGO -> appends -> flush -> bump. Nunca la generación del Excel.
 */

// ---------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------

/**
 * Crea una cotización (fase 1, solo BD).
 *
 * Idempotente por payload.requestId: si esa solicitud ya se procesó, devuelve
 * el resultado anterior sin tocar el lock ni el sheet. Se comprueba dos veces
 * (antes y dentro del lock) para cerrar la ventana de una carrera exacta.
 *
 * @param {!Object} payload Ver validateCreatePayload_ (21_Validation.js).
 * @return {!Object} ok_({idCotizacion, codigo, idCliente, idSolicitante,
 *     idEstablecimiento, numServicios, docEstado, warnings}) o fail_(...).
 */
function qs_createQuotation(payload) {
  var early = qs_checkIdempotency_(payload && payload.requestId);
  if (early) return early;

  var validation = validateCreatePayload_(payload);
  if (validation.errors.length) {
    return fail_('VALIDATION', 'El formulario tiene errores.', validation.errors);
  }
  var clean = validation.clean;
  var cfg = CFG_();
  var idsGenerados = {};

  return tx_conLock_('qs_createQuotation', function () {
    var early2 = qs_checkIdempotency_(clean.requestId);
    if (early2) return early2;

    // 1. Cliente, 2-3. contactos (solicitante + encargado), 4. establecimiento.
    var idCliente = qs_resolveCliente_(clean.cliente, idsGenerados);
    var idSolicitante = qs_resolveContacto_(clean.solicitante, idCliente, idsGenerados, 'idSolicitante');
    var idEstablecimiento = qs_resolveEstablecimiento_(clean.establecimiento, idCliente, idsGenerados);

    // 5. Servicios.
    var idCotizacion = id_new_(cfg.ID_PREFIJO_COTIZACION);
    idsGenerados.idCotizacion = idCotizacion;
    var serviciosConId = qr_createServicios_(idCotizacion, clean.servicios);
    idsGenerados.servicios = serviciosConId;

    // Consecutivo (sheet + ScriptProperties como fuente de verdad).
    var codigo = code_reserve_(clean.fechaElaboracion);
    idsGenerados.codigo = codigo;

    // ELABORADO POR / CARGO: se resuelven UNA sola vez aquí (empleado interno
    // buscado por el correo del usuario activo) y no vuelven a tocarse. Si el
    // correo no corresponde a ningún empleado, quedan vacíos (no bloquea).
    var creadoPor = qs_correoUsuarioActivo_();
    var elaborador = null;
    try { elaborador = creadoPor ? emp_findByCorreo_(creadoPor) : null; } catch (e) { elaborador = null; }

    // 6. COTIZACIONES (una fila por servicio): el registro de commit.
    qr_createCotizaciones_({
      idCotizacion: idCotizacion,
      codigo: codigo,
      fechaElaboracion: clean.fechaElaboracion,
      plazo: clean.plazo,
      fechaVencimiento: clean.fechaVencimiento,
      idCliente: idCliente,
      idSolicitante: idSolicitante,
      idEstablecimiento: idEstablecimiento,
      descripcion: clean.descripcion,
      estado: clean.estado,
      requestId: clean.requestId,
      creadoPor: creadoPor,
      elaboradoPor: elaborador ? elaborador.idEmpleado : '',
      cargoElaborador: elaborador ? elaborador.cargo : ''
    }, serviciosConId);

    var response = ok_({
      idCotizacion: idCotizacion,
      codigo: codigo,
      idCliente: idCliente,
      idSolicitante: idSolicitante,
      idEstablecimiento: idEstablecimiento,
      numServicios: clean.servicios.length,
      docEstado: 'PENDIENTE',
      warnings: []
    });
    qs_saveIdempotencyResult_(clean.requestId, response);
    return response;
  }, {
    requestId: payload && payload.requestId,
    ids: idsGenerados,
    payload: payload,
    detalles: function () { return idsGenerados; },
    mensajeOcupado: 'Otro usuario está creando una cotización. Intenta de nuevo en unos segundos.'
  });
}

/**
 * Respuesta ya guardada para un requestId (caché, o la fila con esa REQUEST ID
 * si la caché expiró). null si la solicitud es nueva.
 * @param {string} requestId
 * @return {Object}
 */
function qs_checkIdempotency_(requestId) {
  if (!requestId) return null;
  var cached = cacheGetJson_('idem:' + requestId);
  if (cached) return cached;

  var found = qr_findByRequestId_(requestId);
  if (found) {
    return ok_({
      idCotizacion: found.idCotizacion,
      codigo: found.codigo,
      numServicios: null,
      docEstado: null,
      warnings: ['Esta cotización ya había sido creada previamente (solicitud repetida).']
    });
  }
  return null;
}

/**
 * Guarda la respuesta de una creación para que un reintento la reciba igual.
 * @param {string} requestId
 * @param {!Object} response
 */
function qs_saveIdempotencyResult_(requestId, response) {
  if (!requestId) return;
  cachePutJson_('idem:' + requestId, response, CFG_().CACHE_TTL.IDEMPOTENCIA_S);
}

/** @return {string} Correo del usuario activo, o '' si Apps Script no lo expone. */
function qs_correoUsuarioActivo_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}

/**
 * idCliente de la cotización, creándolo si modo="nuevo".
 * @throws {AppError_} NOT_FOUND si no existe; CONFLICT si el NIT ya existe.
 */
function qs_resolveCliente_(clienteInput, idsGenerados) {
  if (clienteInput.modo === 'existente') {
    var existing = cli_getCliente_(clienteInput.id);
    if (!existing) throw new AppError_('NOT_FOUND', 'No existe el cliente ' + clienteInput.id + '.');
    return existing.idCliente;
  }
  var dup = cli_findByNumeroIdentificacion_(clienteInput.datos.numeroIdentificacion);
  if (dup) {
    throw new AppError_('CONFLICT', 'Ya existe un cliente con ese número de identificación.', { idClienteExistente: dup.idCliente, razonSocial: dup.razonSocial });
  }
  var idCliente = cli_createCliente_(clienteInput.datos);
  idsGenerados.idCliente = idCliente;
  return idCliente;
}

/**
 * idContacto, creándolo si modo="nuevo". contactoInput puede ser null (el
 * encargado de un establecimiento es opcional): devuelve ''.
 * @throws {AppError_} NOT_FOUND si el contacto existente no está.
 */
function qs_resolveContacto_(contactoInput, idCliente, idsGenerados, label) {
  if (!contactoInput) return '';
  if (contactoInput.modo === 'existente') {
    var existing = con_getContacto_(contactoInput.id);
    if (!existing) throw new AppError_('NOT_FOUND', 'No existe el contacto ' + contactoInput.id + '.');
    return existing.idContacto;
  }
  var idContacto = con_createContacto_(idCliente, contactoInput.datos);
  idsGenerados[label] = idContacto;
  return idContacto;
}

/**
 * idEstablecimiento, creándolo (y su contacto encargado, si aplica) si
 * modo="nuevo". La FK del encargado vive del lado del contacto
 * (CONTACTOS_CLIENTES.ID ESTABLECIMIENTO).
 * @throws {AppError_} NOT_FOUND si el establecimiento existente no está.
 */
function qs_resolveEstablecimiento_(estInput, idCliente, idsGenerados) {
  if (estInput.modo === 'existente') {
    var existing = est_getEstablecimiento_(estInput.idEstablecimiento);
    if (!existing) throw new AppError_('NOT_FOUND', 'No existe el establecimiento ' + estInput.idEstablecimiento + '.');
    return existing.idEstablecimiento;
  }
  var idEncargado = qs_resolveContacto_(estInput.encargado, idCliente, idsGenerados, 'idEncargado');
  var idEstablecimiento = est_createEstablecimiento_(idCliente, estInput.datos);
  if (idEncargado) con_setEstablecimiento_(idEncargado, idEstablecimiento);
  idsGenerados.idEstablecimiento = idEstablecimiento;
  return idEstablecimiento;
}

// ---------------------------------------------------------------------
// Editar
// ---------------------------------------------------------------------

/**
 * Edita una cotización existente: campos compartidos (plazo, descripción,
 * cliente/solicitante/establecimiento), su lista de servicios (agrega,
 * actualiza en sitio o elimina, comparando por ID SERVICIO) con sus tarifas,
 * y los totales SUBTOTAL/IVA/TOTAL. fechaElaboracion y CODIGO nunca cambian.
 *
 * ESTADO: payload.estado vacío = se conserva. "Rechazada" solo se acepta
 * mientras la cotización siga en ESTADO_INICIAL (decisión única). "Aprobada"
 * NO pasa por aquí: va con api_aprobarConOis/Oip para que nunca exista una
 * cotización aprobada sin su orden.
 *
 * Fuera del lock, si acaba de rechazarse, avisa por correo al creador.
 *
 * @param {string} idCotizacion
 * @param {!Object} payload Ver validateUpdatePayload_.
 * @return {!Object} ok_(...) de qs_applyQuotationUpdate_ o fail_(...).
 */
function qs_updateQuotation(idCotizacion, payload) {
  idCotizacion = String(idCotizacion || '').trim();
  if (!idCotizacion) return fail_('VALIDATION', 'Falta idCotizacion.');

  var validation = validateUpdatePayload_(payload);
  if (validation.errors.length) {
    return fail_('VALIDATION', 'El formulario tiene errores.', validation.errors);
  }
  var clean = validation.clean;

  if (clean.estado === CFG_().ESTADO_APROBADA) {
    return fail_('VALIDATION', 'Para aprobar la cotización usa el botón "cotización aprobada" y elige el tipo de orden (OIS).');
  }

  var res = tx_conLock_('qs_updateQuotation', function () {
    return qs_applyQuotationUpdate_(idCotizacion, clean, {});
  }, { ids: { idCotizacion: idCotizacion }, payload: payload });

  // Ya fuera del lock (39_NotifyService.js; nunca lanza). La aprobación avisa
  // al generarse el documento de su OIS/OIP, porque el correo lleva ese enlace.
  if (res.ok && res.data.estadoCambio && res.data.estado === CFG_().ESTADO_RECHAZADA) {
    ntf_cotizacionRechazada_(idCotizacion);
  }
  return res;
}

/**
 * Cuerpo de qs_updateQuotation SIN lock, validación de payload, flush ni
 * bump: DEBE llamarse ya dentro del script lock, con `clean` salido de
 * validateUpdatePayload_. Existe para que otras transacciones reutilicen la
 * misma escritura dentro de SU propio lock:
 *   - ois_aprobarConOis / oip_aprobarConOip: aprobar + crear la orden en una
 *     sola sección crítica.
 *   - ord_actualizarCotizacionPadre_ (41_OrdenComun.js): guardar una orden
 *     reescribe los datos compartidos de su cotización, que ya está Aprobada.
 *
 * Nunca escribe nada antes de una validación que pueda fallar: todos los
 * fail_ ocurren antes de la primera escritura.
 *
 * @param {string} idCotizacion
 * @param {!Object} clean Payload ya validado.
 * @param {{permitirDecidida: (boolean|undefined)}=} opts permitirDecidida:
 *     saltarse el bloqueo "cotización ya decidida = solo lectura" (solo las
 *     órdenes OIS/OIP, que nunca pueden volver a decidirla).
 * @return {!Object} ok_({idCotizacion, codigo, numServicios, estado,
 *     estadoCambio, subtotal, iva, total, revisadoAprobadoPor(Nombre),
 *     asesorComercial(Nombre), tiempoEntrega}) o fail_(...).
 */
function qs_applyQuotationUpdate_(idCotizacion, clean, opts) {
  opts = opts || {};
  var cfg = CFG_();
  qr_requireTarifaCols_();

  var existentes = qr_getServiciosByCotizacion_(idCotizacion);
  if (!existentes.length) return fail_('NOT_FOUND', 'No existe la cotización ' + idCotizacion + '.');

  // CODIGO/fechaElaboracion/ELABORADO POR/CARGO nunca cambian: se capturan
  // antes de tocar filas y se reutilizan para cualquier fila nueva.
  var filaBase = qr_getCotizacionRows_(idCotizacion)[0].obj;

  // Cotización ya decidida = solo lectura (salvo permitirDecidida, que igual
  // nunca puede volver a decidirla). Es la verificación real del servidor:
  // nunca confiar solo en que la UI bloquee los campos.
  var estadoActual = qs_normEstado_(filaBase[normText_('ESTADO')]);
  if (estadoActual !== cfg.ESTADO_INICIAL) {
    if (!opts.permitirDecidida) {
      return fail_('CONFLICT', 'Esta cotización ya fue marcada como "' + estadoActual + '" y no se puede editar.');
    }
    if (clean.estado && clean.estado !== estadoActual) {
      return fail_('CONFLICT', 'La cotización ya fue decidida ("' + estadoActual + '").');
    }
  }

  // Decidir (aprobar o rechazar) exige tarifas, TIEMPO DE ENTREGA y ASESOR.
  var decide = !!clean.estado && clean.estado !== estadoActual;
  if (decide) {
    var faltantes = [];
    if (clean.servicios.some(function (s) { return s.tarifa === '' || s.tarifa == null; })) faltantes.push('las tarifas de todos los servicios');
    if (!clean.tiempoEntrega) faltantes.push('el tiempo de entrega');
    if (!clean.asesorComercial) faltantes.push('el asesor comercial');
    if (faltantes.length) {
      return fail_('VALIDATION', 'Antes de aprobar o rechazar la cotización debes diligenciar: ' + faltantes.join(', ') + '.');
    }
  }

  if (!cli_getCliente_(clean.idCliente)) return fail_('NOT_FOUND', 'No existe el cliente ' + clean.idCliente + '.');
  if (!con_getContacto_(clean.idSolicitante)) return fail_('NOT_FOUND', 'No existe el solicitante ' + clean.idSolicitante + '.');
  if (!est_getEstablecimiento_(clean.idEstablecimiento)) return fail_('NOT_FOUND', 'No existe el establecimiento ' + clean.idEstablecimiento + '.');

  var codigo = filaBase[normText_('CODIGO')];
  var fechaElaboracion = qs_aFecha_(filaBase[normText_('FECHA ELABORACION')]);
  var fechaVencimiento = addDays_(fechaElaboracion, clean.plazo);
  var elaboradoPor = filaBase[normText_('ELABORADO POR')] || '';
  var cargoElaborador = filaBase[normText_('CARGO')] || '';

  // ASESOR COMERCIAL: único campo de personal editable libremente. '' = sin asignar.
  var asesorComercial = '';
  if (clean.asesorComercial) {
    var asesor = emp_getEmpleado_(clean.asesorComercial);
    if (!asesor) return fail_('NOT_FOUND', 'No existe el empleado ' + clean.asesorComercial + ' (asesor comercial).');
    asesorComercial = asesor.idEmpleado;
  }

  // REVISADO Y APROBADO POR: se fija una sola vez, al decidir la cotización.
  var estado = estadoActual;
  var revisadoAprobadoPor = filaBase[normText_('REVISADO Y APROBADO POR')] || '';
  if (decide) {
    estado = clean.estado;
    var correoRevisor = qs_correoUsuarioActivo_();
    var revisor = correoRevisor ? emp_findByCorreo_(correoRevisor) : null;
    revisadoAprobadoPor = revisor ? revisor.idEmpleado : '';
  }

  // Totales: SUBTOTAL = suma de los TOTAL (tarifa x cantidad) de cada servicio.
  var subtotal = 0;
  clean.servicios.forEach(function (s) { if (s.total !== '') subtotal += s.total; });
  var iva = round2_(subtotal * cfg.IVA_TASA);
  var totalCotizacion = round2_(subtotal + iva);

  var existentesPorId = {};
  existentes.forEach(function (s) { existentesPorId[s.idServicio] = true; });
  var enviadosConId = {};
  clean.servicios.forEach(function (s) { if (s.idServicio) enviadosConId[s.idServicio] = true; });

  // ---- A partir de aquí se escribe ----

  // 1. Quitar los servicios que ya no vienen.
  existentes.forEach(function (s) {
    if (!enviadosConId[s.idServicio]) qr_deleteServicio_(idCotizacion, s.idServicio);
  });

  // 2. Actualizar los que siguen / crear los nuevos, renumerando 1..N.
  clean.servicios.forEach(function (s, idx) {
    var numero = idx + 1;
    if (s.idServicio && existentesPorId[s.idServicio]) {
      qr_updateServicio_(s.idServicio, numero, s);
      qr_updateNumeroServicio_(idCotizacion, s.idServicio, numero);
      return;
    }
    var nuevo = qr_createServicios_(idCotizacion, [{
      numero: numero, tipo: s.tipo, codigoUnspsc: s.codigoUnspsc, descripcion: s.descripcion, actividades: s.actividades,
      tarifa: s.tarifa, cantidad: s.cantidad, total: s.total, observaciones: s.observaciones
    }])[0];
    qr_createCotizaciones_({
      idCotizacion: idCotizacion,
      codigo: codigo,
      fechaElaboracion: fechaElaboracion,
      plazo: clean.plazo,
      fechaVencimiento: fechaVencimiento,
      idCliente: clean.idCliente,
      idSolicitante: clean.idSolicitante,
      idEstablecimiento: clean.idEstablecimiento,
      descripcion: clean.descripcion,
      estado: estado,
      elaboradoPor: elaboradoPor,
      cargoElaborador: cargoElaborador,
      revisadoAprobadoPor: revisadoAprobadoPor,
      asesorComercial: asesorComercial,
      tiempoEntrega: clean.tiempoEntrega
    }, [nuevo]);
  });

  // 3. Campos compartidos en TODAS las filas (reescribir las recién creadas es idempotente).
  qr_updateCamposCompartidos_(idCotizacion, {
    'PLAZO': clean.plazo,
    'FECHA VENCIMIENTO': fechaVencimiento,
    'ID CLIENTE': clean.idCliente,
    'ID SOLICITANTE': clean.idSolicitante,
    'ID ESTABLECIMIENTO': clean.idEstablecimiento,
    'DESCRIPCION': clean.descripcion,
    'ESTADO': estado,
    'SUBTOTAL': subtotal,
    'IVA': iva,
    'TOTAL': totalCotizacion,
    'REVISADO Y APROBADO POR': revisadoAprobadoPor,
    'ASESOR COMERCIAL': asesorComercial,
    'TIEMPO DE ENTREGA': clean.tiempoEntrega
  });

  return ok_({
    idCotizacion: idCotizacion,
    codigo: codigo,
    numServicios: clean.servicios.length,
    estado: estado,
    // true solo en la llamada que decidió la cotización (para el correo de rechazo).
    estadoCambio: estado !== estadoActual,
    subtotal: subtotal,
    iva: iva,
    total: totalCotizacion,
    revisadoAprobadoPor: revisadoAprobadoPor,
    revisadoAprobadoPorNombre: qs_nombreEmpleado_(revisadoAprobadoPor),
    asesorComercial: asesorComercial,
    asesorComercialNombre: qs_nombreEmpleado_(asesorComercial),
    tiempoEntrega: clean.tiempoEntrega
  });
}

// ---------------------------------------------------------------------
// Leer
// ---------------------------------------------------------------------

/**
 * Detalle completo de una cotización: datos generales (con los nombres de su
 * personal ya resueltos), servicios, cliente, solicitante, establecimiento y
 * la orden que generó (OIS u OIP), si la hay.
 *
 * @param {string} idCotizacion
 * @return {!Object} ok_({cotizacion, servicios, cliente, solicitante,
 *     establecimiento}) o fail_('NOT_FOUND').
 */
function qs_getCotizacion(idCotizacion) {
  var filas = qr_getCotizacionRows_(idCotizacion);
  if (!filas.length) return fail_('NOT_FOUND', 'No existe la cotización ' + idCotizacion + '.');

  var base = filas[0].obj;
  var cotizacion = {
    idCotizacion: base[normText_('ID COTIZACION')],
    codigo: base[normText_('CODIGO')],
    fechaElaboracion: qs_dateToISO_(base[normText_('FECHA ELABORACION')]),
    plazo: base[normText_('PLAZO')],
    fechaVencimiento: qs_dateToISO_(base[normText_('FECHA VENCIMIENTO')]),
    idCliente: base[normText_('ID CLIENTE')],
    idSolicitante: base[normText_('ID SOLICITANTE')],
    idEstablecimiento: base[normText_('ID ESTABLECIMIENTO')],
    descripcion: base[normText_('DESCRIPCION')],
    estado: qs_normEstado_(base[normText_('ESTADO')]),
    subtotal: qr_num_(base[normText_('SUBTOTAL')]),
    iva: qr_num_(base[normText_('IVA')]),
    total: qr_num_(base[normText_('TOTAL')]),
    urlDocumento: base[normText_('URL DOCUMENTO')] || '',
    docEstado: base[normText_('DOC ESTADO')] || '',
    docFileId: base[normText_('DOC FILE ID')] || '',
    elaboradoPor: base[normText_('ELABORADO POR')] || '',
    cargoElaborador: base[normText_('CARGO')] || '',
    revisadoAprobadoPor: base[normText_('REVISADO Y APROBADO POR')] || '',
    asesorComercial: base[normText_('ASESOR COMERCIAL')] || '',
    tiempoEntrega: base[normText_('TIEMPO DE ENTREGA')] || ''
  };

  // La BD solo guarda los IDs de empleado; la UI y el documento necesitan el nombre.
  cotizacion.elaboradoPorNombre = qs_nombreEmpleado_(cotizacion.elaboradoPor);
  cotizacion.revisadoAprobadoPorNombre = qs_nombreEmpleado_(cotizacion.revisadoAprobadoPor);
  cotizacion.asesorComercialNombre = qs_nombreEmpleado_(cotizacion.asesorComercial);

  var servicios = qr_getServiciosByCotizacion_(idCotizacion);
  var cliente = cli_getCliente_(cotizacion.idCliente);
  var solicitante = cotizacion.idSolicitante ? con_getContacto_(cotizacion.idSolicitante) : null;
  var establecimiento = cotizacion.idEstablecimiento ? est_getEstablecimiento_(cotizacion.idEstablecimiento) : null;

  // Orden generada (para "Ver OIS"/"Ver OIP"). No crítico: si la hoja de la
  // orden falla, la cotización se muestra igual.
  cotizacion.ois = null;
  try {
    var o = ois_findByCotizacion_(cotizacion.idCotizacion);
    if (o) cotizacion.ois = { idOis: o.idOis, codigo: o.codigo };
  } catch (e) { cotizacion.ois = null; }
  cotizacion.oip = null;
  try {
    var p = oip_findByCotizacion_(cotizacion.idCotizacion);
    if (p) cotizacion.oip = { idOip: p.idOip, codigo: p.codigo };
  } catch (e2) { cotizacion.oip = null; }

  return ok_({ cotizacion: cotizacion, servicios: servicios, cliente: cliente, solicitante: solicitante, establecimiento: establecimiento });
}

/**
 * Nombre de un empleado interno por su ID, '' si no hay ID o no existe.
 * @param {string} idEmpleado
 * @return {string}
 */
function qs_nombreEmpleado_(idEmpleado) {
  if (!idEmpleado) return '';
  var emp = emp_getEmpleado_(idEmpleado);
  return emp ? emp.nombre : '';
}

/**
 * Firma comparable de una lista de servicios (orden + id + tipo + UNSPSC +
 * descripción + actividades SIN el prefijo "N.M "). Sirve para que una orden
 * (OIS u OIP) decida si al guardar cambió algo de los servicios de su
 * cotización padre. Tarifas excluidas a propósito: ninguna orden las edita.
 *
 * @param {!Array<!Object>} servicios
 * @return {string}
 */
function qs_serviciosFirma_(servicios) {
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

// ---------------------------------------------------------------------
// Altas y ediciones rápidas (modales de cliente / contacto / establecimiento).
// Cada una persiste de inmediato y el registro queda disponible como
// "existente" en su desplegable. "Gestión de clientes" usa las mismas.
// ---------------------------------------------------------------------

/**
 * Crea un cliente. Rechaza (CONFLICT) un número de identificación repetido.
 * @param {!Object} datos {razonSocial, tipoIdentificacion, numeroIdentificacion,
 *     direccion, ciudad, departamento, pais, telefono, codigoCiiu, actividadPrincipal}
 * @return {!Object} ok_({idCliente, razonSocial, numeroIdentificacion}) o fail_.
 */
function qs_createCliente(datos) {
  datos = isPlainObject_(datos) ? datos : {};
  var razonSocial = cleanText_(datos.razonSocial);
  var numeroIdentificacion = cleanText_(datos.numeroIdentificacion);
  if (!razonSocial) return fail_('VALIDATION', 'La razón social es obligatoria.');
  if (!numeroIdentificacion) return fail_('VALIDATION', 'El número de identificación es obligatorio.');

  return tx_conLock_('qs_createCliente', function () {
    var dup = cli_findByNumeroIdentificacion_(numeroIdentificacion);
    if (dup) {
      return fail_('CONFLICT', 'Ya existe un cliente con ese número de identificación.', { idClienteExistente: dup.idCliente, razonSocial: dup.razonSocial });
    }
    var idCliente = cli_createCliente_(datos);
    return ok_({ idCliente: idCliente, razonSocial: razonSocial, numeroIdentificacion: numeroIdentificacion });
  }, { payload: datos });
}

/**
 * Crea un contacto (solicitante o encargado) de un cliente.
 * @param {string} idCliente
 * @param {!Object} datos {nombre, telefono, correo, cargo, idEstablecimiento?}
 * @return {!Object} ok_({idContacto, idCliente, nombre, cargo}) o fail_.
 */
function qs_createContacto(idCliente, datos) {
  idCliente = String(idCliente || '').trim();
  datos = isPlainObject_(datos) ? datos : {};
  var nombre = cleanText_(datos.nombre);
  if (!idCliente) return fail_('VALIDATION', 'Falta idCliente.');
  if (!nombre) return fail_('VALIDATION', 'El nombre del contacto es obligatorio.');

  return tx_conLock_('qs_createContacto', function () {
    if (!cli_getCliente_(idCliente)) return fail_('NOT_FOUND', 'No existe el cliente ' + idCliente + '.');
    var idContacto = con_createContacto_(idCliente, datos);
    return ok_({ idContacto: idContacto, idCliente: idCliente, nombre: nombre, cargo: cleanText_(datos.cargo) });
  }, { payload: { idCliente: idCliente, datos: datos } });
}

/**
 * Crea un establecimiento de un cliente y, si llega idContacto, lo deja como
 * su encargado (la FK vive en CONTACTOS_CLIENTES.ID ESTABLECIMIENTO).
 * @param {string} idCliente
 * @param {!Object} datos {nombre, direccion, ciudad, departamento, pais}
 * @param {string=} idContacto Encargado (opcional).
 * @return {!Object} ok_({idEstablecimiento, idCliente, idContacto, nombre}) o fail_.
 */
function qs_createEstablecimiento(idCliente, datos, idContacto) {
  idCliente = String(idCliente || '').trim();
  datos = isPlainObject_(datos) ? datos : {};
  idContacto = String(idContacto || '').trim();
  var nombre = cleanText_(datos.nombre);
  if (!idCliente) return fail_('VALIDATION', 'Falta idCliente.');
  if (!nombre) return fail_('VALIDATION', 'El nombre del establecimiento es obligatorio.');

  return tx_conLock_('qs_createEstablecimiento', function () {
    if (!cli_getCliente_(idCliente)) return fail_('NOT_FOUND', 'No existe el cliente ' + idCliente + '.');
    if (idContacto && !con_getContacto_(idContacto)) return fail_('NOT_FOUND', 'No existe el contacto ' + idContacto + '.');
    var idEstablecimiento = est_createEstablecimiento_(idCliente, datos);
    if (idContacto) con_setEstablecimiento_(idContacto, idEstablecimiento);
    return ok_({ idEstablecimiento: idEstablecimiento, idCliente: idCliente, idContacto: idContacto, nombre: nombre });
  }, { payload: { idCliente: idCliente, datos: datos } });
}

/**
 * Edita un cliente. Rechaza (CONFLICT) un número de identificación que ya
 * tenga OTRO cliente.
 * @param {string} idCliente
 * @param {!Object} datos Mismos campos que qs_createCliente.
 * @return {!Object} ok_({idCliente, razonSocial, numeroIdentificacion}) o fail_.
 */
function qs_updateCliente(idCliente, datos) {
  idCliente = String(idCliente || '').trim();
  datos = isPlainObject_(datos) ? datos : {};
  var razonSocial = cleanText_(datos.razonSocial);
  var numeroIdentificacion = cleanText_(datos.numeroIdentificacion);
  if (!idCliente) return fail_('VALIDATION', 'Falta idCliente.');
  if (!razonSocial) return fail_('VALIDATION', 'La razón social es obligatoria.');
  if (!numeroIdentificacion) return fail_('VALIDATION', 'El número de identificación es obligatorio.');

  return tx_conLock_('qs_updateCliente', function () {
    var dup = cli_findByNumeroIdentificacion_(numeroIdentificacion);
    if (dup && dup.idCliente !== idCliente) {
      return fail_('CONFLICT', 'Ya existe otro cliente con ese número de identificación.', { idClienteExistente: dup.idCliente, razonSocial: dup.razonSocial });
    }
    cli_updateCliente_(idCliente, datos);
    return ok_({ idCliente: idCliente, razonSocial: razonSocial, numeroIdentificacion: numeroIdentificacion });
  }, { payload: { idCliente: idCliente, datos: datos } });
}

/**
 * Edita un contacto (solicitante o encargado).
 * @param {string} idContacto
 * @param {!Object} datos {nombre, telefono, correo, cargo}
 * @return {!Object} ok_({idContacto, nombre, cargo}) o fail_.
 */
function qs_updateContacto(idContacto, datos) {
  idContacto = String(idContacto || '').trim();
  datos = isPlainObject_(datos) ? datos : {};
  var nombre = cleanText_(datos.nombre);
  if (!idContacto) return fail_('VALIDATION', 'Falta idContacto.');
  if (!nombre) return fail_('VALIDATION', 'El nombre del contacto es obligatorio.');

  return tx_conLock_('qs_updateContacto', function () {
    con_updateContacto_(idContacto, datos);
    return ok_({ idContacto: idContacto, nombre: nombre, cargo: cleanText_(datos.cargo) });
  }, { payload: { idContacto: idContacto, datos: datos } });
}

/**
 * Edita un establecimiento.
 * @param {string} idEstablecimiento
 * @param {!Object} datos {nombre, direccion, ciudad, departamento, pais}
 * @return {!Object} ok_({idEstablecimiento, nombre}) o fail_.
 */
function qs_updateEstablecimiento(idEstablecimiento, datos) {
  idEstablecimiento = String(idEstablecimiento || '').trim();
  datos = isPlainObject_(datos) ? datos : {};
  var nombre = cleanText_(datos.nombre);
  if (!idEstablecimiento) return fail_('VALIDATION', 'Falta idEstablecimiento.');
  if (!nombre) return fail_('VALIDATION', 'El nombre del establecimiento es obligatorio.');

  return tx_conLock_('qs_updateEstablecimiento', function () {
    est_updateEstablecimiento_(idEstablecimiento, datos);
    return ok_({ idEstablecimiento: idEstablecimiento, nombre: nombre });
  }, { payload: { idEstablecimiento: idEstablecimiento, datos: datos } });
}

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------

/**
 * ESTADO tal como se muestra y se compara en toda la app. Tolera filas
 * antiguas (vacías, "Aprobado"/"Rechazado" en masculino, sin tilde) y las
 * lleva a los valores vigentes de CFG_().ESTADOS.
 * @param {*} raw Valor de la celda ESTADO.
 * @return {string}
 */
function qs_normEstado_(raw) {
  var cfg = CFG_();
  var n = normText_(raw);
  if (!n || n === 'EN REVISION') return cfg.ESTADO_INICIAL;
  if (n === 'APROBADA' || n === 'APROBADO') return cfg.ESTADO_APROBADA;
  if (n === 'RECHAZADA' || n === 'RECHAZADO') return cfg.ESTADO_RECHAZADA;
  return String(raw);
}

/**
 * Celda de fecha -> 'yyyy-MM-dd' (TZ de la app). Un texto se devuelve tal cual.
 * @param {*} value
 * @return {string}
 */
function qs_dateToISO_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') return toISODate_(value);
  return String(value);
}

/**
 * Celda de fecha -> Date (una Date se devuelve tal cual; un texto
 * 'yyyy-MM-dd' se parsea). null si no se puede interpretar.
 * @param {*} value
 * @return {Date}
 */
function qs_aFecha_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') return value;
  return parseISODate_(value);
}
