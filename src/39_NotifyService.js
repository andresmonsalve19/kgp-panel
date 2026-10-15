/**
 * Avisos por correo de los eventos del flujo (CLAUDE.md §14). Todos usan la
 * plantilla única de 04_MailTemplate.js; aquí solo se decide CUÁNDO, A QUIÉN
 * y CON QUÉ VARIABLES. Los textos (asunto, título, párrafos, botón, datos
 * destacados) NO están aquí: salen de mail_textos_(clave), es decir, de la
 * hoja CONFIG_CORREO_TEXTOS o, si está vacía, de mail_textosDefault_.
 *
 *   1. Cotización creada  -> al creador, con el código y el enlace al
 *      documento. Se envía cuando el documento ya existe (fase 2,
 *      api_generateDocument), no al guardar en la BD: sin documento no hay
 *      enlace que mandar.
 *   2. Cotización aprobada -> al creador, con el código de la OIS/OIP y el
 *      enlace al documento de la orden (api_generateOisDocument /
 *      api_generateOipDocument con requestId = generación inicial).
 *      Cotización rechazada -> al creador, con el enlace al documento de la
 *      cotización (qs_updateQuotation, ya fuera del lock: el link es el mismo
 *      archivo de siempre, §8).
 *   3. Tarea creada -> al responsable (CORREO de PERSONAL_KGP), desde
 *      "Gestionar tareas" (tg_saveTarea) y desde "Guardar cambios" de
 *      Gestionar OIS/OIP (tareas nuevas, sin ID).
 *
 * "El creador" = CREADO POR de la cotización (correo del usuario activo al
 * crearla) o, si está vacío, el CORREO del empleado ELABORADO POR. Con
 * executeAs USER_DEPLOYING, getActiveUser() puede venir vacío para usuarios
 * de fuera del dominio: en ese caso no hay a quién escribir y queda el rastro
 * en _ERRORES.
 *
 * Reglas:
 *   - Nunca dentro del script lock y nunca rompen la operación que los
 *     dispara: cualquier fallo se registra con logError_ y se sigue.
 *   - Correos 1 y 2 (aprobación) dependen de que el documento se genere: si
 *     la generación inicial falla, queda una marca NTF_PEND_<evento>_<id> en
 *     ScriptProperties y el correo sale en la primera regeneración exitosa de
 *     ese documento (api_regenerate*). Un reintento de la generación inicial
 *     (mismo requestId) no duplica el correo: marca 'ntf:sent:' en caché 6h.
 */

/** Nombre largo de cada tipo de orden, para el texto de los correos. */
function ntf_nombreOrden_(tipo) {
  return tipo === 'OIP' ? 'Orden Interna de Proyectos' : 'Orden Interna de Servicio';
}

/** "14 de octubre de 2026" a partir de una Date o de 'yyyy-MM-dd'. '' si no hay fecha. */
function ntf_fechaLarga_(v) {
  var d = (Object.prototype.toString.call(v) === '[object Date]') ? v : parseISODate_(v);
  if (!d || isNaN(d.getTime())) return '';
  return fmtDate_(d, 'd') + ' de ' + oipn_nombreMes_(Number(fmtDate_(d, 'M'))) + ' de ' + fmtDate_(d, 'yyyy');
}

/**
 * Datos de una cotización que necesitan los correos, incluido su creador:
 * {idCotizacion, codigo, cliente, fechaElaboracion, urlDocumento,
 * correoCreador, nombreCreador}. null si la cotización no existe.
 */
function ntf_infoCotizacion_(idCotizacion) {
  var filas = qr_getCotizacionRows_(idCotizacion);
  if (!filas.length) return null;
  var base = filas[0].obj;

  var correo = String(base[normText_('CREADO POR')] || '').trim();
  var emp = null;
  try { emp = correo ? emp_findByCorreo_(correo) : null; } catch (e) { emp = null; }
  var idElaborador = base[normText_('ELABORADO POR')];
  if (!emp && idElaborador) {
    try { emp = emp_getEmpleado_(idElaborador); } catch (e2) { emp = null; }
  }
  if (!correo && emp) correo = String(emp.correo || '').trim();

  var cliente = null;
  try { cliente = cli_getCliente_(base[normText_('ID CLIENTE')]); } catch (e3) { cliente = null; }

  return {
    idCotizacion: idCotizacion,
    codigo: base[normText_('CODIGO')] || '',
    cliente: (cliente && cliente.razonSocial) || '',
    fechaElaboracion: base[normText_('FECHA ELABORACION')],
    urlDocumento: base[normText_('URL DOCUMENTO')] || '',
    correoCreador: correo,
    nombreCreador: emp ? emp.nombre : ''
  };
}

