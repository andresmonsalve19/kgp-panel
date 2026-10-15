/**
 * Plantilla ÚNICA de correo de KGP (CLAUDE.md §14).
 *
 * Todo correo que envíe la app pasa por aquí: mail_send_(destino, opts). El
 * HTML es el de assets/Plantilla Correo KGP (standalone).html (desempaquetado)
 * con su diseño intacto — logo, franja verde, tarjeta #eef4e4, botón
 * centrado, bloque "Dato destacado", firma y pie verde con dirección,
 * teléfonos, correo y sitio web. Lo ÚNICO que cambia de un correo a otro es lo
 * que llega en `opts` (asunto, títulos y cuerpo). No se arma HTML de correo en
 * ningún otro archivo.
 *
 * Requisitos del usuario aplicados aquí, para todos los correos:
 *   - El botón va centrado (como en la plantilla).
 *   - Todo el texto del cuerpo va justificado (text-align:justify): saludo,
 *     párrafos, datos destacados y firma. Etiqueta y título no (ver
 *     mail_render_).
 *   - Cada párrafo es su propio <p>; un '\n' dentro de un texto se vuelve
 *     <br> (saltos de línea).
 *
 * Las imágenes (logo e íconos del pie) viven en 05_MailAssets.js y viajan
 * como inlineImages ("cid:"), porque Gmail no muestra imágenes data:.
 *
 * Parametrizable (CLAUDE.md §15): firma, nota y pie salen de CFG().CORREO
 * (hoja CONFIG_CORREO); los textos de cada correo, de mail_textos_(clave)
 * (hoja CONFIG_CORREO_TEXTOS, con mail_textosDefault_ como respaldo). Un
 * correo de la app se envía con mail_enviar_(clave, destino, vars, opciones);
 * mail_send_(destino, opts) queda para armar opts a mano.
 *
 * opts:
 *   asunto      (obligatorio) asunto del correo.
 *   preheader   texto de vista previa en la bandeja (oculto en el cuerpo).
 *   etiqueta    texto pequeño en mayúsculas sobre el título ("Comunicado" en
 *               la plantilla).
 *   titulo      título principal (h1).
 *   saludo      "Hola Nombre," (opcional).
 *   parrafos    [string] párrafos del cuerpo, texto plano.
 *   boton       {texto, url} botón centrado (opcional; sin url no se pinta).
 *   destacados  [{titulo, texto}] bloque "Dato destacado" (opcional).
 *   firma       por defecto "Equipo KGP".
 *   nota        texto legal pequeño del pie (por defecto, aviso de correo
 *               automático).
 */

/** Escapa texto para HTML; los saltos de línea pasan a <br>. */
function mail_esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r?\n/g, '<br>');
}

