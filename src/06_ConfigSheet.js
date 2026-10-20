/**
 * Configuración editable (CLAUDE.md §15). Por decisión del usuario SOLO se
 * configuran tres cosas; todo lo demás (plazos, IVA, límites, celdas de la
 * plantilla, nombres de pestañas, firma y pie del correo...) vive únicamente
 * en el código (00_Config.js, 04_MailTemplate.js).
 *
 *   1. IDs de spreadsheets, carpetas y archivos   -> hoja CONFIG_IDS
 *   2. Correos: destinatarios fijos, "copia siempre a", asunto y cuerpo
 *                                                  -> hoja CONFIG_CORREOS
 *   3. Tipos de servicio                           -> hoja TIPOS DE SERVICIOS
 *                                                     (11_CatalogRepo.js)
 *
 * Las tres viven en el spreadsheet de catálogo (cfgs_sheetId_) y se editan
 * desde la vista "Configuración" (ui/ViewConfig.html + ui/JsConfig.js.html,
 * api_*Config* en 50_WebApp.js), que escribe directamente en estas hojas.
 * También se pueden editar a mano en el spreadsheet.
 *
 * CÓMO SE APLICA
 *   - doGet (cada carga o recarga de la página) llama cfgs_refresh_: lee
 *     CONFIG_IDS y CONFIG_CORREOS en una sola apertura del spreadsheet y deja
 *     el resultado en CacheService. Las llamadas google.script.run de esa
 *     sesión y los disparadores usan esa copia. Guardar desde la vista
 *     Configuración también la refresca.
 *   - CFG_() (00_Config.js) aplica los IDs y los destinatarios fijos con
 *     cfgs_aplicar_; los textos y la copia fija de cada correo los toma
 *     mail_textos_ (04_MailTemplate.js).
 *   - Solo se aplican claves conocidas (allowlist: cfgs_catalogoIds_ y los
 *     destinatarios fijos de mail_textosDefault_). Celda vacía o clave
 *     desconocida = se queda el valor del código: la app nunca se cae por la
 *     configuración.
 *
 * Las hojas antiguas (CONFIG_LEEME, CONFIG_HOJAS, CONFIG_GENERAL,
 * CONFIG_CORREO, CONFIG_CORREO_TEXTOS, CONFIG_CELDAS) se eliminan la primera
 * vez que se abre la vista Configuración (o con admin_crearHojasConfig()),
 * migrando antes lo que sigue siendo configurable (cfgs_asegurarHojas_).
 *
 * Regla de recursión: nada de lo que se usa al LEER la config puede llamar
 * CFG_() (CFG depende de esto). Por eso el ID del spreadsheet vive en
 * cfgs_sheetId_ y no en CFG.
 */

/** Spreadsheet de catálogo y configuración. Fijo en el código: es de donde sale todo lo demás. */
function cfgs_sheetId_() {
  return '1n87Kj1wgP7PQ3jZXunHgiR7EK2MqG7zcDzhHwCCkaqM';
}

/** Hojas de configuración vigentes. */
function cfgs_tabs_() {
  return { IDS: 'CONFIG_IDS', CORREOS: 'CONFIG_CORREOS' };
}

/** Hojas de la configuración anterior: se eliminan al migrar (cfgs_asegurarHojas_). */
function cfgs_tabsObsoletas_() {
  return ['CONFIG_LEEME', 'CONFIG_HOJAS', 'CONFIG_GENERAL', 'CONFIG_CORREO', 'CONFIG_CORREO_TEXTOS', 'CONFIG_CELDAS'];
}

/** Columnas de CONFIG_IDS. */
function cfgs_columnasIds_() {
  return ['GRUPO', 'CLAVE', 'NOMBRE', 'VALOR', 'DESCRIPCION', 'ENLACE'];
}

/** Columnas de CONFIG_CORREOS: ayuda + destinatarios + los campos de texto editables + variables. */
function cfgs_columnasCorreos_() {
  return ['CLAVE', 'CORREO', 'CUANDO SE ENVIA', 'DESTINATARIOS', 'COPIA SIEMPRE A']
    .concat(mail_camposTexto_())
    .concat(['VARIABLES']);
}

/** Clave de CacheService donde vive la copia leída de las hojas de configuración. */
function cfgs_cacheKey_() {
  return 'cfgsheet:data:v2';
}

/**
 * Segundos que dura esa copia: el máximo de CacheService (6 h). Fijo aquí y no
 * en CFG_(): leer CFG_() desde la lectura de la config sería recursivo. En la
 * práctica se renueva en cada carga de la página (doGet).
 */
function cfgs_ttl_() {
  return 21600;
}

/** Overrides vacíos (sin hoja o con error). */
function cfgs_vacio_(aviso) {
  return { valores: {}, correos: {}, avisos: aviso ? [aviso] : [], leidoEn: '' };
}

// ---------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------

/**
 * Overrides vigentes: memo de la ejecución -> CacheService -> lectura de la
 * hoja (solo si la caché expiró, p. ej. en un disparador). Nunca lanza.
 */