/** Deja rastro en _ERRORES de un correo que no se pudo enviar (sin relanzar). */
function ntf_log_(etapa, ids, err) {
  logError_(etapa, null, ids, null, err);
}

/**
 * Envío de un correo que depende de un documento recién generado (eventos 1
 * y 2). evento: 'CTZ' | 'OIS' | 'OIP'; id: de la cotización o de la orden;
 * docRes: respuesta de doc_generate*; inicial: true = primera generación
 * (con requestId), false = regeneración (solo envía si quedó pendiente).
 * enviar(docUrl): manda el correo; devuelve false si no hay destinatario
 * (permanente: no se reintenta) y lanza si el envío falla (se reintenta en la
 * próxima regeneración exitosa).
 */
function ntf_trasDocumento_(evento, id, docRes, inicial, enviar) {
  var pendKey = 'NTF_PEND_' + evento + '_' + id;
  var props;
  try {
    props = PropertiesService.getScriptProperties();
    if (!docRes || !docRes.ok) {
      if (inicial) props.setProperty(pendKey, '1');
      return;
    }
    if (!inicial && !props.getProperty(pendKey)) return;

    var sentKey = 'ntf:sent:' + evento + ':' + id;
    if (!cache_().get(sentKey)) {
      enviar(docRes.data && docRes.data.docUrl);
      cache_().put(sentKey, '1', 21600);
    }
    props.deleteProperty(pendKey);
  } catch (e) {
    ntf_log_('ntf_trasDocumento_:' + evento, { id: id, idCotizacion: evento === 'CTZ' ? id : '' }, e);
    try { if (props) props.setProperty(pendKey, '1'); } catch (e2) { /* sin marca: no se reintenta */ }
  }
}

// ---------------------------------------------------------------------
// 1. Cotización creada
// ---------------------------------------------------------------------

/** Llamado tras api_generateDocument (inicial) / api_regenerateDocument. */
function ntf_onDocumentoCotizacion_(idCotizacion, docRes, inicial) {
  ntf_trasDocumento_('CTZ', idCotizacion, docRes, inicial, function (docUrl) {
    var info = ntf_infoCotizacion_(idCotizacion);
    if (!info) return false;
    if (!info.correoCreador) {
      ntf_log_('ntf_cotizacionCreada', { idCotizacion: idCotizacion },
        new AppError_('MAIL', 'No se envió el correo de cotización creada (' + info.codigo + '): no se encontró el correo de quien la creó (CREADO POR vacío y ELABORADO POR sin correo).'));
      return false;
    }
    mail_enviar_('COTIZACION_CREADA', info.correoCreador, {
      nombre: info.nombreCreador,
      codigo: info.codigo,
      cliente: info.cliente,
      estado: CFG().ESTADO_INICIAL,
      fechaElaboracion: ntf_fechaLarga_(info.fechaElaboracion)
    }, { url: docUrl || info.urlDocumento });
    return true;
  });
}

// ---------------------------------------------------------------------
// 2. Cotización aprobada (OIS / OIP) o rechazada
// ---------------------------------------------------------------------

/**
 * Llamado tras api_generateOisDocument / api_generateOipDocument (inicial =
 * con requestId, que solo manda el flujo de aprobación de Gestionar
 * cotización) y tras sus api_regenerate* (solo si el correo quedó pendiente).
 */
