/**
 * Generación de IDs internos y de los CÓDIGOS consecutivos visibles.
 *
 * ID interno: PREFIJO-yyMMddHHmmss-XXXX (prefijos en CFG_().ID_PREFIJO_*).
 * Legible en el Sheet para depurar FKs a ojo, sin colisión práctica porque
 * toda la generación ocurre dentro del script lock.
 *
 * Código consecutivo: <prefijo>NNN-YY (prefijos en CFG_().CODIGO_PREFIJO_*).
 *   - Cotización: CTZ-KGP-NNN-YY, NNN reinicia cada año (marca SEQ_YY).
 *   - OIS:        OIS-KGP-NNN-YY, NNN reinicia cada año (marca SEQ_OIS_YY).
 *   - OIP:        OIP-KGP-NNN-YY, NNN NO reinicia (marca única SEQ_OIP;
 *                 decisión del usuario, CLAUDE.md §11.1). Techo global de 999.
 * El siguiente número = máximo entre lo que hay en la columna CODIGO y la marca
 * de agua en ScriptProperties (anti-regresión si se borra una fila a mano).
 * La marca de agua = "último número usado": se puede subir desde la vista
 * Configuración (code_guardarContador_) para que la numeración siga desde otro
 * punto (p. ej. 200 -> la próxima es la 201); nunca por debajo de lo que ya
 * existe en la hoja.
 */

/**
 * ID interno nuevo.
 * @param {string} prefix Uno de CFG_().ID_PREFIJO_*.
 * @return {string} p. ej. "CLI-261015100000-A1B2".
 */
function id_new_(prefix) {
  var ts = Utilities.formatDate(new Date(), CFG_().TZ, 'yyMMddHHmmss');
  var rnd = Utilities.base64Encode(Utilities.getUuid())
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 4);
  return prefix + '-' + ts + '-' + rnd;
}

/**
 * Qué distingue a cada consecutivo: hoja, prefijo, marca de agua y si reinicia
 * cada año. Lo usan las reservas y la vista Configuración.
 * @param {string} tipo 'COTIZACION' | 'OIS' | 'OIP'
 * @param {!Date} fecha Define el año (YY) del código.
 * @return {?Object} null si el tipo no existe.
 */
function code_spec_(tipo, fecha) {
  var cfg = CFG_();
  var yy = fmtDate_(fecha, 'yy');
  if (tipo === 'COTIZACION') {
    return { tipo: tipo, nombre: 'Cotizaciones', prefijo: cfg.CODIGO_PREFIJO_COTIZACION, tab: cfg.TABS.COTIZACIONES,
      propKey: 'SEQ_' + yy, yy: yy, porAnio: true,
      mensajeTope: 'Se alcanzó el máximo de 999 cotizaciones para el año 20' + yy + '.' };
  }
  if (tipo === 'OIS') {
    return { tipo: tipo, nombre: 'OIS', prefijo: cfg.CODIGO_PREFIJO_OIS, tab: cfg.TABS.OIS,
      propKey: 'SEQ_OIS_' + yy, yy: yy, porAnio: true,
      mensajeTope: 'Se alcanzó el máximo de 999 OIS para el año 20' + yy + '.' };
  }
  if (tipo === 'OIP') {
    return { tipo: tipo, nombre: 'OIP', prefijo: cfg.CODIGO_PREFIJO_OIP, tab: cfg.TABS.OIP,
      propKey: 'SEQ_OIP', yy: yy, porAnio: false,
      mensajeTope: 'Se alcanzó el máximo de 999 OIP (el consecutivo de la OIP no reinicia por año). Hay que ampliar la numeración a 4 dígitos.' };
  }
  return null;
}

/**
 * Reserva el siguiente CODIGO de una cotización. DEBE llamarse dentro del
 * script lock (lee la hoja y escribe la marca de agua).
 * @param {!Date} fechaElaboracion Define el año (YY) del código.
 * @return {string} CTZ-KGP-NNN-YY
 * @throws {AppError_} SEQ_OVERFLOW al pasar de 999 en el año.
 */
function code_reserve_(fechaElaboracion) {
  return code_reservar_(code_spec_('COTIZACION', fechaElaboracion));
}

/**
 * Vista previa del próximo CODIGO de cotización, SIN reservarlo. Solo
 * informativa (va en api_bootstrap, en cada carga de página), así que lee la
 * marca de agua de ScriptProperties y NO escanea COTIZACIONES (CLAUDE.md §2):
 * la fuente de verdad se recalcula dentro del lock en code_reserve_.
 * @param {!Date} fechaElaboracion
 * @return {string}
 */
function code_previewNext_(fechaElaboracion) {
  var yy = fmtDate_(fechaElaboracion, 'yy');
  var watermark = Number(PropertiesService.getScriptProperties().getProperty('SEQ_' + yy) || 0);
  return CFG_().CODIGO_PREFIJO_COTIZACION + pad3_(watermark + 1) + '-' + yy;
}

/**
 * Reserva el siguiente CODIGO de OIS (OIS-KGP-NNN-YY, reinicia cada año).
 * DEBE llamarse dentro del script lock.
 * @param {!Date} fechaElaboracion
 * @return {string}
 */
function ois_codeReserve_(fechaElaboracion) {
  return code_reservar_(code_spec_('OIS', fechaElaboracion));
}

/**
 * Reserva el siguiente CODIGO de OIP (OIP-KGP-NNN-YY). El NNN NO reinicia
 * cada año (solo cambia el sufijo YY): una sola marca de agua 'SEQ_OIP' y un
 * techo GLOBAL de 999 OIP. DEBE llamarse dentro del script lock.
 * @param {!Date} fechaElaboracion
 * @return {string}
 */
