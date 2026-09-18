/**
 * Envoltura uniforme de respuestas para toda la API expuesta a
 * google.script.run (ver 50_WebApp.js). Ninguna función api_* debe lanzar
 * una excepción al cliente: todas pasan por safeCall_.
 */

function ok_(data, meta) {
  return { ok: true, data: (data === undefined ? null : data), error: null, meta: meta_(meta) };
}

/**
 * code: uno de VALIDATION, NOT_FOUND, BUSY, CONFLICT, SCHEMA, DRIVE,
 * EXPORT, SEQ_OVERFLOW, INTERNAL, TRANSPORT, TIMEOUT.
 */
function fail_(code, message, details) {
  return {
    ok: false,
    data: null,
    error: { code: code, message: message, details: (details === undefined ? null : details) },
    meta: meta_()
  };
}

function meta_(extra) {
  var base = { ts: new Date().toISOString(), v: CFG().APP_VERSION };
  if (extra) {
    for (var k in extra) { base[k] = extra[k]; }
  }
  return base;
}

/**
 * Envuelve una función api_* para garantizar que siempre devuelve
 * {ok,data,error,meta} y nunca deja escapar una excepción cruda hacia
 * google.script.run (que las reporta mal al cliente). Registra el error
 * en la hoja _ERRORES antes de responder.
 *
 * name: nombre de la operación (para logging).
 * fn: función sin argumentos que ejecuta la lógica real y devuelve
 *     directamente ok_(...) o fail_(...).
 */
function safeCall_(name, fn) {
  try {
    var result = fn();
    return result || fail_('INTERNAL', 'La operación ' + name + ' no devolvió una respuesta.');
  } catch (e) {
    try { logError_(name, null, null, null, e); } catch (logErr) { /* no bloquear la respuesta por un fallo de logging */ }
    // AppError_ (10_SheetRepo.js) trae un código tipado (SCHEMA, VALIDATION, ...);
    // cualquier otra excepción cae en INTERNAL.
    var code = (e && e.name === 'AppError_' && e.code) ? e.code : 'INTERNAL';
    return fail_(code, errMsg_(e), e && e.details ? e.details : null);
  }
}