function cfgs_overrides_() {
  var memo = repo_memo_();
  if (memo.__cfgsSinHoja) return cfgs_vacio_();
  if (memo.__cfgs) return memo.__cfgs;
  // Guarda anti-recursión: si algo de abajo llama CFG_(), ve "sin overrides".
  memo.__cfgs = cfgs_vacio_();
  var data = null;
  try {
    data = cacheGetJson_(cfgs_cacheKey_());
    if (!data) {
      data = cfgs_leerHoja_();
      cachePutJson_(cfgs_cacheKey_(), data, cfgs_ttl_());
    }
  } catch (e) {
    data = cfgs_vacio_('No se pudo leer la configuración: ' + errMsg_(e));
    Logger.log('cfgs_overrides_: ' + errMsg_(e));
  }
  memo.__cfgs = data;
  return data;
}

/**
 * Relee las hojas de configuración y reemplaza la copia en caché. Lo llama
 * doGet en cada carga de la página y la vista Configuración tras guardar. Si
 * la lectura falla, se queda la copia anterior.
 */
function cfgs_refresh_() {
  var memo = repo_memo_();
  try {
    memo.__cfgs = cfgs_vacio_(); // anti-recursión durante la lectura
    var data = cfgs_leerHoja_();
    cachePutJson_(cfgs_cacheKey_(), data, cfgs_ttl_());
    memo.__cfgs = data;
    return data;
  } catch (e) {
    Logger.log('cfgs_refresh_: ' + errMsg_(e));
    delete memo.__cfgs;
    return cfgs_overrides_();
  }
}

/** Encabezados normalizados de la fila 1 de `values` -> {NOMBRE: índice}. */
function cfgs_indiceColumnas_(fila) {
  var col = {};
  (fila || []).forEach(function (x, i) {
    var k = normText_(x);
    if (k && col[k] === undefined) col[k] = i;
  });
  return col;
}

/**
 * Lee CONFIG_IDS y CONFIG_CORREOS en una sola apertura del spreadsheet.
 * Devuelve {valores: {CLAVE: texto}, correos: {CLAVE: {CAMPO: texto, CC}},
 * avisos: [], leidoEn}. Los destinatarios fijos de un correo
 * (DESTINO_CFG en mail_textosDefault_) se copian a `valores` para que CFG_()
 * los vea con su nombre de siempre (OIP_NOTIF_EMAIL, OIS_FINALIZADA_EMAIL).
 */
function cfgs_leerHoja_() {
  var tabs = cfgs_tabs_();
  var out = cfgs_vacio_();
  out.leidoEn = new Date().toISOString();
  var ss = SpreadsheetApp.openById(cfgs_sheetId_());

  var shIds = ss.getSheetByName(tabs.IDS);
  if (shIds) {
    var vIds = shIds.getDataRange().getValues();
    var cIds = cfgs_indiceColumnas_(vIds[0]);
    if (cIds.CLAVE === undefined || cIds.VALOR === undefined) {
      out.avisos.push('La hoja ' + tabs.IDS + ' no tiene las columnas CLAVE y VALOR; se ignoró.');
    } else {
      vIds.slice(1).forEach(function (row) {
        var clave = String(row[cIds.CLAVE] || '').trim();
        var v = String(row[cIds.VALOR] == null ? '' : row[cIds.VALOR]).trim();
        if (clave && v) out.valores[clave] = v;
      });
    }
  }

  var shCor = ss.getSheetByName(tabs.CORREOS);
  if (shCor) {
    var vCor = shCor.getDataRange().getValues();
    var cCor = cfgs_indiceColumnas_(vCor[0]);
    if (cCor.CLAVE === undefined) {
      out.avisos.push('La hoja ' + tabs.CORREOS + ' no tiene columna CLAVE; se ignoró.');
    } else {
      var campos = mail_camposTexto_();
      vCor.slice(1).forEach(function (row) {
        var clave = String(row[cCor.CLAVE] || '').trim();
        if (!clave) return;
        // Todas las columnas de texto, incluso vacías: un campo vaciado a
        // propósito (sin botón, sin título...) queda vacío. Ver mail_textos_.
        var t = {};
        campos.forEach(function (c) {
          var i = cCor[c];
          if (i !== undefined) t[c] = row[i] == null ? '' : String(row[i]);
        });
        var iCc = cCor[normText_('COPIA SIEMPRE A')];
        if (iCc !== undefined && String(row[iCc] || '').trim()) t.CC = String(row[iCc]).trim();
        var iDest = cCor.DESTINATARIOS;
        if (iDest !== undefined && String(row[iDest] || '').trim()) t.DESTINATARIOS = String(row[iDest]).trim();
        out.correos[clave] = t;
      });
    }
  }

  // Destinatarios fijos -> claves de CFG_().
  var defs = mail_textosDefault_();
  Object.keys(defs).forEach(function (k) {
    var destinoCfg = defs[k].DESTINO_CFG;
    var hoja = out.correos[k];
    if (destinoCfg && hoja && hoja.DESTINATARIOS) out.valores[destinoCfg] = hoja.DESTINATARIOS;
  });
  return out;
}

// ---------------------------------------------------------------------
// Aplicación sobre CFG_()
// ---------------------------------------------------------------------

/**
 * Claves de CFG_() que la hoja puede sobrescribir: los IDs editables y los
 * destinatarios fijos de los correos. Memoizado por ejecución.
 */