/** Escapa un valor para un atributo href (sin convertir saltos de línea). */
function mail_attr_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** HTML completo del correo, con el diseño de la plantilla. */
function mail_render_(opts) {
  opts = opts || {};
  var parrafos = (opts.parrafos || []).filter(function (p) { return String(p == null ? '' : p).trim(); });
  var destacados = (opts.destacados || []).filter(function (d) { return d && (d.titulo || d.texto); });
  var boton = (opts.boton && opts.boton.url) ? opts.boton : null;
  var pie = CFG().CORREO; // firma, nota y pie: hoja CONFIG_CORREO
  var firma = opts.firma || pie.FIRMA;
  var nota = opts.nota || pie.NOTA_PIE;
  var webUrl = mail_attr_(pie.SITIO_WEB_URL);
  var preheader = opts.preheader || opts.titulo || opts.asunto || '';

  var FONT = 'font-family:Arial,Helvetica,sans-serif;';
  var JUST = 'text-align:justify;';
  var P_STYLE = 'margin:0 0 16px;' + FONT + 'font-size:16px;line-height:26px;mso-line-height-rule:exactly;color:#33392c;' + JUST;
  var P_LAST = 'margin:0 0 28px;' + FONT + 'font-size:16px;line-height:26px;mso-line-height-rule:exactly;color:#33392c;' + JUST;

  // Etiqueta y título quedan alineados a la izquierda como en la plantilla:
  // un h1 de 30px justificado que se parte en dos líneas reparte las palabras
  // de borde a borde y se ve roto. El justificado aplica al texto del cuerpo.
  var cuerpo = [];
  if (opts.etiqueta) {
    cuerpo.push('<p class="t-mute" style="margin:0 0 12px;' + FONT + 'font-size:12px;line-height:16px;mso-line-height-rule:exactly;letter-spacing:2px;text-transform:uppercase;color:#5d6b4c;font-weight:bold;">' + mail_esc_(opts.etiqueta) + '</p>');
  }
  if (opts.titulo) {
    cuerpo.push('<h1 class="h1 t-ink" style="margin:0 0 20px;' + FONT + 'font-size:30px;line-height:36px;mso-line-height-rule:exactly;color:#1f2a14;font-weight:bold;">' + mail_esc_(opts.titulo) + '</h1>');
  }
  var lineas = (opts.saludo ? [opts.saludo] : []).concat(parrafos);
  lineas.forEach(function (p, i) {
    cuerpo.push('<p class="t-ink" style="' + (i === lineas.length - 1 ? P_LAST : P_STYLE) + '">' + mail_esc_(p) + '</p>');
  });

  var html = [];
  html.push('<!DOCTYPE html>');
  html.push('<html lang="es" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>');
  html.push('<meta charset="utf-8">');
  html.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  html.push('<meta http-equiv="X-UA-Compatible" content="IE=edge">');
  html.push('<meta name="color-scheme" content="light dark">');
  html.push('<meta name="supported-color-schemes" content="light dark">');
  html.push('<title>KGP</title>');
  html.push('<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->');
  html.push('<style>' +
    'body{margin:0;padding:0;}' +
    'a{color:#436b0a;}' +
    '@media screen and (max-width:620px){' +
    '.wrap{width:100% !important;}' +
    '.px{padding-left:24px !important;padding-right:24px !important;}' +
    '.h1{font-size:26px !important;line-height:32px !important;}' +
    '}' +
    '@media (prefers-color-scheme:dark){' +
    '.bg-outer{background:#1b1f17 !important;}' +
    '.bg-card{background:#242a1f !important;}' +
    '.t-ink{color:#eef0ea !important;}' +
    '.t-mute{color:#b9bfb1 !important;}' +
    '.logo-cell{background:#f6f7f3 !important;}' +
    '.t-brand{color:#9fbf6a !important;}' +
    '}' +
    '</style>');
  html.push('</head>');
  html.push('<body style="margin:0;padding:0;background:#3a3f35;">');

  // Preheader (texto de vista previa de la bandeja de entrada).
  html.push('<span style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#3a3f35;">' + mail_esc_(preheader) + '&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</span>');

  html.push('<table role="presentation" class="bg-outer" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#3a3f35" style="background:#3a3f35;">');
  html.push('<tbody><tr><td align="center" style="padding:32px 12px;">');
  html.push('<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->');
  html.push('<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">');

  // Logo
  html.push('<tbody><tr><td class="logo-cell bg-card" align="center" bgcolor="#eef4e4" style="background:#eef4e4;padding:36px 40px 28px;border-radius:8px 8px 0 0;">' +
    '<a href="' + webUrl + '" target="_blank" style="text-decoration:none;">' +
    '<img src="cid:logo" width="150" alt="KGP" style="display:block;width:150px;max-width:150px;height:auto;border:0;outline:none;text-decoration:none;' + FONT + 'font-size:28px;font-weight:bold;color:#436b0a;">' +
    '</a></td></tr>');

  // Franja verde
  html.push('<tr><td height="4" bgcolor="#436b0a" style="background:#436b0a;height:4px;font-size:0;line-height:0;mso-line-height-rule:exactly;">&nbsp;</td></tr>');

  // Cuerpo
  html.push('<tr><td class="px bg-card" bgcolor="#eef4e4" style="background:#eef4e4;padding:40px 48px 8px;">' + cuerpo.join('') + '</td></tr>');

  // Botón (centrado)
  if (boton) {
    var url = mail_attr_(boton.url);
    var texto = mail_esc_(boton.texto || 'Ver más información');
    html.push('<tr><td class="px bg-card" align="center" bgcolor="#eef4e4" style="background:#eef4e4;padding:0 48px 36px;">' +
      '<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">' +
      '<tbody><tr><td bgcolor="#436b0a" style="background:#436b0a;border-radius:4px;">' +
      '<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="' + url + '" style="height:48px;v-text-anchor:middle;width:260px;" arcsize="9%" stroke="f" fillcolor="#436b0a"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">' + texto + '</center></v:roundrect><![endif]-->' +
      '<!--[if !mso]><!-->' +
      '<a href="' + url + '" target="_blank" style="display:block;padding:14px 28px;' + FONT + 'font-size:15px;line-height:20px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:4px;text-align:center;">' + texto + '</a>' +
      '<!--<![endif]-->' +
      '</td></tr></tbody></table>' +
      '</td></tr>');
  }

  // Datos destacados (mismo bloque "Dato destacado" de la plantilla, uno por dato)
  if (destacados.length) {
    var items = destacados.map(function (d, i) {
      var ultimo = i === destacados.length - 1;
      return '<p class="t-ink" style="margin:0 0 6px;' + FONT + 'font-size:15px;line-height:22px;font-weight:bold;color:#1f2a14;' + JUST + '">' + mail_esc_(d.titulo) + '</p>' +
        '<p class="t-mute" style="margin:0 0 ' + (ultimo ? '0' : '16px') + ';' + FONT + 'font-size:15px;line-height:22px;mso-line-height-rule:exactly;color:#5a6150;' + JUST + '">' + mail_esc_(d.texto) + '</p>';
    }).join('');
    html.push('<tr><td class="px bg-card" bgcolor="#eef4e4" style="background:#eef4e4;padding:0 48px 36px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #dde2d4;">' +
      '<tbody><tr><td style="padding:24px 0 0;">' + items + '</td></tr></tbody></table>' +
      '</td></tr>');
  }

  // Firma
  html.push('<tr><td class="px bg-card" bgcolor="#eef4e4" style="background:#eef4e4;padding:0 48px 36px;">' +
    '<p class="t-ink" style="margin:0;' + FONT + 'font-size:15px;line-height:22px;color:#33392c;' + JUST + '">Saludos cordiales,<br><strong class="t-brand" style="color:#436b0a;">' + mail_esc_(firma) + '</strong></p>' +
    '</td></tr>');

  // Pie
  var FOOT_TD = 'padding:0 0 6px;' + FONT + 'font-size:13px;line-height:18px;mso-line-height-rule:exactly;color:#ffffff;';
  var ICON_TD = 'width:16px;padding:1px 10px 6px 0;';
  function filaPie(cid, alt, contenido) {
    return '<tr><td width="16" valign="top" style="' + ICON_TD + '"><img src="cid:' + cid + '" width="16" height="16" alt="' + alt + '" style="display:block;width:16px;height:16px;border:0;"></td>' +
      '<td valign="top" style="' + FOOT_TD + '">' + contenido + '</td></tr>';
  }
  html.push('<tr><td class="px" bgcolor="#436b0a" style="background:#436b0a;padding:20px 48px 18px;border-radius:0 0 8px 8px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody>' +
    (pie.DIRECCION ? filaPie('icoDireccion', 'Dirección', mail_esc_(pie.DIRECCION)) : '') +
    (pie.TELEFONOS ? filaPie('icoTelefono', 'Teléfonos', mail_telLinks_(pie.TELEFONOS)) : '') +
    (pie.CORREO_CONTACTO ? filaPie('icoCorreo', 'Correo', '<a href="mailto:' + mail_attr_(pie.CORREO_CONTACTO) + '" style="color:#ffffff;text-decoration:none;">' + mail_esc_(pie.CORREO_CONTACTO) + '</a>') : '') +
    (pie.SITIO_WEB_TEXTO ? filaPie('icoWeb', 'Sitio web', '<a href="' + webUrl + '" target="_blank" style="color:#ffffff;text-decoration:underline;">' + mail_esc_(pie.SITIO_WEB_TEXTO) + '</a>') : '') +
    '<tr><td colspan="2" style="padding:10px 0 0;border-top:1px solid #5d8526;">' +
    '<p style="margin:0;' + FONT + 'font-size:11px;line-height:16px;mso-line-height-rule:exactly;color:#dfe9cf;">' + mail_esc_(nota) + '</p>' +
    '</td></tr>' +
    '</tbody></table>' +
    '</td></tr>');

  html.push('</tbody></table>');
  html.push('<!--[if mso]></td></tr></table><![endif]-->');
  html.push('</td></tr>');
  html.push('</tbody></table>');
  html.push('</body></html>');
  return html.join('\n');
}

