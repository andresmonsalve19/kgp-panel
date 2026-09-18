/**
 * Repo de PERSONAL_KGP (gestión de empleados). Tabla independiente, sin FKs
 * hacia otras hojas: a diferencia de CLIENTES/CONTACTOS/ESTABLECIMIENTOS,
 * "Gestión de empleados" no participa del flujo de cotización, así que este
 * repo no lo llama ninguna orquestación de 30_QuoteService.js.
 */

function emp_table_() {
  var t = repo_readTable_(CFG().DB_SHEET_ID, CFG().TABS.PERSONAL);
  repo_requireCols_(t.hmap, CFG().TABS.PERSONAL, SCHEMA().PERSONAL_KGP.required);
  return t;
}

function emp_rowToObj_(row) {
  return {
    idEmpleado: row[normText_('ID EMPLEADO')],
    nombre: row[normText_('NOMBRE')],
    correo: row[normText_('CORREO')],
    telefono: row[normText_('TELEFONO')],
    cargo: row[normText_('CARGO')],
    // Opcional (no está en SCHEMA().PERSONAL_KGP.required): se usa para la
    // etiqueta "Cédula - Nombre" del responsable de una tarea de OIS. Sin la
    // columna, la etiqueta muestra solo el nombre.
    cedula: row[normText_('CEDULA')] || ''
  };
}

/** Listado completo para la vista de gestión. Cacheado por dataVersion (mismo patrón que cli_listClientes_). */
function emp_listEmpleados_() {
  var v = dataVersion_();
  var key = 'emp:list:v' + v;
  var cached = cacheGetJson_(key);
  if (cached) return cached;

  var table = emp_table_();
  var list = table.rows.map(emp_rowToObj_);

  cachePutJson_(key, list, CFG().CACHE_TTL.EMPLEADOS_S);
  return list;
}

/** datos: {nombre, correo, telefono, cargo}. Devuelve el idEmpleado generado. */
function emp_createEmpleado_(datos) {
  var idEmpleado = id_new_('EMP');
  repo_appendRows_(CFG().DB_SHEET_ID, CFG().TABS.PERSONAL, [{
    'ID EMPLEADO': idEmpleado,
    'NOMBRE': cleanText_(datos.nombre),
    'CORREO': cleanText_(datos.correo),
    'TELEFONO': cleanText_(datos.telefono),
    'CARGO': cleanText_(datos.cargo)
  }]);
  return idEmpleado;
}

/** Edita un empleado existente. datos: {nombre, correo, telefono, cargo}. */
function emp_updateEmpleado_(idEmpleado, datos) {
  var table = emp_table_();
  var match = repo_findRowByCol_(table, 'ID EMPLEADO', idEmpleado);
  if (!match) throw new AppError_('NOT_FOUND', 'No existe el empleado ' + idEmpleado + '.');
  repo_updateCells_(CFG().DB_SHEET_ID, CFG().TABS.PERSONAL, match.rowIndex, {
    'NOMBRE': cleanText_(datos.nombre),
    'CORREO': cleanText_(datos.correo),
    'TELEFONO': cleanText_(datos.telefono),
    'CARGO': cleanText_(datos.cargo)
  });
}

/** Elimina físicamente un empleado. */
function emp_deleteEmpleado_(idEmpleado) {
  var table = emp_table_();
  var match = repo_findRowByCol_(table, 'ID EMPLEADO', idEmpleado);
  if (!match) throw new AppError_('NOT_FOUND', 'No existe el empleado ' + idEmpleado + '.');
  repo_deleteRows_(CFG().DB_SHEET_ID, CFG().TABS.PERSONAL, [match.rowIndex]);
}

/** Un empleado por ID EMPLEADO, o null. Usado para resolver ELABORADO POR / REVISADO Y APROBADO POR / ASESOR COMERCIAL al leer una cotización. */
function emp_getEmpleado_(idEmpleado) {
  idEmpleado = String(idEmpleado || '').trim();
  if (!idEmpleado) return null;
  var match = repo_findRowByCol_(emp_table_(), 'ID EMPLEADO', idEmpleado);
  return match ? emp_rowToObj_(match.obj) : null;
}

/**
 * Un empleado por CORREO (comparación insensible a mayúsculas/espacios,
 * a diferencia de repo_findRowByCol_ que compara exacto) — el correo del
 * usuario activo (Session.getActiveUser().getEmail()) puede no coincidir
 * carácter a carácter con lo digitado en PERSONAL_KGP. Usado para resolver
 * ELABORADO POR/CARGO al crear una cotización y REVISADO Y APROBADO POR al
 * decidir la garantía (30_QuoteService.js). Devuelve null si no hay match
 * (no crítico: esas columnas simplemente quedan vacías).
 */
function emp_findByCorreo_(correo) {
  var wanted = normText_(correo);
  if (!wanted) return null;
  var table = emp_table_();
  var norm = normText_('CORREO');
  var found = table.rows.filter(function (row) { return normText_(row[norm]) === wanted; })[0];
  return found ? emp_rowToObj_(found) : null;
}