function cfgs_clavesEditables_() {
  var memo = repo_memo_();
  if (memo.__cfgsEditables) return memo.__cfgsEditables;
  var set = {};
  cfgs_catalogoIds_().forEach(function (f) { if (!f.soloLectura) set[f.clave] = true; });
  var defs = mail_textosDefault_();
  Object.keys(defs).forEach(function (k) { if (defs[k].DESTINO_CFG) set[defs[k].DESTINO_CFG] = true; });
  memo.__cfgsEditables = set;
  return set;
}

/**
 * Aplica sobre `cfg` (defaults del código) los valores de la hoja que estén
 * en la allowlist. Todos son textos (IDs, correos). avisos (opcional): array
 * donde anotar lo ignorado. ov (opcional): overrides a usar en vez de
 * cfgs_overrides_ (verificación).
 */
function cfgs_aplicar_(cfg, avisos, ov) {
  var mapa = (ov || cfgs_overrides_()).valores || {};
  var editables = cfgs_clavesEditables_();
  Object.keys(mapa).forEach(function (k) {
    if (!editables[k] || !(k in cfg)) {
      if (avisos) avisos.push('Clave desconocida o no editable: ' + k + ' (se ignoró).');
      return;
    }
    var v = String(mapa[k] == null ? '' : mapa[k]).trim();
    if (v) cfg[k] = v;
  });
  return cfg;
}

/** Ejecuta fn() viendo SOLO los valores por defecto del código (sin la hoja). */
function cfgs_sinHoja_(fn) {
  var memo = repo_memo_();
  var antes = memo.__cfgsSinHoja;
  memo.__cfgsSinHoja = true;
  try {
    return fn();
  } finally {
    memo.__cfgsSinHoja = antes;
  }
}

/**
 * Parámetros que necesita el navegador (doGet los inyecta en la página como
 * window.KGP_CONFIG; el cliente los lee con KGP.cfg (números) o
 * KGP.cfgTexto (textos)). Salen del código (00_Config.js), salvo el
 * destinatario del aviso a contabilidad (configurable). Solo valores simples
 * y nada sensible: IDs de archivos y demás se quedan en el servidor.
 */
function cfgs_clientConfig_() {
  var c = CFG_();
  return {
    IVA_TASA: c.IVA_TASA,
    MAX_SERVICIOS: c.LIMITS.MAX_SERVICIOS,
    MAX_ACTIVIDADES: c.LIMITS.MAX_ACTIVIDADES,
    MAX_TAREAS: c.LIMITS.MAX_TAREAS,
    MAX_TAREAS_OIP: c.LIMITS.MAX_TAREAS_OIP,
    MAX_CC: c.LIMITS.MAX_CC,
    OIS_FINALIZADA_EMAIL: c.OIS_FINALIZADA_EMAIL,
    TARIFA_MAX_DIGITS: String(Math.trunc(c.TARIFA_MAX)).length,
    CANTIDAD_MAX: c.CANTIDAD_MAX,
    PLAZO_DEFAULT: c.COTIZACION_PLAZO_DEFAULT,
    MAX_PLAZO_DIAS: c.LIMITS.MAX_PLAZO_DIAS,
    DIAS_POR_VENCER_COTIZACION: c.DIAS_POR_VENCER_COTIZACION,
    DIAS_POR_VENCER_ORDENES: c.DIAS_POR_VENCER_ORDENES,
    DIAS_POR_VENCER_TAREAS: c.DIAS_POR_VENCER_TAREAS,
    DIAS_RECIENTES_COTIZACION: c.DIAS_RECIENTES_COTIZACION,
    DASHBOARD_POLL_MS: c.DASHBOARD_POLL_MS,
    TIPO_RESPONSABLE_INTERNO: c.TIPO_RESPONSABLE_INTERNO,
    TIPO_RESPONSABLE_TERCERO: c.TIPO_RESPONSABLE_TERCERO,
    ETIQUETA_RESPONSABLE_INTERNO: c.ETIQUETA_RESPONSABLE_INTERNO,
    ETIQUETA_RESPONSABLE_TERCERO: c.ETIQUETA_RESPONSABLE_TERCERO
  };
}

// ---------------------------------------------------------------------
// Catálogo de IDs (filas de CONFIG_IDS)
// ---------------------------------------------------------------------

/**
 * IDs configurables: {grupo, clave, nombre, tipo ('Spreadsheet'|'Carpeta'|
 * 'Archivo'), descripcion, soloLectura?}. El valor por defecto es el de
 * CFG_() (00_Config.js). Para agregar uno: su default en CFG_() y su fila aquí.
 */
