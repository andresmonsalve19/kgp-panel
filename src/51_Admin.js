/**
 * Funciones de diagnóstico y preparación, pensadas para ejecutarse desde
 * el editor de Apps Script (Ejecutar > seleccionar función), no desde la
 * webapp. Cada una deja un resumen legible en Logger.log (Ver > Registros)
 * además de devolver un objeto.
 *
 * Orden recomendado (Fase 2 del plan, "Descubrimiento del esquema"):
 *   1. admin_convertTemplate()      — una sola vez
 *   2. admin_smokeTestTemplate()    — comparar visualmente con el original
 *   3. admin_health()               — ver encabezados reales de las 5 hojas
 *      (si TEMPLATE_TAB_NAME detectado automáticamente no es el correcto,
 *      admin_setTemplateTabName('NombreReal') lo corrige)
 *   4. admin_dumpSample()           — opcional, ver 3 filas reales de cada hoja
 *
 * SEGURIDAD: google.script.run puede invocar cualquier función global que no
 * termine en "_", y la web app está publicada para cualquiera con el enlace.
 * Por eso TODA función admin_* empieza con admin_soloEditor_(): solo corre si
 * quien la ejecuta es la misma cuenta con la que corre el script (el dueño,
 * desde el editor). Desde el navegador de cualquier otra persona falla.
 */

/**
 * Corta la ejecución si no la lanzó la cuenta dueña del script (ver el
 * encabezado). En el editor, el usuario activo y el efectivo son el mismo; en
 * la web app (executeAs USER_DEPLOYING) el activo es el visitante, o vacío.
 * @throws {Error}
 */
function admin_soloEditor_() {
  var activo = '';
  var efectivo = '';
  try { activo = Session.getActiveUser().getEmail() || ''; } catch (e) { activo = ''; }
  try { efectivo = Session.getEffectiveUser().getEmail() || ''; } catch (e2) { efectivo = ''; }
  if (!activo || !efectivo || activo.toLowerCase() !== efectivo.toLowerCase()) {
    throw new Error('Las funciones admin_* solo se pueden ejecutar desde el editor de Apps Script, con la cuenta dueña del proyecto.');
  }
}

/**
 * Convierte la plantilla .xlsx (CFG_().TEMPLATE_FILE_ID) a un Google Sheet
 * nativo UNA SOLA VEZ, y guarda su ID en ScriptProperties (TEMPLATE_SHEET_ID)
 * para que CFG_() lo recoja automáticamente en adelante. El .xlsx original
 * no se toca. Si ya existe un TEMPLATE_SHEET_ID guardado, no vuelve a
 * convertir (evita duplicar el archivo si se ejecuta más de una vez).
 */
function admin_convertTemplate() {
  admin_soloEditor_();
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperty('TEMPLATE_SHEET_ID');
  if (existing) {
    var msgExist = 'Ya existe una plantilla nativa convertida: ' + existing +
      '. Si quieres forzar una nueva conversión, borra la propiedad TEMPLATE_SHEET_ID en ' +
      'Configuración del proyecto > Propiedades del script, y vuelve a ejecutar esta función.';
    Logger.log(msgExist);
    return { templateSheetId: existing, alreadyExisted: true, message: msgExist };
  }

  var templateFileId = CFG_().TEMPLATE_FILE_ID;
  var parentId = null;
  try {
    var templateFile = DriveApp.getFileById(templateFileId);
    var parents = templateFile.getParents();
    if (parents.hasNext()) parentId = parents.next().getId();
  } catch (e) {
    Logger.log('No se pudo leer la carpeta contenedora de la plantilla original: ' + errMsg_(e) + '. Se creará en la raíz de Drive.');
  }

  var copyResource = { title: 'PLANTILLA_COTIZACION (nativa - no editar a mano)', mimeType: MimeType.GOOGLE_SHEETS };
  if (parentId) copyResource.parents = [{ id: parentId }];

  var converted = Drive.Files.copy(copyResource, templateFileId, { convert: true, supportsAllDrives: true });

  props.setProperty('TEMPLATE_SHEET_ID', converted.id);
  cfg_invalidar_();

  var msg = 'Plantilla convertida a Google Sheet nativo.\n' +
    'Nuevo ID: ' + converted.id + '\n' +
    'Guardado en ScriptProperties (TEMPLATE_SHEET_ID). CFG_() lo usará automáticamente desde ahora.\n' +
    'Siguiente paso: ejecuta admin_smokeTestTemplate() y compara el resultado visualmente con la plantilla original.';
  Logger.log(msg);
  return { templateSheetId: converted.id, alreadyExisted: false, message: msg };
}