function oip_codeReserve_(fechaElaboracion) {
  return code_reservar_(code_spec_('OIP', fechaElaboracion));
}

/**
 * Lógica común de reserva: calcula el siguiente número, valida el tope de 3
 * dígitos, persiste la marca de agua y arma el código.
 * @param {{prefijo: string, tab: string, propKey: string, yy: string,
 *     porAnio: boolean, mensajeTope: string}} spec porAnio: true = solo
 *     cuentan los códigos con este YY; false = cualquier año.
 * @return {string}
 */
function code_reservar_(spec) {
  var next = code_siguienteNumero_(spec.tab, spec.prefijo, spec.propKey, spec.porAnio ? spec.yy : null);
  if (next > 999) throw new AppError_('SEQ_OVERFLOW', spec.mensajeTope);
  PropertiesService.getScriptProperties().setProperty(spec.propKey, String(next));
  return spec.prefijo + pad3_(next) + '-' + spec.yy;
}

/**
 * Siguiente NNN para códigos "<prefijo>NNN-YY" de una hoja: máximo entre su
 * columna CODIGO y la marca de agua `propKey`, + 1.
 * @param {string} tabName Hoja de la BD con la columna CODIGO.
 * @param {string} prefix Prefijo del código (se escapa para la regex).
 * @param {string} propKey Marca de agua en ScriptProperties.
 * @param {?string} yy Año de 2 dígitos que debe tener el código; null = cualquiera.
 * @return {number}
 */
function code_siguienteNumero_(tabName, prefix, propKey, yy) {
  var maxInSheet = code_maxEnHoja_(tabName, prefix, yy);
  var watermark = Number(PropertiesService.getScriptProperties().getProperty(propKey) || 0);
  return Math.max(maxInSheet, watermark) + 1;
}

/**
 * Mayor NNN que ya existe en la columna CODIGO de una hoja con códigos
 * "<prefijo>NNN-YY" (0 si no hay ninguno). yy null = cualquier año.
 */
function code_maxEnHoja_(tabName, prefix, yy) {
  var escapado = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var pattern = new RegExp('^' + escapado + '(\\d{3})-' + (yy ? yy : '\\d{2}') + '$');
  var colCodigo = normText_('CODIGO');

  var maxInSheet = 0;
  repo_readTable_(CFG_().DB_SHEET_ID, tabName).rows.forEach(function (row) {
    var codigo = row[colCodigo];
    if (!codigo) return;
    var m = pattern.exec(String(codigo).trim());
    if (m && Number(m[1]) > maxInSheet) maxInSheet = Number(m[1]);
  });
  return maxInSheet;
}

// ---------------------------------------------------------------------
// Contadores editables desde la vista Configuración
// ---------------------------------------------------------------------

/**
 * Estado de los tres contadores para el año de `fecha`: [{tipo, nombre,
 * prefijo, anio, porAnio, ultimo, minimo, proximo}]. `ultimo` = último número
 * usado (el mayor entre la hoja y la marca de agua); `minimo` = lo que ya
 * existe en la hoja (no se puede bajar de ahí); `proximo` = código que saldrá.
 * Escanea las hojas: solo para la vista Configuración, nunca en la carga de página.
 */
function code_estadoContadores_(fecha) {
  var props = PropertiesService.getScriptProperties();
  return ['COTIZACION', 'OIS', 'OIP'].map(function (tipo) {
    var spec = code_spec_(tipo, fecha);
    var enHoja = code_maxEnHoja_(spec.tab, spec.prefijo, spec.porAnio ? spec.yy : null);
    var marca = Number(props.getProperty(spec.propKey) || 0);
    var ultimo = Math.max(enHoja, marca);
    return {
      tipo: tipo, nombre: spec.nombre, prefijo: spec.prefijo, anio: '20' + spec.yy, porAnio: spec.porAnio,
      ultimo: ultimo, minimo: enHoja,
      proximo: ultimo >= 999 ? '' : spec.prefijo + pad3_(ultimo + 1) + '-' + spec.yy
    };
  });
}

/**
 * Fija el ULTIMO número usado de un contador (el siguiente será ultimo + 1).
 * Solo se puede subir o igualar lo que ya existe en la hoja: bajar de ahí
 * repetiría códigos. DEBE llamarse dentro del script lock.
 * @param {string} tipo 'COTIZACION' | 'OIS' | 'OIP'
 * @param {*} ultimo Entero 0-999.
 * @return {!Object} ok_(estado de los tres contadores) o fail_.
 */
function code_guardarContador_(tipo, ultimo) {
  var fecha = new Date();
  var spec = code_spec_(String(tipo || '').toUpperCase(), fecha);
  if (!spec) return fail_('VALIDATION', 'Contador desconocido.');
  var n = Number(String(ultimo == null ? '' : ultimo).trim());
  if (!isFinite(n) || n !== Math.trunc(n) || n < 0 || n > 999) {
    return fail_('VALIDATION', 'Escribe un número entero entre 0 y 999.', { ultimo: 'Escribe un número entero entre 0 y 999.' });
  }
  var enHoja = code_maxEnHoja_(spec.tab, spec.prefijo, spec.porAnio ? spec.yy : null);
  if (n < enHoja) {
    var msg = 'Ya existen códigos hasta el ' + pad3_(enHoja) + (spec.porAnio ? ' en 20' + spec.yy : '') + '; el contador no puede quedar por debajo.';
    return fail_('VALIDATION', msg, { ultimo: msg });
  }
  PropertiesService.getScriptProperties().setProperty(spec.propKey, String(n));
  return ok_(code_estadoContadores_(fecha));
}