function cfgs_catalogoIds_() {
  return [
    { grupo: 'Bases de datos', clave: 'DB_SHEET_ID', nombre: 'Base de datos principal', tipo: 'Spreadsheet',
      descripcion: 'Spreadsheet con COTIZACIONES, SERVICIOS, CLIENTES, OIS, OIP, tareas, personal, etc.' },
    { grupo: 'Bases de datos', clave: 'CAT_SHEET_ID', nombre: 'Catálogo y configuración', tipo: 'Spreadsheet', soloLectura: true,
      descripcion: 'Este archivo (TIPOS DE SERVICIOS + CONFIG_IDS + CONFIG_CORREOS). Fijo en el código porque de aquí se lee todo lo demás.' },
    { grupo: 'Bases de datos', clave: 'MAIL_HISTORIAL_SHEET_ID', nombre: 'Historial de correos', tipo: 'Spreadsheet',
      descripcion: 'Spreadsheet donde se registra cada correo enviado (pestaña HISTORIAL).' },
    { grupo: 'Plantilla de documentos', clave: 'TEMPLATE_SHEET_ID', nombre: 'Plantilla convertida (Google Sheets)', tipo: 'Spreadsheet',
      descripcion: 'Copia nativa de Google de la plantilla, de la que se generan los documentos de cotizaciones, OIS y OIP.' },
    { grupo: 'Carpetas de documentos', clave: 'OUT_FOLDER_ID', nombre: 'Carpeta de cotizaciones', tipo: 'Carpeta',
      descripcion: 'Carpeta de Drive donde se guardan los documentos de las cotizaciones.' },
    { grupo: 'Carpetas de documentos', clave: 'OIS_FOLDER_ID', nombre: 'Carpeta de OIS', tipo: 'Carpeta',
      descripcion: 'Carpeta raíz de las OIS: cada OIS crea aquí su subcarpeta con su documento.' },
    { grupo: 'Carpetas de documentos', clave: 'OIP_FOLDER_ID', nombre: 'Carpeta de OIP', tipo: 'Carpeta',
      descripcion: 'Carpeta raíz de las OIP: cada OIP crea aquí su subcarpeta con su documento.' }
  ];
}

/** Enlace de Drive para un ID según su tipo ('' si no hay ID). */
function cfgs_urlDe_(tipo, id) {
  if (!id) return '';
  if (tipo === 'Carpeta') return 'https://drive.google.com/drive/folders/' + id;
  if (tipo === 'Archivo') return 'https://drive.google.com/file/d/' + id + '/view';
  return 'https://docs.google.com/spreadsheets/d/' + id + '/edit';
}

/** Fórmula ENLACE de CONFIG_IDS: sigue a la celda VALOR de la misma fila. */
function cfgs_formulaEnlace_(tipo, fila, letraValor) {
  var ref = letraValor + fila;
  var base = tipo === 'Carpeta' ? 'https://drive.google.com/drive/folders/'
    : tipo === 'Archivo' ? 'https://drive.google.com/file/d/'
      : 'https://docs.google.com/spreadsheets/d/';
  return '=IF(' + ref + '="","",HYPERLINK("' + base + '"&' + ref + ',"Abrir"))';
}

/** Saca el ID de un enlace de Drive/Sheets (.../d/<id>/..., /folders/<id>, ?id=<id>) o devuelve el texto tal cual. */
function cfgs_extraerId_(texto) {
  var s = String(texto == null ? '' : texto).trim();
  var m = s.match(/\/d\/([A-Za-z0-9_-]{10,})/) || s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : s;
}

// ---------------------------------------------------------------------
// Hojas: creación, migración desde la configuración anterior y formato
// ---------------------------------------------------------------------

/**
 * Deja el spreadsheet con la configuración vigente (idempotente):
 *   - CONFIG_IDS: si no existe o tiene el formato anterior (con "VALOR POR
 *     DEFECTO"), se reescribe con las columnas de cfgs_columnasIds_
 *     conservando los VALOR ya escritos.
 *   - CONFIG_CORREOS: si no existe, se crea con los textos vigentes (los de
 *     la antigua CONFIG_CORREO_TEXTOS donde tuvieran valor, si no los del
 *     código) y los destinatarios de la antigua CONFIG_CORREO. Si existe, solo
 *     se agregan las filas de correos nuevos; con `refrescarAyuda` se
 *     reescriben además las columnas informativas (nombre, cuándo se envía,
 *     variables).
 *   - Las hojas antiguas (cfgs_tabsObsoletas_) se eliminan.
 * Llamar dentro del script lock (escribe). Devuelve un resumen de lo hecho.
 */
