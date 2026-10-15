/**
 * Validación server-side del payload de api_createQuotation. Nunca confía
 * en el cliente para nada que afecte integridad (NUMERO SERVICIO, ESTADO
 * inicial, FECHA VENCIMIENTO): todo eso se recalcula aquí.
 *
 * Devuelve {clean, errors}. Si errors.length > 0, `clean` puede estar
 * incompleto y NO debe usarse.
 */
function validateCreatePayload_(payload) {
  var errors = [];
  function err(msg) { errors.push(msg); }

  if (!isPlainObject_(payload)) {
    return { clean: null, errors: ['El payload de la cotización es inválido.'] };
  }

  // ---- requestId ----
  var requestId = String(payload.requestId || '').trim();
  if (!requestId) err('Falta requestId (identificador de solicitud).');

  // ---- fecha elaboración ----
  var fechaElaboracion = parseISODate_(payload.fechaElaboracion);
  if (!fechaElaboracion) {
    err('fechaElaboracion inválida (se espera formato yyyy-MM-dd).');
  } else {
    var maxFutura = addDays_(new Date(), 366);
    if (fechaElaboracion.getTime() > maxFutura.getTime()) {
      err('fechaElaboracion no puede ser más de 1 año en el futuro.');
    }
  }

  // ---- plazo ----
  var plazo = Math.trunc(Number(payload.plazo));
  if (!plazo || isNaN(plazo) || plazo < 1 || plazo > CFG().LIMITS.MAX_PLAZO_DIAS) {
    err('plazo debe ser un entero entre 1 y ' + CFG().LIMITS.MAX_PLAZO_DIAS + ' días.');
  }

  // ---- descripción ----
  var descripcion = cleanText_(payload.descripcion);
  if (!descripcion) err('descripcion es obligatoria.');

  // ---- cliente ----
  var cliente = validateEntidadFK_(payload.cliente, 'cliente', [
    'razonSocial', 'tipoIdentificacion', 'numeroIdentificacion', 'direccion',
    'ciudad', 'departamento', 'pais', 'telefono', 'codigoCiiu', 'actividadPrincipal'
  ], errors);

  if (cliente && cliente.modo === 'nuevo' && cliente.datos) {
    if (!cleanText_(cliente.datos.razonSocial)) err('cliente.datos.razonSocial es obligatoria.');
    if (!cleanText_(cliente.datos.numeroIdentificacion)) err('cliente.datos.numeroIdentificacion es obligatorio.');
  }

  // ---- solicitante (contacto del cliente) ----
  var solicitante = validateEntidadFK_(payload.solicitante, 'solicitante', ['nombre', 'telefono', 'correo', 'cargo'], errors);
  if (solicitante && solicitante.modo === 'nuevo' && solicitante.datos) {
    if (!cleanText_(solicitante.datos.nombre)) err('solicitante.datos.nombre es obligatorio.');
  }

  // ---- establecimiento ----
  var establecimiento = null;
  if (!isPlainObject_(payload.establecimiento)) {
    err('establecimiento es obligatorio.');
  } else {
    var estModo = payload.establecimiento.modo;
    if (estModo !== 'existente' && estModo !== 'nuevo') {
      err('establecimiento.modo debe ser "existente" o "nuevo".');
    }
    establecimiento = {
      modo: estModo,
      idEstablecimiento: String(payload.establecimiento.idEstablecimiento || '').trim(),
      datos: null,
      encargado: null
    };
    if (estModo === 'existente' && !establecimiento.idEstablecimiento) {
      err('establecimiento.idEstablecimiento es obligatorio cuando modo="existente".');
    }
    if (estModo === 'nuevo') {
      var ed = payload.establecimiento.datos || {};
      establecimiento.datos = {
        nombre: cleanText_(ed.nombre),
        direccion: cleanText_(ed.direccion),
        ciudad: cleanText_(ed.ciudad),
        departamento: cleanText_(ed.departamento),
        pais: cleanText_(ed.pais)
      };
      if (!establecimiento.datos.nombre) err('establecimiento.datos.nombre es obligatorio.');

      var enc = ed.encargado;
      establecimiento.encargado = validateEntidadFK_(enc, 'establecimiento.datos.encargado', ['nombre', 'telefono', 'correo', 'cargo'], errors);
      if (establecimiento.encargado && establecimiento.encargado.modo === 'nuevo' && establecimiento.encargado.datos) {
        if (!cleanText_(establecimiento.encargado.datos.nombre)) err('establecimiento.datos.encargado.datos.nombre es obligatorio.');
      }
    }
  }

  // ---- servicios ----
  var servicios = validateServiciosArray_(payload.servicios, errors);

  // ESTADO: toda cotización nueva nace SIEMPRE en CFG().ESTADO_INICIAL; lo
  // que mande el cliente se ignora. Solo cambia después, una vez, con los
  // botones "Cotización aprobada/rechazada" de Gestionar cotización.
  var estado = CFG().ESTADO_INICIAL;

  if (errors.length) return { clean: null, errors: errors };

  var fechaVencimiento = addDays_(fechaElaboracion, plazo);

  return {
    clean: {
      requestId: requestId,
      fechaElaboracion: fechaElaboracion,
      plazo: plazo,
      fechaVencimiento: fechaVencimiento,
      descripcion: descripcion,
      estado: estado,
      cliente: cliente,
      solicitante: solicitante,
      establecimiento: establecimiento,
      servicios: servicios
    },
    errors: []
  };
}

