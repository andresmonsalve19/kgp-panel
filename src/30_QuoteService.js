/**
 * Orquestación del caso de uso "crear cotización" — Fase 1 (solo BD).
 * La Fase 2 (generación del documento) vive en 31_DocService.js y se llama
 * por separado desde el cliente, ya con la cotización persistida.
 *
 * Sección crítica del lock: SOLO validar -> resolver/crear FKs -> reservar
 * CODIGO -> appends -> flush -> bump. Nunca la generación del Excel.
 */

/**
 * payload: ver 21_Validation.js / plan (api_createQuotation).
 * Devuelve ok_({idCotizacion, codigo, numServicios, docEstado, warnings})
 * o fail_(code, message).
 */
function qs_createQuotation(payload) {
  // Idempotencia: si esta requestId ya se procesó, devolver el resultado
  // anterior sin tocar el lock ni el sheet. Se comprueba dos veces (antes
  // y dentro del lock) para cerrar la ventana de una carrera exacta.
  var early = qs_checkIdempotency_(payload && payload.requestId);
  if (early) return early;

  var validation = validateCreatePayload_(payload);
  if (validation.errors.length) {
    return fail_('VALIDATION', 'El formulario tiene errores.', validation.errors);
  }
  var clean = validation.clean;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'Otro usuario está creando una cotización. Intenta de nuevo en unos segundos.');
  }

  var idsGenerados = {};
  try {
    // Repetir el chequeo de idempotencia ya dentro del lock.
    var early2 = qs_checkIdempotency_(clean.requestId);
    if (early2) return early2;

    var warnings = [];

    // 1. CLIENTE
    var idCliente = qs_resolveCliente_(clean.cliente, idsGenerados);

    // 2 y 3. CONTACTOS (solicitante + encargado del establecimiento, si aplica)
    var idSolicitante = qs_resolveContacto_(clean.solicitante, idCliente, idsGenerados, 'idSolicitante');

    // 4. ESTABLECIMIENTO (puede crear su propio contacto encargado)
    var idEstablecimiento = qs_resolveEstablecimiento_(clean.establecimiento, idCliente, idsGenerados);

    // 5. SERVICIOS
    var idCotizacion = id_new_('CTZ');
    idsGenerados.idCotizacion = idCotizacion;
    var serviciosConId = qr_createServicios_(idCotizacion, clean.servicios);
    idsGenerados.servicios = serviciosConId;

    // Reservar CODIGO (usa el sheet + ScriptProperties como fuente de verdad).
    var codigo = code_reserve_(clean.fechaElaboracion);
    idsGenerados.codigo = codigo;

    var creadoPor = '';
    try { creadoPor = Session.getActiveUser().getEmail() || ''; } catch (e) { creadoPor = ''; }

    // ELABORADO POR / CARGO: se resuelven UNA sola vez aquí (ID de empleado y
    // cargo de PERSONAL_KGP, buscados por el correo del usuario activo) y no
    // vuelven a tocarse en qs_updateQuotation. Si el correo no corresponde a
    // ningún empleado registrado, quedan vacíos (no bloquea la creación).
    var elaborador = null;
    try { elaborador = creadoPor ? emp_findByCorreo_(creadoPor) : null; } catch (e) { elaborador = null; }

    // 6. COTIZACIONES (una fila por servicio) — REGISTRO DE COMMIT
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

    // 7. flush antes de soltar el lock (para que el siguiente lector no vea estado parcial)
    SpreadsheetApp.flush();

    // 8. versión de datos (invalida cachés de listas/dashboard)
    bumpDataVersion_();

    var response = ok_({
      idCotizacion: idCotizacion,
      codigo: codigo,
      idCliente: idCliente,
      idSolicitante: idSolicitante,
      idEstablecimiento: idEstablecimiento,
      numServicios: clean.servicios.length,
      docEstado: 'PENDIENTE',
      warnings: warnings
    });

    qs_saveIdempotencyResult_(clean.requestId, response);
    return response;
  } catch (e) {
    logError_('qs_createQuotation', payload && payload.requestId, idsGenerados, payload, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e), idsGenerados);
  } finally {
    lock.releaseLock();
  }
}