function cfgs_asegurarHojas_(refrescarAyuda) {
  var tabs = cfgs_tabs_();
  var ss = SpreadsheetApp.openById(cfgs_sheetId_());
  var resumen = [];

  // Valores de las hojas antiguas (para migrar) antes de borrar nada.
  var viejoCorreo = cfgs_leerKv_(ss.getSheetByName('CONFIG_CORREO'));
  var viejosTextos = cfgs_leerFilas_(ss.getSheetByName('CONFIG_CORREO_TEXTOS'));

  // ---- CONFIG_IDS ----
  var shIds = ss.getSheetByName(tabs.IDS);
  var headIds = shIds && shIds.getLastColumn() ? cfgs_indiceColumnas_(shIds.getRange(1, 1, 1, shIds.getLastColumn()).getValues()[0]) : {};
  var formatoViejo = !shIds || headIds[normText_('VALOR POR DEFECTO')] !== undefined ||
    cfgs_columnasIds_().some(function (c) { return headIds[normText_(c)] === undefined; }) ||
    cfgs_hayIdsObsoletos_(shIds);
  if (formatoViejo || refrescarAyuda) {
    var previos = cfgs_leerKv_(shIds);
    var defs = cfgs_sinHoja_(function () { return CFG_(); });
    var cols = cfgs_columnasIds_();
    var letraValor = cfgs_colLetra_(cols.indexOf('VALOR') + 1);
    var filas = cfgs_catalogoIds_().map(function (f, i) {
      var valor = f.soloLectura ? cfgs_sheetId_() : (previos[f.clave] !== undefined ? previos[f.clave] : (defs[f.clave] || ''));
      return [f.grupo, f.clave, f.nombre, valor, (f.soloLectura ? '(Solo lectura) ' : '') + f.descripcion,
        cfgs_formulaEnlace_(f.tipo, i + 2, letraValor)];
    });
    shIds = shIds || ss.insertSheet(tabs.IDS);
    shIds.clear();
    shIds.getRange(2, cols.indexOf('VALOR') + 1, Math.max(shIds.getMaxRows() - 1, 1), 1).setNumberFormat('@');
    shIds.getRange(1, 1, 1, cols.length).setValues([cols]);
    shIds.getRange(2, 1, filas.length, cols.length).setValues(filas);
    cfgs_formatoTabla_(shIds, cols, [170, 220, 260, 380, 460, 90], filas.length);
    resumen.push(tabs.IDS + ': ' + (formatoViejo ? 'reescrita con el formato nuevo (se conservaron los valores).' : 'columnas de ayuda actualizadas.'));
  }

  // ---- CONFIG_CORREOS ----
  var colsCor = cfgs_columnasCorreos_();
  var shCor = ss.getSheetByName(tabs.CORREOS);
  var textos = mail_textosDefault_();
  var cfgCodigo = cfgs_sinHoja_(function () { return CFG_(); });
  var filaDefault = function (k, previo) {
    var t = textos[k];
    previo = previo || {};
    var fila = {
      CLAVE: k,
      CORREO: t.NOMBRE,
      'CUANDO SE ENVIA': t.DESCRIPCION,
      DESTINATARIOS: t.DESTINO_CFG
        ? (viejoCorreo[t.DESTINO_CFG] || cfgCodigo[t.DESTINO_CFG] || '')
        : '(automático) ' + t.DESTINATARIO,
      'COPIA SIEMPRE A': '',
      VARIABLES: t.VARIABLES
    };
    mail_camposTexto_().forEach(function (c) {
      fila[c] = (previo[c] != null && String(previo[c]).trim() !== '') ? String(previo[c]) : t[c];
    });
    return colsCor.map(function (c) { return fila[c] == null ? '' : fila[c]; });
  };

  if (!shCor) {
    shCor = ss.insertSheet(tabs.CORREOS);
    var filasCor = Object.keys(textos).map(function (k) { return filaDefault(k, viejosTextos[k]); });
    shCor.getRange(1, 1, Math.max(shCor.getMaxRows(), filasCor.length + 1), colsCor.length).setNumberFormat('@');
    shCor.getRange(1, 1, 1, colsCor.length).setValues([colsCor]);
    shCor.getRange(2, 1, filasCor.length, colsCor.length).setValues(filasCor);
    cfgs_formatoTabla_(shCor, colsCor, [190, 230, 320, 260, 260, 300, 300, 200, 520, 220, 380, 320], filasCor.length);
    resumen.push(tabs.CORREOS + ': creada con ' + filasCor.length + ' correos' + (Object.keys(viejosTextos).length ? ' (textos migrados de CONFIG_CORREO_TEXTOS).' : '.'));
  } else {
    var datos = shCor.getDataRange().getValues();
    var head = cfgs_indiceColumnas_(datos[0]);
    var faltanCols = colsCor.some(function (c) { return head[normText_(c)] === undefined; });
    var existentes = {};
    datos.slice(1).forEach(function (r) { if (head.CLAVE !== undefined && r[head.CLAVE]) existentes[String(r[head.CLAVE]).trim()] = true; });
    var nuevas = Object.keys(textos).filter(function (k) { return !existentes[k]; });
    if (faltanCols) {
      resumen.push(tabs.CORREOS + ': AVISO — faltan columnas (' + colsCor.join(', ') + '). Corrígela a mano o bórrala para que se vuelva a crear.');
    } else {
      if (nuevas.length) {
        var filasNuevas = nuevas.map(function (k) {
          var arr = filaDefault(k);
          return datos[0].map(function (hd) { var i = colsCor.map(normText_).indexOf(normText_(hd)); return i >= 0 ? arr[i] : ''; });
        });
        shCor.getRange(shCor.getLastRow() + 1, 1, filasNuevas.length, datos[0].length).setNumberFormat('@').setValues(filasNuevas);
        resumen.push(tabs.CORREOS + ': ' + nuevas.length + ' correo(s) nuevo(s) agregado(s).');
      }
      if (refrescarAyuda && datos.length > 1) {
        var ayuda = ['CORREO', 'CUANDO SE ENVIA', 'VARIABLES'];
        datos.slice(1).forEach(function (r, i) {
          var t = textos[String(r[head.CLAVE] || '').trim()];
          if (!t) return;
          ayuda.forEach(function (c) {
            var v = c === 'CORREO' ? t.NOMBRE : c === 'CUANDO SE ENVIA' ? t.DESCRIPCION : t.VARIABLES;
            shCor.getRange(i + 2, head[normText_(c)] + 1).setValue(v);
          });
          if (!t.DESTINO_CFG) shCor.getRange(i + 2, head.DESTINATARIOS + 1).setValue('(automático) ' + t.DESTINATARIO);
        });
        resumen.push(tabs.CORREOS + ': columnas de ayuda actualizadas.');
      }
    }
  }

  // ---- Hojas antiguas ----
  cfgs_tabsObsoletas_().forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh && ss.getSheets().length > 1) {
      ss.deleteSheet(sh);
      resumen.push(n + ': eliminada (su configuración volvió al código).');
    }
  });

  if (!resumen.length) resumen.push('La configuración ya estaba al día.');
  return resumen;
}

