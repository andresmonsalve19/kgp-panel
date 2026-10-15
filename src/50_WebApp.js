/**
 * Punto de entrada de la Web App: doGet, include, y todas las funciones
 * api_* expuestas a google.script.run desde ui/*.html.
 *
 * doGet solo sirve el shell: los datos llegan vía api_bootstrap() después
 * del primer render. La única lectura de Sheets de doGet es la de la
 * configuración (hojas CONFIG_*, cfgs_refresh_), requisito explícito del
 * usuario: se relee en cada carga de la página. Toda api_* devuelve {ok,data,error,meta} (ver 01_Result.js)
 * y nunca deja escapar una excepción cruda (safeCall_).
 */

function doGet(e) {
  // Recargar/refrescar la página (F5) SIEMPRE pasa por acá — a diferencia
  // de las llamadas google.script.run que hace la SPA al navegar entre
  // vistas, que nunca vuelven a ejecutar doGet. Por eso este es el único
  // lugar correcto para invalidar las cachés basadas en dataVersion_
  // (cli_listClientes_, cli_getDetalleCompleto_, el short-circuit del
  // Dashboard) cuando el usuario pide explícitamente "ver todo de nuevo":
  // por ejemplo tras editar CLIENTES/CONTACTOS_CLIENTES/ESTABLECIMIENTOS_CLIENTES
  // a mano en el Sheet, que no pasa por safeCall_ y por lo tanto nunca
  // llama bumpDataVersion_ por sí solo. bumpDataVersion_ es solo una
  // escritura a ScriptProperties.
  bumpDataVersion_();

  // Requisito del usuario: la configuración (hojas CONFIG_* del spreadsheet
  // de catálogo, 06_ConfigSheet.js) se lee SIEMPRE al cargar la página. Una
  // sola apertura del spreadsheet; el resultado queda en caché para todas las
  // llamadas google.script.run de esta sesión. Si falla, se usa la copia
  // anterior o los valores del código (nunca impide abrir la app).
  cfgs_refresh_();

  var t = HtmlService.createTemplateFromFile('ui/Index');
  t.initialView = (e && e.parameter && e.parameter.v === 'dashboard') ? 'dashboard' : 'cotizacion';
  // Parámetros que usa el navegador (IVA, límites, días de aviso...): van
  // dentro del HTML, así el cliente no necesita otro round-trip para tenerlos.
  var clientConfig = {};
  try { clientConfig = cfgs_clientConfig_(); } catch (err) { clientConfig = {}; }
  // JSON listo para un <script>: "<" escapado para que un texto de la config
  // nunca pueda cerrar la etiqueta.
  t.clientConfigJson = JSON.stringify(clientConfig).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle('KGP Panel')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Usado por las plantillas HTML: <?!= include('ui/Styles.css'); ?> */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// ---------------------------------------------------------------------
// API — Formulario de cotización
// ---------------------------------------------------------------------

/** Datos iniciales para pintar el formulario: catálogo, clientes, estados, defaults. */
function api_bootstrap() {
  return safeCall_('api_bootstrap', function () {
    var user = '';
    try { user = Session.getActiveUser().getEmail() || ''; } catch (e) { user = ''; }

    var warnings = [];
    var schemaOk = true;
    var tiposServicio = [];
    var catalogoPares = [];
    var clientes = [];
    var empleados = [];
    var terceros = [];
    var codigoTentativo = null;

    try {
      catalogoPares = cat_getCatalogoPares_();
      tiposServicio = catalogoPares.map(function (p) { return p.tipo; });
    } catch (e) {
      schemaOk = false;
      warnings.push('Catálogo de tipos de servicio no disponible: ' + errMsg_(e));
    }
    try {
      clientes = cli_listClientes_();
    } catch (e) {
      schemaOk = false;
      warnings.push('Listado de clientes no disponible: ' + errMsg_(e));
    }
    try {
      // Usado por "Gestionar cotización" para el desplegable de Asesor
      // comercial (ver CLAUDE.md §2.1: se pasa por KGP.catalog en vez de un
      // google.script.run aparte, mismo criterio que tiposServicio/clientes).
      empleados = emp_listEmpleados_();
    } catch (e) {
      // No crítico: el desplegable de Asesor comercial queda vacío.
    }
    try {
      // Terceros / independientes: solo para el responsable de las tareas de
      // OIS/OIP (KGP.ui.responsables). El asesor comercial sigue siendo interno.
      terceros = emp_listEmpleados_(CFG().TIPO_RESPONSABLE_TERCERO);
    } catch (e) {
      // No crítico: sin la hoja PERSONAL_TERCEROS solo se ofrecen internos.
    }
    try {
      // Informativo únicamente (no reserva el consecutivo): se incluye aquí
      // para que la vista cargue en un solo round-trip en vez de dos.
      codigoTentativo = code_previewNext_(new Date());
    } catch (e) {
      // No crítico: el campo de código se queda en su valor por defecto.
    }
    if (!CFG().TEMPLATE_SHEET_ID) {
      warnings.push('La plantilla del documento aún no se ha preparado (falta ejecutar admin_convertTemplate()). Podrás crear cotizaciones, pero no generar el documento hasta que esto se resuelva.');
    }

    return ok_({
      user: user,
      tiposServicio: tiposServicio,
      catalogoPares: catalogoPares,
      clientes: clientes,
      empleados: empleados,
      terceros: terceros,
      estados: CFG().ESTADOS,
      defaults: { plazo: CFG().COTIZACION_PLAZO_DEFAULT, fechaElaboracion: toISODate_(new Date()), estado: CFG().ESTADO_INICIAL },
      codigoTentativo: codigoTentativo,
      schemaOk: schemaOk,
      warnings: warnings
    });
  });
}

/**
 * Solo los datos propios de un cliente (sin contactos/establecimientos):
 * lectura rápida de una fila para habilitar "Editar cliente" sin esperar a
 * que carguen sus dependientes (ver api_getClienteDetalle, más pesado).
 */
function api_getCliente(idCliente) {
  return safeCall_('api_getCliente', function () {
    if (!idCliente) return fail_('VALIDATION', 'Falta idCliente.');
    var cliente = cli_getCliente_(idCliente);
    if (!cliente) return fail_('NOT_FOUND', 'No existe el cliente ' + idCliente + '.');
    return ok_(cliente);
  });
}

/** Contactos y establecimientos de un cliente, para los dropdowns dependientes. */
function api_getClienteDetalle(idCliente) {
  return safeCall_('api_getClienteDetalle', function () {
    if (!idCliente) return fail_('VALIDATION', 'Falta idCliente.');
    var detalle = cli_getDetalleCompleto_(idCliente);
    if (!detalle) return fail_('NOT_FOUND', 'No existe el cliente ' + idCliente + '.');
    return ok_(detalle);
  });
}

/** Fase 1: valida, resuelve/crea FKs, reserva CODIGO, escribe las 5 hojas. */
function api_createQuotation(payload) {
  return safeCall_('api_createQuotation', function () {
    return qs_createQuotation(payload);
  });
}

/**
 * Fase 2: genera el documento .xlsx a partir de una cotización ya creada.
 * Con requestId (solo la creación) envía además el correo "cotización
 * creada" al creador, con el enlace al documento (39_NotifyService.js).
 */
function api_generateDocument(idCotizacion, requestId) {
  return safeCall_('api_generateDocument', function () {
    if (!idCotizacion) return fail_('VALIDATION', 'Falta idCotizacion.');
    var res = doc_generateForQuotation_(idCotizacion, requestId);
    if (requestId) ntf_onDocumentoCotizacion_(idCotizacion, res, true);
    return res;
  });
}

/**
 * Reintenta la generación del documento de una cotización cuyo DOC ESTADO
 * quedó en ERROR (y regenera tras "Guardar cambios"). Si el correo de
 * "cotización creada" quedó pendiente porque el documento inicial falló,
 * sale aquí en la primera regeneración exitosa.
 */
function api_regenerateDocument(idCotizacion) {
  return safeCall_('api_regenerateDocument', function () {
    if (!idCotizacion) return fail_('VALIDATION', 'Falta idCotizacion.');
    var res = doc_regenerate_(idCotizacion);
    ntf_onDocumentoCotizacion_(idCotizacion, res, false);
    return res;
  });
}

/** Detalle completo de una cotización (para la vista de detalle del dashboard). */
function api_getCotizacion(idCotizacion) {
  return safeCall_('api_getCotizacion', function () {
    if (!idCotizacion) return fail_('VALIDATION', 'Falta idCotizacion.');
    return qs_getCotizacion(idCotizacion);
  });
}

/**
 * Edita una cotización ya creada: campos generales (plazo, descripción,
 * cliente/solicitante/establecimiento), su lista de servicios (agregar,
 * editar, quitar) con sus tarifas, y los totales SUBTOTAL/IVA/TOTAL.
 * payload.estado solo se usa para la decisión única de garantía
 * (Aprobada/Rechazada); vacío = conservar. NO cambia fechaElaboracion ni CODIGO. No
 * regenera el documento por sí sola — el cliente llama api_generateDocument
 * (o regenerateDocument) después, igual que en la creación (fase 2 aparte).
 */
function api_updateQuotation(idCotizacion, payload) {
  return safeCall_('api_updateQuotation', function () {
    if (!idCotizacion) return fail_('VALIDATION', 'Falta idCotizacion.');
    return qs_updateQuotation(idCotizacion, payload);
  });
}

/** Alta rápida de cliente desde el panel "Crear Cliente Nuevo" (se guarda de inmediato). */
function api_createCliente(datos) {
  return safeCall_('api_createCliente', function () {
    return qs_createCliente(datos);
  });
}

/** Alta rápida de un contacto del cliente (solicitante o encargado de un establecimiento). */
function api_createContacto(idCliente, datos) {
  return safeCall_('api_createContacto', function () {
    return qs_createContacto(idCliente, datos);
  });
}

/** Alta rápida de un establecimiento del cliente. idContacto (encargado) es opcional. */
function api_createEstablecimiento(idCliente, datos, idContacto) {
  return safeCall_('api_createEstablecimiento', function () {
    return qs_createEstablecimiento(idCliente, datos, idContacto);
  });
}

/** Edita un cliente ya existente. */
function api_updateCliente(idCliente, datos) {
  return safeCall_('api_updateCliente', function () {
    return qs_updateCliente(idCliente, datos);
  });
}

/** Edita un contacto ya existente (solicitante o encargado). */
function api_updateContacto(idContacto, datos) {
  return safeCall_('api_updateContacto', function () {
    return qs_updateContacto(idContacto, datos);
  });
}

/** Edita un establecimiento ya existente. */
function api_updateEstablecimiento(idEstablecimiento, datos) {
  return safeCall_('api_updateEstablecimiento', function () {
    return qs_updateEstablecimiento(idEstablecimiento, datos);
  });
}

// ---------------------------------------------------------------------
// API — OIS (orden interna de servicio)
// ---------------------------------------------------------------------

/**
 * Popup "Garantía aprobada" -> "Crear OIS": guarda la cotización como
 * Aprobada y crea su OIS en una sola transacción (ver ois_aprobarConOis).
 * No genera documentos: el cliente llama después api_regenerateDocument
 * (cotización) y api_generateOisDocument (OIS).
 */
function api_aprobarConOis(idCotizacion, payload, requestId) {
  return safeCall_('api_aprobarConOis', function () {
    return ois_aprobarConOis(idCotizacion, payload, requestId);
  });
}

/** Listado paginado/filtrado de "Gestionar OIS" (mismo contrato de params que api_getDashboard). */
function api_listOis(params) {
  return safeCall_('api_listOis', function () {
    return ois_listOis(params || {});
  });
}

/** Detalle de una OIS + tareas + todo el detalle de su cotización padre. */
function api_getOis(idOis) {
  return safeCall_('api_getOis', function () {
    return ois_getOis(idOis);
  });
}

/** "Guardar cambios" de Gestionar OIS (BD). Devuelve {cotizacionCambio} para decidir qué documentos regenerar. */
function api_updateOis(idOis, payload) {
  return safeCall_('api_updateOis', function () {
    return ois_updateOis(idOis, payload);
  });
}

/**
 * Genera el documento de la OIS (primera vez, con requestId para
 * idempotencia). Con requestId (flujo de aprobación) envía además el correo
 * "cotización aprobada" al creador, con el código de la OIS y su enlace.
 */
function api_generateOisDocument(idOis, requestId) {
  return safeCall_('api_generateOisDocument', function () {
    if (!idOis) return fail_('VALIDATION', 'Falta idOis.');
    var res = doc_generateForOis_(idOis, requestId || null);
    if (requestId) ntf_onDocumentoOrden_('OIS', idOis, res, true);
    return res;
  });
}

/** Regenera el documento de la OIS (tras "Guardar cambios" o para reintentar un DOC ESTADO = ERROR). Envía el correo de aprobación si quedó pendiente. */
function api_regenerateOisDocument(idOis) {
  return safeCall_('api_regenerateOisDocument', function () {
    if (!idOis) return fail_('VALIDATION', 'Falta idOis.');
    var res = doc_generateForOis_(idOis, null);
    ntf_onDocumentoOrden_('OIS', idOis, res, false);
    return res;
  });
}

// ---------------------------------------------------------------------
// API — OIP
// ---------------------------------------------------------------------

/**
 * Popup "Garantía aprobada" -> "OIP": guarda la cotización como Aprobada y
 * crea su OIP en una sola transacción (ver oip_aprobarConOip). No genera
 * documentos: el cliente llama después api_regenerateDocument (cotización) y
 * api_generateOipDocument (OIP).
 */
function api_aprobarConOip(idCotizacion, payload, requestId) {
  return safeCall_('api_aprobarConOip', function () {
    return oip_aprobarConOip(idCotizacion, payload, requestId);
  });
}

/** Listado paginado/filtrado de "Gestionar OIP" (mismo contrato de params que api_listOis). */
function api_listOip(params) {
  return safeCall_('api_listOip', function () {
    return oip_listOip(params || {});
  });
}

/** Detalle de una OIP + tareas + facturación + todo el detalle de su cotización padre. */
function api_getOip(idOip) {
  return safeCall_('api_getOip', function () {
    return oip_getOip(idOip);
  });
}

/** "Guardar cambios" de Gestionar OIP (BD). Devuelve {cotizacionCambio} para decidir qué documentos regenerar. */
function api_updateOip(idOip, payload) {
  return safeCall_('api_updateOip', function () {
    return oip_updateOip(idOip, payload);
  });
}

/**
 * Genera el documento de la OIP (primera vez, con requestId para
 * idempotencia). Con requestId (flujo de aprobación) envía además el correo
 * "cotización aprobada" al creador, con el código de la OIP y su enlace.
 */
function api_generateOipDocument(idOip, requestId) {
  return safeCall_('api_generateOipDocument', function () {
    if (!idOip) return fail_('VALIDATION', 'Falta idOip.');
    var res = doc_generateForOip_(idOip, requestId || null);
    if (requestId) ntf_onDocumentoOrden_('OIP', idOip, res, true);
    return res;
  });
}

/** Regenera el documento de la OIP (tras "Guardar cambios" o para reintentar un DOC ESTADO = ERROR). Envía el correo de aprobación si quedó pendiente. */
function api_regenerateOipDocument(idOip) {
  return safeCall_('api_regenerateOipDocument', function () {
    if (!idOip) return fail_('VALIDATION', 'Falta idOip.');
    var res = doc_generateForOip_(idOip, null);
    ntf_onDocumentoOrden_('OIP', idOip, res, false);
    return res;
  });
}

/**
 * Crea o edita una fila de facturación de la OIP. A diferencia de las tareas,
 * se guarda de inmediato (no espera el "Guardar cambios" de la vista) y no
 * regenera ningún documento: la facturación solo vive en la BD.
 * idFacturacion vacío = crear.
 */
function api_saveOipFactura(idOip, idFacturacion, payload) {
  return safeCall_('api_saveOipFactura', function () {
    return oip_saveFactura(idOip, idFacturacion, payload);
  });
}

/** Elimina una fila de facturación de la OIP. */
function api_deleteOipFactura(idOip, idFacturacion) {
  return safeCall_('api_deleteOipFactura', function () {
    return oip_deleteFactura(idOip, idFacturacion);
  });
}

// ---------------------------------------------------------------------
// API — Gestionar tareas (TAREAS_OIS + TAREAS_OIP en una sola vista)
// ---------------------------------------------------------------------

/** Snapshot completo de "Gestionar tareas": tareas de OIS y OIP, órdenes, empleados y usuario activo (ver tg_snapshot). */
function api_listTareas() {
  return safeCall_('api_listTareas', function () {
    return tg_snapshot();
  });
}

/**
 * Crea (payload.idTarea vacío) o edita UNA tarea de una OIS u OIP y la guarda
 * de inmediato. No regenera el documento de la orden: el cliente llama
 * después api_regenerateOisDocument / api_regenerateOipDocument.
 */
function api_saveTarea(payload) {
  return safeCall_('api_saveTarea', function () {
    return tg_saveTarea(payload);
  });
}

/** Finaliza o reabre una tarea (solo la celda ESTADO) y recalcula el estado de su orden. */
function api_setTareaEstado(tipo, idOrden, idTarea, estado) {
  return safeCall_('api_setTareaEstado', function () {
    return tg_setTareaEstado(tipo, idOrden, idTarea, estado);
  });
}

/** Elimina una tarea de su orden y recalcula el estado de la orden. */
function api_deleteTarea(tipo, idOrden, idTarea) {
  return safeCall_('api_deleteTarea', function () {
    return tg_deleteTarea(tipo, idOrden, idTarea);
  });
}

// ---------------------------------------------------------------------
// API — Gestión de clientes (40_ClienteService.js). Altas y ediciones usan
// los endpoints de arriba (api_createCliente, api_updateCliente, ...).
// ---------------------------------------------------------------------

/** Todos los clientes con sus conteos de contactos, establecimientos y cotizaciones. */
function api_listClientesGestion() {
  return safeCall_('api_listClientesGestion', function () {
    return clis_listGestion();
  });
}

/** Detalle de un cliente: datos + contactos + establecimientos + historial de cotizaciones. */
function api_getClienteGestion(idCliente) {
  return safeCall_('api_getClienteGestion', function () {
    return clis_getGestion(idCliente);
  });
}

/** Borra un cliente (y sus contactos/establecimientos) si ninguna cotización lo usa. */
function api_deleteCliente(idCliente) {
  return safeCall_('api_deleteCliente', function () {
    return clis_deleteCliente(idCliente);
  });
}

/** Borra un contacto si ninguna cotización lo tiene como solicitante. */
function api_deleteContacto(idContacto) {
  return safeCall_('api_deleteContacto', function () {
    return clis_deleteContacto(idContacto);
  });
}

/** Borra un establecimiento si ninguna cotización lo usa. */
function api_deleteEstablecimiento(idEstablecimiento) {
  return safeCall_('api_deleteEstablecimiento', function () {
    return clis_deleteEstablecimiento(idEstablecimiento);
  });
}

/** Asigna (o quita, con idContacto vacío) el contacto encargado de un establecimiento. */
function api_setEncargadoEstablecimiento(idEstablecimiento, idContacto) {
  return safeCall_('api_setEncargadoEstablecimiento', function () {
    return clis_setEncargado(idEstablecimiento, idContacto);
  });
}

// ---------------------------------------------------------------------
// API — Gestión de empleados (PERSONAL_KGP y PERSONAL_TERCEROS)
// ---------------------------------------------------------------------

/**
 * Listado completo para la vista de gestión. tipo: CFG().TIPO_RESPONSABLE_
 * INTERNO (PERSONAL_KGP, por defecto) o _TERCERO (PERSONAL_TERCEROS). Lo mismo
 * para create/update/delete de abajo.
 */
function api_listEmpleados(tipo) {
  return safeCall_('api_listEmpleados', function () {
    return ok_(emp_listEmpleados_(tipo));
  });
}

/** Alta de un empleado nuevo (interno o tercero). */
function api_createEmpleado(datos, tipo) {
  return safeCall_('api_createEmpleado', function () {
    return emps_createEmpleado(datos, tipo);
  });
}

/** Edita un empleado ya existente (interno o tercero). */
function api_updateEmpleado(idEmpleado, datos, tipo) {
  return safeCall_('api_updateEmpleado', function () {
    return emps_updateEmpleado(idEmpleado, datos, tipo);
  });
}

/** Elimina un empleado (interno o tercero). */
function api_deleteEmpleado(idEmpleado, tipo) {
  return safeCall_('api_deleteEmpleado', function () {
    return emps_deleteEmpleado(idEmpleado, tipo);
  });
}

// ---------------------------------------------------------------------
// API — Dashboard
// ---------------------------------------------------------------------

/** Snapshot paginado del dashboard, con protocolo de versión para polling barato (ver 32_DashboardService.js). */
function api_getDashboard(params) {
  return safeCall_('api_getDashboard', function () {
    return ds_getDashboard_(params || {});
  });
}

/**
 * Snapshot COMPLETO del dashboard (todas las cotizaciones agregadas por ID
 * COTIZACION, más catálogos de filtro). Lo consume el Dashboard, que a
 * partir de aquí filtra, ordena, pagina y grafica en el cliente sin volver
 * al servidor. params: {sinceVersion} — ver ds_getSnapshot_.
 */
function api_getDashboardSnapshot(params) {
  return safeCall_('api_getDashboardSnapshot', function () {
    return ds_getSnapshot_(params || {});
  });
}

/**
 * Snapshot COMPLETO de OIS y OIP para las pestañas "OIS" / "OIP" del
 * Dashboard (mismo protocolo de versión que api_getDashboardSnapshot; el
 * token incluye la fecha de hoy porque el estado "Vencida" depende del día).
 * params: {sinceVersion} — ver ds_getOrdenesSnapshot_.
 */
function api_getOrdenesDashboard(params) {
  return safeCall_('api_getOrdenesDashboard', function () {
    return ds_getOrdenesSnapshot_(params || {});
  });
}

// ---------------------------------------------------------------------
// API — Diagnóstico (usable también desde la UI, además de admin_health() en el editor)
// ---------------------------------------------------------------------

function api_health() {
  return safeCall_('api_health', function () {
    return ok_(admin_health());
  });
}