/** Versión en texto plano del mismo correo (clientes que no muestran HTML). */
function mail_text_(opts) {
  opts = opts || {};
  var out = [];
  if (opts.titulo) out.push(String(opts.titulo).toUpperCase(), '');
  if (opts.saludo) out.push(opts.saludo, '');
  (opts.parrafos || []).forEach(function (p) {
    if (String(p == null ? '' : p).trim()) out.push(String(p), '');
  });
  if (opts.boton && opts.boton.url) out.push((opts.boton.texto || 'Enlace') + ': ' + opts.boton.url, '');
  (opts.destacados || []).forEach(function (d) {
    if (d && (d.titulo || d.texto)) out.push((d.titulo ? d.titulo + ': ' : '') + (d.texto || ''));
  });
  var pie = CFG().CORREO;
  out.push('', 'Saludos cordiales,', opts.firma || pie.FIRMA, '',
    joinNonEmpty_([pie.DIRECCION, pie.TELEFONOS, pie.CORREO_CONTACTO, pie.SITIO_WEB_TEXTO], ' · '));
  return out.join('\n');
}

/**
 * Teléfonos del pie con cada número convertido en enlace tel:. Un número es
 * una secuencia de dígitos (con espacios o paréntesis) de 7 o más cifras; si
 * tiene 10 cifras se le antepone el indicativo de Colombia (+57), como en la
 * plantilla original. El resto del texto (separadores "/" o "-") se respeta.
 */
