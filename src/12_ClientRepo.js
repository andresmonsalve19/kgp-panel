/**
 * Repos de CLIENTES, CONTACTOS_CLIENTES y ESTABLECIMIENTOS_CLIENTES.
 * Todas las funciones que crean filas devuelven el ID recién generado
 * (ver 20_Ids.js) y NO incrementan dataVersion_ por sí mismas: eso lo hace
 * el orquestador (30_QuoteService.js) una sola vez al final de la
 * transacción completa.
 */

// ---------- CLIENTES ----------

/** CLIENTES leída (memo) y con sus columnas requeridas verificadas. */
function cli_table_() {
  var t = repo_readTable_(CFG_().DB_SHEET_ID, CFG_().TABS.CLIENTES);
  repo_requireCols_(t.hmap, CFG_().TABS.CLIENTES, SCHEMA_().CLIENTES.required);
  return t;
}

/** Fila cruda de CLIENTES -> objeto de dominio. */
function cli_rowToObj_(row) {
  return {
    idCliente: row[normText_('ID CLIENTE')],
    razonSocial: row[normText_('RAZON SOCIAL')],
    tipoIdentificacion: row[normText_('TIPO IDENTIFICACION')],
    numeroIdentificacion: row[normText_('NUMERO IDENTIFICACION')],
    direccion: row[normText_('DIRECCION')],
    ciudad: row[normText_('CIUDAD')],
    departamento: row[normText_('DEPARTAMENTO')],
    pais: row[normText_('PAIS')],
    telefono: row[normText_('TELEFONO')],
    codigoCiiu: row[normText_('CODIGO CIIU')],
    actividadPrincipal: row[normText_('ACTIVIDAD PRINCIPAL')],
    activo: row[normText_('ACTIVO')]
  };
}

/** Lista liviana para el dropdown del formulario. Cacheada por dataVersion. */
function cli_listClientes_() {
  var v = dataVersion_();
  var key = 'cli:list:v' + v;
  var cached = cacheGetJson_(key);
  if (cached) return cached;

  var table = cli_table_();
  var list = table.rows
    .filter(function (row) { return String(row[normText_('ACTIVO')]) !== '0'; })
    .map(function (row) {
      return {
        idCliente: row[normText_('ID CLIENTE')],
        razonSocial: row[normText_('RAZON SOCIAL')],
        numeroIdentificacion: row[normText_('NUMERO IDENTIFICACION')]
      };
    });

  cachePutJson_(key, list, CFG_().CACHE_TTL.CLIENTES_S);
  return list;
}

/** Un cliente por ID CLIENTE, o null. */
function cli_getCliente_(idCliente) {
  var table = cli_table_();
  var match = repo_findRowByCol_(table, 'ID CLIENTE', idCliente);
  return match ? cli_rowToObj_(match.obj) : null;
}

/** Para el chequeo anti-duplicado al crear cliente nuevo (-> CONFLICT). */
function cli_findByNumeroIdentificacion_(numero) {
  var table = cli_table_();
  var target = String(numero || '').trim();
  if (!target) return null;
  var found = table.rows.find(function (row) {
    return String(row[normText_('NUMERO IDENTIFICACION')] || '').trim() === target;
  });
  return found ? cli_rowToObj_(found) : null;
}

/**
 * Crea un cliente nuevo. datos: {razonSocial, tipoIdentificacion,
 * numeroIdentificacion, direccion, ciudad, departamento, pais, telefono,
 * codigoCiiu, actividadPrincipal}. ACTIVO siempre queda en 1.
 * Devuelve el idCliente generado.
 */
function cli_createCliente_(datos) {
  var idCliente = id_new_(CFG_().ID_PREFIJO_CLIENTE);
  repo_appendRows_(CFG_().DB_SHEET_ID, CFG_().TABS.CLIENTES, [{
    'ID CLIENTE': idCliente,
    'RAZON SOCIAL': cleanText_(datos.razonSocial),
    'TIPO IDENTIFICACION': cleanText_(datos.tipoIdentificacion),
    'NUMERO IDENTIFICACION': cleanText_(datos.numeroIdentificacion),
    'DIRECCION': cleanText_(datos.direccion),
    'CIUDAD': cleanText_(datos.ciudad),
    'DEPARTAMENTO': cleanText_(datos.departamento),
    'PAIS': cleanText_(datos.pais),
    'TELEFONO': cleanText_(datos.telefono),
    'CODIGO CIIU': cleanText_(datos.codigoCiiu),
    'ACTIVIDAD PRINCIPAL': cleanText_(datos.actividadPrincipal),
    'ACTIVO': 1
  }]);
  return idCliente;
}

/**
 * Edita un cliente existente. datos: mismos campos que cli_createCliente_
 * (los que vengan undefined no tocan la celda: repo_updateCells_ los
 * escribiría como '' si se incluyen, así que solo se listan los provistos).
 */
