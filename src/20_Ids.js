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
 * Reserva el siguiente CODIGO de una cotización. DEBE llamarse dentro del
 * script lock (lee la hoja y escribe la marca de agua).
 * @param {!Date} fechaElaboracion Define el año (YY) del código.
 * @return {string} CTZ-KGP-NNN-YY
 * @throws {AppError_} SEQ_OVERFLOW al pasar de 999 en el año.
 */
function code_reserve_(fechaElaboracion) {
  var cfg = CFG_();
  var yy = fmtDate_(fechaElaboracion, 'yy');
  return code_reservar_({
    prefijo: cfg.CODIGO_PREFIJO_COTIZACION,
    tab: cfg.TABS.COTIZACIONES,
    propKey: 'SEQ_' + yy,
    yy: yy,
    porAnio: true,
    mensajeTope: 'Se alcanzó el máximo de 999 cotizaciones para el año 20' + yy + '.'
  });
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
  var cfg = CFG_();
  var yy = fmtDate_(fechaElaboracion, 'yy');
  return code_reservar_({
    prefijo: cfg.CODIGO_PREFIJO_OIS,
    tab: cfg.TABS.OIS,
    propKey: 'SEQ_OIS_' + yy,
    yy: yy,
    porAnio: true,
    mensajeTope: 'Se alcanzó el máximo de 999 OIS para el año 20' + yy + '.'
  });
}

/**
 * Reserva el siguiente CODIGO de OIP (OIP-KGP-NNN-YY). El NNN NO reinicia
 * cada año (solo cambia el sufijo YY): una sola marca de agua 'SEQ_OIP' y un
 * techo GLOBAL de 999 OIP. DEBE llamarse dentro del script lock.
 * @param {!Date} fechaElaboracion
 * @return {string}
 */
function oip_codeReserve_(fechaElaboracion) {
  var cfg = CFG_();
  return code_reservar_({
    prefijo: cfg.CODIGO_PREFIJO_OIP,
    tab: cfg.TABS.OIP,
    propKey: 'SEQ_OIP',
    yy: fmtDate_(fechaElaboracion, 'yy'),
    porAnio: false,
    mensajeTope: 'Se alcanzó el máximo de 999 OIP (el consecutivo de la OIP no reinicia por año). Hay que ampliar la numeración a 4 dígitos.'
  });
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

  var watermark = Number(PropertiesService.getScriptProperties().getProperty(propKey) || 0);
  return Math.max(maxInSheet, watermark) + 1;
}