function mail_telLinks_(texto) {
  return mail_esc_(texto).replace(/\(?\d[\d ()]{5,}\d/g, function (num) {
    var digitos = num.replace(/\D/g, '');
    var tel = digitos.length === 10 ? '+57' + digitos : '+' + digitos;
    return '<a href="tel:' + tel + '" style="color:#ffffff;text-decoration:none;">' + num + '</a>';
  });
}

/** Blobs de las imágenes de la plantilla, con la clave que usa cada "cid:". */
function mail_inlineImages_() {
  var assets = mail_assets_();
  var out = {};
  Object.keys(assets).forEach(function (k) {
    out[k] = Utilities.newBlob(Utilities.base64Decode(assets[k]), 'image/png', k + '.png');
  });
  return out;
}

/**
 * Envía un correo con la plantilla. destino: un correo o varios separados por
 * coma. Lanza si no hay destino, si no queda cuota diaria o si MailApp falla:
 * cada llamador decide qué hacer (los avisos de 39_NotifyService.js nunca
 * dejan que eso tumbe la operación que los disparó).
 */
function mail_send_(destino, opts) {
  destino = String(destino || '').trim();
  if (!destino) throw new AppError_('MAIL', 'Correo sin destinatario: ' + (opts && opts.asunto));
  if (!opts || !opts.asunto) throw new AppError_('MAIL', 'Correo sin asunto.');
  if (MailApp.getRemainingDailyQuota() < 1) {
    throw new AppError_('MAIL', 'Se agotó la cuota diaria de correos de Apps Script; no se envió "' + opts.asunto + '".');
  }
  var texto = mail_text_(opts);
  MailApp.sendEmail({
    to: destino,
    subject: opts.asunto,
    htmlBody: mail_render_(opts),
    body: texto,
    name: CFG().CORREO.REMITENTE_NOMBRE || 'KGP',
    inlineImages: mail_inlineImages_()
  });
  // Solo si MailApp NO lanzó: el historial lista correos realmente enviados.
  mail_log_(destino, opts.asunto, texto);
}

/**
 * Agrega una fila a HISTORIAL (spreadsheet CFG().MAIL_HISTORIAL_SHEET_ID) por
 * cada correo enviado: NUMERO (autoincremental desde 1), TIMESTAMP, FROM (la
 * cuenta con la que corre la app, que es la que figura como remitente), TO,
 * SUBJECT y BODY (el cuerpo en texto plano, truncado al máximo de celda).
 *
 * Nunca lanza: un fallo del historial no puede hacer creer que el correo no
 * salió (ya salió), así que solo se registra en _ERRORES. Para no escanear una
 * hoja que crece sin parar, NUMERO sale de la última fila (no de toda la
 * columna); el lock corto evita que dos envíos simultáneos repitan número.
 */
function mail_log_(destino, asunto, cuerpo) {
  var lock = null;
  try {
    var cfg = CFG();
    var from = '';
    try { from = Session.getEffectiveUser().getEmail() || ''; } catch (e) { from = ''; }

    lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) throw new AppError_('BUSY', 'No se pudo tomar el lock para el historial de correos.');

    var ss = SpreadsheetApp.openById(cfg.MAIL_HISTORIAL_SHEET_ID);
    var sheet = ss.getSheetByName(cfg.MAIL_HISTORIAL_TAB);
    var cols = ['NUMERO', 'TIMESTAMP', 'FROM', 'TO', 'SUBJECT', 'BODY'];
    if (!sheet) sheet = ss.insertSheet(cfg.MAIL_HISTORIAL_TAB);
    if (sheet.getLastColumn() < 1) {
      sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
      sheet.setFrozenRows(1);
    }

    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(normText_);
    var iNumero = headers.indexOf('NUMERO');
    var lastRow = sheet.getLastRow();
    var numero = 1;
    if (lastRow > 1 && iNumero >= 0) {
      var previo = Number(sheet.getRange(lastRow, iNumero + 1).getValue());
      numero = (isNaN(previo) ? lastRow - 1 : previo) + 1;
    }

    var valores = {
      'NUMERO': numero,
      'TIMESTAMP': new Date(),
      'FROM': from,
      'TO': destino,
      'SUBJECT': asunto,
      'BODY': truncate_(cuerpo, 49000)
    };
    var fila = headers.map(function (h) { return valores.hasOwnProperty(h) ? valores[h] : ''; });
    sheet.getRange(lastRow + 1, 1, 1, lastCol).setValues([fila]);
    SpreadsheetApp.flush();
  } catch (e) {
    logError_('mail_log_', null, { to: destino, subject: asunto }, null, e);
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e2) { /* nada que liberar */ } }
  }
}