function cli_updateCliente_(idCliente, datos) {
  var table = cli_table_();
  var match = repo_findRowByCol_(table, 'ID CLIENTE', idCliente);
  if (!match) throw new AppError_('NOT_FOUND', 'No existe el cliente ' + idCliente + '.');
  repo_updateCells_(CFG_().DB_SHEET_ID, CFG_().TABS.CLIENTES, match.rowIndex, {
    'RAZON SOCIAL': cleanText_(datos.razonSocial),
    'TIPO IDENTIFICACION': cleanText_(datos.tipoIdentificacion),
    'NUMERO IDENTIFICACION': cleanText_(datos.numeroIdentificacion),
    'DIRECCION': cleanText_(datos.direccion),
    'CIUDAD': cleanText_(datos.ciudad),
    'DEPARTAMENTO': cleanText_(datos.departamento),
    'PAIS': cleanText_(datos.pais),
    'TELEFONO': cleanText_(datos.telefono),
    'CODIGO CIIU': cleanText_(datos.codigoCiiu),
    'ACTIVIDAD PRINCIPAL': cleanText_(datos.actividadPrincipal)
  });
}

// ---------- CONTACTOS_CLIENTES ----------

/** CONTACTOS_CLIENTES leída (memo) y con sus columnas requeridas verificadas. */
function con_table_() {
  var t = repo_readTable_(CFG_().DB_SHEET_ID, CFG_().TABS.CONTACTOS);
  repo_requireCols_(t.hmap, CFG_().TABS.CONTACTOS, SCHEMA_().CONTACTOS_CLIENTES.required);
  return t;
}

/** Fila cruda de CONTACTOS_CLIENTES -> objeto de dominio. */
function con_rowToObj_(row) {
  return {
    idContacto: row[normText_('ID CONTACTO')],
    idCliente: row[normText_('ID CLIENTE')],
    nombre: row[normText_('NOMBRE')],
    telefono: row[normText_('TELEFONO')],
    correo: row[normText_('CORREO')],
    cargo: row[normText_('CARGO')],
    // Establecimiento del que este contacto es encargado (vacío si no aplica).
    idEstablecimiento: row[normText_('ID ESTABLECIMIENTO')] || ''
  };
}

/** Contactos de un cliente, para el dropdown dependiente. */
function con_listByCliente_(idCliente) {
  var table = con_table_();
  var matches = repo_findRowsByCol_(table, 'ID CLIENTE', [idCliente]);
  return matches.map(function (m) { return con_rowToObj_(m.obj); });
}

/** Un contacto por ID CONTACTO, o null. */
function con_getContacto_(idContacto) {
  var table = con_table_();
  var match = repo_findRowByCol_(table, 'ID CONTACTO', idContacto);
  return match ? con_rowToObj_(match.obj) : null;
}

/**
 * datos: {nombre, telefono, correo, cargo, idEstablecimiento}.
 * idEstablecimiento es opcional: se envía cuando el contacto se crea como
 * encargado de un establecimiento ya seleccionado en el formulario (ver
 * crearContactoModal en Js*.js.html), para que quede asociado desde ya y
 * refreshEncargadoOptions lo proponga la próxima vez sin intervención manual.
 * Devuelve el idContacto generado.
 */
function con_createContacto_(idCliente, datos) {
  var idContacto = id_new_(CFG_().ID_PREFIJO_CONTACTO);
  repo_appendRows_(CFG_().DB_SHEET_ID, CFG_().TABS.CONTACTOS, [{
    'ID CONTACTO': idContacto,
    'ID CLIENTE': idCliente,
    'NOMBRE': cleanText_(datos.nombre),
    'TELEFONO': cleanText_(datos.telefono),
    'CORREO': cleanText_(datos.correo),
    'CARGO': cleanText_(datos.cargo),
    'ID ESTABLECIMIENTO': cleanText_(datos.idEstablecimiento)
  }]);
  return idContacto;
}

/** Asocia (o desasocia, con '') un contacto a un establecimiento como su encargado. No toca el resto de sus campos. */
function con_setEstablecimiento_(idContacto, idEstablecimiento) {
  var table = con_table_();
  var match = repo_findRowByCol_(table, 'ID CONTACTO', idContacto);
  if (!match) return;
  repo_updateCells_(CFG_().DB_SHEET_ID, CFG_().TABS.CONTACTOS, match.rowIndex, { 'ID ESTABLECIMIENTO': idEstablecimiento || '' });
}

/**
 * Contacto encargado de un establecimiento (el primero cuyo ID
 * ESTABLECIMIENTO coincida), o null si ninguno tiene ese establecimiento
 * asignado. Único lugar donde se resuelve esa FK inversa para uso del
 * servidor (ver doc_generateForQuotation_ en 31_DocService.js).
 */
function con_findEncargadoByEstablecimiento_(idEstablecimiento) {
  if (!idEstablecimiento) return null;
  var table = con_table_();
  var match = repo_findRowByCol_(table, 'ID ESTABLECIMIENTO', idEstablecimiento);
  return match ? con_rowToObj_(match.obj) : null;
}

