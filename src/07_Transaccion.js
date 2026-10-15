/**
 * Sección crítica común de todas las escrituras (CLAUDE.md §5).
 *
 * Antes, cada servicio repetía el mismo bloque de ~15 líneas: tomar el script
 * lock, ejecutar, flush + bumpDataVersion_ si todo salió bien, convertir la
 * excepción en fail_ y soltar el lock. tx_conLock_ es ese bloque, una sola
 * vez. Las reglas siguen siendo las mismas:
 *   - El lock cubre SOLO lecturas de validación + escrituras a las hojas;
 *     nunca la generación de documentos ni el envío de correos (eso lo hace
 *     el llamador DESPUÉS de que tx_conLock_ devuelve).
 *   - flush + bump antes de soltar el lock: el siguiente lector nunca ve un
 *     estado parcial y todas las cachés por dataVersion_ quedan invalidadas.
 */

/** Códigos de error que son rechazos esperados del negocio, no fallos del sistema. */
function tx_codigosEsperados_() {
  return ['CONFLICT', 'NOT_FOUND', 'VALIDATION'];
}

/**
 * Ejecuta fn() dentro del script lock.
 *
 * Si fn devuelve ok_(...): SpreadsheetApp.flush() + bumpDataVersion_() antes
 * de soltar el lock. Si devuelve fail_(...): se devuelve tal cual (fn no debe
 * haber escrito nada antes de fallar). Si lanza: se registra en _ERRORES
 * (salvo los rechazos esperados de tx_codigosEsperados_) y se convierte en
 * fail_ con el código de la AppError_ o INTERNAL.
 *
 * @param {string} etapa Nombre de la operación (para _ERRORES).
 * @param {function(): !Object} fn Lógica de la transacción; devuelve ok_/fail_.
 * @param {{requestId: (string|undefined), ids: (Object|undefined),
 *     payload: (*|undefined), detalles: (function(): *|undefined),
 *     mensajeOcupado: (string|undefined)}=} opts
 *     ids/payload/requestId: contexto que se guarda en _ERRORES si falla.
 *     detalles: función que arma `error.details` del fail_ si fn lanza.
 *     mensajeOcupado: texto del BUSY si no se consigue el lock a tiempo.
 * @return {!Object} Respuesta {ok, data, error, meta}.
 */
function tx_conLock_(etapa, fn, opts) {
  opts = opts || {};
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG_().LIMITS.LOCK_MS)) {
    return fail_('BUSY', opts.mensajeOcupado || 'El sistema está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    var res = fn();
    if (res && res.ok) {
      SpreadsheetApp.flush();
      bumpDataVersion_();
    }
    return res;
  } catch (e) {
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    if (tx_codigosEsperados_().indexOf(code) === -1) {
      logError_(etapa, opts.requestId || null, opts.ids || null, opts.payload === undefined ? null : opts.payload, e);
    }
    return fail_(code, errMsg_(e), opts.detalles ? opts.detalles() : undefined);
  } finally {
    lock.releaseLock();
  }
}
