/**
 * Orquestación de "Gestión de empleados": alta, edición y baja sobre
 * PERSONAL_KGP. Mismo patrón que las altas rápidas de 30_QuoteService.js
 * (lock corto, flush + bumpDataVersion_ antes de soltar el lock), pero sin
 * ninguna FK que resolver — cada operación toca solo esta hoja.
 */

/** datos: {nombre, correo, telefono, cargo}. */
function emps_createEmpleado(datos) {
  datos = isPlainObject_(datos) ? datos : {};
  var nombre = cleanText_(datos.nombre);
  if (!nombre) return fail_('VALIDATION', 'El nombre es obligatorio.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    var idEmpleado = emp_createEmpleado_(datos);
    SpreadsheetApp.flush();
    bumpDataVersion_();
    return ok_({ idEmpleado: idEmpleado, nombre: nombre, correo: cleanText_(datos.correo), telefono: cleanText_(datos.telefono), cargo: cleanText_(datos.cargo) });
  } catch (e) {
    logError_('emps_createEmpleado', null, {}, datos, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/** Edita un empleado ya existente. datos: {nombre, correo, telefono, cargo}. */
function emps_updateEmpleado(idEmpleado, datos) {
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
    emp_updateEmpleado_(idEmpleado, datos);
    SpreadsheetApp.flush();
    bumpDataVersion_();
    return ok_({ idEmpleado: idEmpleado, nombre: nombre, correo: cleanText_(datos.correo), telefono: cleanText_(datos.telefono), cargo: cleanText_(datos.cargo) });
  } catch (e) {
    logError_('emps_updateEmpleado', null, { idEmpleado: idEmpleado }, datos, e);
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/** Elimina un empleado. */
function emps_deleteEmpleado(idEmpleado) {
  idEmpleado = String(idEmpleado || '').trim();
  if (!idEmpleado) return fail_('VALIDATION', 'Falta idEmpleado.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG().LIMITS.LOCK_MS)) {
    return fail_('BUSY', 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    emp_deleteEmpleado_(idEmpleado);
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