// ---------------------------------------------------------------------
// Textos de cada correo (asunto, título, párrafos...) — parametrizables
// ---------------------------------------------------------------------

/**
 * Textos POR DEFECTO de cada correo de la app, por clave. La hoja
 * CONFIG_CORREO_TEXTOS (06_ConfigSheet.js) tiene una fila por clave y puede
 * reemplazar cualquier campo: una celda vacía = se usa el texto de aquí.
 *
 * Formato de los campos (el mismo en la hoja):
 *   {{variable}}                  se reemplaza por su valor.
 *   {{#variable}}...{{/variable}} solo aparece si la variable tiene valor.
 *   {{^variable}}...{{/variable}} solo aparece si la variable está vacía.
 *   PARRAFOS    párrafos separados por una línea en blanco; un salto de línea
 *               simple dentro de un párrafo se respeta.
 *   DESTACADOS  una línea por dato: "Título | valor". Un dato cuyo valor
 *               quede vacío no se muestra.
 *   BOTON       texto del botón; el enlace lo pone el código (sin enlace no
 *               hay botón).
 * DESCRIPCION / DESTINATARIO / VARIABLES son solo informativos (columnas de
 * ayuda en la hoja); el código no los usa para enviar.
 */
function mail_textosDefault_() {
  var saludo = 'Hola{{#nombre}} {{nombre}}{{/nombre}},';
  return {
    COTIZACION_CREADA: {
      DESCRIPCION: 'Se envía cuando termina de generarse el documento de una cotización recién creada.',
      DESTINATARIO: 'Quien creó la cotización (CREADO POR o, si está vacío, el correo de ELABORADO POR).',
      VARIABLES: 'nombre, codigo, cliente, estado, fechaElaboracion',
      ASUNTO: 'Cotización {{codigo}} creada correctamente',
      PREHEADER: 'Su cotización {{codigo}} quedó registrada y su documento ya está disponible.',
      ETIQUETA: 'Cotización creada',
      TITULO: 'Su cotización fue creada correctamente',
      SALUDO: saludo,
      PARRAFOS: 'Le confirmamos que la cotización {{codigo}}{{#cliente}} para el cliente {{cliente}}{{/cliente}} quedó registrada en KGP Panel con el estado "{{estado}}".\n\n' +
        'El documento de la cotización ya fue generado en Google Sheets. Puede abrirlo directamente con el botón de abajo.',
      BOTON: 'Abrir documento de la cotización',
      DESTACADOS: 'Código de la cotización | {{codigo}}\nCliente | {{cliente}}\nFecha de elaboración | {{fechaElaboracion}}'
    },
    COTIZACION_APROBADA: {
      DESCRIPCION: 'Se envía cuando se aprueba una cotización y termina de generarse el documento de su OIS u OIP.',
      DESTINATARIO: 'Quien creó la cotización.',
      VARIABLES: 'nombre, codigo, cliente, tipoOrden (OIS/OIP), nombreOrden, codigoOrden, fechaAprobacion',
      ASUNTO: 'Cotización {{codigo}} aprobada — {{tipoOrden}} {{codigoOrden}}',
      PREHEADER: 'Su cotización {{codigo}} fue aprobada y se generó la {{tipoOrden}} {{codigoOrden}}.',
      ETIQUETA: 'Cotización aprobada',
      TITULO: 'Su cotización fue aprobada',
      SALUDO: saludo,
      PARRAFOS: 'Nos complace informarle que la cotización {{codigo}}{{#cliente}} del cliente {{cliente}}{{/cliente}} fue aprobada.\n\n' +
        'Con esta aprobación se generó la {{nombreOrden}} ({{tipoOrden}}) {{codigoOrden}}. Su documento ya está disponible en Google Sheets y puede abrirlo directamente con el botón de abajo.',
      BOTON: 'Abrir documento de la {{tipoOrden}}',
      DESTACADOS: 'Código de la {{tipoOrden}} | {{codigoOrden}}\nCotización | {{codigo}}\nCliente | {{cliente}}\nFecha de aprobación | {{fechaAprobacion}}'
    },
    COTIZACION_RECHAZADA: {
      DESCRIPCION: 'Se envía cuando una cotización se marca como rechazada en "Gestionar cotización".',
      DESTINATARIO: 'Quien creó la cotización.',
      VARIABLES: 'nombre, codigo, cliente, fecha, tieneDocumento (vacía si la cotización no tiene documento)',
      ASUNTO: 'Cotización {{codigo}} rechazada',
      PREHEADER: 'La cotización {{codigo}} fue marcada como rechazada.',
      ETIQUETA: 'Cotización rechazada',
      TITULO: 'Su cotización fue rechazada',
      SALUDO: saludo,
      PARRAFOS: 'Le informamos que la cotización {{codigo}}{{#cliente}} del cliente {{cliente}}{{/cliente}} fue marcada como rechazada.\n\n' +
        'La cotización queda cerrada y ya no admite cambios. {{#tieneDocumento}}Puede consultar su documento en Google Sheets con el botón de abajo.{{/tieneDocumento}}' +
        '{{^tieneDocumento}}Puede consultarla en cualquier momento desde "Gestionar cotización" en KGP Panel.{{/tieneDocumento}}',
      BOTON: 'Abrir documento de la cotización',
      DESTACADOS: 'Código de la cotización | {{codigo}}\nCliente | {{cliente}}\nFecha de la decisión | {{fecha}}'
    },
    TAREA_ASIGNADA: {
      DESCRIPCION: 'Se envía al crear una tarea (Gestionar tareas, o tareas nuevas al guardar una OIS/OIP). Editar una tarea no envía nada.',
      DESTINATARIO: 'El responsable de la tarea (CORREO en PERSONAL_KGP).',
      VARIABLES: 'nombre, tarea, descripcion, tipoOrden (OIS/OIP), nombreOrden, codigoOrden, cliente, fechaInicio, fechaEntrega',
      ASUNTO: 'Nueva tarea asignada — {{tipoOrden}} {{codigoOrden}}',
      PREHEADER: 'Se le asignó una tarea en la {{tipoOrden}} {{codigoOrden}} con entrega el {{fechaEntrega}}.',
      ETIQUETA: 'Nueva tarea',
      TITULO: 'Se le asignó una nueva tarea',
      SALUDO: saludo,
      PARRAFOS: 'Se le asignó una nueva tarea en la {{nombreOrden}} ({{tipoOrden}}) {{codigoOrden}}{{#cliente}} del cliente {{cliente}}{{/cliente}}.\n\n' +
        'A continuación encontrará el detalle de la tarea. Le pedimos tener presente la fecha de entrega.',
      BOTON: 'Abrir documento de la {{tipoOrden}}',
      DESTACADOS: 'Tarea | {{tarea}}\nDescripción | {{descripcion}}{{^descripcion}}Sin descripción adicional.{{/descripcion}}\n' +
        'Pertenece a | {{tipoOrden}} {{codigoOrden}}{{#cliente}} — {{cliente}}{{/cliente}}\nFecha de entrega | {{fechaEntrega}}'
    },
    OIP_RECORDATORIO: {
      DESCRIPCION: 'Recordatorio mensual de facturación de las OIP (día 1 de cada mes; disparador instalado con admin_installOipFacturacionTrigger).',
      DESTINATARIO: 'OIP_NOTIF_EMAIL (hoja CONFIG_CORREO).',
      VARIABLES: 'mes (p. ej. "septiembre de 2026"), total, plural ("s" si son varias), filasCreadas, estadoPendiente. DESTACADOS se repite por cada OIP pendiente con: codigo, cliente, estado, nueva',
      ASUNTO: 'Recordatorio de facturación OIP — {{mes}} ({{total}} pendiente{{plural}})',
      PREHEADER: '{{total}} OIP pendiente{{plural}} de facturar del mes de {{mes}}.',
      ETIQUETA: 'Facturación OIP',
      TITULO: 'Recordatorio de facturación — {{mes}}',
      SALUDO: 'Hola,',
      PARRAFOS: 'Este es el recordatorio automático de facturación de las Órdenes Internas de Proyectos (OIP). Para el mes de {{mes}} hay {{total}} OIP pendiente{{plural}} de facturar{{#filasCreadas}} (filas de facturación creadas automáticamente: {{filasCreadas}}){{/filasCreadas}}.\n\n' +
        'Cada una ya tiene su fila del mes en la hoja OIP_FACTURACION con estado "{{estadoPendiente}}".\n' +
        'Entre a "Gestionar OIP" en KGP Panel, abra la OIP y complete la cuota y el número de factura en la sección Facturación.',
      BOTON: '',
      DESTACADOS: '{{codigo}}{{#cliente}} — {{cliente}}{{/cliente}} | Estado: {{estado}}{{#nueva}} (fila creada automáticamente){{/nueva}}'
    }
  };
}