/**
 * Valida y limpia un array de servicios (compartido entre creación y
 * edición de cotización). El servidor SIEMPRE reasigna `numero` según la
 * posición (1-based), ignora lo que mande el cliente. `idServicio`, si
 * viene, identifica un servicio YA EXISTENTE que se está editando (lo usa
 * qs_updateQuotation para decidir update-en-sitio vs. crear uno nuevo); en
 * creación siempre viene vacío.
 */
function validateServiciosArray_(serviciosRaw, errors) {
  var out = [];
  if (!Array.isArray(serviciosRaw) || serviciosRaw.length < 1) {
    errors.push('Debe incluir al menos 1 servicio.');
    return out;
  }
  if (serviciosRaw.length > CFG().LIMITS.MAX_SERVICIOS) {
    errors.push('No se permiten más de ' + CFG().LIMITS.MAX_SERVICIOS + ' servicios por cotización.');
    return out;
  }

  serviciosRaw.forEach(function (s, idx) {
    var numero = idx + 1;
    var idServicio = String((s && s.idServicio) || '').trim();
    var tipo = cleanText_(s && s.tipo);
    var codigoUnspsc = cleanText_(s && s.codigoUnspsc);
    var descripcionServicio = cleanText_(s && s.descripcion);

    if (!tipo) {
      errors.push('servicios[' + idx + '].tipo es obligatorio.');
    } else if (!cat_isTipoValido_(tipo)) {
      errors.push('servicios[' + idx + '].tipo "' + tipo + '" no existe en el catálogo TIPOS DE SERVICIOS.');
    }
    if (!descripcionServicio) errors.push('servicios[' + idx + '].descripcion es obligatoria.');

    var actividadesRaw = Array.isArray(s && s.actividades) ? s.actividades : [];
    if (actividadesRaw.length > CFG().LIMITS.MAX_ACTIVIDADES) {
      errors.push('servicios[' + idx + '].actividades no puede tener más de ' + CFG().LIMITS.MAX_ACTIVIDADES + '.');
    }
    var actividades = actividadesRaw
      .map(function (a) { return cleanText_(a); })
      .filter(function (a) { return a; });

    // Tarifas (solo llegan desde Gestionar cotización; en creación vienen
    // vacías). TOTAL del servicio siempre se recalcula aquí, nunca se toma
    // del cliente. '' = sin dato (celda vacía).
    var tarifa = validateEntero_(s && s.tarifa, 0, CFG().TARIFA_MAX);
    if (tarifa === null) errors.push('servicios[' + idx + '].tarifa debe ser un número entero entre 0 y ' + CFG().TARIFA_MAX + '.');
    var cantidad = validateEntero_(s && s.cantidad, 1, CFG().CANTIDAD_MAX);
    if (cantidad === null) errors.push('servicios[' + idx + '].cantidad debe ser un número entero entre 1 y ' + CFG().CANTIDAD_MAX + '.');
    if (tarifa !== '' && tarifa !== null && cantidad === '') cantidad = 1;
    var total = (tarifa !== '' && tarifa !== null && cantidad !== '' && cantidad !== null) ? tarifa * cantidad : '';
    var observaciones = cleanMultiline_(s && s.observaciones);

    out.push({
      numero: numero, idServicio: idServicio || null, tipo: tipo, codigoUnspsc: codigoUnspsc,
      descripcion: descripcionServicio, actividades: actividades,
      tarifa: tarifa === null ? '' : tarifa,
      cantidad: cantidad === null ? '' : cantidad,
      total: total,
      observaciones: observaciones
    });
  });

  return out;
}

/**
 * Entero opcional en [min, max]. Acepta número o string de solo dígitos.
 * Devuelve '' si viene vacío, el entero si es válido, o null si es inválido.
 */
