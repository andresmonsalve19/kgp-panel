/**
 * Repo de PERSONAL_KGP (empleados internos) y PERSONAL_TERCEROS (terceros /
 * independientes). Las dos hojas tienen EXACTAMENTE las mismas columnas, así
 * que todo este archivo es común: el parámetro `tipo` (CFG().TIPO_RESPONSABLE_
 * INTERNO / _TERCERO) elige la hoja. Sin `tipo` = interno (comportamiento de
 * siempre: ELABORADO POR, asesor comercial, etc. son solo internos).
 *
 * Tabla independiente, sin FKs hacia otras hojas: "Gestión de empleados" no
 * participa del flujo de cotización.
 */

/** Tipo normalizado: TERCERO si así se pide, INTERNO en cualquier otro caso. */
function emp_tipo_(tipo) {
  var cfg = CFG();
  return String(tipo || '').trim().toUpperCase() === cfg.TIPO_RESPONSABLE_TERCERO
    ? cfg.TIPO_RESPONSABLE_TERCERO
    : cfg.TIPO_RESPONSABLE_INTERNO;
}

/** {tab, schema, prefijo} de la hoja de un tipo de empleado. */
function emp_hoja_(tipo) {
  var cfg = CFG();
  if (emp_tipo_(tipo) === cfg.TIPO_RESPONSABLE_TERCERO) {
    return { tab: cfg.TABS.PERSONAL_TERCEROS, schema: SCHEMA().PERSONAL_TERCEROS, prefijo: cfg.ID_PREFIJO_TERCERO };
  }
  return { tab: cfg.TABS.PERSONAL, schema: SCHEMA().PERSONAL_KGP, prefijo: cfg.ID_PREFIJO_EMPLEADO };
}

function emp_table_(tipo) {
  var h = emp_hoja_(tipo);
  var t = repo_readTable_(CFG().DB_SHEET_ID, h.tab);
  repo_requireCols_(t.hmap, h.tab, h.schema.required);
  return t;
}

function emp_rowToObj_(row, tipo) {
  return {
    idEmpleado: row[normText_('ID EMPLEADO')],
    nombre: row[normText_('NOMBRE')],
    correo: row[normText_('CORREO')],
    telefono: row[normText_('TELEFONO')],
    cargo: row[normText_('CARGO')],
    // Opcional (no está en SCHEMA().PERSONAL_KGP.required): se usa para la
    // etiqueta "Cédula - Nombre" del responsable de una tarea. Sin la
    // columna, la etiqueta muestra solo el nombre.
    cedula: row[normText_('CEDULA')] || '',
    // `tipo` ya normalizado por quien llama (emp_listEmpleados_); sin él, interno.
    tipoResponsable: tipo || CFG().TIPO_RESPONSABLE_INTERNO
  };
}

/** Listado completo de un tipo (vista de gestión, desplegables). Cacheado por dataVersion (mismo patrón que cli_listClientes_). */
function emp_listEmpleados_(tipo) {
  tipo = emp_tipo_(tipo);
  var key = 'emp:list:' + tipo + ':v' + dataVersion_();
  var cached = cacheGetJson_(key);
  if (cached) return cached;

  var list = emp_table_(tipo).rows.map(function (r) { return emp_rowToObj_(r, tipo); });
  cachePutJson_(key, list, CFG().CACHE_TTL.EMPLEADOS_S);
  return list;
}

/**
 * Internos + terceros, cada uno con su tipoResponsable: los candidatos a
 * responsable de una tarea. Si la hoja de terceros todavía no existe o le
 * faltan columnas, se devuelven solo los internos (no rompe las tareas).
 */
function emp_listResponsables_() {
  var cfg = CFG();
  var terceros = [];
  try { terceros = emp_listEmpleados_(cfg.TIPO_RESPONSABLE_TERCERO); } catch (e) { terceros = []; }
  return emp_listEmpleados_(cfg.TIPO_RESPONSABLE_INTERNO).concat(terceros);
}

