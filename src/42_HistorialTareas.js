/**
 * Historial de cambios de las tareas (OIS y OIP): quién cambió qué y cuándo.
 *
 * Hoja HISTORIAL_TAREAS (CFG_().TABS.HISTORIAL_TAREAS, en la BD principal):
 * una fila por cambio, nunca se edita ni se borra (es un registro de
 * auditoría). Columnas: ver SCHEMA_().HISTORIAL_TAREAS. La crea
 * admin_prepararHistorialTareas() (51_Admin.js).
 *
 * Quién escribe aquí — TODA escritura de tareas, dentro de su mismo lock:
 *   - "Gestionar tareas": tg_saveTarea / tg_setTareaEstado / tg_deleteTarea.
 *   - "Gestionar OIS/OIP" (Guardar cambios): ord_sincronizarTareas_.
 * Una edición que no cambió nada no deja fila. Si solo cambió el estado, la
 * acción es FINALIZADA / REABIERTA; si cambió algo más, EDITADA (con el
 * estado incluido en el detalle).
 *
 * Además, las hojas de tareas tienen ACTUALIZADO POR / ACTUALIZADO EN
 * (opcionales): el último cambio de cada tarea sin tener que leer este
 * historial (el listado de "Gestionar tareas" lo muestra en cada fila).
 *
 * Reglas:
 *   - htar_registrar_ NUNCA lanza: si la hoja no existe o falla el append,
 *     queda en _ERRORES y la operación de la tarea sigue (el historial no
 *     puede tumbar un guardado que ya escribió las tareas).
 *   - La lectura (api_getHistorialTareas) es bajo demanda, al abrir el popup
 *     de historial: nunca se lee desde el snapshot ni desde una carga de vista
 *     (CLAUDE.md §2, esta hoja solo crece).
 */

/** Acciones que se registran (valor de la columna ACCION). */
function htar_acciones_() {
  return {
    CREADA: 'CREADA',
    EDITADA: 'EDITADA',
    FINALIZADA: 'FINALIZADA',
    REABIERTA: 'REABIERTA',
    ELIMINADA: 'ELIMINADA'
  };
}

/**
 * Usuario activo para el historial y ACTUALIZADO POR, resuelto una vez por
 * ejecución. etiqueta = nombre del empleado (PERSONAL_KGP, por correo) o, si
 * no está registrado, el correo; '' si Apps Script no expone al usuario
 * (executeAs USER_DEPLOYING con una cuenta de fuera del dominio).
 * @return {{nombre: string, correo: string, etiqueta: string}}
 */
function htar_usuario_() {
  var memo = repo_memo_();
  if (!memo.__htarUsuario) {
    var correo = qs_correoUsuarioActivo_();
    var nombre = correo ? emps_nombreUsuarioActivo_() : '';
    memo.__htarUsuario = { nombre: nombre, correo: correo, etiqueta: nombre || correo };
  }
  return memo.__htarUsuario;
}

/**
 * Sello del último cambio, para las columnas ACTUALIZADO POR / ACTUALIZADO EN
 * de la tarea (se copia sobre el objeto que va a tar_toRow_ / tarp_toRow_).
 * @return {{actualizadoPor: string, actualizadoEn: !Date}}
 */
function htar_sello_() {
  return { actualizadoPor: htar_usuario_().etiqueta, actualizadoEn: new Date() };
}

/** Fecha de una celda (Date o texto) -> 'yyyy-MM-dd HH:mm' ('' si vacía). */
function htar_fechaHora_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') return fmtDate_(value, 'yyyy-MM-dd HH:mm');
  return String(value);
}

/** Estado de tarea normalizado a uno de los dos válidos (mismo criterio que ord_tareaToDto_). */
function htar_estado_(estado) {
  var cfg = CFG_();
  return estado === cfg.TAREA_ESTADO_FINALIZADA ? cfg.TAREA_ESTADO_FINALIZADA : cfg.TAREA_ESTADO_INICIAL;
}

/** Texto corto para el detalle (una línea, máx. 300 caracteres). */
function htar_corto_(s) {
  var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > 300 ? t.slice(0, 297) + '...' : (t || '(vacío)');
}

/**
 * Resumen de una tarea (al crearla o eliminarla).
 * @param {!Object} t Tarea de dominio o validada.
 * @param {boolean} conEstado
 * @return {string}
 */
function htar_resumen_(t, conEstado) {
  var lineas = [
    'Responsable: ' + htar_corto_(t.responsable || t.idEmpleado),
    'Fecha de inicio: ' + (qs_dateToISO_(t.fechaInicio) || '—'),
    'Fecha de entrega: ' + (qs_dateToISO_(t.fechaEntrega) || '—')
  ];
  if (conEstado) lineas.push('Estado: ' + htar_estado_(t.estado));
  var obs = String(t.observacion || '').trim();
  if (obs) lineas.push('Observación: ' + htar_corto_(obs));
  return lineas.join('\n');
}