/**
 * 🚦 Puerta de decisión del plan: genera un .xlsx de la plantilla SIN
 * escribir ningún dato de negocio, y lo guarda en la carpeta destino. Hay
 * que abrirlo y compararlo visualmente contra la plantilla original
 * (CFG_().TEMPLATE_FILE_ID) antes de dar por buena la generación de
 * documentos reales.
 */
function admin_smokeTestTemplate() {
  admin_soloEditor_();
  if (!CFG_().TEMPLATE_SHEET_ID) {
    var errMsg = 'TEMPLATE_SHEET_ID vacío. Ejecuta admin_convertTemplate() primero.';
    Logger.log(errMsg);
    throw new Error(errMsg);
  }

  var tmpId = null;
  try {
    var copy = Drive.Files.copy(
      { title: '__TMP_SMOKETEST__' + Date.now(), mimeType: MimeType.GOOGLE_SHEETS },
      CFG_().TEMPLATE_SHEET_ID,
      { convert: true, supportsAllDrives: true }
    );
    tmpId = copy.id;

    var name = '__SMOKETEST__' + Utilities.formatDate(new Date(), CFG_().TZ, 'yyyyMMdd_HHmmss') + '.xlsx';
    var blob = doc_exportXlsx_(tmpId, name);
    var saved = Drive.Files.insert({ title: name, parents: [{ id: CFG_().OUT_FOLDER_ID }] }, blob, { supportsAllDrives: true });

    var msg = 'Smoke test generado: ' + saved.alternateLink + '\n' +
      'Ábrelo y compáralo visualmente con la plantilla original (Drive file ID ' + CFG_().TEMPLATE_FILE_ID + ').\n' +
      'Si el formato se ve degradado (bordes, validaciones de datos, imágenes), avisa antes de continuar.';
    Logger.log(msg);
    return { url: saved.alternateLink, fileId: saved.id, message: msg };
  } finally {
    if (tmpId) {
      try { doc_cleanupTemp_(tmpId); } catch (cleanupErr) { Logger.log('No se pudo limpiar el temporal del smoke test: ' + errMsg_(cleanupErr)); }
    }
  }
}

/**
 * Vuelca a Logger.log los encabezados REALES de las 5 hojas de la BD, del
 * catálogo, y de la plantilla, comparándolos contra SCHEMA_(). Es el paso
 * que resuelve todas las incógnitas de esquema pendientes de la Fase 2.
 */
