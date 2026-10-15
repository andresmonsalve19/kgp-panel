/**
 * ORDEN INTERNA DE SERVICIO (OIS) — funciones públicas.
 *
 * Una OIS nace de UNA cotización al aprobarla (popup "Cotización aprobada" ->
 * "OIS" en Gestionar cotización); una cotización produce a lo sumo una orden.
 * La OIS NO duplica los datos de la cotización: cliente, solicitante,
 * establecimiento y servicios se leen de la cotización padre, y "Guardar
 * cambios" en Gestionar OIS los reescribe allí mismo. Lo propio de la OIS son
 * su fila en la hoja OIS (plazo, vencimiento, estado, trazabilidad) y sus
 * tareas (TAREAS_OIS).
 *
 * Toda la lógica es común con la OIP y vive en 41_OrdenComun.js; aquí solo se
 * fija el tipo. Reglas propias de la OIS (en ord_spec_('OIS')): una OIS
 * Finalizada es de solo lectura, el plazo inicial es el de la cotización y el
 * tope de tareas es el de la plantilla (CFG_().LIMITS.MAX_TAREAS).
 *
 * Mismo patrón de 2 fases que la cotización: la BD dentro del lock; los
 * documentos después, desde el cliente (api_generateOisDocument).
 */

/**
 * Aprueba la cotización y crea su OIS en una sola transacción.
 * @param {string} idCotizacion
 * @param {!Object} payload Formulario de Gestionar cotización.
 * @param {string} requestId UUID para idempotencia.
 * @return {!Object} ok_({cotizacion, idOis, codigoOis}) o fail_.
 */
function ois_aprobarConOis(idCotizacion, payload, requestId) {
  return ord_aprobar_(ord_spec_('OIS'), 'ois_aprobarConOis', idCotizacion, payload, requestId);
}

/**
 * Detalle de una OIS + tareas + todo el detalle de su cotización padre.
 * @param {string} idOis
 * @return {!Object} ok_({ois, tareas, cotizacion, servicios, cliente,
 *     solicitante, establecimiento}) o fail_.
 */
function ois_getOis(idOis) {
  return ord_obtener_(ord_spec_('OIS'), idOis);
}

/**
 * Listado de "Gestionar OIS": filtra por año/estado/texto, ordena y pagina.
 * @param {!Object} params Ver ord_listar_.
 * @return {!Object} ok_({rows, total, page, pageSize})
 */
function ois_listOis(params) {
  return ord_listar_(ord_spec_('OIS'), params);
}

/**
 * "Guardar cambios" de Gestionar OIS. CONFLICT si la OIS ya está Finalizada.
 * @param {string} idOis
 * @param {!Object} payload Ver ord_validarPayload_.
 * @return {!Object} ok_({idOis, codigo, estado, fechaVencimiento,
 *     cotizacionCambio, tareas}) o fail_.
 */
function ois_updateOis(idOis, payload) {
  return ord_actualizar_(ord_spec_('OIS'), 'ois_updateOis', idOis, payload);
}