/** true si CONFIG_IDS tiene una fila cuya CLAVE ya no es configurable (p. ej. TEMPLATE_FILE_ID): se limpia al reescribirla. */
function cfgs_hayIdsObsoletos_(sh) {
  if (!sh || sh.getLastRow() < 2) return false;
  var v = sh.getDataRange().getValues();
  var c = cfgs_indiceColumnas_(v[0]);
  if (c.CLAVE === undefined) return false;
  var validas = {};
  cfgs_catalogoIds_().forEach(function (f) { validas[f.clave] = true; });
  return v.slice(1).some(function (r) {
    var k = String(r[c.CLAVE] || '').trim();
    return k && !validas[k];
  });
}

/** {CLAVE: VALOR (texto)} de una hoja con columnas CLAVE y VALOR. {} si no existe. */
function cfgs_leerKv_(sh) {
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  var v = sh.getDataRange().getValues();
  var c = cfgs_indiceColumnas_(v[0]);
  if (c.CLAVE === undefined || c.VALOR === undefined) return out;
  v.slice(1).forEach(function (r) {
    var k = String(r[c.CLAVE] || '').trim();
    var val = String(r[c.VALOR] == null ? '' : r[c.VALOR]).trim();
    if (k && val) out[k] = val;
  });
  return out;
}

/** {CLAVE: {COLUMNA: texto}} de una hoja con una fila por CLAVE. {} si no existe. */
function cfgs_leerFilas_(sh) {
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  var v = sh.getDataRange().getValues();
  var c = cfgs_indiceColumnas_(v[0]);
  if (c.CLAVE === undefined) return out;
  v.slice(1).forEach(function (r) {
    var k = String(r[c.CLAVE] || '').trim();
    if (!k) return;
    var fila = {};
    Object.keys(c).forEach(function (h) { fila[h] = r[c[h]] == null ? '' : String(r[c[h]]); });
    out[k] = fila;
  });
  return out;
}

/** Formato de "tabla": encabezado verde KGP, filas alternas, filtro, CLAVE fija y anchos. */
function cfgs_formatoTabla_(sh, headers, anchos, nFilas) {
  var nCols = headers.length;
  var total = Math.max(nFilas + 1, 2);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, nCols).setFontWeight('bold').setFontColor('#ffffff').setBackground('#436b0a')
    .setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(1, 32);
  sh.getRange(2, 1, total - 1, nCols).setVerticalAlignment('top').setWrap(true);

  sh.getBandings().forEach(function (b) { b.remove(); });
  sh.getRange(1, 1, total, nCols).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false)
    .setHeaderRowColor('#436b0a').setFirstRowColor('#ffffff').setSecondRowColor('#eef4e4');

  var filtro = sh.getFilter();
  if (filtro) filtro.remove();
  sh.getRange(1, 1, total, nCols).createFilter();

  var iClave = headers.map(normText_).indexOf('CLAVE');
  if (iClave >= 0) {
    sh.getRange(2, iClave + 1, total - 1, 1).setFontWeight('bold').setFontFamily('Roboto Mono');
    sh.setFrozenColumns(iClave + 1);
    sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
      if (p.getDescription() === 'KGP: columna CLAVE') p.remove();
    });
    sh.getRange(2, iClave + 1, total - 1, 1).protect().setDescription('KGP: columna CLAVE').setWarningOnly(true);
  }
  headers.forEach(function (hd, i) { if (anchos[i]) sh.setColumnWidth(i + 1, anchos[i]); });
}