/**
 * Qué cambió entre la tarea guardada y la nueva versión.
 * @param {!Object} antes Tarea de la hoja (tar_rowToObj_ / tarp_rowToObj_).
 * @param {!Object} despues Tarea validada con responsable resuelto.
 * @return {{lineas: !Array<string>, soloEstado: boolean, escribir: boolean}}
 *     lineas: una por campo visible que cambió ('Campo: antes → después').
 *     escribir: hay que reescribir la fila (también cuando solo cambió algo
 *     no visible, como TIPO RESPONSABLE vacío en una tarea antigua).
 */
function htar_diff_(antes, despues) {
  var lineas = [];
  var estadoCambio = false;

  if (String(antes.tarea || '') !== String(despues.tarea || '')) {
    lineas.push('Tarea: ' + htar_corto_(antes.tarea) + ' → ' + htar_corto_(despues.tarea));
  }
  if (String(antes.idEmpleado || '') !== String(despues.idEmpleado || '')) {
    lineas.push('Responsable: ' + htar_corto_(antes.responsable || antes.idEmpleado) + ' → ' + htar_corto_(despues.responsable || despues.idEmpleado));
  }
  var ini0 = qs_dateToISO_(antes.fechaInicio), ini1 = qs_dateToISO_(despues.fechaInicio);
  if (ini0 !== ini1) lineas.push('Fecha de inicio: ' + (ini0 || '—') + ' → ' + (ini1 || '—'));
  var ent0 = qs_dateToISO_(antes.fechaEntrega), ent1 = qs_dateToISO_(despues.fechaEntrega);
  if (ent0 !== ent1) lineas.push('Fecha de entrega: ' + (ent0 || '—') + ' → ' + (ent1 || '—'));

  // OBSERVACION es acumulativa: lo normal es que se agregue una línea al final.
  var obs0 = String(antes.observacion || '').trim(), obs1 = String(despues.observacion || '').trim();
  if (obs0 !== obs1) {
    if (obs1.indexOf(obs0) === 0 && obs1.length > obs0.length) {
      lineas.push('Observación agregada: ' + htar_corto_(obs1.slice(obs0.length)));
    } else {
      lineas.push('Observación modificada: ' + htar_corto_(obs1));
    }
  }

  var est0 = htar_estado_(antes.estado), est1 = htar_estado_(despues.estado);
  if (est0 !== est1) {
    estadoCambio = true;
    lineas.push('Estado: ' + est0 + ' → ' + est1);
  }

  var tipoCambio = String(antes.tipoResponsable || '') !== String(despues.tipoResponsable || '') ||
    String(antes.responsable || '') !== String(despues.responsable || '');
  return {
    lineas: lineas,
    soloEstado: estadoCambio && lineas.length === 1,
    escribir: lineas.length > 0 || tipoCambio
  };
}

/**
 * Entrada del historial para una edición, o null si no cambió nada visible.
 * @param {!Object} spec ord_spec_(...)
 * @param {!Object} orden Objeto de dominio de la orden (codigo).
 * @param {string} idOrden
 * @param {string} idTarea
 * @param {!Object} diff Salida de htar_diff_.
 * @param {string} textoTarea Texto de la tarea (ya con el cambio).
 * @param {string} estadoNuevo
 * @return {Object}
 */
function htar_entradaEdicion_(spec, orden, idOrden, idTarea, diff, textoTarea, estadoNuevo) {
  if (!diff.lineas.length) return null;
  var acc = htar_acciones_();
  var accion = acc.EDITADA;
  if (diff.soloEstado) accion = htar_estado_(estadoNuevo) === CFG_().TAREA_ESTADO_FINALIZADA ? acc.FINALIZADA : acc.REABIERTA;
  return htar_entrada_(spec, orden, idOrden, idTarea, textoTarea, accion, diff.lineas.join('\n'));
}

/**
 * Una entrada lista para htar_registrar_.
 * @return {!Object}
 */
function htar_entrada_(spec, orden, idOrden, idTarea, textoTarea, accion, detalle) {
  return {
    tipo: spec.tipo,
    idOrden: idOrden,
    codigoOrden: (orden && orden.codigo) || '',
    idTarea: idTarea,
    tarea: textoTarea,
    accion: accion,
    detalle: detalle
  };
}

/**
 * Agrega las entradas al historial con UN solo append. Se llama dentro del
 * lock de la escritura de tareas, al final (después de escribir las tareas).
 * NUNCA lanza (ver el encabezado).
 * @param {!Array<Object>} entradas (se ignoran los null)
 */