function admin_health() {
  admin_soloEditor_();
  var cfg = CFG_();
  var schema = SCHEMA_();
  var report = { sheets: [], catalogo: null, plantilla: null };

  var checks = [
    { tabKey: 'COTIZACIONES', schemaKey: 'COTIZACIONES' },
    { tabKey: 'SERVICIOS', schemaKey: 'SERVICIOS' },
    { tabKey: 'CLIENTES', schemaKey: 'CLIENTES' },
    { tabKey: 'CONTACTOS', schemaKey: 'CONTACTOS_CLIENTES' },
    { tabKey: 'ESTABLECIMIENTOS', schemaKey: 'ESTABLECIMIENTOS_CLIENTES' },
    { tabKey: 'PERSONAL', schemaKey: 'PERSONAL_KGP' },
    { tabKey: 'PERSONAL_TERCEROS', schemaKey: 'PERSONAL_TERCEROS' },
    { tabKey: 'OIS', schemaKey: 'OIS' },
    { tabKey: 'TAREAS_OIS', schemaKey: 'TAREAS_OIS' },
    { tabKey: 'OIP', schemaKey: 'OIP' },
    { tabKey: 'TAREAS_OIP', schemaKey: 'TAREAS_OIP' },
    { tabKey: 'OIP_FACTURACION', schemaKey: 'OIP_FACTURACION' }
  ];

  checks.forEach(function (c) {
    var tabName = cfg.TABS[c.tabKey];
    var entry = { tab: tabName, ok: false, headersFound: [], missing: [], optionalMissing: [] };
    try {
      var sheet = repo_openSheet_(cfg.DB_SHEET_ID, tabName);
      var hmap = repo_headerMap_(sheet);
      entry.headersFound = Object.keys(hmap);

      schema[c.schemaKey].required.forEach(function (col) {
        if (!hmap[normText_(col)]) entry.missing.push(col);
      });
      (schema[c.schemaKey].optional || []).forEach(function (col) {
        if (!hmap[normText_(col)]) entry.optionalMissing.push(col);
      });
      entry.ok = entry.missing.length === 0;
    } catch (e) {
      entry.error = errMsg_(e);
    }
    report.sheets.push(entry);
  });

  try {
    var tipos = cat_getTiposServicio_();
    report.catalogo = { ok: true, count: tipos.length, muestra: tipos.slice(0, 5) };
  } catch (e) {
    report.catalogo = { ok: false, error: errMsg_(e) };
  }

  if (cfg.TEMPLATE_SHEET_ID) {
    try {
      var ss = SpreadsheetApp.openById(cfg.TEMPLATE_SHEET_ID);
      var hojas = ss.getSheets().map(function (s) { return s.getName(); });
      report.plantilla = {
        ok: true,
        hojas: hojas,
        hojaUsadaActualmente: cfg.TEMPLATE_TAB_NAME || hojas[0],
        hojaOis: cfg.TEMPLATE_TAB_OIS,
        hojaOisExiste: hojas.indexOf(cfg.TEMPLATE_TAB_OIS) !== -1,
        hojaOip: cfg.TEMPLATE_TAB_OIP,
        hojaOipExiste: hojas.indexOf(cfg.TEMPLATE_TAB_OIP) !== -1
      };
    } catch (e) {
      report.plantilla = { ok: false, error: errMsg_(e) };
    }
  } else {
    report.plantilla = { ok: false, error: 'TEMPLATE_SHEET_ID vacío. Ejecuta admin_convertTemplate() primero.' };
  }

  Logger.log(admin_formatHealthReport_(report));
  return report;
}

/** Texto legible del informe de admin_health para Logger.log. */
function admin_formatHealthReport_(report) {
  var lines = ['=== admin_health() ==='];
  report.sheets.forEach(function (s) {
    lines.push('');
    lines.push('Hoja: ' + s.tab + (s.ok ? '  [OK]' : '  [FALTAN COLUMNAS]'));
    if (s.error) {
      lines.push('  ERROR: ' + s.error);
      return;
    }
    lines.push('  Encabezados encontrados: ' + s.headersFound.join(' | '));
    if (s.missing.length) lines.push('  ⚠ Requeridas FALTANTES: ' + s.missing.join(', '));
    if (s.optionalMissing.length) lines.push('  (opcionales no presentes: ' + s.optionalMissing.join(', ') + ')');
  });
  lines.push('');
  lines.push('Catálogo TIPOS DE SERVICIOS: ' + JSON.stringify(report.catalogo));
  lines.push('Plantilla: ' + JSON.stringify(report.plantilla));
  return lines.join('\n');
}

/**
 * Corrige el nombre de la hoja de la plantilla que se usa para escribir
 * las celdas, si la primera hoja detectada automáticamente no es la
 * correcta (ver report.plantilla.hojas de admin_health()).
 */
function admin_setTemplateTabName(nombreHoja) {
  admin_soloEditor_();
  PropertiesService.getScriptProperties().setProperty('TEMPLATE_TAB_NAME', nombreHoja);
  cfg_invalidar_();
  var msg = 'TEMPLATE_TAB_NAME fijado a: "' + nombreHoja + '"';
  Logger.log(msg);
  return { ok: true, nombreHoja: nombreHoja, message: msg };
}

