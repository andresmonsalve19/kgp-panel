/**
 * Generación de IDs de negocio e IDs de solicitud (idempotencia).
 * Ver plan: PREFIJO-yyMMddHHmmss-XXXX, legible en el Sheet para depurar FKs
 * a ojo, sin colisión práctica porque toda la generación ocurre dentro del
 * script lock (ver 30_QuoteService.js).
 */

function id_new_(prefix) {
  var ts = Utilities.formatDate(new Date(), CFG().TZ, 'yyMMddHHmmss');
  var rnd = Utilities.base64Encode(Utilities.getUuid())
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 4);
  return prefix + '-' + ts + '-' + rnd;
}

function id_newRequestId_() {
  return Utilities.getUuid();
}

/**
 * Reserva el siguiente CODIGO consecutivo para una fecha de elaboración
 * dada. DEBE llamarse dentro del script lock (ver 30_QuoteService.js):
 * lee la columna CODIGO completa del sheet (fuente de verdad) y una marca
 * de agua en ScriptProperties (anti-regresión si se borra una fila a
 * mano), toma el máximo de ambos, y persiste la marca de agua actualizada.
 *
 * Formato: CTZ-KGP-NNN-YY, NNN reinicia en 001 cada año (YY = últimos 2
 * dígitos del año de fechaElaboracion).
 */
function code_reserve_(fechaElaboracion) {
  var yy = fmtDate_(fechaElaboracion, 'yy');
  var next = code_nextNumber_(yy);

  if (next > 999) {
    throw new AppError_('SEQ_OVERFLOW', 'Se alcanzó el máximo de 999 cotizaciones para el año 20' + yy + '.');
  }

  PropertiesService.getScriptProperties().setProperty('SEQ_' + yy, String(next));
  return 'CTZ-KGP-' + pad3_(next) + '-' + yy;
}

/**
 * Vista previa del próximo CODIGO, SIN reservarlo (no escribe la marca de
 * agua). Puramente informativo para la UI (se incluye en api_bootstrap, que
 * corre en cada carga de página); el consecutivo real puede avanzar antes de
 * que el usuario envíe el formulario.
 *
 * A propósito NO escanea COTIZACIONES (a diferencia de code_reserve_): esa
 * hoja crece una fila por servicio y escanearla en cada carga de página se
 * volvería más lento con el tiempo. Basta con leer la marca de agua en
 * ScriptProperties (~20ms, sin tocar Sheets) porque solo es una vista previa;
 * la fuente de verdad autoritativa (sheet + marca de agua) se recalcula de
 * todos modos dentro del lock, una vez por transacción real, en code_reserve_.
 */
function code_previewNext_(fechaElaboracion) {
  var yy = fmtDate_(fechaElaboracion, 'yy');
  var watermark = Number(PropertiesService.getScriptProperties().getProperty('SEQ_' + yy) || 0);
  return 'CTZ-KGP-' + pad3_(watermark + 1) + '-' + yy;
}

/** Lógica compartida de lectura (sheet + marca de agua) entre reserva y previsualización. */
function code_nextNumber_(yy) {
  return code_nextNumberFor_(CFG().TABS.COTIZACIONES, 'CTZ-KGP-', 'SEQ_' + yy, yy);
}

/**
 * Siguiente número NNN para códigos "<prefijo>NNN-YY" de una hoja: máximo
 * entre lo que ya hay en su columna CODIGO y la marca de agua `propKey` en
 * ScriptProperties (anti-regresión si se borra una fila a mano), + 1.
 * Compartido por cotizaciones (CTZ-KGP-) y OIS (OIS-KGP-).
 */
function code_nextNumberFor_(tabName, prefix, propKey, yy) {
  var pattern = new RegExp('^' + prefix + '(\\d{3})-' + yy + '$');

  var table = repo_readTable_(CFG().DB_SHEET_ID, tabName);
  var maxInSheet = 0;
  table.rows.forEach(function (row) {
    var codigo = row[normText_('CODIGO')];
    if (!codigo) return;
    var m = pattern.exec(String(codigo).trim());
    if (m) {
      var n = Number(m[1]);
      if (n > maxInSheet) maxInSheet = n;
    }
  });

  var watermark = Number(PropertiesService.getScriptProperties().getProperty(propKey) || 0);
  return Math.max(maxInSheet, watermark) + 1;
}

/**
 * Reserva el siguiente CODIGO de OIS: OIS-KGP-NNN-YY. Mismo contrato que
 * code_reserve_ (DEBE llamarse dentro del script lock) y la misma regla,
 * confirmada con el usuario: NNN reinicia en 001 cada año. Marca de agua
 * propia (SEQ_OIS_YY), independiente de la de cotizaciones.
 */
function ois_codeReserve_(fechaElaboracion) {
  var yy = fmtDate_(fechaElaboracion, 'yy');
  var propKey = 'SEQ_OIS_' + yy;
  var next = code_nextNumberFor_(CFG().TABS.OIS, 'OIS-KGP-', propKey, yy);

  if (next > 999) {
    throw new AppError_('SEQ_OVERFLOW', 'Se alcanzó el máximo de 999 OIS para el año 20' + yy + '.');
  }

  PropertiesService.getScriptProperties().setProperty(propKey, String(next));
  return 'OIS-KGP-' + pad3_(next) + '-' + yy;
}
