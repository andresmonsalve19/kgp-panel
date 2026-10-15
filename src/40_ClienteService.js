/**
 * Orquestación de "Gestión de clientes" (ui/ViewClientes.html +
 * ui/JsClientes.js.html): listado de todas las empresas clientes con sus
 * conteos, detalle (datos + contactos + establecimientos + historial de
 * cotizaciones) y las BAJAS. Las altas y ediciones reutilizan los endpoints
 * de siempre (api_createCliente / api_updateCliente / api_createContacto /
 * api_updateContacto / api_createEstablecimiento / api_updateEstablecimiento,
 * 30_QuoteService.js): no se duplica esa lógica aquí.
 *
 * Bajas (decisión del usuario: borrar la fila, no desactivar):
 *   - Cliente: solo si NINGUNA cotización lo usa; borra también sus
 *     contactos y establecimientos (sin cotizaciones, nadie más los usa).
 *   - Contacto: solo si ninguna cotización lo tiene como solicitante.
 *   - Establecimiento: solo si ninguna cotización lo usa; a los contactos que
 *     eran su encargado se les limpia ID ESTABLECIMIENTO.
 * Un rechazo es CONFLICT con las cotizaciones que lo impiden (hasta 5 códigos).
 *
 * Mismo patrón que el resto de escrituras: lock corto, flush + bumpDataVersion_
 * antes de soltarlo (invalida las cachés de listados y desplegables).
 */

/** Cotizaciones agregadas por ID COTIZACION (una fila por servicio en la hoja -> una por cotización). */
function clis_cotizaciones_() {
  var vistas = {};
  var lista = [];
  qr_tableCotizaciones_().rows.forEach(function (r) {
    var id = r[normText_('ID COTIZACION')];
    if (!id || vistas[id]) return;
    vistas[id] = true;
    lista.push({
      idCotizacion: id,
      codigo: r[normText_('CODIGO')] || '',
      idCliente: String(r[normText_('ID CLIENTE')] || ''),
      idSolicitante: String(r[normText_('ID SOLICITANTE')] || ''),
      idEstablecimiento: String(r[normText_('ID ESTABLECIMIENTO')] || ''),
      fechaElaboracion: qs_dateToISO_(r[normText_('FECHA ELABORACION')]),
      estado: qs_normEstado_(r[normText_('ESTADO')]),
      total: qr_num_(r[normText_('TOTAL')])
    });
  });
  return lista;
}

/**
 * Todos los clientes (activos e inactivos) con sus conteos de contactos,
 * establecimientos y cotizaciones. Cacheado por dataVersion (cualquier
 * escritura lo invalida). Solo se lee al entrar a la vista, nunca en la carga
 * de la página.
 */
function clis_listGestion() {
  var key = 'cli:gestion:v' + dataVersion_();
  var cached = cacheGetJson_(key);
  if (cached) return ok_(cached);

  function contar(table, col) {
    var n = {};
    table.rows.forEach(function (r) {
      var id = String(r[normText_(col)] || '');
      if (id) n[id] = (n[id] || 0) + 1;
    });
    return n;
  }
  var nCon = contar(con_table_(), 'ID CLIENTE');
  var nEst = contar(est_table_(), 'ID CLIENTE');
  var nCot = {};
  clis_cotizaciones_().forEach(function (c) { if (c.idCliente) nCot[c.idCliente] = (nCot[c.idCliente] || 0) + 1; });

  var clientes = cli_table_().rows.map(function (r) {
    var c = cli_rowToObj_(r);
    var id = String(c.idCliente || '');
    c.activo = String(c.activo) !== '0';
    c.numContactos = nCon[id] || 0;
    c.numEstablecimientos = nEst[id] || 0;
    c.numCotizaciones = nCot[id] || 0;
    return c;
  }).filter(function (c) { return c.idCliente; });

  var data = { clientes: clientes };
  cachePutJson_(key, data, CFG_().CACHE_TTL.CLIENTES_S);
  return ok_(data);
}

/** Detalle para la vista: cliente + contactos + establecimientos + sus cotizaciones (más recientes primero). */
function clis_getGestion(idCliente) {
  idCliente = String(idCliente || '').trim();
  if (!idCliente) return fail_('VALIDATION', 'Falta idCliente.');
  var cliente = cli_getCliente_(idCliente);
  if (!cliente) return fail_('NOT_FOUND', 'No existe el cliente ' + idCliente + '.');
  cliente.activo = String(cliente.activo) !== '0';
  var cotizaciones = clis_cotizaciones_()
    .filter(function (c) { return c.idCliente === idCliente; })
    .sort(function (a, b) { return a.fechaElaboracion < b.fechaElaboracion ? 1 : a.fechaElaboracion > b.fechaElaboracion ? -1 : 0; });
  return ok_({
    cliente: cliente,
    contactos: con_listByCliente_(idCliente),
    establecimientos: est_listByCliente_(idCliente),
    cotizaciones: cotizaciones
  });
}

/** CONFLICT si alguna cotización usa el registro (campo de clis_cotizaciones_ = id). null si está libre. */
function clis_bloqueoPorUso_(campo, id, queEs) {
  var usos = clis_cotizaciones_().filter(function (c) { return c[campo] === id; });
  if (!usos.length) return null;
  var codigos = usos.slice(0, 5).map(function (c) { return c.codigo; }).join(', ') + (usos.length > 5 ? '…' : '');
  var detalle = usos.length === 1
    ? 'lo usa la cotización ' + codigos
    : 'lo usan ' + usos.length + ' cotizaciones (' + codigos + ')';
  return fail_('CONFLICT', 'No se puede eliminar ' + queEs + ': ' + detalle + '.', { cotizaciones: usos.length });
}