/**
 * Busca un responsable en la lista de emp_listResponsables_: por tipo + ID si
 * llega el tipo; si no (tareas antiguas o sin la columna TIPO RESPONSABLE),
 * por ID en cualquiera de las dos hojas. null si no existe.
 */
function emp_buscarResponsable_(responsables, idEmpleado, tipo) {
  idEmpleado = String(idEmpleado || '').trim();
  if (!idEmpleado) return null;
  var conTipo = tipo ? emp_tipo_(tipo) : '';
  return (responsables || []).filter(function (e) {
    return String(e.idEmpleado) === idEmpleado && (!conTipo || e.tipoResponsable === conTipo);
  })[0] || null;
}

/** datos: {nombre, correo, telefono, cargo}. Devuelve el idEmpleado generado. */
function emp_createEmpleado_(datos, tipo) {
  var h = emp_hoja_(tipo);
  var idEmpleado = id_new_(h.prefijo);
  repo_appendRows_(CFG().DB_SHEET_ID, h.tab, [{
    'ID EMPLEADO': idEmpleado,
    'NOMBRE': cleanText_(datos.nombre),
    'CORREO': cleanText_(datos.correo),
    'TELEFONO': cleanText_(datos.telefono),
    'CARGO': cleanText_(datos.cargo)
  }]);
  return idEmpleado;
}

/** Edita un empleado existente. datos: {nombre, correo, telefono, cargo}. */
function emp_updateEmpleado_(idEmpleado, datos, tipo) {
  var h = emp_hoja_(tipo);
  var match = repo_findRowByCol_(emp_table_(tipo), 'ID EMPLEADO', idEmpleado);
  if (!match) throw new AppError_('NOT_FOUND', 'No existe el empleado ' + idEmpleado + '.');
  repo_updateCells_(CFG().DB_SHEET_ID, h.tab, match.rowIndex, {
    'NOMBRE': cleanText_(datos.nombre),
    'CORREO': cleanText_(datos.correo),
    'TELEFONO': cleanText_(datos.telefono),
    'CARGO': cleanText_(datos.cargo)
  });
}

/** Elimina físicamente un empleado. */
function emp_deleteEmpleado_(idEmpleado, tipo) {
  var h = emp_hoja_(tipo);
  var match = repo_findRowByCol_(emp_table_(tipo), 'ID EMPLEADO', idEmpleado);
  if (!match) throw new AppError_('NOT_FOUND', 'No existe el empleado ' + idEmpleado + '.');
  repo_deleteRows_(CFG().DB_SHEET_ID, h.tab, [match.rowIndex]);
}

/** Un empleado INTERNO por ID EMPLEADO, o null. Usado para resolver ELABORADO POR / REVISADO Y APROBADO POR / ASESOR COMERCIAL al leer una cotización. */
function emp_getEmpleado_(idEmpleado) {
  idEmpleado = String(idEmpleado || '').trim();
  if (!idEmpleado) return null;
  var match = repo_findRowByCol_(emp_table_(), 'ID EMPLEADO', idEmpleado);
  return match ? emp_rowToObj_(match.obj) : null;
}

/**
 * Un empleado INTERNO por CORREO (comparación insensible a mayúsculas/
 * espacios, a diferencia de repo_findRowByCol_ que compara exacto) — el
 * correo del usuario activo (Session.getActiveUser().getEmail()) puede no
 * coincidir carácter a carácter con lo digitado en PERSONAL_KGP. Usado para
 * resolver ELABORADO POR/CARGO al crear una cotización y REVISADO Y APROBADO
 * POR al decidir la cotización (30_QuoteService.js). Devuelve null si no hay
 * match (no crítico: esas columnas simplemente quedan vacías).
 */
function emp_findByCorreo_(correo) {
  var wanted = normText_(correo);
  if (!wanted) return null;
  var table = emp_table_();
  var norm = normText_('CORREO');
  var found = table.rows.filter(function (row) { return normText_(row[norm]) === wanted; })[0];
  return found ? emp_rowToObj_(found) : null;
}
