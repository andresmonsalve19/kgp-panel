/**
 * Orquestación de "Gestión de empleados": alta, edición y baja sobre
 * PERSONAL_KGP (internos) o PERSONAL_TERCEROS (terceros / independientes),
 * según `tipo` (CFG().TIPO_RESPONSABLE_*; vacío = interno). Mismo patrón que las altas rápidas de 30_QuoteService.js
 * (lock corto, flush + bumpDataVersion_ antes de soltar el lock), pero sin
 * ninguna FK que resolver — cada operación toca solo esta hoja.
 */

/** datos: {nombre, correo, telefono, cargo}. tipo: interno (por defecto) o tercero. */
function emps_createEmpleado(datos, tipo) {
  datos = isPlainObject_(datos) ? datos : {};
  var nombre = cleanText_(datos.nombre);
  if (!nombre) return fail_('VALIDATION', 'El nombre es obligatorio.');
  if (!cleanText_(datos.cargo)) return fail_('VALIDATION', 'El cargo es obligatorio.');
  if (!/^\d+$/.test(cleanText_(datos.telefono))) return fail_('VALIDATION', 'El teléfono es obligatorio y solo admite números.');
  if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(cleanText_(datos.correo))) return fail_('VALIDATION', 'Ingresa un correo electrónico válido.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    var idEmpleado = emp_createEmpleado_(datos, tipo);
    SpreadsheetApp.flush();
    bumpDataVersion_();
    return ok_({ idEmpleado: idEmpleado, nombre: nombre, correo: cleanText_(datos.correo), telefono: cleanText_(datos.telefono), cargo: cleanText_(datos.cargo), tipoResponsable: emp_tipo_(tipo) });
  } catch (e) {
    logError_('emps_createEmpleado', null, {}, datos, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/** Edita un empleado ya existente. datos: {nombre, correo, telefono, cargo}. */
function emps_updateEmpleado(idEmpleado, datos, tipo) {
  idEmpleado = String(idEmpleado || '').trim();
  datos = isPlainObject_(datos) ? datos : {};
  var nombre = cleanText_(datos.nombre);
  if (!idEmpleado) return fail_('VALIDATION', 'Falta idEmpleado.');
  if (!nombre) return fail_('VALIDATION', 'El nombre es obligatorio.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    emp_updateEmpleado_(idEmpleado, datos, tipo);
    SpreadsheetApp.flush();
    bumpDataVersion_();
    return ok_({ idEmpleado: idEmpleado, nombre: nombre, correo: cleanText_(datos.correo), telefono: cleanText_(datos.telefono), cargo: cleanText_(datos.cargo), tipoResponsable: emp_tipo_(tipo) });
  } catch (e) {
    logError_('emps_updateEmpleado', null, { idEmpleado: idEmpleado }, datos, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/** Elimina un empleado (interno o tercero según `tipo`). */
function emps_deleteEmpleado(idEmpleado, tipo) {
  idEmpleado = String(idEmpleado || '').trim();
  if (!idEmpleado) return fail_('VALIDATION', 'Falta idEmpleado.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    emp_deleteEmpleado_(idEmpleado, tipo);
    SpreadsheetApp.flush();
    bumpDataVersion_();
    return ok_({ idEmpleado: idEmpleado });
  } catch (e) {
    logError_('emps_deleteEmpleado', null, { idEmpleado: idEmpleado }, null, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/**
 * Nombre del empleado del usuario activo (PERSONAL_KGP, buscado por correo),
 * para las columnas ELABORADO POR / ACTUALIZADO POR de las órdenes. '' si el
 * correo no corresponde a ningún empleado: no bloquea la operación, mismo
 * criterio que la cotización (la columna simplemente queda vacía).
 *
 * Vive aquí, y no en el servicio de una orden en particular, porque lo usan
 * tanto la OIS (35_OisService.js) como la OIP (36_OipService.js).
 */
function emps_nombreUsuarioActivo_() {
  var correo = '';
  try { correo = Session.getActiveUser().getEmail() || ''; } catch (e) { correo = ''; }
  if (!correo) return '';
  try {
    var emp = emp_findByCorreo_(correo);
    return emp ? emp.nombre : '';
  } catch (e2) {
    return '';
  }
}