/** Letra de columna (1 -> A, 27 -> AA). */
function cfgs_colLetra_(n) {
  var s = '';
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------------------------------------------------------------------
// Vista "Configuración": lectura y escrituras
// ---------------------------------------------------------------------

/** Lista de correos (texto con comas/;/espacios) -> {lista, malos}. */
function cfgs_parsearCorreos_(texto) {
  var partes = String(texto == null ? '' : texto).split(/[,;\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  var re = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
  var vistos = {};
  var lista = [];
  var malos = [];
  partes.forEach(function (c) {
    if (!re.test(c) || c.length > 254) { malos.push(c); return; }
    if (vistos[c.toLowerCase()]) return;
    vistos[c.toLowerCase()] = true;
    lista.push(c);
  });
  return { lista: lista, malos: malos };
}

/** Texto largo de un correo: normaliza saltos de línea, recorta espacios al final de cada línea y trunca. Conserva las líneas en blanco (separan párrafos). */
function cfgs_textoLargo_(s) {
  var t = String(s == null ? '' : s).replace(/\r\n?/g, '\n').split('\n')
    .map(function (l) { return l.replace(/[ \t]+$/g, ''); }).join('\n').trim();
  return truncate_(t, CFG_().LIMITS.CELL_MAX);
}

/**
 * Todo lo que muestra la vista Configuración, leído en el momento (nunca de
 * caché): {hojaUrl, ids, correos, tipos}. Antes deja las hojas al día
 * (cfgs_asegurarHojas_, dentro del lock) para que la primera visita migre la
 * configuración anterior.
 */
function cfgs_snapshot_() {
  var tabs = cfgs_tabs_();
  var ss = SpreadsheetApp.openById(cfgs_sheetId_());
  var necesitaMigrar = !ss.getSheetByName(tabs.IDS) || !ss.getSheetByName(tabs.CORREOS) ||
    cfgs_tabsObsoletas_().some(function (n) { return !!ss.getSheetByName(n); });
  if (!necesitaMigrar) {
    var shIds = ss.getSheetByName(tabs.IDS);
    var head = cfgs_indiceColumnas_(shIds.getRange(1, 1, 1, Math.max(shIds.getLastColumn(), 1)).getValues()[0]);
    necesitaMigrar = head[normText_('VALOR POR DEFECTO')] !== undefined || cfgs_hayIdsObsoletos_(shIds);
  }
  if (necesitaMigrar) {
    var mig = tx_conLock_('cfgs_asegurarHojas_', function () { return ok_(cfgs_asegurarHojas_(false)); });
    if (!mig.ok) return mig;
  }

  var data = cfgs_refresh_();
  var cfg = CFG_();
  var cfgCodigo = cfgs_sinHoja_(function () { return CFG_(); });

  var ids = cfgs_catalogoIds_().map(function (f) {
    var valor = f.soloLectura ? cfgs_sheetId_() : String(cfg[f.clave] || '');
    return {
      clave: f.clave, grupo: f.grupo, nombre: f.nombre, tipo: f.tipo, descripcion: f.descripcion,
      soloLectura: !!f.soloLectura, valor: valor, url: cfgs_urlDe_(f.tipo, valor),
      enHoja: !f.soloLectura && !!(data.valores || {})[f.clave]
    };
  });

  var defs = mail_textosDefault_();
  var correos = Object.keys(defs).map(function (k) {
    var d = defs[k];
    var efectivo = mail_textos_(k);
    var campos = {};
    var originales = {};
    mail_camposTexto_().forEach(function (c) { campos[c] = efectivo[c] || ''; originales[c] = d[c] || ''; });
    return {
      clave: k,
      nombre: d.NOMBRE,
      descripcion: d.DESCRIPCION,
      destinatarioFijo: !!d.DESTINO_CFG,
      destinatarios: d.DESTINO_CFG ? String(cfg[d.DESTINO_CFG] || '') : d.DESTINATARIO,
      destinatariosOriginal: d.DESTINO_CFG ? String(cfgCodigo[d.DESTINO_CFG] || '') : '',
      cc: efectivo.CC || '',
      campos: campos,
      originales: originales,
      variables: d.VARIABLES
    };
  });

  return ok_({
    hojaUrl: 'https://docs.google.com/spreadsheets/d/' + cfgs_sheetId_() + '/edit',
    ids: ids,
    correos: correos,
    tipos: cat_listarConFila_(),
    consecutivos: code_estadoContadores_(new Date()),
    avisos: data.avisos || []
  });
}

/**
 * Guarda IDs desde la vista. cambios: {CLAVE: valor}. Cada valor puede ser el
 * ID o el enlace completo (se extrae el ID). Vacío = volver al valor del
 * código. Antes de escribir se comprueba que el archivo/carpeta exista y que
 * la cuenta de la app tenga acceso: un ID equivocado dejaría la app sin poder
 * leer o guardar. Devuelve ok_({ids: [...]}) con el snapshot de IDs, o
 * fail_('VALIDATION', ..., {CLAVE: mensaje}).
 */
function cfgs_guardarIds_(cambios) {
  if (!isPlainObject_(cambios) || !Object.keys(cambios).length) return fail_('VALIDATION', 'No hay cambios que guardar.');
  var catalogo = {};
  cfgs_catalogoIds_().forEach(function (f) { catalogo[f.clave] = f; });

  var errores = {};
  var limpios = {};
  var nombres = {};
  Object.keys(cambios).forEach(function (k) {
    var f = catalogo[k];
    if (!f || f.soloLectura) { errores[k] = 'Este valor no se puede cambiar.'; return; }
    var id = cfgs_extraerId_(cambios[k]);
    if (!id) { limpios[k] = ''; return; }
    if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) { errores[k] = 'No parece un ID de Google Drive válido.'; return; }
    try {
      if (f.tipo === 'Carpeta') nombres[k] = DriveApp.getFolderById(id).getName();
      else if (f.tipo === 'Spreadsheet') nombres[k] = SpreadsheetApp.openById(id).getName();
      else nombres[k] = DriveApp.getFileById(id).getName();
    } catch (e) {
      errores[k] = 'No se encontró ' + (f.tipo === 'Carpeta' ? 'la carpeta' : 'el archivo') + ' o la cuenta de la app no tiene acceso: ' + errMsg_(e);
      return;
    }
    limpios[k] = id;
  });
  if (Object.keys(errores).length) return fail_('VALIDATION', 'Revisa los IDs marcados.', errores);

  var res = tx_conLock_('cfgs_guardarIds_', function () {
    cfgs_asegurarHojas_(false);
    var sh = SpreadsheetApp.openById(cfgs_sheetId_()).getSheetByName(cfgs_tabs_().IDS);
    var v = sh.getDataRange().getValues();
    var c = cfgs_indiceColumnas_(v[0]);
    Object.keys(limpios).forEach(function (k) {
      for (var i = 1; i < v.length; i++) {
        if (String(v[i][c.CLAVE]).trim() === k) {
          sh.getRange(i + 1, c.VALOR + 1).setNumberFormat('@').setValue(limpios[k]);
          return;
        }
      }
      throw new AppError_('SCHEMA', 'No se encontró la fila ' + k + ' en ' + cfgs_tabs_().IDS + '.');
    });
    return ok_(true);
  }, { payload: cambios });
  if (!res.ok) return res;

  cfgs_refresh_();
  var snap = cfgs_snapshot_();
  if (!snap.ok) return snap;
  return ok_({ ids: snap.data.ids, nombres: nombres });
}

/**
 * Guarda un correo desde la vista: datos {destinatarios (solo si el correo
 * tiene destinatario fijo), cc, ASUNTO, TITULO, SALUDO, PARRAFOS, BOTON,
 * DESTACADOS}. Asunto y párrafos son obligatorios; los demás pueden quedar
 * vacíos (p. ej. BOTON vacío = sin botón). Devuelve ok_(correo) con el mismo
 * formato de cfgs_snapshot_.
 */
function cfgs_guardarCorreo_(clave, datos) {
  clave = String(clave || '').trim();
  var defs = mail_textosDefault_();
  var d = defs[clave];
  if (!d) return fail_('NOT_FOUND', 'No existe el correo ' + clave + '.');
  if (!isPlainObject_(datos)) return fail_('VALIDATION', 'Datos del correo inválidos.');

  var errores = {};
  var fila = {};
  mail_camposTexto_().forEach(function (c) { fila[c] = cfgs_textoLargo_(datos[c]); });
  if (!fila.ASUNTO) errores.ASUNTO = 'El asunto es obligatorio.';
  if (/[\r\n]/.test(fila.ASUNTO)) errores.ASUNTO = 'El asunto debe ir en una sola línea.';
  if (!fila.PARRAFOS) errores.PARRAFOS = 'El cuerpo del correo no puede quedar vacío.';

  var cc = cfgs_parsearCorreos_(datos.cc);
  if (cc.malos.length) errores.cc = 'Correo no válido: ' + cc.malos.join(', ');
  if (cc.lista.length > CFG_().LIMITS.MAX_CC) errores.cc = 'Máximo ' + CFG_().LIMITS.MAX_CC + ' correos en copia.';
  fila['COPIA SIEMPRE A'] = cc.lista.join(', ');

  if (d.DESTINO_CFG) {
    var dest = cfgs_parsearCorreos_(datos.destinatarios);
    if (dest.malos.length) errores.destinatarios = 'Correo no válido: ' + dest.malos.join(', ');
    else if (!dest.lista.length) errores.destinatarios = 'Este correo necesita al menos un destinatario.';
    fila.DESTINATARIOS = dest.lista.join(', ');
  }
  if (Object.keys(errores).length) return fail_('VALIDATION', 'Revisa los campos marcados.', errores);

  var res = tx_conLock_('cfgs_guardarCorreo_', function () {
    cfgs_asegurarHojas_(false);
    var sh = SpreadsheetApp.openById(cfgs_sheetId_()).getSheetByName(cfgs_tabs_().CORREOS);
    var v = sh.getDataRange().getValues();
    var c = cfgs_indiceColumnas_(v[0]);
    var idx = -1;
    for (var i = 1; i < v.length; i++) if (String(v[i][c.CLAVE]).trim() === clave) { idx = i; break; }
    if (idx < 0) throw new AppError_('SCHEMA', 'No se encontró la fila ' + clave + ' en ' + cfgs_tabs_().CORREOS + '.');
    var nueva = v[idx].slice();
    Object.keys(fila).forEach(function (col) {
      var j = c[normText_(col)];
      if (j !== undefined) nueva[j] = fila[col];
    });
    sh.getRange(idx + 1, 1, 1, nueva.length).setNumberFormat('@').setValues([nueva]);
    return ok_(true);
  }, { ids: { clave: clave }, payload: datos });
  if (!res.ok) return res;

  cfgs_refresh_();
  var snap = cfgs_snapshot_();
  if (!snap.ok) return snap;
  return ok_(snap.data.correos.filter(function (x) { return x.clave === clave; })[0]);
}

/**
 * Relee la configuración y devuelve qué se aplicó y qué se ignoró (para
 * admin_verConfig). No escribe nada.
 */
function cfgs_verificar_() {
  var data = cfgs_refresh_();
  var avisos = (data.avisos || []).slice();
  var defs = cfgs_sinHoja_(function () { return Object.assign({}, CFG_()); });
  cfgs_aplicar_(defs, avisos, data);
  var textos = mail_textosDefault_();
  Object.keys(data.correos || {}).forEach(function (k) {
    if (!textos[k]) avisos.push('Correo desconocido en ' + cfgs_tabs_().CORREOS + ': ' + k + ' (se ignoró).');
  });
  return {
    leidoEn: data.leidoEn,
    clavesEnHoja: Object.keys(data.valores || {}).length,
    correosEnHoja: Object.keys(data.correos || {}).length,
    avisos: avisos,
    efectivo: { CFG: CFG_(), CLIENTE: cfgs_clientConfig_() }
  };
}