/**
 * Corrige el nombre de la pestaña de la OIS dentro de la plantilla
 * (CFG_().TEMPLATE_TAB_OIS, por defecto "OIS V-4") si en el archivo real se
 * llama distinto (ver report.plantilla.hojas de admin_health()).
 */
function admin_setOisTabName(nombreHoja) {
  admin_soloEditor_();
  PropertiesService.getScriptProperties().setProperty('TEMPLATE_TAB_OIS', nombreHoja);
  cfg_invalidar_();
  var msg = 'TEMPLATE_TAB_OIS fijado a: "' + nombreHoja + '"';
  Logger.log(msg);
  return { ok: true, nombreHoja: nombreHoja, message: msg };
}

/** Igual que admin_setOisTabName pero para la pestaña de la OIP ("OIP V-4"). */
function admin_setOipTabName(nombreHoja) {
  admin_soloEditor_();
  PropertiesService.getScriptProperties().setProperty('TEMPLATE_TAB_OIP', nombreHoja);
  cfg_invalidar_();
  var msg = 'TEMPLATE_TAB_OIP fijado a: "' + nombreHoja + '"';
  Logger.log(msg);
  return { ok: true, nombreHoja: nombreHoja, message: msg };
}

/**
 * Instala el disparador mensual del recordatorio de facturación de las OIP
 * (día 1 de cada mes, ~7am hora de Bogotá -> oipn_recordatorioFacturacion).
 *
 * EJECUTAR UNA SOLA VEZ a mano desde el editor de Apps Script. Es idempotente:
 * primero borra cualquier disparador que ya apunte a esa función, así
 * volverla a correr no deja dos recordatorios enviando el correo dos veces.
 */
function admin_installOipFacturacionTrigger() {
  admin_soloEditor_();
  var fn = 'oipn_recordatorioFacturacion';
  var borrados = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === fn) {
      ScriptApp.deleteTrigger(t);
      borrados++;
    }
  });

  var cfg = CFG_();
  ScriptApp.newTrigger(fn)
    .timeBased()
    .onMonthDay(cfg.OIP_NOTIF_DIA)
    .atHour(cfg.OIP_NOTIF_HORA)
    .inTimezone(cfg.TZ)
    .create();

  var msg = 'Disparador mensual instalado para ' + fn + ' (día ' + cfg.OIP_NOTIF_DIA + ', ~' + cfg.OIP_NOTIF_HORA + ':00 ' + cfg.TZ + ').' +
    (borrados ? ' Se eliminaron ' + borrados + ' disparador(es) anterior(es) de la misma función.' : '');
  Logger.log(msg);
  return { ok: true, borrados: borrados, message: msg };
}

/** Lista los disparadores del proyecto (para confirmar que el recordatorio quedó instalado una sola vez). */
function admin_listTriggers() {
  admin_soloEditor_();
  var list = ScriptApp.getProjectTriggers().map(function (t) {
    return { funcion: t.getHandlerFunction(), tipo: String(t.getEventType()), fuente: String(t.getTriggerSource()) };
  });
  Logger.log(JSON.stringify(list, null, 2));
  return list;
}

/**
 * Prueba el recordatorio de facturación SIN esperar al día 1 y sin la
 * protección de "ya se ejecutó este mes": borra la marca OIP_NOTIF_LAST y
 * corre el proceso con la fecha de hoy. Ojo: SÍ crea las filas de
 * OIP_FACTURACION que falten y SÍ envía el correo de verdad.
 */
function admin_probarRecordatorioOip() {
  admin_soloEditor_();
  PropertiesService.getScriptProperties().deleteProperty('OIP_NOTIF_LAST');
  var res = oipn_recordatorioFacturacion();
  Logger.log(JSON.stringify(res, null, 2));
  return res;
}