/** Campos de texto de un correo que se pueden editar (columnas de CONFIG_CORREO_TEXTOS). */
function mail_camposTexto_() {
  return ['ASUNTO', 'PREHEADER', 'ETIQUETA', 'TITULO', 'SALUDO', 'PARRAFOS', 'BOTON', 'DESTACADOS'];
}

/** Textos efectivos de un correo: los de la hoja de config donde tengan valor; si no, los de mail_textosDefault_. */
function mail_textos_(clave) {
  var base = mail_textosDefault_()[clave];
  if (!base) throw new AppError_('MAIL', 'No existe el correo "' + clave + '" en mail_textosDefault_.');
  var hoja = (cfgs_overrides_().correos || {})[clave] || {};
  var out = Object.assign({}, base);
  mail_camposTexto_().forEach(function (campo) {
    if (hoja[campo] != null && String(hoja[campo]).trim() !== '') out[campo] = String(hoja[campo]);
  });
  return out;
}

/** Reemplaza {{var}} y resuelve {{#var}}..{{/var}} / {{^var}}..{{/var}}. Texto plano (el escape HTML lo hace mail_render_). */
function mail_tpl_(texto, vars) {
  var s = String(texto == null ? '' : texto);
  vars = vars || {};
  function lleno(k) {
    var v = vars[k];
    return !(v == null || v === false || v === 0 || String(v).trim() === '');
  }
  var re = /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
  var prev;
  do {
    prev = s;
    s = s.replace(re, function (m, tipo, k, dentro) {
      return (tipo === '#') === lleno(k) ? dentro : '';
    });
  } while (s !== prev);
  s = s.replace(/\{\{(\w+)\}\}/g, function (m, k) { return vars[k] == null ? '' : String(vars[k]); });
  // "S.A.S." al final de una frase no debe quedar "S.A.S.." (sin tocar "...").
  return s.replace(/([^.])\.\.(?!\.)/g, '$1.');
}