/**
 * Borra el cliente y sus contactos/establecimientos, solo si no tiene cotizaciones.
 * @param {string} idCliente
 * @return {!Object} ok_({idCliente, contactosBorrados, establecimientosBorrados}) o fail_.
 */
function clis_deleteCliente(idCliente) {
  idCliente = String(idCliente || '').trim();
  if (!idCliente) return fail_('VALIDATION', 'Falta idCliente.');
  return tx_conLock_('clis_deleteCliente', function () {
    var match = repo_findRowByCol_(cli_table_(), 'ID CLIENTE', idCliente);
    if (!match) return fail_('NOT_FOUND', 'No existe el cliente ' + idCliente + '.');
    var bloqueo = clis_bloqueoPorUso_('idCliente', idCliente, 'el cliente');
    if (bloqueo) return bloqueo;

    var cfg = CFG_();
    var filasCon = repo_findRowsByCol_(con_table_(), 'ID CLIENTE', [idCliente]).map(function (m) { return m.rowIndex; });
    var filasEst = repo_findRowsByCol_(est_table_(), 'ID CLIENTE', [idCliente]).map(function (m) { return m.rowIndex; });
    repo_deleteRows_(cfg.DB_SHEET_ID, cfg.TABS.CONTACTOS, filasCon);
    repo_deleteRows_(cfg.DB_SHEET_ID, cfg.TABS.ESTABLECIMIENTOS, filasEst);
    repo_deleteRows_(cfg.DB_SHEET_ID, cfg.TABS.CLIENTES, [match.rowIndex]);
    return ok_({ idCliente: idCliente, contactosBorrados: filasCon.length, establecimientosBorrados: filasEst.length });
  }, { ids: { idCliente: idCliente } });
}

/** Borra un contacto, solo si ninguna cotización lo tiene como solicitante. */
function clis_deleteContacto(idContacto) {
  idContacto = String(idContacto || '').trim();
  if (!idContacto) return fail_('VALIDATION', 'Falta idContacto.');
  return tx_conLock_('clis_deleteContacto', function () {
    var match = repo_findRowByCol_(con_table_(), 'ID CONTACTO', idContacto);
    if (!match) return fail_('NOT_FOUND', 'No existe el contacto ' + idContacto + '.');
    var bloqueo = clis_bloqueoPorUso_('idSolicitante', idContacto, 'el contacto');
    if (bloqueo) return bloqueo;
    repo_deleteRows_(CFG_().DB_SHEET_ID, CFG_().TABS.CONTACTOS, [match.rowIndex]);
    return ok_({ idContacto: idContacto });
  }, { ids: { idContacto: idContacto } });
}

/** Borra un establecimiento, solo si ninguna cotización lo usa; desasocia a su encargado. */
function clis_deleteEstablecimiento(idEstablecimiento) {
  idEstablecimiento = String(idEstablecimiento || '').trim();
  if (!idEstablecimiento) return fail_('VALIDATION', 'Falta idEstablecimiento.');
  return tx_conLock_('clis_deleteEstablecimiento', function () {
    var match = repo_findRowByCol_(est_table_(), 'ID ESTABLECIMIENTO', idEstablecimiento);
    if (!match) return fail_('NOT_FOUND', 'No existe el establecimiento ' + idEstablecimiento + '.');
    var bloqueo = clis_bloqueoPorUso_('idEstablecimiento', idEstablecimiento, 'el establecimiento');
    if (bloqueo) return bloqueo;
    // La FK de encargado vive en el contacto (CONTACTOS_CLIENTES.ID ESTABLECIMIENTO).
    repo_findRowsByCol_(con_table_(), 'ID ESTABLECIMIENTO', [idEstablecimiento]).forEach(function (m) {
      con_setEstablecimiento_(m.obj[normText_('ID CONTACTO')], '');
    });
    repo_deleteRows_(CFG_().DB_SHEET_ID, CFG_().TABS.ESTABLECIMIENTOS, [match.rowIndex]);
    return ok_({ idEstablecimiento: idEstablecimiento });
  }, { ids: { idEstablecimiento: idEstablecimiento } });
}

/** Asigna (o quita, con idContacto vacío) el contacto encargado de un establecimiento. */
function clis_setEncargado(idEstablecimiento, idContacto) {
  idEstablecimiento = String(idEstablecimiento || '').trim();
  idContacto = String(idContacto || '').trim();
  if (!idEstablecimiento) return fail_('VALIDATION', 'Falta idEstablecimiento.');
  return tx_conLock_('clis_setEncargado', function () {
    var est = est_getEstablecimiento_(idEstablecimiento);
    if (!est) return fail_('NOT_FOUND', 'No existe el establecimiento ' + idEstablecimiento + '.');
    if (idContacto) {
      var con = con_getContacto_(idContacto);
      if (!con) return fail_('NOT_FOUND', 'No existe el contacto ' + idContacto + '.');
      if (String(con.idCliente) !== String(est.idCliente)) return fail_('VALIDATION', 'El contacto no pertenece al mismo cliente que el establecimiento.');
    }
    // Un establecimiento tiene a lo sumo un encargado: se desasocia el anterior.
    repo_findRowsByCol_(con_table_(), 'ID ESTABLECIMIENTO', [idEstablecimiento]).forEach(function (m) {
      var id = m.obj[normText_('ID CONTACTO')];
      if (id !== idContacto) con_setEstablecimiento_(id, '');
    });
    if (idContacto) con_setEstablecimiento_(idContacto, idEstablecimiento);
    return ok_({ idEstablecimiento: idEstablecimiento, idContacto: idContacto });
  }, { ids: { idEstablecimiento: idEstablecimiento, idContacto: idContacto } });
}