function ntf_onDocumentoOrden_(tipo, idOrden, docRes, inicial) {
  ntf_trasDocumento_(tipo, idOrden, docRes, inicial, function (docUrl) {
    var found = tipo === 'OIP' ? oip_findById_(idOrden) : ois_findById_(idOrden);
    if (!found) return false;
    var orden = found.obj;
    var info = ntf_infoCotizacion_(orden.idCotizacion);
    if (!info) return false;
    if (!info.correoCreador) {
      ntf_log_('ntf_cotizacionAprobada', { idCotizacion: orden.idCotizacion, idOrden: idOrden },
        new AppError_('MAIL', 'No se envió el correo de cotización aprobada (' + info.codigo + ' / ' + orden.codigo + '): no se encontró el correo de quien creó la cotización.'));
      return false;
    }
    mail_enviar_('COTIZACION_APROBADA', info.correoCreador, {
      nombre: info.nombreCreador,
      codigo: info.codigo,
      cliente: info.cliente,
      tipoOrden: tipo,
      nombreOrden: ntf_nombreOrden_(tipo),
      codigoOrden: orden.codigo,
      fechaAprobacion: ntf_fechaLarga_(orden.fechaElaboracion)
    }, { url: docUrl || orden.urlDocumento });
    return true;
  });
}

/** Llamado por qs_updateQuotation, ya fuera del lock, cuando la cotización acaba de pasar a Rechazada. */
function ntf_cotizacionRechazada_(idCotizacion) {
  try {
    var info = ntf_infoCotizacion_(idCotizacion);
    if (!info) return;
    if (!info.correoCreador) {
      ntf_log_('ntf_cotizacionRechazada', { idCotizacion: idCotizacion },
        new AppError_('MAIL', 'No se envió el correo de cotización rechazada (' + info.codigo + '): no se encontró el correo de quien la creó.'));
      return;
    }
    mail_enviar_('COTIZACION_RECHAZADA', info.correoCreador, {
      nombre: info.nombreCreador,
      codigo: info.codigo,
      cliente: info.cliente,
      fecha: ntf_fechaLarga_(new Date()),
      tieneDocumento: info.urlDocumento ? 'si' : ''
    }, { url: info.urlDocumento });
  } catch (e) {
    ntf_log_('ntf_cotizacionRechazada', { idCotizacion: idCotizacion }, e);
  }
}

// ---------------------------------------------------------------------
// 3. Tarea creada
// ---------------------------------------------------------------------

/**
 * Un correo por tarea nueva, a su responsable. tipo: 'OIS' | 'OIP'; orden:
 * objeto de dominio de la orden ({codigo, idCotizacion, urlDocumento});
 * tareas: tareas ya validadas ({tarea, idEmpleado, responsable, fechaEntrega,
 * observacion}). Llamar SIEMPRE fuera del lock.
 */
function ntf_tareasCreadas_(tipo, orden, tareas) {
  if (!orden || !tareas || !tareas.length) return;
  var cliente = '';
  var responsables = [];
  try {
    var info = ntf_infoCotizacion_(orden.idCotizacion);
    cliente = info ? info.cliente : '';
    responsables = emp_listResponsables_(); // internos + terceros
  } catch (e) {
    ntf_log_('ntf_tareasCreadas_', { idCotizacion: orden.idCotizacion }, e);
    return;
  }
  var nombreOrden = ntf_nombreOrden_(tipo);

  tareas.forEach(function (t) {
    try {
      var emp = emp_buscarResponsable_(responsables, t.idEmpleado, t.tipoResponsable);
      var correo = emp ? String(emp.correo || '').trim() : '';
      if (!correo) {
        throw new AppError_('MAIL', 'No se envió el aviso de la tarea "' + truncate_(t.tarea, 80) + '" (' + tipo + ' ' + orden.codigo +
          '): el responsable ' + (t.responsable || t.idEmpleado) + ' no tiene correo registrado.');
      }
      mail_enviar_('TAREA_ASIGNADA', correo, {
        nombre: emp.nombre,
        tarea: t.tarea,
        descripcion: String(t.observacion || '').trim(),
        tipoOrden: tipo,
        nombreOrden: nombreOrden,
        codigoOrden: orden.codigo,
        cliente: cliente,
        fechaInicio: ntf_fechaLarga_(t.fechaInicio),
        fechaEntrega: ntf_fechaLarga_(t.fechaEntrega)
      }, { url: orden.urlDocumento });
    } catch (e2) {
      ntf_log_('ntf_tareasCreadas_', { idCotizacion: orden.idCotizacion, orden: orden.codigo }, e2);
    }
  });
}
