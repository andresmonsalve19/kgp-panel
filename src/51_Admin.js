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
 */

/**
 * Convierte la plantilla .xlsx (CFG().TEMPLATE_FILE_ID) a un Google Sheet
 * nativo UNA SOLA VEZ, y guarda su ID en ScriptProperties (TEMPLATE_SHEET_ID)
 * para que CFG() lo recoja automáticamente en adelante. El .xlsx original
 * no se toca. Si ya existe un TEMPLATE_SHEET_ID guardado, no vuelve a
 * convertir (evita duplicar el archivo si se ejecuta más de una vez).
 */
function admin_convertTemplate() {
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperty('TEMPLATE_SHEET_ID');
  if (existing) {
    var msgExist = 'Ya existe una plantilla nativa convertida: ' + existing +
      '. Si quieres forzar una nueva conversión, borra la propiedad TEMPLATE_SHEET_ID en ' +
      'Configuración del proyecto > Propiedades del script, y vuelve a ejecutar esta función.';
    Logger.log(msgExist);
    return { templateSheetId: existing, alreadyExisted: true, message: msgExist };
  }

  var templateFileId = CFG().TEMPLATE_FILE_ID;
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

  var msg = 'Plantilla convertida a Google Sheet nativo.\n' +
    'Nuevo ID: ' + converted.id + '\n' +
    'Guardado en ScriptProperties (TEMPLATE_SHEET_ID). CFG() lo usará automáticamente desde ahora.\n' +
    'Siguiente paso: ejecuta admin_smokeTestTemplate() y compara el resultado visualmente con la plantilla original.';
  Logger.log(msg);
  return { templateSheetId: converted.id, alreadyExisted: false, message: msg };
}

/**
 * 🚦 Puerta de decisión del plan: genera un .xlsx de la plantilla SIN
 * escribir ningún dato de negocio, y lo guarda en la carpeta destino. Hay
 * que abrirlo y compararlo visualmente contra la plantilla original
 * (CFG().TEMPLATE_FILE_ID) antes de dar por buena la generación de
 * documentos reales.
 */
function admin_smokeTestTemplate() {
  if (!CFG().TEMPLATE_SHEET_ID) {
    var errMsg = 'TEMPLATE_SHEET_ID vacío. Ejecuta admin_convertTemplate() primero.';
    Logger.log(errMsg);
    throw new Error(errMsg);
  }

  var tmpId = null;
  try {
    var copy = Drive.Files.copy(
      { title: '__TMP_SMOKETEST__' + Date.now(), mimeType: MimeType.GOOGLE_SHEETS },
      CFG().TEMPLATE_SHEET_ID,
      { convert: true, supportsAllDrives: true }
    );
    tmpId = copy.id;

    var name = '__SMOKETEST__' + Utilities.formatDate(new Date(), CFG().TZ, 'yyyyMMdd_HHmmss') + '.xlsx';
    var blob = doc_exportXlsx_(tmpId, name);
    var saved = Drive.Files.insert({ title: name, parents: [{ id: CFG().OUT_FOLDER_ID }] }, blob, { supportsAllDrives: true });

    var msg = 'Smoke test generado: ' + saved.alternateLink + '\n' +
      'Ábrelo y compáralo visualmente con la plantilla original (Drive file ID ' + CFG().TEMPLATE_FILE_ID + ').\n' +
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
 * catálogo, y de la plantilla, comparándolos contra SCHEMA(). Es el paso
 * que resuelve todas las incógnitas de esquema pendientes de la Fase 2.
 */
function admin_health() {
  var cfg = CFG();
  var schema = SCHEMA();
  var report = { sheets: [], catalogo: null, plantilla: null };

  var checks = [
    { tabKey: 'COTIZACIONES', schemaKey: 'COTIZACIONES' },
    { tabKey: 'SERVICIOS', schemaKey: 'SERVICIOS' },
    { tabKey: 'CLIENTES', schemaKey: 'CLIENTES' },
    { tabKey: 'CONTACTOS', schemaKey: 'CONTACTOS_CLIENTES' },
    { tabKey: 'ESTABLECIMIENTOS', schemaKey: 'ESTABLECIMIENTOS_CLIENTES' },
    { tabKey: 'PERSONAL', schemaKey: 'PERSONAL_KGP' },
    { tabKey: 'OIS', schemaKey: 'OIS' },
    { tabKey: 'TAREAS_OIS', schemaKey: 'TAREAS_OIS' }
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
        hojaOisExiste: hojas.indexOf(cfg.TEMPLATE_TAB_OIS) !== -1
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
  PropertiesService.getScriptProperties().setProperty('TEMPLATE_TAB_NAME', nombreHoja);
  var msg = 'TEMPLATE_TAB_NAME fijado a: "' + nombreHoja + '"';
  Logger.log(msg);
  return { ok: true, nombreHoja: nombreHoja, message: msg };
}

/**
 * Corrige el nombre de la pestaña de la OIS dentro de la plantilla
 * (CFG().TEMPLATE_TAB_OIS, por defecto "OIS V-4") si en el archivo real se
 * llama distinto (ver report.plantilla.hojas de admin_health()).
 */
function admin_setOisTabName(nombreHoja) {
  PropertiesService.getScriptProperties().setProperty('TEMPLATE_TAB_OIS', nombreHoja);
  var msg = 'TEMPLATE_TAB_OIS fijado a: "' + nombreHoja + '"';
  Logger.log(msg);
  return { ok: true, nombreHoja: nombreHoja, message: msg };
}

/** Vuelca 3 filas reales de cada hoja de la BD, para verificar que el mapeo de columnas interpreta bien los datos. */
function admin_dumpSample() {
  var cfg = CFG();
  var out = {};
  ['COTIZACIONES', 'SERVICIOS', 'CLIENTES', 'CONTACTOS', 'ESTABLECIMIENTOS', 'PERSONAL'].forEach(function (key) {
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

/** Invalida todas las cachés (incrementa dataVersion + limpia el catálogo, que no depende de dataVersion). */
function admin_clearCaches() {
  bumpDataVersion_();
  CacheService.getScriptCache().remove('cat:tipos:v1');
  var msg = 'Cachés invalidadas: dataVersion incrementada y catálogo de tipos limpiado.';
  Logger.log(msg);
  return { ok: true, message: msg };
}