/** Edita un contacto existente (solicitante o encargado). datos: {nombre, telefono, correo, cargo}. */
function con_updateContacto_(idContacto, datos) {
  var table = con_table_();
  var match = repo_findRowByCol_(table, 'ID CONTACTO', idContacto);
  if (!match) throw new AppError_('NOT_FOUND', 'No existe el contacto ' + idContacto + '.');
  repo_updateCells_(CFG_().DB_SHEET_ID, CFG_().TABS.CONTACTOS, match.rowIndex, {
    'NOMBRE': cleanText_(datos.nombre),
    'TELEFONO': cleanText_(datos.telefono),
    'CORREO': cleanText_(datos.correo),
    'CARGO': cleanText_(datos.cargo)
  });
}

// ---------- ESTABLECIMIENTOS_CLIENTES ----------

/** ESTABLECIMIENTOS_CLIENTES leída (memo) y con sus columnas requeridas verificadas. */
function est_table_() {
  var t = repo_readTable_(CFG_().DB_SHEET_ID, CFG_().TABS.ESTABLECIMIENTOS);
  repo_requireCols_(t.hmap, CFG_().TABS.ESTABLECIMIENTOS, SCHEMA_().ESTABLECIMIENTOS_CLIENTES.required);
  return t;
}

/** Fila cruda de ESTABLECIMIENTOS_CLIENTES -> objeto de dominio. */
function est_rowToObj_(row) {
  return {
    idEstablecimiento: row[normText_('ID ESTABLECIMIENTO')],
    idCliente: row[normText_('ID CLIENTE')],
    nombre: row[normText_('NOMBRE')],
    direccion: row[normText_('DIRECCION')],
    ciudad: row[normText_('CIUDAD')],
    departamento: row[normText_('DEPARTAMENTO')],
    pais: row[normText_('PAIS')]
  };
}

/** Establecimientos de un cliente, para el dropdown dependiente. */
function est_listByCliente_(idCliente) {
  var table = est_table_();
  var matches = repo_findRowsByCol_(table, 'ID CLIENTE', [idCliente]);
  return matches.map(function (m) { return est_rowToObj_(m.obj); });
}

/** Un establecimiento por ID ESTABLECIMIENTO, o null. */
function est_getEstablecimiento_(idEstablecimiento) {
  var table = est_table_();
  var match = repo_findRowByCol_(table, 'ID ESTABLECIMIENTO', idEstablecimiento);
  return match ? est_rowToObj_(match.obj) : null;
}

/**
 * datos: {nombre, direccion, ciudad, departamento, pais}. El encargado (si
 * lo hay) no se guarda aquí: el llamador debe asociarlo aparte con
 * con_setEstablecimiento_(idContacto, idEstablecimiento) sobre el contacto,
 * que es donde vive esa FK (CONTACTOS_CLIENTES.ID ESTABLECIMIENTO).
 * Devuelve el idEstablecimiento generado.
 */
function est_createEstablecimiento_(idCliente, datos) {
  var idEstablecimiento = id_new_(CFG_().ID_PREFIJO_ESTABLECIMIENTO);
  repo_appendRows_(CFG_().DB_SHEET_ID, CFG_().TABS.ESTABLECIMIENTOS, [{
    'ID ESTABLECIMIENTO': idEstablecimiento,
    'ID CLIENTE': idCliente,
    'NOMBRE': cleanText_(datos.nombre),
    'DIRECCION': cleanText_(datos.direccion),
    'CIUDAD': cleanText_(datos.ciudad),
    'DEPARTAMENTO': cleanText_(datos.departamento),
    'PAIS': cleanText_(datos.pais)
  }]);
  return idEstablecimiento;
}

/** Edita un establecimiento existente. datos: {nombre, direccion, ciudad, departamento, pais}. */
function est_updateEstablecimiento_(idEstablecimiento, datos) {
  var table = est_table_();
  var match = repo_findRowByCol_(table, 'ID ESTABLECIMIENTO', idEstablecimiento);
  if (!match) throw new AppError_('NOT_FOUND', 'No existe el establecimiento ' + idEstablecimiento + '.');
  repo_updateCells_(CFG_().DB_SHEET_ID, CFG_().TABS.ESTABLECIMIENTOS, match.rowIndex, {
    'NOMBRE': cleanText_(datos.nombre),
    'DIRECCION': cleanText_(datos.direccion),
    'CIUDAD': cleanText_(datos.ciudad),
    'DEPARTAMENTO': cleanText_(datos.departamento),
    'PAIS': cleanText_(datos.pais)
  });
}

/** Detalle completo de un cliente: datos + contactos + establecimientos (para api_getClienteDetalle). Cacheado por dataVersion. */
function cli_getDetalleCompleto_(idCliente) {
  var v = dataVersion_();
  var key = 'cli:det:' + idCliente + ':v' + v;
  var cached = cacheGetJson_(key);
  if (cached) return cached;

  var cliente = cli_getCliente_(idCliente);
  if (!cliente) return null;

  var detalle = {
    cliente: cliente,
    contactos: con_listByCliente_(idCliente),
    establecimientos: est_listByCliente_(idCliente)
  };

  cachePutJson_(key, detalle, CFG_().CACHE_TTL.CLIENTES_S);
  return detalle;
}
