/**
 * ORDEN INTERNA DE PROYECTOS (OIP) — funciones públicas y facturación.
 *
 * Calca la OIS (35_OisService.js): toda la lógica común vive en
 * 41_OrdenComun.js. Diferencias deliberadas, confirmadas con el usuario (están
 * en ord_spec_('OIP') o en este archivo):
 *   1. PLAZO nace en CFG_().OIP_PLAZO_DEFAULT (365 días), no hereda el de la
 *      cotización.
 *   2. El consecutivo NO reinicia cada año (oip_codeReserve_, 20_Ids.js).
 *   3. Una OIP Finalizada NO queda de solo lectura: sigue facturando ~1 año.
 *   4. Las tareas no tienen un bloque fijo en la plantilla (se insertan filas)
 *      y la vista las agrupa por mes de FECHA ENTREGA.
 *   5. Facturación mensual (OIP_FACTURACION): se guarda al instante (no espera
 *      "Guardar cambios") y nunca se escribe en el documento.
 */

/**
 * Aprueba la cotización y crea su OIP en una sola transacción. CONFLICT si la
 * cotización ya tiene OIS u OIP.
 * @param {string} idCotizacion
 * @param {!Object} payload Formulario de Gestionar cotización.
 * @param {string} requestId UUID para idempotencia.
 * @return {!Object} ok_({cotizacion, idOip, codigoOip}) o fail_.
 */
function oip_aprobarConOip(idCotizacion, payload, requestId) {
  return ord_aprobar_(ord_spec_('OIP'), 'oip_aprobarConOip', idCotizacion, payload, requestId);
}

/**
 * Detalle de una OIP + tareas + facturación + detalle de su cotización padre.
 * @param {string} idOip
 * @return {!Object} ok_({oip, tareas, facturacion, cotizacion, servicios,
 *     cliente, solicitante, establecimiento}) o fail_.
 */
function oip_getOip(idOip) {
  return ord_obtener_(ord_spec_('OIP'), idOip);
}

/**
 * Listado de "Gestionar OIP" (mismo contrato que ois_listOis).
 * @param {!Object} params Ver ord_listar_.
 * @return {!Object} ok_({rows, total, page, pageSize})
 */
function oip_listOip(params) {
  return ord_listar_(ord_spec_('OIP'), params);
}

/**
 * "Guardar cambios" de Gestionar OIP. Sin bloqueo por estado (ver punto 3).
 * @param {string} idOip
 * @param {!Object} payload Ver ord_validarPayload_.
 * @return {!Object} ok_({idOip, codigo, estado, fechaVencimiento,
 *     cotizacionCambio, tareas}) o fail_.
 */
function oip_updateOip(idOip, payload) {
  return ord_actualizar_(ord_spec_('OIP'), 'oip_updateOip', idOip, payload);
}

// ---------------------------------------------------------------------
// Facturación (se guarda al instante, no espera "Guardar cambios")
// ---------------------------------------------------------------------

/**
 * Fila de facturación de la hoja -> DTO para la UI.
 * @param {!Object} f fac_rowToObj_.
 * @return {!Object}
 */
function oip_facturaToDto_(f) {
  var cfg = CFG_();
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

/**
 * Valida una fila del formulario de factura. MES se guarda como NÚMERO (1-12),
 * no como nombre: el recordatorio mensual compara mes/año sin depender de
 * acentos ni de cómo esté escrito el nombre en la hoja.
 * @param {*} payload {mes, year, cuota, numeroFactura, estado}
 * @return {{clean: ?Object, errors: !Array<string>}}
 */
function validateFacturaPayload_(payload) {
  var errors = [];
  if (!isPlainObject_(payload)) return { clean: null, errors: ['El payload de la factura es inválido.'] };
  var cfg = CFG_();

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
 * Crea (idFacturacion vacío) o edita una fila de OIP_FACTURACION y la
 * persiste de inmediato. No toca la cotización ni regenera documentos.
 * @param {string} idOip
 * @param {string} idFacturacion '' / null = crear.
 * @param {!Object} payload Ver validateFacturaPayload_.
 * @return {!Object} ok_({idFacturacion, facturacion}) o fail_.
 */
function oip_saveFactura(idOip, idFacturacion, payload) {
  idOip = String(idOip || '').trim();
  idFacturacion = String(idFacturacion || '').trim();
  if (!idOip) return fail_('VALIDATION', 'Falta idOip.');

  var validation = validateFacturaPayload_(payload);
  if (validation.errors.length) return fail_('VALIDATION', 'El formulario de la factura tiene errores.', validation.errors);
  var clean = validation.clean;

  return tx_conLock_('oip_saveFactura', function () {
    if (!oip_findById_(idOip)) return fail_('NOT_FOUND', 'No existe la OIP ' + idOip + '.');

    var filas = fac_getRowsByOip_(idOip);
    if (idFacturacion) {
      var fila = filas.filter(function (f) { return f.obj.idFacturacion === idFacturacion; })[0];
      if (!fila) return fail_('NOT_FOUND', 'No existe la fila de facturación ' + idFacturacion + '.');
      fac_update_(fila.rowIndex, idFacturacion, idOip, clean);
    } else {
      var max = CFG_().LIMITS.MAX_FACTURAS_OIP;
      if (filas.length >= max) return fail_('VALIDATION', 'Esta OIP ya tiene el máximo de ' + max + ' filas de facturación.');
      idFacturacion = fac_create_(idOip, clean);
    }
    return ok_({ idFacturacion: idFacturacion, facturacion: fac_getByOip_(idOip).map(oip_facturaToDto_) });
  }, { ids: { idOip: idOip, idFacturacion: idFacturacion }, payload: payload });
}

/**
 * Elimina una fila de facturación de una OIP.
 * @param {string} idOip
 * @param {string} idFacturacion
 * @return {!Object} ok_({idFacturacion, facturacion}) o fail_.
 */
function oip_deleteFactura(idOip, idFacturacion) {
  idOip = String(idOip || '').trim();
  idFacturacion = String(idFacturacion || '').trim();
  if (!idOip) return fail_('VALIDATION', 'Falta idOip.');
  if (!idFacturacion) return fail_('VALIDATION', 'Falta idFacturacion.');

  return tx_conLock_('oip_deleteFactura', function () {
    var fila = fac_getRowsByOip_(idOip).filter(function (f) { return f.obj.idFacturacion === idFacturacion; })[0];
    if (!fila) return fail_('NOT_FOUND', 'No existe la fila de facturación ' + idFacturacion + '.');
    fac_deleteRows_([fila.rowIndex]);
    return ok_({ idFacturacion: idFacturacion, facturacion: fac_getByOip_(idOip).map(oip_facturaToDto_) });
  }, { ids: { idOip: idOip, idFacturacion: idFacturacion } });
}