function htar_registrar_(entradas) {
  var lista = (entradas || []).filter(Boolean);
  if (!lista.length) return;
  try {
    var cfg = CFG_();
    var u = htar_usuario_();
    var ahora = new Date();
    repo_appendRows_(cfg.DB_SHEET_ID, cfg.TABS.HISTORIAL_TAREAS, lista.map(function (e) {
      return {
        'ID HISTORIAL': id_new_(cfg.ID_PREFIJO_HISTORIAL_TAREA),
        'FECHA': ahora,
        'TIPO ORDEN': e.tipo,
        'ID ORDEN': e.idOrden,
        'CODIGO ORDEN': e.codigoOrden,
        'ID TAREA': e.idTarea,
        'TAREA': truncate_(e.tarea),
        'ACCION': e.accion,
        'DETALLE': truncate_(e.detalle),
        'USUARIO': u.etiqueta || 'Usuario no identificado',
        'CORREO USUARIO': u.correo
      };
    }));
  } catch (err) {
    logError_('htar_registrar_', null, { entradas: lista.length, idTarea: lista[0].idTarea }, lista.slice(0, 5), err);
  }
}

/**
 * Historial de una tarea o de todas las tareas de una orden (también las ya
 * eliminadas), del más reciente al más antiguo. Siempre fresco, bajo demanda.
 *
 * @param {{tipo: string, idOrden: (string|undefined), idTarea: (string|undefined)}} params
 *     tipo 'OIS'|'OIP' y al menos uno de idOrden / idTarea.
 * @return {!Object} ok_({entradas: [{fecha, accion, usuario, correo, tarea,
 *     idTarea, codigoOrden, detalle}], total, truncado, aviso})
 */
function htar_listar_(params) {
  params = isPlainObject_(params) ? params : {};
  var spec = ord_spec_(params.tipo);
  if (!spec) return fail_('VALIDATION', 'Tipo de orden inválido.');
  var idOrden = String(params.idOrden || '').trim();
  var idTarea = String(params.idTarea || '').trim();
  if (!idOrden && !idTarea) return fail_('VALIDATION', 'Falta la orden o la tarea.');

  var cfg = CFG_();
  var table;
  try {
    table = repo_readTable_(cfg.DB_SHEET_ID, cfg.TABS.HISTORIAL_TAREAS);
    repo_requireCols_(table.hmap, cfg.TABS.HISTORIAL_TAREAS, SCHEMA_().HISTORIAL_TAREAS.required);
  } catch (e) {
    if (e && e.code === 'SCHEMA') {
      return ok_({ entradas: [], total: 0, truncado: false,
        aviso: 'El historial todavía no está activado: falta la hoja ' + cfg.TABS.HISTORIAL_TAREAS + ' (se crea con admin_prepararHistorialTareas).' });
    }
    throw e;
  }

  var c = {
    tipo: normText_('TIPO ORDEN'), idOrden: normText_('ID ORDEN'), idTarea: normText_('ID TAREA'),
    fecha: normText_('FECHA'), accion: normText_('ACCION'), usuario: normText_('USUARIO'),
    correo: normText_('CORREO USUARIO'), tarea: normText_('TAREA'), codigo: normText_('CODIGO ORDEN'),
    detalle: normText_('DETALLE')
  };
  var filas = table.rows.filter(function (r) {
    if (String(r[c.tipo] || '').toUpperCase() !== spec.tipo) return false;
    if (idTarea && String(r[c.idTarea]) !== idTarea) return false;
    if (idOrden && String(r[c.idOrden]) !== idOrden) return false;
    return true;
  });
  // Más reciente primero; a igual fecha (mismo guardado), la fila posterior primero.
  function ms(v) { return Object.prototype.toString.call(v) === '[object Date]' ? v.getTime() : 0; }
  filas.sort(function (a, b) {
    return (ms(b[c.fecha]) - ms(a[c.fecha])) || (b.__row - a.__row);
  });

  var max = cfg.LIMITS.MAX_HISTORIAL_TAREAS;
  return ok_({
    entradas: filas.slice(0, max).map(function (r) {
      return {
        fecha: htar_fechaHora_(r[c.fecha]),
        accion: String(r[c.accion] || ''),
        usuario: String(r[c.usuario] || ''),
        correo: String(r[c.correo] || ''),
        tarea: String(r[c.tarea] || ''),
        idTarea: String(r[c.idTarea] || ''),
        codigoOrden: String(r[c.codigo] || ''),
        detalle: String(r[c.detalle] || '')
      };
    }),
    total: filas.length,
    truncado: filas.length > max,
    aviso: ''
  });
}