function qs_checkIdempotency_(requestId) {
  if (!requestId) return null;
  var cached = cacheGetJson_('idem:' + requestId);
  if (cached) return cached;

  // Fallback si la caché expiró (6h) pero la columna REQUEST ID existe.
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

function qs_saveIdempotencyResult_(requestId, response) {
  if (!requestId) return;
  cachePutJson_('idem:' + requestId, response, 21600); // 6h
}

/** Devuelve idCliente, creándolo si modo="nuevo". Lanza CONFLICT si el NIT ya existe. */
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
 * Devuelve idContacto, creándolo si modo="nuevo". contactoInput puede ser
 * null (caso del encargado de establecimiento, que es opcional).
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

/** Devuelve idEstablecimiento, creándolo (y su contacto encargado, si aplica) si modo="nuevo". */
function qs_resolveEstablecimiento_(estInput, idCliente, idsGenerados) {
  if (estInput.modo === 'existente') {
    var existing = est_getEstablecimiento_(estInput.idEstablecimiento);
    if (!existing) throw new AppError_('NOT_FOUND', 'No existe el establecimiento ' + estInput.idEstablecimiento + '.');
    return existing.idEstablecimiento;
  }
  var idEncargado = qs_resolveContacto_(estInput.encargado, idCliente, idsGenerados, 'idEncargado');
  var idEstablecimiento = est_createEstablecimiento_(idCliente, estInput.datos);
  // La FK vive del lado del contacto (CONTACTOS_CLIENTES.ID ESTABLECIMIENTO);
  // ver comentario equivalente en qs_createEstablecimiento.
  if (idEncargado) con_setEstablecimiento_(idEncargado, idEstablecimiento);
  idsGenerados.idEstablecimiento = idEstablecimiento;
  return idEstablecimiento;
}

/**
 * Edita una cotización existente: campos compartidos (plazo, descripción,
 * FKs de cliente/solicitante/establecimiento), su lista de servicios
 * (agrega, actualiza en sitio, o elimina según corresponda, comparando por
 * ID SERVICIO) con sus tarifas, y los totales SUBTOTAL/IVA/TOTAL que se
 * derivan de ellas. fechaElaboracion y CODIGO nunca cambian.
 *
 * ESTADO: payload.estado vacío = se conserva. Si llega (botones "Garantía
 * aprobada/rechazada"), solo se acepta mientras la cotización siga en
 * CFG().ESTADO_INICIAL — la decisión de garantía es única e irreversible.
 *
 * Igual que qs_createQuotation: sección crítica corta (solo lectura +
 * escrituras de esta transacción), flush + bump antes de soltar el lock. No
 * genera el documento — eso es una llamada aparte del cliente
 * (api_generateDocument/api_regenerateDocument), mismo patrón de 2 fases.
 */
function qs_updateQuotation(idCotizacion, payload) {
  idCotizacion = String(idCotizacion || '').trim();
  if (!idCotizacion) return fail_('VALIDATION', 'Falta idCotizacion.');

  var validation = validateUpdatePayload_(payload);
  if (validation.errors.length) {
    return fail_('VALIDATION', 'El formulario tiene errores.', validation.errors);
  }
  var clean = validation.clean;

  // Aprobar solo es posible junto con la creación de su OIS (popup de
  // "Garantía aprobada" -> api_aprobarConOis, una sola sección crítica): así
  // nunca existe una cotización Aprobada sin su orden. Rechazar sí sigue
  // pasando por aquí.
  if (clean.estado === CFG().ESTADO_APROBADA) {
    return fail_('VALIDATION', 'Para aprobar la garantía usa el botón "Garantía aprobada" y elige el tipo de orden (OIS).');
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    var res = qs_applyQuotationUpdate_(idCotizacion, clean, {});
    if (res.ok) {
      SpreadsheetApp.flush();
      bumpDataVersion_();
    }
    return res;
  } catch (e) {
    logError_('qs_updateQuotation', null, { idCotizacion: idCotizacion }, payload, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/**
 * Cuerpo de qs_updateQuotation SIN lock, validación de payload, flush ni
 * bump: DEBE llamarse ya dentro del script lock, con `clean` salido de
 * validateUpdatePayload_. Existe para que otras transacciones reutilicen
 * exactamente la misma escritura de la cotización dentro de SU propio lock:
 *   - ois_aprobarConOis (35_OisService.js): aprobar + crear la OIS en una
 *     sola sección crítica (nunca una cotización Aprobada sin su OIS).
 *   - ois_updateOis: guardar la OIS reescribe los datos compartidos de la
 *     cotización padre, que ya está Aprobada.
 *
 * opts.permitirDecidida: true = saltarse el bloqueo de "cotización ya
 * decidida = solo lectura". SOLO lo usa la OIS (decisión confirmada con el
 * usuario: la OIS es la única puerta de edición de una cotización aprobada;
 * "Gestionar cotización" sigue bloqueada como siempre).
 *
 * Devuelve ok_(...)/fail_(...); las excepciones las maneja el llamador.
 */
function qs_applyQuotationUpdate_(idCotizacion, clean, opts) {
  opts = opts || {};
  qr_requireTarifaCols_();

  var existentes = qr_getServiciosByCotizacion_(idCotizacion);
  if (!existentes.length) return fail_('NOT_FOUND', 'No existe la cotización ' + idCotizacion + '.');

  // Capturados ANTES de tocar filas: CODIGO/fechaElaboracion/ELABORADO POR/
  // CARGO nunca cambian, y no dependen de qué filas sobrevivan al diff de
  // servicios de abajo (se reutilizan tal cual para cualquier fila nueva
  // que cree este mismo servicio, ver el ctx de qr_createCotizaciones_ más
  // abajo).
  var filaBase = qr_getCotizacionRows_(idCotizacion)[0].obj;

  // Cotización ya decidida (Aprobada/Rechazada) = solo lectura, sin
  // excepción: ni tarifas, ni servicios, ni datos generales, ni siquiera
  // el asesor comercial. Se revisa ANTES de validar cliente/solicitante/
  // establecimiento para fallar rápido y no hacer lecturas de más. El
  // formulario de "Gestionar cotización" ya bloquea los campos en la UI
  // (ver applyLockState_ en JsGestion.js.html); este chequeo es la
  // garantía real del lado del servidor — nunca confiar solo en que el
  // cliente no haya enviado el "Guardar cambios".
  // Única excepción: opts.permitirDecidida (guardar desde la OIS), que igual
  // nunca puede volver a decidir la garantía — clean.estado debe venir vacío.
  var estadoActual = qs_normEstado_(filaBase[normText_('ESTADO')]);
  if (estadoActual !== CFG().ESTADO_INICIAL) {
    if (!opts.permitirDecidida) {
      return fail_('CONFLICT', 'Esta cotización ya fue marcada como "' + estadoActual + '" y no se puede editar.');
    }
    if (clean.estado && clean.estado !== estadoActual) {
      return fail_('CONFLICT', 'La garantía de esta cotización ya fue decidida ("' + estadoActual + '").');
    }
  }

  var cliente = cli_getCliente_(clean.idCliente);
  if (!cliente) return fail_('NOT_FOUND', 'No existe el cliente ' + clean.idCliente + '.');
  var solicitante = con_getContacto_(clean.idSolicitante);
  if (!solicitante) return fail_('NOT_FOUND', 'No existe el solicitante ' + clean.idSolicitante + '.');
  var establecimiento = est_getEstablecimiento_(clean.idEstablecimiento);
  if (!establecimiento) return fail_('NOT_FOUND', 'No existe el establecimiento ' + clean.idEstablecimiento + '.');

  var codigo = filaBase[normText_('CODIGO')];
  var fechaElaboracionRaw = filaBase[normText_('FECHA ELABORACION')];
  var fechaElaboracion = (Object.prototype.toString.call(fechaElaboracionRaw) === '[object Date]')
    ? fechaElaboracionRaw
    : parseISODate_(fechaElaboracionRaw);
  var fechaVencimiento = addDays_(fechaElaboracion, clean.plazo);
  var elaboradoPor = filaBase[normText_('ELABORADO POR')] || '';
  var cargoElaborador = filaBase[normText_('CARGO')] || '';

  // ASESOR COMERCIAL: único de los 4 campos de personal editable libremente
  // (desplegable en "Gestionar cotización"). Opcional — '' = sin asignar.
  var asesorComercial = '';
  if (clean.asesorComercial) {
    var asesor = emp_getEmpleado_(clean.asesorComercial);
    if (!asesor) return fail_('NOT_FOUND', 'No existe el empleado ' + clean.asesorComercial + ' (asesor comercial).');
    asesorComercial = asesor.idEmpleado;
  }

  // Si clean.estado llega distinto de estadoActual, el chequeo de arriba ya
  // garantizó que estadoActual es ESTADO_INICIAL, así que aquí "decidir la
  // garantía" siempre es la primera vez.
  var estado = estadoActual;
  // REVISADO Y APROBADO POR: se fija una sola vez, en el mismo momento en
  // que la garantía pasa de ESTADO_INICIAL a Aprobada/Rechazada. Fuera de
  // ese momento se conserva el valor ya guardado (filaBase).
  var revisadoAprobadoPor = filaBase[normText_('REVISADO Y APROBADO POR')] || '';
  if (clean.estado && clean.estado !== estadoActual) {
    estado = clean.estado;
    var correoRevisor = '';
    try { correoRevisor = Session.getActiveUser().getEmail() || ''; } catch (e) { correoRevisor = ''; }
    var revisor = correoRevisor ? emp_findByCorreo_(correoRevisor) : null;
    revisadoAprobadoPor = revisor ? revisor.idEmpleado : '';
  }

  // SUBTOTAL = suma de los TOTAL (tarifa x cantidad) de cada servicio.
  var subtotal = 0;
  clean.servicios.forEach(function (s) { if (s.total !== '') subtotal += s.total; });
  var iva = round2_(subtotal * CFG().IVA_TASA);
  var totalCotizacion = round2_(subtotal + iva);

  var existentesPorId = {};
  existentes.forEach(function (s) { existentesPorId[s.idServicio] = true; });
  var enviadosConId = {};
  clean.servicios.forEach(function (s) { if (s.idServicio) enviadosConId[s.idServicio] = true; });

  // 1. Quitar servicios que ya no vienen en el payload.
  existentes.forEach(function (s) {
    if (!enviadosConId[s.idServicio]) qr_deleteServicio_(idCotizacion, s.idServicio);
  });

  // 2. Actualizar los que siguen existiendo / crear los nuevos, renumerando 1..N según el orden recibido.
  clean.servicios.forEach(function (s, idx) {
    var numero = idx + 1;
    if (s.idServicio && existentesPorId[s.idServicio]) {
      qr_updateServicio_(s.idServicio, numero, s);
      qr_updateNumeroServicio_(idCotizacion, s.idServicio, numero);
    } else {
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
    }
  });

  // 3. Campos compartidos en todas las filas que quedaron (incluye las recién creadas: reescribirlas es idempotente).
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

  var revisadoAprobadoPorEmp = revisadoAprobadoPor ? emp_getEmpleado_(revisadoAprobadoPor) : null;
  var asesorComercialEmp = asesorComercial ? emp_getEmpleado_(asesorComercial) : null;

  return ok_({
    idCotizacion: idCotizacion,
    codigo: codigo,
    numServicios: clean.servicios.length,
    estado: estado,
    subtotal: subtotal,
    iva: iva,
    total: totalCotizacion,
    revisadoAprobadoPor: revisadoAprobadoPor,
    revisadoAprobadoPorNombre: revisadoAprobadoPorEmp ? revisadoAprobadoPorEmp.nombre : '',
    asesorComercial: asesorComercial,
    asesorComercialNombre: asesorComercialEmp ? asesorComercialEmp.nombre : '',
    tiempoEntrega: clean.tiempoEntrega
  });
}

/** Detalle completo de una cotización para la vista de detalle del dashboard. */
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

  // Nombres resueltos para mostrar en el resumen (Gestionar cotización):
  // la BD solo guarda los IDs de empleado, la UI necesita el nombre.
  var elaboradoPorEmp = cotizacion.elaboradoPor ? emp_getEmpleado_(cotizacion.elaboradoPor) : null;
  var revisadoAprobadoPorEmp = cotizacion.revisadoAprobadoPor ? emp_getEmpleado_(cotizacion.revisadoAprobadoPor) : null;
  var asesorComercialEmp = cotizacion.asesorComercial ? emp_getEmpleado_(cotizacion.asesorComercial) : null;
  cotizacion.elaboradoPorNombre = elaboradoPorEmp ? elaboradoPorEmp.nombre : '';
  cotizacion.revisadoAprobadoPorNombre = revisadoAprobadoPorEmp ? revisadoAprobadoPorEmp.nombre : '';
  cotizacion.asesorComercialNombre = asesorComercialEmp ? asesorComercialEmp.nombre : '';

  var servicios = qr_getServiciosByCotizacion_(idCotizacion);
  var cliente = cli_getCliente_(cotizacion.idCliente);
  var solicitante = cotizacion.idSolicitante ? con_getContacto_(cotizacion.idSolicitante) : null;
  var establecimiento = cotizacion.idEstablecimiento ? est_getEstablecimiento_(cotizacion.idEstablecimiento) : null;

  // OIS generada a partir de esta cotización (si ya se aprobó con "Crear
  // OIS"), para el acceso directo "Ver OIS" de Gestionar cotización. No
  // crítico: si la hoja OIS no existe o falla, la cotización se muestra igual.
  var ois = null;
  try {
    var o = ois_findByCotizacion_(cotizacion.idCotizacion);
    if (o) ois = { idOis: o.idOis, codigo: o.codigo };
  } catch (e) { ois = null; }
  cotizacion.ois = ois;

  return ok_({ cotizacion: cotizacion, servicios: servicios, cliente: cliente, solicitante: solicitante, establecimiento: establecimiento });
}

// ---------------------------------------------------------------------
// Alta rápida desde los paneles "Crear nuevo" del formulario (cliente,
// contacto/solicitante, establecimiento y su encargado). Cada uno persiste
// de inmediato -- a diferencia del flujo de creación de cotización, aquí
// no hay un modo "nuevo" diferido: el panel guarda y el registro pasa a
// estar disponible como "existente" en su desplegable correspondiente.
// ---------------------------------------------------------------------

/** datos: {razonSocial, tipoIdentificacion, numeroIdentificacion, direccion, ciudad, departamento, pais, telefono, codigoCiiu, actividadPrincipal}. */
function qs_createCliente(datos) {
  datos = isPlainObject_(datos) ? datos : {};
  var razonSocial = cleanText_(datos.razonSocial);
  var numeroIdentificacion = cleanText_(datos.numeroIdentificacion);
  if (!razonSocial) return fail_('VALIDATION', 'La razón social es obligatoria.');
  if (!numeroIdentificacion) return fail_('VALIDATION', 'El número de identificación es obligatorio.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    var dup = cli_findByNumeroIdentificacion_(numeroIdentificacion);
    if (dup) {
      return fail_('CONFLICT', 'Ya existe un cliente con ese número de identificación.', { idClienteExistente: dup.idCliente, razonSocial: dup.razonSocial });
    }
    var idCliente = cli_createCliente_(datos);
    SpreadsheetApp.flush();
    bumpDataVersion_();
    return ok_({ idCliente: idCliente, razonSocial: razonSocial, numeroIdentificacion: numeroIdentificacion });
  } catch (e) {
    logError_('qs_createCliente', null, {}, datos, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/** datos: {nombre, telefono, correo, cargo}. */
function qs_createContacto(idCliente, datos) {
  idCliente = String(idCliente || '').trim();
  datos = isPlainObject_(datos) ? datos : {};
  var nombre = cleanText_(datos.nombre);
  if (!idCliente) return fail_('VALIDATION', 'Falta idCliente.');
  if (!nombre) return fail_('VALIDATION', 'El nombre del contacto es obligatorio.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    var cliente = cli_getCliente_(idCliente);
    if (!cliente) return fail_('NOT_FOUND', 'No existe el cliente ' + idCliente + '.');
    var idContacto = con_createContacto_(idCliente, datos);
    SpreadsheetApp.flush();
    bumpDataVersion_();
    return ok_({ idContacto: idContacto, idCliente: idCliente, nombre: nombre, cargo: cleanText_(datos.cargo) });
  } catch (e) {
    logError_('qs_createContacto', null, {}, { idCliente: idCliente, datos: datos }, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/** datos: {nombre, direccion, ciudad, departamento, pais}. idContacto (encargado) es opcional. */
function qs_createEstablecimiento(idCliente, datos, idContacto) {
  idCliente = String(idCliente || '').trim();
  datos = isPlainObject_(datos) ? datos : {};
  idContacto = String(idContacto || '').trim();
  var nombre = cleanText_(datos.nombre);
  if (!idCliente) return fail_('VALIDATION', 'Falta idCliente.');
  if (!nombre) return fail_('VALIDATION', 'El nombre del establecimiento es obligatorio.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    var cliente = cli_getCliente_(idCliente);
    if (!cliente) return fail_('NOT_FOUND', 'No existe el cliente ' + idCliente + '.');
    if (idContacto) {
      var contacto = con_getContacto_(idContacto);
      if (!contacto) return fail_('NOT_FOUND', 'No existe el contacto ' + idContacto + '.');
    }
    var idEstablecimiento = est_createEstablecimiento_(idCliente, datos);
    // La FK de encargado vive del lado del contacto
    // (CONTACTOS_CLIENTES.ID ESTABLECIMIENTO), para que
    // refreshEncargadoOptions (Js*.js.html) filtre y proponga este mismo
    // contacto la próxima vez que se elija este establecimiento.
    if (idContacto) con_setEstablecimiento_(idContacto, idEstablecimiento);
    SpreadsheetApp.flush();
    bumpDataVersion_();
    return ok_({ idEstablecimiento: idEstablecimiento, idCliente: idCliente, idContacto: idContacto, nombre: nombre });
  } catch (e) {
    logError_('qs_createEstablecimiento', null, {}, { idCliente: idCliente, datos: datos }, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/** Edita un cliente ya existente (botón "Editar" del panel de cliente). */
function qs_updateCliente(idCliente, datos) {
  idCliente = String(idCliente || '').trim();
  datos = isPlainObject_(datos) ? datos : {};
  var razonSocial = cleanText_(datos.razonSocial);
  var numeroIdentificacion = cleanText_(datos.numeroIdentificacion);
  if (!idCliente) return fail_('VALIDATION', 'Falta idCliente.');
  if (!razonSocial) return fail_('VALIDATION', 'La razón social es obligatoria.');
  if (!numeroIdentificacion) return fail_('VALIDATION', 'El número de identificación es obligatorio.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    var dup = cli_findByNumeroIdentificacion_(numeroIdentificacion);
    if (dup && dup.idCliente !== idCliente) {
      return fail_('CONFLICT', 'Ya existe otro cliente con ese número de identificación.', { idClienteExistente: dup.idCliente, razonSocial: dup.razonSocial });
    }
    cli_updateCliente_(idCliente, datos);
    SpreadsheetApp.flush();
    bumpDataVersion_();
    return ok_({ idCliente: idCliente, razonSocial: razonSocial, numeroIdentificacion: numeroIdentificacion });
  } catch (e) {
    logError_('qs_updateCliente', null, {}, { idCliente: idCliente, datos: datos }, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/** Edita un contacto ya existente (solicitante o encargado). */
function qs_updateContacto(idContacto, datos) {
  idContacto = String(idContacto || '').trim();
  datos = isPlainObject_(datos) ? datos : {};
  var nombre = cleanText_(datos.nombre);
  if (!idContacto) return fail_('VALIDATION', 'Falta idContacto.');
  if (!nombre) return fail_('VALIDATION', 'El nombre del contacto es obligatorio.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    con_updateContacto_(idContacto, datos);
    SpreadsheetApp.flush();
    bumpDataVersion_();
    return ok_({ idContacto: idContacto, nombre: nombre, cargo: cleanText_(datos.cargo) });
  } catch (e) {
    logError_('qs_updateContacto', null, {}, { idContacto: idContacto, datos: datos }, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/** Edita un establecimiento ya existente. */
function qs_updateEstablecimiento(idEstablecimiento, datos) {
  idEstablecimiento = String(idEstablecimiento || '').trim();
  datos = isPlainObject_(datos) ? datos : {};
  var nombre = cleanText_(datos.nombre);
  if (!idEstablecimiento) return fail_('VALIDATION', 'Falta idEstablecimiento.');
  if (!nombre) return fail_('VALIDATION', 'El nombre del establecimiento es obligatorio.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    est_updateEstablecimiento_(idEstablecimiento, datos);
    SpreadsheetApp.flush();
    bumpDataVersion_();
    return ok_({ idEstablecimiento: idEstablecimiento, nombre: nombre });
  } catch (e) {
    logError_('qs_updateEstablecimiento', null, {}, { idEstablecimiento: idEstablecimiento, datos: datos }, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/**
 * ESTADO tal como se muestra y se compara en toda la app. Tolera filas
 * antiguas (vacías, "Aprobado"/"Rechazado" en masculino, sin tilde) y las
 * lleva a los valores vigentes de CFG().ESTADOS.
 */
function qs_normEstado_(raw) {
  // Se llama una vez por fila en ds_buildSnapshot_: CFG() lee
  // ScriptProperties, así que se memoiza por ejecución.
  var memo = repo_memo_();
  var cfg = memo.__cfgEstados || (memo.__cfgEstados = CFG());
  var n = normText_(raw);
  if (!n || n === 'EN REVISION') return cfg.ESTADO_INICIAL;
  if (n === 'APROBADA' || n === 'APROBADO') return cfg.ESTADO_APROBADA;
  if (n === 'RECHAZADA' || n === 'RECHAZADO') return cfg.ESTADO_RECHAZADA;
  return String(raw);
}

function qs_dateToISO_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') return toISODate_(value);
  return String(value);
}