function validateEntero_(raw, min, max) {
  if (raw === undefined || raw === null) return '';
  var str = String(raw).trim();
  if (str === '') return '';
  if (!/^\d+$/.test(str)) return null;
  var n = Number(str);
  if (!isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * Validación server-side de api_updateQuotation. A diferencia de la
 * creación: no hay fechaElaboracion (no se edita) ni modos "nuevo" para
 * cliente/solicitante/establecimiento — para cuando se llega aquí, cualquier
 * entidad nueva ya se creó y persistió desde el modal "Agregar" de la vista
 * de edición (mismo patrón que la vista de creación), así que siempre son
 * IDs de registros existentes.
 */
function validateUpdatePayload_(payload) {
  var errors = [];
  function err(msg) { errors.push(msg); }

  if (!isPlainObject_(payload)) {
    return { clean: null, errors: ['El payload de la cotización es inválido.'] };
  }

  var plazo = Math.trunc(Number(payload.plazo));
  if (!plazo || isNaN(plazo) || plazo < 1 || plazo > CFG().LIMITS.MAX_PLAZO_DIAS) {
    err('plazo debe ser un entero entre 1 y ' + CFG().LIMITS.MAX_PLAZO_DIAS + ' días.');
  }

  var descripcion = cleanText_(payload.descripcion);
  if (!descripcion) err('descripcion es obligatoria.');

  var idCliente = String((payload.cliente && payload.cliente.idCliente) || '').trim();
  if (!idCliente) err('cliente es obligatorio.');

  var idSolicitante = String((payload.solicitante && payload.solicitante.idContacto) || '').trim();
  if (!idSolicitante) err('solicitante es obligatorio.');

  var idEstablecimiento = String((payload.establecimiento && payload.establecimiento.idEstablecimiento) || '').trim();
  if (!idEstablecimiento) err('establecimiento es obligatorio.');

  // ESTADO es opcional: '' = conservar el actual. Si llega, solo puede ser la
  // decisión de Cotización (Aprobada/Rechazada); qs_updateQuotation verifica
  // además que la cotización siga en ESTADO_INICIAL (la decisión es única).
  var estado = String(payload.estado || '').trim();
  if (estado && estado !== CFG().ESTADO_APROBADA && estado !== CFG().ESTADO_RECHAZADA) {
    err('estado inválido: "' + estado + '". Valores permitidos: ' + CFG().ESTADO_APROBADA + ', ' + CFG().ESTADO_RECHAZADA + '.');
  }

  // ASESOR COMERCIAL: opcional, id de PERSONAL_KGP (desplegable en
  // "Gestionar cotización"). '' = sin asignar; qs_updateQuotation verifica
  // que exista si viene informado.
  var asesorComercial = String(payload.asesorComercial || '').trim();

  // TIEMPO DE ENTREGA: texto libre, opcional, editable únicamente desde
  // "Gestionar cotización" (no existe en el formulario de creación). Sin
  // formato fijo ("15 días hábiles", "Inmediato", ...) — mismo criterio que
  // descripcion/observaciones: cleanText_ antes de guardar.
  var tiempoEntrega = cleanText_(payload.tiempoEntrega);

  var servicios = validateServiciosArray_(payload.servicios, errors);

  if (errors.length) return { clean: null, errors: errors };

  return {
    clean: {
      plazo: plazo,
      descripcion: descripcion,
      estado: estado,
      idCliente: idCliente,
      idSolicitante: idSolicitante,
      idEstablecimiento: idEstablecimiento,
      asesorComercial: asesorComercial,
      tiempoEntrega: tiempoEntrega,
      servicios: servicios
    },
    errors: []
  };
}

/**
 * Valida el patrón común {modo: 'existente'|'nuevo', idX, datos:{...}} que
 * usan cliente/solicitante/encargado. Devuelve el objeto limpio o null si
 * la forma básica es inválida (y registra el error en `errors`).
 * requiredKeys: nombres de campos esperados en `datos` (solo para limpiar,
 * la obligatoriedad puntual se valida en el llamador).
 */
function validateEntidadFK_(input, label, camposDatos, errors) {
  if (!isPlainObject_(input)) {
    errors.push(label + ' es obligatorio.');
    return null;
  }
  var modo = input.modo;
  if (modo !== 'existente' && modo !== 'nuevo') {
    errors.push(label + '.modo debe ser "existente" o "nuevo".');
    return null;
  }

  var out = { modo: modo, idContacto: undefined, idCliente: undefined, datos: null };

  if (modo === 'existente') {
    var idVal = String(input.idContacto || input.idCliente || input.id || '').trim();
    if (!idVal) {
      errors.push(label + ': falta el ID cuando modo="existente".');
    }
    out.id = idVal;
  } else {
    var datos = isPlainObject_(input.datos) ? input.datos : {};
    var clean = {};
    camposDatos.forEach(function (campo) {
      clean[campo] = cleanText_(datos[campo]);
    });
    out.datos = clean;
  }

  return out;
}