/**
 * Envía a `destino` un ejemplo de cada correo de la app (todas las claves de
 * mail_textosDefault_), con la plantilla única y los textos VIGENTES (hoja
 * CONFIG_CORREO_TEXTOS si tiene valor) sobre datos de muestra: NO lee ni
 * escribe la BD. Para revisar cómo se ven después de cambiar la plantilla o
 * los textos. Ejecutar a mano desde el editor, p. ej.
 * admin_probarCorreos('alguien@dominio.com'). Sin argumento usa
 * CFG_().OIP_NOTIF_EMAIL. Si agregas un correo nuevo, agrega sus variables de
 * muestra en admin_muestrasCorreo_.
 */
function admin_probarCorreos(destino) {
  admin_soloEditor_();
  cfgs_refresh_(); // textos recién editados en la hoja, sin esperar a recargar la página
  destino = destino || CFG_().OIP_NOTIF_EMAIL;
  var muestras = admin_muestrasCorreo_();
  var claves = Object.keys(mail_textosDefault_());
  claves.forEach(function (clave) {
    var m = muestras[clave] || { vars: {}, opciones: {} };
    var opts = mail_construir_(clave, m.vars, m.opciones);
    opts.asunto = '[Prueba] ' + opts.asunto;
    mail_send_(destino, opts);
  });
  var msg = 'Se enviaron ' + claves.length + ' correos de prueba a ' + destino + '. Cuota restante hoy: ' + MailApp.getRemainingDailyQuota() + '.';
  Logger.log(msg);
  return msg;
}

/** Variables de muestra de cada correo, para admin_probarCorreos. */
function admin_muestrasCorreo_() {
  var hoy = ntf_fechaLarga_(new Date());
  var url = 'https://docs.google.com/spreadsheets/';
  return {
    COTIZACION_CREADA: {
      vars: { nombre: 'Nombre Apellido', codigo: 'CTZ-KGP-001-26', cliente: 'CLIENTE DE PRUEBA S.A.S.', estado: CFG_().ESTADO_INICIAL, fechaElaboracion: hoy },
      opciones: { url: url }
    },
    COTIZACION_APROBADA: {
      vars: { nombre: 'Nombre Apellido', codigo: 'CTZ-KGP-001-26', cliente: 'CLIENTE DE PRUEBA S.A.S.', tipoOrden: 'OIS', nombreOrden: ntf_nombreOrden_('OIS'), codigoOrden: 'OIS-KGP-001-26', fechaAprobacion: hoy },
      opciones: { url: url }
    },
    COTIZACION_RECHAZADA: {
      vars: { nombre: 'Nombre Apellido', codigo: 'CTZ-KGP-002-26', cliente: 'CLIENTE DE PRUEBA S.A.S.', fecha: hoy, tieneDocumento: 'si' },
      opciones: { url: url }
    },
    TAREA_ASIGNADA: {
      vars: {
        nombre: 'Nombre Apellido', tarea: 'Visita técnica de inspección',
        descripcion: 'Llevar los equipos de medición.\nConfirmar la hora con el encargado del establecimiento.',
        tipoOrden: 'OIP', nombreOrden: ntf_nombreOrden_('OIP'), codigoOrden: 'OIP-KGP-001-26',
        cliente: 'CLIENTE DE PRUEBA S.A.S.', fechaInicio: hoy, fechaEntrega: hoy
      },
      opciones: { url: url }
    },
    OIP_RECORDATORIO: {
      vars: { mes: 'septiembre de 2026', total: 2, plural: 's', filasCreadas: 1, estadoPendiente: CFG_().FACT_ESTADO_PENDIENTE },
      opciones: {
        items: [
          { codigo: 'OIP-KGP-001-26', cliente: 'CLIENTE DE PRUEBA S.A.S.', estado: CFG_().FACT_ESTADO_PENDIENTE, nueva: 'si' },
          { codigo: 'OIP-KGP-002-26', cliente: 'OTRO CLIENTE LTDA', estado: CFG_().FACT_ESTADO_PENDIENTE, nueva: '' }
        ]
      }
    }
  };
}

