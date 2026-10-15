/**
 * "Gestión de empleados": alta, edición y baja sobre PERSONAL_KGP (internos)
 * o PERSONAL_TERCEROS (terceros / independientes), según `tipo`
 * (CFG_().TIPO_RESPONSABLE_*; vacío = interno). Cada operación toca solo su
 * hoja, dentro del lock común (tx_conLock_).
 */

/** Teléfono: solo dígitos. */
var EMP_TELEFONO_RE_ = /^\d+$/;
/** Correo: algo@algo.dominio (misma regla que el modal del cliente). */
var EMP_CORREO_RE_ = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

/**
 * Crea un empleado. En el alta todos los campos son obligatorios.
 * @param {!Object} datos {nombre, correo, telefono, cargo}
 * @param {string=} tipo Interno (por defecto) o tercero.
 * @return {!Object} ok_({idEmpleado, nombre, correo, telefono, cargo,
 *     tipoResponsable}) o fail_.
 */
function emps_createEmpleado(datos, tipo) {
  datos = isPlainObject_(datos) ? datos : {};
  var nombre = cleanText_(datos.nombre);
  if (!nombre) return fail_('VALIDATION', 'El nombre es obligatorio.');
  if (!cleanText_(datos.cargo)) return fail_('VALIDATION', 'El cargo es obligatorio.');
  if (!EMP_TELEFONO_RE_.test(cleanText_(datos.telefono))) return fail_('VALIDATION', 'El teléfono es obligatorio y solo admite números.');
  if (!EMP_CORREO_RE_.test(cleanText_(datos.correo))) return fail_('VALIDATION', 'Ingresa un correo electrónico válido.');

  return tx_conLock_('emps_createEmpleado', function () {
    var idEmpleado = emp_createEmpleado_(datos, tipo);
    return ok_(emps_respuesta_(idEmpleado, datos, tipo));
  }, { payload: datos });
}

/**
 * Edita un empleado (en la edición solo el nombre es obligatorio, para no
 * bloquear registros antiguos incompletos).
 * @param {string} idEmpleado
 * @param {!Object} datos {nombre, correo, telefono, cargo}
 * @param {string=} tipo
 * @return {!Object} ok_(...) como emps_createEmpleado, o fail_.
 */
function emps_updateEmpleado(idEmpleado, datos, tipo) {
  idEmpleado = String(idEmpleado || '').trim();
  datos = isPlainObject_(datos) ? datos : {};
  if (!idEmpleado) return fail_('VALIDATION', 'Falta idEmpleado.');
  if (!cleanText_(datos.nombre)) return fail_('VALIDATION', 'El nombre es obligatorio.');

  return tx_conLock_('emps_updateEmpleado', function () {
    emp_updateEmpleado_(idEmpleado, datos, tipo);
    return ok_(emps_respuesta_(idEmpleado, datos, tipo));
  }, { ids: { idEmpleado: idEmpleado }, payload: datos });
}

/**
 * Elimina un empleado (interno o tercero según `tipo`).
 * @param {string} idEmpleado
 * @param {string=} tipo
 * @return {!Object} ok_({idEmpleado}) o fail_.
 */
function emps_deleteEmpleado(idEmpleado, tipo) {
  idEmpleado = String(idEmpleado || '').trim();
  if (!idEmpleado) return fail_('VALIDATION', 'Falta idEmpleado.');

  return tx_conLock_('emps_deleteEmpleado', function () {
    emp_deleteEmpleado_(idEmpleado, tipo);
    return ok_({ idEmpleado: idEmpleado });
  }, { ids: { idEmpleado: idEmpleado } });
}

/** Lo que el cliente necesita para pintar la fila sin releer el listado. */
function emps_respuesta_(idEmpleado, datos, tipo) {
  return {
    idEmpleado: idEmpleado,
    nombre: cleanText_(datos.nombre),
    correo: cleanText_(datos.correo),
    telefono: cleanText_(datos.telefono),
    cargo: cleanText_(datos.cargo),
    tipoResponsable: emp_tipo_(tipo)
  };
}

/**
 * Nombre del empleado interno del usuario activo (buscado por correo), para
 * las columnas ELABORADO POR / ACTUALIZADO POR de las órdenes. '' si no se
 * encuentra: no bloquea la operación (la columna queda vacía).
 * @return {string}
 */
function emps_nombreUsuarioActivo_() {
  var correo = qs_correoUsuarioActivo_();
  if (!correo) return '';
  try {
    var emp = emp_findByCorreo_(correo);
    return emp ? emp.nombre : '';
  } catch (e) {
    return '';
  }
}