/**
 * Arma los `opts` de mail_send_ para el correo `clave` con sus variables.
 * opciones.url: enlace del botón (sin url no hay botón).
 * opciones.items: [vars] — las líneas de DESTACADOS se repiten por item (con
 * las variables del item sobre las generales); lo usa el recordatorio OIP.
 */
function mail_construir_(clave, vars, opciones) {
  opciones = opciones || {};
  vars = vars || {};
  var t = mail_textos_(clave);

  var parrafos = String(t.PARRAFOS || '').split(/\r?\n[ \t]*\r?\n/)
    .map(function (p) { return mail_tpl_(p.trim(), vars).trim(); })
    .filter(function (p) { return p; });

  var lineas = String(t.DESTACADOS || '').split(/\r?\n/).filter(function (l) { return l.trim(); });
  var destacados = [];
  (opciones.items || [vars]).forEach(function (item) {
    var v = opciones.items ? Object.assign({}, vars, item) : vars;
    lineas.forEach(function (l) {
      var i = l.indexOf('|');
      var titulo = i >= 0 ? mail_tpl_(l.slice(0, i), v).trim() : '';
      var texto = mail_tpl_(i >= 0 ? l.slice(i + 1) : l, v).trim();
      if (texto) destacados.push({ titulo: titulo, texto: texto });
    });
  });

  var botonTexto = mail_tpl_(t.BOTON, vars).trim();
  return {
    asunto: mail_tpl_(t.ASUNTO, vars).trim(),
    preheader: mail_tpl_(t.PREHEADER, vars).trim(),
    etiqueta: mail_tpl_(t.ETIQUETA, vars).trim(),
    titulo: mail_tpl_(t.TITULO, vars).trim(),
    saludo: mail_tpl_(t.SALUDO, vars).trim(),
    parrafos: parrafos,
    boton: (opciones.url && botonTexto) ? { texto: botonTexto, url: opciones.url } : null,
    destacados: destacados
  };
}

/** Envía el correo `clave` (textos de mail_textos_) a `destino`. Mismas reglas que mail_send_ (lanza si falla). */
function mail_enviar_(clave, destino, vars, opciones) {
  mail_send_(destino, mail_construir_(clave, vars, opciones));
}