/**
 * Crea (o completa) las hojas CONFIG_* en el spreadsheet de catálogo
 * (CFG_().CAT_SHEET_ID) con todos los parámetros de la app en forma de tabla:
 * IDs, nombres de hojas, parámetros generales, correo, textos de cada correo
 * y celdas de la plantilla, más CONFIG_LEEME con las instrucciones.
 *
 * EJECUTAR A MANO desde el editor de Apps Script. Se puede repetir cuando se
 * quiera: nunca pisa un VALOR ya escrito (ni un texto de correo); solo agrega
 * las filas que falten y refresca las columnas de ayuda (descripción, valor
 * por defecto, enlace). Ver 06_ConfigSheet.js / CLAUDE.md §15.
 */
function admin_crearHojasConfig() {
  admin_soloEditor_();
  var resumen = cfgs_crearHojas_();
  cfgs_refresh_();
  var msg = 'Hojas de configuración listas en https://docs.google.com/spreadsheets/d/' + cfgs_sheetId_() + '/edit\n' + resumen.join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * Relee las hojas CONFIG_* y muestra en el registro: qué claves se ignoraron
 * (desconocidas o con un valor no válido) y la configuración efectiva que
 * está usando la app. No escribe nada.
 */
function admin_verConfig() {
  admin_soloEditor_();
  var r = cfgs_verificar_();
  Logger.log('Configuración leída: ' + r.leidoEn + ' | claves en la hoja: ' + r.clavesEnHoja + ' | correos en la hoja: ' + r.correosEnHoja);
  Logger.log(r.avisos.length ? 'AVISOS:\n- ' + r.avisos.join('\n- ') : 'Sin avisos: todo lo de la hoja se aplicó.');
  Logger.log('Configuración efectiva:\n' + JSON.stringify(r.efectivo, null, 2));
  return r;
}

/** Vuelca 3 filas reales de cada hoja de la BD, para verificar que el mapeo de columnas interpreta bien los datos. */
function admin_dumpSample() {
  admin_soloEditor_();
  var cfg = CFG_();
  var out = {};
  ['COTIZACIONES', 'SERVICIOS', 'CLIENTES', 'CONTACTOS', 'ESTABLECIMIENTOS', 'PERSONAL', 'PERSONAL_TERCEROS'].forEach(function (key) {
    var tabName = cfg.TABS[key];
    try {
      var table = repo_readTable_(cfg.DB_SHEET_ID, tabName);
      out[tabName] = table.rows.slice(0, 3);
    } catch (e) {
      out[tabName] = { error: errMsg_(e) };
    }
  });
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** Borra archivos temporales __TMP_* de más de 24h que hayan quedado huérfanos por un fallo de script (timeout duro, etc). */
function admin_cleanTempFiles() {
  admin_soloEditor_();
  var cutoff = Date.now() - 24 * 3600 * 1000;
  var result = Drive.Files.list({
    q: "title contains '__TMP_' and trashed = false",
    maxResults: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  var items = result.items || [];
  var cleaned = [], skipped = [];

  items.forEach(function (f) {
    var created = new Date(f.createdDate).getTime();
    if (created < cutoff) {
      try {
        doc_cleanupTemp_(f.id);
        cleaned.push(f.title);
      } catch (e) {
        skipped.push(f.title + ' (' + errMsg_(e) + ')');
      }
    }
  });

  var msg = 'Limpiados: ' + cleaned.length + '. Omitidos: ' + skipped.length;
  Logger.log(msg + '\n' + JSON.stringify({ cleaned: cleaned, skipped: skipped }));
  return { cleaned: cleaned, skipped: skipped };
}

/**
 * Invalida todas las cachés: incrementa dataVersion (listados, dashboard,
 * empleados...) y relee las hojas CONFIG_* (la copia de la configuración no
 * depende de dataVersion). El catálogo TIPOS DE SERVICIOS nunca se cachea.
 */
function admin_clearCaches() {
  admin_soloEditor_();
  bumpDataVersion_();
  cfgs_refresh_();
  var msg = 'Cachés invalidadas: dataVersion incrementada y configuración releída de las hojas CONFIG_*.';
  Logger.log(msg);
  return { ok: true, message: msg };
}
