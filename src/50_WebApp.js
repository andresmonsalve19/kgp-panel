/**
 * Punto de entrada de la Web App: doGet, include, y todas las funciones
 * api_* expuestas a google.script.run desde ui/*.html.
 *
 * doGet solo sirve el shell (cero lectura de Sheets): los datos llegan vía
 * api_bootstrap() después del primer render, así el HTML pinta de
 * inmediato. Toda api_* devuelve {ok,data,error,meta} (ver 01_Result.js)
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
  // llama bumpDataVersion_ por sí solo. Sigue sin leer Sheets (ver doc de
  // arriba): bumpDataVersion_ es solo una escritura a ScriptProperties.
  bumpDataVersion_();

  var t = HtmlService.createTemplateFromFile('ui/Index');
  t.initialView = (e && e.parameter && e.parameter.v === 'dashboard') ? 'dashboard' : 'cotizacion';
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
      estados: CFG().ESTADOS,
      defaults: { plazo: 15, fechaElaboracion: toISODate_(new Date()), estado: CFG().ESTADO_INICIAL },
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

/** Fase 2: genera el documento .xlsx a partir de una cotización ya creada. */
function api_generateDocument(idCotizacion, requestId) {
  return safeCall_('api_generateDocument', function () {
    if (!idCotizacion) return fail_('VALIDATION', 'Falta idCotizacion.');
    return doc_generateForQuotation_(idCotizacion, requestId);
  });
}

/** Reintenta la generación del documento de una cotización cuyo DOC ESTADO quedó en ERROR. */
function api_regenerateDocument(idCotizacion) {
  return safeCall_('api_regenerateDocument', function () {
    if (!idCotizacion) return fail_('VALIDATION', 'Falta idCotizacion.');
    return doc_regenerate_(idCotizacion);
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

/** Genera el documento de la OIS (primera vez, con requestId para idempotencia). */
function api_generateOisDocument(idOis, requestId) {
  return safeCall_('api_generateOisDocument', function () {
    if (!idOis) return fail_('VALIDATION', 'Falta idOis.');
    return doc_generateForOis_(idOis, requestId || null);
  });
}

/** Regenera el documento de la OIS (tras "Guardar cambios" o para reintentar un DOC ESTADO = ERROR). */
function api_regenerateOisDocument(idOis) {
  return safeCall_('api_regenerateOisDocument', function () {
    if (!idOis) return fail_('VALIDATION', 'Falta idOis.');
    return doc_generateForOis_(idOis, null);
  });
}

// ---------------------------------------------------------------------
// API — Gestión de empleados (PERSONAL_KGP)
// ---------------------------------------------------------------------

/** Listado completo de empleados para la vista de gestión. */
function api_listEmpleados() {
  return safeCall_('api_listEmpleados', function () {
    return ok_(emp_listEmpleados_());
  });
}

/** Alta de un empleado nuevo. */
function api_createEmpleado(datos) {
  return safeCall_('api_createEmpleado', function () {
    return emps_createEmpleado(datos);
  });
}

/** Edita un empleado ya existente. */
function api_updateEmpleado(idEmpleado, datos) {
  return safeCall_('api_updateEmpleado', function () {
    return emps_updateEmpleado(idEmpleado, datos);
  });
}

/** Elimina un empleado. */
function api_deleteEmpleado(idEmpleado) {
  return safeCall_('api_deleteEmpleado', function () {
    return emps_deleteEmpleado(idEmpleado);
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

// ---------------------------------------------------------------------
// API — Diagnóstico (usable también desde la UI, además de admin_health() en el editor)
// ---------------------------------------------------------------------

function api_health() {
  return safeCall_('api_health', function () {
    return ok_(admin_health());
  });
}
