/**
 * Configuración editable desde Google Sheets (CLAUDE.md §15).
 *
 * El spreadsheet de catálogo (cfgs_sheetId_, el mismo de TIPOS DE SERVICIOS)
 * tiene varias hojas CONFIG_* con forma de tabla. Todas usan las mismas
 * columnas base para que se lean igual:
 *
 *   GRUPO | CLAVE | VALOR | VALOR POR DEFECTO | DESCRIPCION  (+ columnas de ayuda)
 *
 * salvo CONFIG_CORREO_TEXTOS (una fila por correo, una columna por campo de
 * texto) y CONFIG_LEEME (solo explicación).
 *
 *   CONFIG_IDS            IDs de spreadsheets, carpetas y archivos.
 *   CONFIG_HOJAS          nombres de las pestañas (BD, plantilla, historial).
 *   CONFIG_GENERAL        plazos, IVA, límites, avisos, dashboard, caché.
 *   CONFIG_CORREO         destinatarios, remitente, firma y pie del correo.
 *   CONFIG_CORREO_TEXTOS  asunto, título, párrafos... de cada correo.
 *   CONFIG_CELDAS         mapa de celdas de la plantilla (CELLMAP).
 *
 * CÓMO SE APLICA
 *   - doGet (cada vez que se carga o recarga la página) llama cfgs_refresh_:
 *     lee TODAS las hojas CONFIG_* en una sola apertura del spreadsheet y
 *     guarda el resultado en CacheService. Las demás llamadas de esa sesión
 *     (google.script.run, disparadores) usan esa copia sin volver a leer.
 *   - CFG_() y CELLMAP_() (00_Config.js) aplican esos valores al final con
 *     cfgs_aplicar_. Los textos de correo los toma mail_textos_.
 *   - Solo se aplican claves del catálogo (cfgs_catalogo_): una clave
 *     desconocida o un valor que no se puede interpretar se IGNORA y queda el
 *     valor del código. La app nunca se cae por la config; admin_verConfig()
 *     lista lo que se ignoró.
 *   - Celda VALOR vacía = valor por defecto del código.
 *
 * Las hojas las crea / completa admin_crearHojasConfig() (51_Admin.js): es
 * idempotente y NUNCA pisa un VALOR ya escrito; solo agrega filas nuevas y
 * refresca las columnas de ayuda (VALOR POR DEFECTO, DESCRIPCION...).
 *
 * Regla de recursión: nada de este archivo que se use al leer la config puede
 * llamar CFG_() (CFG depende de esto). Por eso el ID del spreadsheet vive en
 * cfgs_sheetId_ y no en CFG.
 */

/** Spreadsheet de catálogo y configuración. Fijo en el código: es de donde sale todo lo demás. */
function cfgs_sheetId_() {
  return '1n87Kj1wgP7PQ3jZXunHgiR7EK2MqG7zcDzhHwCCkaqM';
}

/** Nombres de las hojas de configuración. */
function cfgs_tabs_() {
  return {
    LEEME: 'CONFIG_LEEME',
    IDS: 'CONFIG_IDS',
    HOJAS: 'CONFIG_HOJAS',
    GENERAL: 'CONFIG_GENERAL',
    CORREO: 'CONFIG_CORREO',
    CORREO_TEXTOS: 'CONFIG_CORREO_TEXTOS',
    CELDAS: 'CONFIG_CELDAS'
  };
}

/** Clave de CacheService donde vive la copia leída de las hojas CONFIG_*. */
function cfgs_cacheKey_() {
  return 'cfgsheet:data:v1';
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
  return { valores: {}, celdas: {}, correos: {}, avisos: aviso ? [aviso] : [], leidoEn: '' };
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
 * Relee las hojas CONFIG_* y reemplaza la copia en caché. Lo llama doGet en
 * cada carga de la página. Si la lectura falla, se queda la copia anterior.
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

/**
 * Lee todas las hojas CONFIG_* en una sola apertura del spreadsheet.
 * Devuelve {valores: {CLAVE: valor}, celdas: {CLAVE: valor},
 * correos: {CLAVE: {CAMPO: texto}}, avisos: [], leidoEn}.
 */
function cfgs_leerHoja_() {
  var tabs = cfgs_tabs_();
  var out = cfgs_vacio_();
  out.leidoEn = new Date().toISOString();
  var ss = SpreadsheetApp.openById(cfgs_sheetId_());

  ss.getSheets().forEach(function (sh) {
    var nombre = sh.getName();
    if (nombre.indexOf('CONFIG_') !== 0 || nombre === tabs.LEEME) return;
    var values = sh.getDataRange().getValues();
    if (values.length < 2) return;
    var h = values[0].map(function (x) { return normText_(x); });
    var iClave = h.indexOf('CLAVE');
    if (iClave < 0) {
      out.avisos.push('La hoja ' + nombre + ' no tiene columna CLAVE; se ignoró.');
      return;
    }

    if (nombre === tabs.CORREO_TEXTOS) {
      var campos = mail_camposTexto_();
      values.slice(1).forEach(function (row) {
        var clave = String(row[iClave] || '').trim();
        if (!clave) return;
        var textos = {};
        campos.forEach(function (c) {
          var i = h.indexOf(c);
          if (i >= 0 && row[i] !== '' && row[i] != null) textos[c] = String(row[i]);
        });
        out.correos[clave] = textos;
      });
      return;
    }

    var iValor = h.indexOf('VALOR');
    if (iValor < 0) {
      out.avisos.push('La hoja ' + nombre + ' no tiene columna VALOR; se ignoró.');
      return;
    }
    var destino = nombre === tabs.CELDAS ? out.celdas : out.valores;
    values.slice(1).forEach(function (row) {
      var clave = String(row[iClave] || '').trim();
      var v = row[iValor];
      if (!clave || v === '' || v == null) return;
      if (Object.prototype.toString.call(v) === '[object Date]') v = v.toISOString();
      if (destino.hasOwnProperty(clave)) out.avisos.push('La clave ' + clave + ' está repetida; se usó la de la hoja ' + nombre + '.');
      destino[clave] = v;
    });
  });
  return out;
}

// ---------------------------------------------------------------------
// Aplicación sobre CFG_() / CELLMAP_()
// ---------------------------------------------------------------------

/** Claves de CFG_() que se pueden sobrescribir desde la hoja (las del catálogo, salvo las de solo lectura). Memoizado. */
function cfgs_clavesEditables_() {
  var memo = repo_memo_();
  if (memo.__cfgsEditables) return memo.__cfgsEditables;
  var set = {};
  var cat = cfgs_catalogo_();
  Object.keys(cat).forEach(function (tab) {
    if (tab === 'CELDAS') return;
    cat[tab].forEach(function (f) { if (!f.soloLectura) set[f.clave] = true; });
  });
  memo.__cfgsEditables = set;
  return set;
}

/**
 * Convierte el valor de la hoja al tipo del valor por defecto. Devuelve
 * undefined si no se puede (y entonces se queda el valor del código).
 * esCelda: valida formato de celda ("A7") o columna ("B") como el default.
 */
function cfgs_coerce_(def, v, esCelda) {
  if (typeof def === 'number') {
    var n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
    if (!isFinite(n) || n < 0) return undefined;
    if (Number.isInteger(def) && !Number.isInteger(n)) return undefined;
    return n;
  }
  if (def === null || typeof def === 'string') {
    var s = String(v).trim();
    if (!s) return undefined;
    if (esCelda && typeof def === 'string') {
      s = s.toUpperCase();
      if (/^[A-Z]{1,3}\d+$/.test(def) && !/^[A-Z]{1,3}\d+$/.test(s)) return undefined;
      if (/^[A-Z]{1,3}$/.test(def) && !/^[A-Z]{1,3}$/.test(s)) return undefined;
    }
    return s;
  }
  return undefined; // listas, objetos, booleanos: no editables desde la hoja
}

/**
 * Aplica los valores de la hoja sobre `obj` (defaults de CFG o CELLMAP).
 * seccion: 'valores' (CFG, claves con puntos: "LIMITS.MAX_SERVICIOS") o
 * 'celdas' (CELLMAP). avisos (opcional): array donde anotar lo ignorado.
 * ov (opcional): overrides a usar en vez de cfgs_overrides_ (verificación).
 */
function cfgs_aplicar_(obj, seccion, avisos, ov) {
  var mapa = (ov || cfgs_overrides_())[seccion] || {};
  var claves = Object.keys(mapa);
  if (!claves.length) return obj;
  var editables = seccion === 'valores' ? cfgs_clavesEditables_() : null;

  claves.forEach(function (path) {
    if (editables && !editables[path]) {
      if (avisos) avisos.push('Clave desconocida o no editable en la hoja: ' + path + ' (se ignoró).');
      return;
    }
    var partes = path.split('.');
    var cont = obj;
    for (var i = 0; i < partes.length - 1; i++) {
      cont = cont ? cont[partes[i]] : null;
    }
    var k = partes[partes.length - 1];
    if (!isPlainObject_(cont) || !(k in cont)) {
      if (avisos) avisos.push('Clave desconocida: ' + path + ' (se ignoró).');
      return;
    }
    var v = cfgs_coerce_(cont[k], mapa[path], seccion === 'celdas');
    if (v === undefined) {
      if (avisos) avisos.push('Valor no válido para ' + path + ': "' + mapa[path] + '" (se usa ' + cont[k] + ').');
      return;
    }
    cont[k] = v;
  });
  return obj;
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
 * KGP.cfgTexto (textos)). Solo valores simples y nada sensible: IDs de
 * archivos, correos y demás se quedan en el servidor.
 */
function cfgs_clientConfig_() {
  var c = CFG_();
  return {
    IVA_TASA: c.IVA_TASA,
    MAX_SERVICIOS: c.LIMITS.MAX_SERVICIOS,
    MAX_ACTIVIDADES: c.LIMITS.MAX_ACTIVIDADES,
    MAX_TAREAS: c.LIMITS.MAX_TAREAS,
    MAX_TAREAS_OIP: c.LIMITS.MAX_TAREAS_OIP,
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
// Catálogo documentado: qué va en cada hoja
// ---------------------------------------------------------------------

/**
 * Filas de cada hoja de configuración. {grupo, clave, descripcion, tipo,
 * nombre?, hoja?, soloLectura?}. El VALOR POR DEFECTO sale del código
 * (cfgs_valorDefault_); aquí solo se documenta. Para agregar un parámetro
 * nuevo: añádelo a CFG_()/CELLMAP_() y luego aquí, y vuelve a ejecutar
 * admin_crearHojasConfig().
 */
function cfgs_catalogo_() {
  return {
    IDS: [
      { grupo: 'Bases de datos', clave: 'DB_SHEET_ID', nombre: 'Base de datos principal', tipo: 'Spreadsheet',
        descripcion: 'Spreadsheet con COTIZACIONES, SERVICIOS, CLIENTES, OIS, OIP, tareas, personal, etc.' },
      { grupo: 'Bases de datos', clave: 'CAT_SHEET_ID', nombre: 'Catálogo y configuración', tipo: 'Spreadsheet', soloLectura: true,
        descripcion: 'ESTE archivo (TIPOS DE SERVICIOS + hojas CONFIG_*). Solo informativo: está fijo en el código (cfgs_sheetId_) porque de aquí se lee todo lo demás.' },
      { grupo: 'Bases de datos', clave: 'MAIL_HISTORIAL_SHEET_ID', nombre: 'Historial de correos', tipo: 'Spreadsheet',
        descripcion: 'Spreadsheet donde se registra cada correo enviado (pestaña de CONFIG_HOJAS > MAIL_HISTORIAL_TAB).' },
      { grupo: 'Plantilla de documentos', clave: 'TEMPLATE_FILE_ID', nombre: 'Plantilla original (.xlsx)', tipo: 'Archivo',
        descripcion: 'Archivo .xlsx original de la plantilla de cotización/OIS/OIP. admin_convertTemplate() lo convierte a hoja de Google.' },
      { grupo: 'Plantilla de documentos', clave: 'TEMPLATE_SHEET_ID', nombre: 'Plantilla convertida', tipo: 'Spreadsheet',
        descripcion: 'Copia nativa de Google de la plantilla, de la que se generan los documentos. La escribe admin_convertTemplate(); si esta celda tiene valor, manda esta celda.' },
      { grupo: 'Carpetas de salida', clave: 'OUT_FOLDER_ID', nombre: 'Carpeta de cotizaciones', tipo: 'Carpeta',
        descripcion: 'Carpeta de Drive donde se guardan los documentos de las cotizaciones.' },
      { grupo: 'Carpetas de salida', clave: 'OIS_FOLDER_ID', nombre: 'Carpeta de OIS', tipo: 'Carpeta',
        descripcion: 'Carpeta raíz de las OIS: cada OIS crea aquí su subcarpeta con su documento.' },
      { grupo: 'Carpetas de salida', clave: 'OIP_FOLDER_ID', nombre: 'Carpeta de OIP', tipo: 'Carpeta',
        descripcion: 'Carpeta raíz de las OIP: cada OIP crea aquí su subcarpeta con su documento.' }
    ],
    HOJAS: [
      { grupo: 'Base de datos principal', clave: 'TABS.COTIZACIONES', tipo: 'Texto', descripcion: 'Pestaña de cotizaciones (una fila por servicio).' },
      { grupo: 'Base de datos principal', clave: 'TABS.SERVICIOS', tipo: 'Texto', descripcion: 'Pestaña de servicios de cada cotización.' },
      { grupo: 'Base de datos principal', clave: 'TABS.CLIENTES', tipo: 'Texto', descripcion: 'Pestaña de clientes.' },
      { grupo: 'Base de datos principal', clave: 'TABS.CONTACTOS', tipo: 'Texto', descripcion: 'Pestaña de contactos de los clientes (solicitantes y encargados).' },
      { grupo: 'Base de datos principal', clave: 'TABS.ESTABLECIMIENTOS', tipo: 'Texto', descripcion: 'Pestaña de establecimientos de los clientes.' },
      { grupo: 'Base de datos principal', clave: 'TABS.PERSONAL', tipo: 'Texto', descripcion: 'Pestaña de empleados internos (Gestión de empleados > Internos).' },
      { grupo: 'Base de datos principal', clave: 'TABS.PERSONAL_TERCEROS', tipo: 'Texto', descripcion: 'Pestaña de empleados terceros / independientes (Gestión de empleados > Terceros). Mismas columnas que la de internos.' },
      { grupo: 'Base de datos principal', clave: 'TABS.OIS', tipo: 'Texto', descripcion: 'Pestaña de OIS.' },
      { grupo: 'Base de datos principal', clave: 'TABS.TAREAS_OIS', tipo: 'Texto', descripcion: 'Pestaña de tareas de las OIS.' },
      { grupo: 'Base de datos principal', clave: 'TABS.OIP', tipo: 'Texto', descripcion: 'Pestaña de OIP.' },
      { grupo: 'Base de datos principal', clave: 'TABS.TAREAS_OIP', tipo: 'Texto', descripcion: 'Pestaña de tareas de las OIP.' },
      { grupo: 'Base de datos principal', clave: 'TABS.OIP_FACTURACION', tipo: 'Texto', descripcion: 'Pestaña de facturación mensual de las OIP.' },
      { grupo: 'Base de datos principal', clave: 'TABS.ERRORES', tipo: 'Texto', descripcion: 'Pestaña donde se registran los errores (se crea sola si no existe).' },
      { grupo: 'Catálogo', clave: 'TABS.TIPOS_SERVICIO', tipo: 'Texto', descripcion: 'Pestaña de este archivo con los tipos de servicio (columna A) y su código UNSPSC (columna B).' },
      { grupo: 'Plantilla de documentos', clave: 'TEMPLATE_TAB_NAME', tipo: 'Texto', descripcion: 'Pestaña de la plantilla para la cotización. Vacío = la primera hoja de la plantilla.' },
      { grupo: 'Plantilla de documentos', clave: 'TEMPLATE_TAB_OIS', tipo: 'Texto', descripcion: 'Pestaña de la plantilla para la OIS.' },
      { grupo: 'Plantilla de documentos', clave: 'TEMPLATE_TAB_OIP', tipo: 'Texto', descripcion: 'Pestaña de la plantilla para la OIP.' },
      { grupo: 'Historial de correos', clave: 'MAIL_HISTORIAL_TAB', tipo: 'Texto', descripcion: 'Pestaña del historial de correos (columnas NUMERO, TIMESTAMP, FROM, TO, SUBJECT, BODY).' }
    ],
    GENERAL: [
      { grupo: 'Fechas y plazos', clave: 'TZ', tipo: 'Texto', descripcion: 'Zona horaria de fechas y consecutivos (formato IANA, p. ej. America/Bogota).' },
      { grupo: 'Fechas y plazos', clave: 'COTIZACION_PLAZO_DEFAULT', tipo: 'Número entero', descripcion: 'Plazo (días) con el que arranca el formulario de "Crear cotización".' },
      { grupo: 'Fechas y plazos', clave: 'OIP_PLAZO_DEFAULT', tipo: 'Número entero', descripcion: 'Plazo (días) con el que nace una OIP. La OIS hereda el plazo de su cotización.' },
      { grupo: 'Fechas y plazos', clave: 'LIMITS.MAX_PLAZO_DIAS', tipo: 'Número entero', descripcion: 'Plazo máximo (días) permitido en cotizaciones y órdenes.' },
      { grupo: 'Tarifas', clave: 'IVA_TASA', tipo: 'Número decimal', descripcion: 'Tasa de IVA sobre el SUBTOTAL (0.19 = 19 %).' },
      { grupo: 'Tarifas', clave: 'TARIFA_MAX', tipo: 'Número entero', descripcion: 'Tarifa máxima por servicio (su cantidad de dígitos limita también el campo en pantalla).' },
      { grupo: 'Tarifas', clave: 'CANTIDAD_MAX', tipo: 'Número entero', descripcion: 'Cantidad máxima por servicio.' },
      { grupo: 'Límites', clave: 'LIMITS.MAX_SERVICIOS', tipo: 'Número entero', descripcion: 'Servicios por cotización. OJO: la plantilla solo tiene 10 bloques de servicio (CONFIG_CELDAS).' },
      { grupo: 'Límites', clave: 'LIMITS.MAX_ACTIVIDADES', tipo: 'Número entero', descripcion: 'Actividades por servicio. Debe coincidir con SERVICIOS_ACT_MAX de CONFIG_CELDAS.' },
      { grupo: 'Límites', clave: 'LIMITS.MAX_TAREAS', tipo: 'Número entero', descripcion: 'Tareas por OIS. OJO: la plantilla OIS solo tiene 20 filas de tareas (229 a 248).' },
      { grupo: 'Límites', clave: 'LIMITS.MAX_TAREAS_OIP', tipo: 'Número entero', descripcion: 'Tareas por OIP (salvaguarda; la plantilla OIP inserta filas según haga falta).' },
      { grupo: 'Límites', clave: 'LIMITS.MAX_FACTURAS_OIP', tipo: 'Número entero', descripcion: 'Filas de facturación por OIP (una por mes).' },
      { grupo: 'Límites', clave: 'LIMITS.CELL_MAX', tipo: 'Número entero', descripcion: 'Máximo de caracteres de un texto libre que se guarda en una celda.' },
      { grupo: 'Avisos y dashboard', clave: 'DIAS_POR_VENCER_COTIZACION', tipo: 'Número entero', descripcion: 'Días antes del vencimiento en que una cotización aparece como "por vencer".' },
      { grupo: 'Avisos y dashboard', clave: 'DIAS_POR_VENCER_ORDENES', tipo: 'Número entero', descripcion: 'Días antes del vencimiento en que una OIS/OIP aparece como "por vencer".' },
      { grupo: 'Avisos y dashboard', clave: 'DIAS_POR_VENCER_TAREAS', tipo: 'Número entero', descripcion: 'Días antes de la fecha de entrega en que una tarea aparece como "por vencer".' },
      { grupo: 'Avisos y dashboard', clave: 'DIAS_RECIENTES_COTIZACION', tipo: 'Número entero', descripcion: 'Días hacia atrás que cuenta la tarjeta "Recién creadas" del Dashboard.' },
      { grupo: 'Avisos y dashboard', clave: 'DASHBOARD_POLL_MS', tipo: 'Número entero', descripcion: 'Cada cuántos milisegundos el Dashboard revisa si hay datos nuevos (30000 = 30 s).' },
      { grupo: 'Avisos y dashboard', clave: 'LIMITS.DASHBOARD_MAX_COTIZACIONES', tipo: 'Número entero', descripcion: 'Máximo de cotizaciones que descarga el Dashboard (las más recientes).' },
      { grupo: 'Responsables de tareas', clave: 'ETIQUETA_RESPONSABLE_INTERNO', tipo: 'Texto', descripcion: 'Cómo se muestra la opción "interno" al elegir el responsable de una tarea y en Gestión de empleados.' },
      { grupo: 'Responsables de tareas', clave: 'ETIQUETA_RESPONSABLE_TERCERO', tipo: 'Texto', descripcion: 'Cómo se muestra la opción "tercero" al elegir el responsable de una tarea y en Gestión de empleados.' },
      { grupo: 'Identificadores', clave: 'ID_PREFIJO_EMPLEADO', tipo: 'Texto', descripcion: 'Prefijo del ID de un empleado interno nuevo (EMP-...). Solo afecta a los que se creen después.' },
      { grupo: 'Identificadores', clave: 'ID_PREFIJO_TERCERO', tipo: 'Texto', descripcion: 'Prefijo del ID de un tercero nuevo (TER-...). Solo afecta a los que se creen después.' },
      { grupo: 'Identificadores', clave: 'ID_PREFIJO_CLIENTE', tipo: 'Texto', descripcion: 'Prefijo del ID de un cliente nuevo (CLI-...).' },
      { grupo: 'Identificadores', clave: 'ID_PREFIJO_CONTACTO', tipo: 'Texto', descripcion: 'Prefijo del ID de un contacto nuevo (CON-...).' },
      { grupo: 'Identificadores', clave: 'ID_PREFIJO_ESTABLECIMIENTO', tipo: 'Texto', descripcion: 'Prefijo del ID de un establecimiento nuevo (EST-...).' },
      { grupo: 'Identificadores', clave: 'ID_PREFIJO_COTIZACION', tipo: 'Texto', descripcion: 'Prefijo del ID interno de una cotización nueva (CTZ-...). No es el código visible.' },
      { grupo: 'Identificadores', clave: 'ID_PREFIJO_SERVICIO', tipo: 'Texto', descripcion: 'Prefijo del ID de un servicio nuevo (SRV-...).' },
      { grupo: 'Identificadores', clave: 'ID_PREFIJO_OIS', tipo: 'Texto', descripcion: 'Prefijo del ID interno de una OIS nueva (OIS-...). No es el código visible.' },
      { grupo: 'Identificadores', clave: 'ID_PREFIJO_OIP', tipo: 'Texto', descripcion: 'Prefijo del ID interno de una OIP nueva (OIP-...). No es el código visible.' },
      { grupo: 'Identificadores', clave: 'ID_PREFIJO_TAREA_OIS', tipo: 'Texto', descripcion: 'Prefijo del ID de una tarea nueva de OIS (TAR-...).' },
      { grupo: 'Identificadores', clave: 'ID_PREFIJO_TAREA_OIP', tipo: 'Texto', descripcion: 'Prefijo del ID de una tarea nueva de OIP (TAP-...).' },
      { grupo: 'Identificadores', clave: 'ID_PREFIJO_FACTURA_OIP', tipo: 'Texto', descripcion: 'Prefijo del ID de una fila nueva de facturación OIP (FAC-...).' },
      { grupo: 'Consecutivos', clave: 'CODIGO_PREFIJO_COTIZACION', tipo: 'Texto', descripcion: 'Prefijo del código visible de una cotización (CTZ-KGP-001-26). La numeración continúa aunque se cambie.' },
      { grupo: 'Consecutivos', clave: 'CODIGO_PREFIJO_OIS', tipo: 'Texto', descripcion: 'Prefijo del código visible de una OIS (OIS-KGP-001-26). La numeración continúa aunque se cambie.' },
      { grupo: 'Consecutivos', clave: 'CODIGO_PREFIJO_OIP', tipo: 'Texto', descripcion: 'Prefijo del código visible de una OIP (OIP-KGP-001-26). La numeración continúa aunque se cambie.' },
      { grupo: 'Textos', clave: 'NOMBRE_OIS', tipo: 'Texto', descripcion: 'Nombre largo de la OIS en los correos ({{nombreOrden}}).' },
      { grupo: 'Textos', clave: 'NOMBRE_OIP', tipo: 'Texto', descripcion: 'Nombre largo de la OIP en los correos ({{nombreOrden}}).' },
      { grupo: 'Recordatorio de facturación OIP', clave: 'OIP_NOTIF_DIA', tipo: 'Número entero', descripcion: 'Día del mes (1-28) en que corre el recordatorio. Se aplica al volver a ejecutar admin_installOipFacturacionTrigger().' },
      { grupo: 'Recordatorio de facturación OIP', clave: 'OIP_NOTIF_HORA', tipo: 'Número entero', descripcion: 'Hora aproximada (0-23, zona TZ) del recordatorio. Se aplica al volver a ejecutar admin_installOipFacturacionTrigger().' },
      { grupo: 'Avanzado (no tocar sin necesidad)', clave: 'LIMITS.LOCK_MS', tipo: 'Número entero', descripcion: 'Milisegundos que una escritura espera su turno antes de responder "sistema ocupado".' },
      { grupo: 'Avanzado (no tocar sin necesidad)', clave: 'LIMITS.LOCK_HISTORIAL_MS', tipo: 'Número entero', descripcion: 'Milisegundos que espera el registro de un correo en HISTORIAL antes de rendirse (el correo ya salió).' },
      { grupo: 'Avanzado (no tocar sin necesidad)', clave: 'CACHE_TTL.IDEMPOTENCIA_S', tipo: 'Número entero', descripcion: 'Segundos durante los que un reintento de la misma operación devuelve el resultado ya guardado (máx. 21600).' },
      { grupo: 'Avanzado (no tocar sin necesidad)', clave: 'CACHE_TTL.CLIENTES_S', tipo: 'Número entero', descripcion: 'Segundos de caché del listado de clientes (máx. 21600).' },
      { grupo: 'Avanzado (no tocar sin necesidad)', clave: 'CACHE_TTL.EMPLEADOS_S', tipo: 'Número entero', descripcion: 'Segundos de caché del listado de empleados (máx. 21600).' },
      { grupo: 'Avanzado (no tocar sin necesidad)', clave: 'CACHE_TTL.DASHBOARD_S', tipo: 'Número entero', descripcion: 'Segundos de caché de las consultas paginadas del Dashboard y listados.' },
      { grupo: 'Avanzado (no tocar sin necesidad)', clave: 'CACHE_TTL.DASHBOARD_SNAPSHOT_S', tipo: 'Número entero', descripcion: 'Segundos de caché del snapshot completo del Dashboard (máx. 21600).' }
    ],
    CORREO: [
      { grupo: 'Destinatarios', clave: 'OIP_NOTIF_EMAIL', tipo: 'Correo(s)', descripcion: 'Quién recibe el recordatorio mensual de facturación de las OIP. Varios: separados por coma.' },
      { grupo: 'Remitente y firma', clave: 'CORREO.REMITENTE_NOMBRE', tipo: 'Texto', descripcion: 'Nombre que ve el destinatario como remitente. La dirección es siempre la de la cuenta que publica la app.' },
      { grupo: 'Remitente y firma', clave: 'CORREO.FIRMA', tipo: 'Texto', descripcion: 'Firma debajo de "Saludos cordiales,".' },
      { grupo: 'Remitente y firma', clave: 'CORREO.NOTA_PIE', tipo: 'Texto', descripcion: 'Texto pequeño al final del pie verde.' },
      { grupo: 'Pie del correo', clave: 'CORREO.DIRECCION', tipo: 'Texto', descripcion: 'Dirección del pie (vacío = no se muestra).' },
      { grupo: 'Pie del correo', clave: 'CORREO.TELEFONOS', tipo: 'Texto', descripcion: 'Teléfonos del pie. Cada número de 10 dígitos se vuelve un enlace tel:+57...' },
      { grupo: 'Pie del correo', clave: 'CORREO.CORREO_CONTACTO', tipo: 'Correo', descripcion: 'Correo de contacto del pie (enlace mailto:).' },
      { grupo: 'Pie del correo', clave: 'CORREO.SITIO_WEB_TEXTO', tipo: 'Texto', descripcion: 'Texto del sitio web en el pie.' },
      { grupo: 'Pie del correo', clave: 'CORREO.SITIO_WEB_URL', tipo: 'URL', descripcion: 'Enlace del sitio web (pie y logo).' }
    ],
    CELDAS: [
      { grupo: 'Encabezado', hoja: 'Todas', clave: 'FECHA_ANIO', descripcion: 'Año de elaboración.' },
      { grupo: 'Encabezado', hoja: 'Todas', clave: 'FECHA_MES', descripcion: 'Mes de elaboración.' },
      { grupo: 'Encabezado', hoja: 'Todas', clave: 'FECHA_DIA', descripcion: 'Día de elaboración.' },
      { grupo: 'Encabezado', hoja: 'Todas', clave: 'CODIGO', descripcion: 'Código de la cotización.' },
      { grupo: 'Cliente', hoja: 'Todas', clave: 'CLIENTE_RAZON_SOCIAL', descripcion: 'Razón social.' },
      { grupo: 'Cliente', hoja: 'Todas', clave: 'CLIENTE_NUMERO_ID', descripcion: 'Tipo y número de identificación.' },
      { grupo: 'Cliente', hoja: 'Todas', clave: 'CLIENTE_DIRECCION', descripcion: 'Dirección.' },
      { grupo: 'Cliente', hoja: 'Todas', clave: 'CLIENTE_CIUDAD_DEPTO_PAIS', descripcion: 'Ciudad, departamento y país.' },
      { grupo: 'Cliente', hoja: 'Todas', clave: 'CLIENTE_TELEFONO', descripcion: 'Teléfono.' },
      { grupo: 'Cliente', hoja: 'Todas', clave: 'CLIENTE_CIIU', descripcion: 'Código CIIU.' },
      { grupo: 'Cliente', hoja: 'Todas', clave: 'CLIENTE_ACTIVIDAD_PRINCIPAL', descripcion: 'Actividad principal.' },
      { grupo: 'Solicitante', hoja: 'Todas', clave: 'SOLICITANTE_NOMBRE', descripcion: 'Nombre del solicitante.' },
      { grupo: 'Solicitante', hoja: 'Todas', clave: 'SOLICITANTE_CARGO', descripcion: 'Cargo del solicitante.' },
      { grupo: 'Solicitante', hoja: 'Todas', clave: 'SOLICITANTE_TELEFONO', descripcion: 'Teléfono del solicitante.' },
      { grupo: 'Solicitante', hoja: 'Todas', clave: 'SOLICITANTE_CORREO', descripcion: 'Correo del solicitante.' },
      { grupo: 'Cotización', hoja: 'Todas', clave: 'COTIZACION_DESCRIPCION', descripcion: 'Descripción general de la cotización.' },
      { grupo: 'Establecimiento', hoja: 'Todas', clave: 'ESTABLECIMIENTO_NOMBRE', descripcion: 'Nombre del establecimiento.' },
      { grupo: 'Establecimiento', hoja: 'Todas', clave: 'ESTABLECIMIENTO_DIRECCION', descripcion: 'Dirección del establecimiento.' },
      { grupo: 'Establecimiento', hoja: 'Todas', clave: 'ESTABLECIMIENTO_CIUDAD_DEPTO_PAIS', descripcion: 'Ciudad, departamento y país del establecimiento.' },
      { grupo: 'Establecimiento', hoja: 'Todas', clave: 'ENCARGADO_NOMBRE', descripcion: 'Nombre del encargado.' },
      { grupo: 'Establecimiento', hoja: 'Todas', clave: 'ENCARGADO_CARGO', descripcion: 'Cargo del encargado.' },
      { grupo: 'Establecimiento', hoja: 'Todas', clave: 'ENCARGADO_TELEFONO', descripcion: 'Teléfono del encargado.' },
      { grupo: 'Establecimiento', hoja: 'Todas', clave: 'ENCARGADO_CORREO', descripcion: 'Correo del encargado.' },
      { grupo: 'Servicios', hoja: 'Todas', clave: 'SERVICIOS_FILA_BASE', descripcion: 'Fila del Servicio #1 (número de fila).' },
      { grupo: 'Servicios', hoja: 'Todas', clave: 'SERVICIOS_FILA_PASO', descripcion: 'Filas entre un servicio y el siguiente (#2 = base + paso, ...).' },
      { grupo: 'Servicios', hoja: 'Todas', clave: 'SERVICIOS_COL_TIPO', descripcion: 'Columna del tipo de servicio (letra).' },
      { grupo: 'Servicios', hoja: 'Todas', clave: 'SERVICIOS_COL_UNSPSC', descripcion: 'Columna del código UNSPSC (letra).' },
      { grupo: 'Servicios', hoja: 'Todas', clave: 'SERVICIOS_COL_DESCRIPCION', descripcion: 'Columna de la descripción del servicio (letra).' },
      { grupo: 'Servicios', hoja: 'Todas', clave: 'SERVICIOS_ACT_COL', descripcion: 'Columna de las actividades (letra).' },
      { grupo: 'Servicios', hoja: 'Todas', clave: 'SERVICIOS_ACT_OFFSET_FILA', descripcion: 'Filas debajo del servicio donde empieza su lista de actividades.' },
      { grupo: 'Servicios', hoja: 'Todas', clave: 'SERVICIOS_ACT_MAX', descripcion: 'Filas de actividades por servicio en la plantilla.' },
      { grupo: 'Tarifas', hoja: 'Cotización', clave: 'TARIFAS_FILA_BASE', descripcion: 'Fila de la tarifa del Servicio #1 (#2 en la siguiente, ...).' },
      { grupo: 'Tarifas', hoja: 'Cotización', clave: 'TARIFAS_COL_TARIFA', descripcion: 'Columna de la tarifa (letra).' },
      { grupo: 'Tarifas', hoja: 'Cotización', clave: 'TARIFAS_COL_CANTIDAD', descripcion: 'Columna de la cantidad (letra).' },
      { grupo: 'Tarifas', hoja: 'Cotización', clave: 'TARIFAS_COL_OBSERVACIONES', descripcion: 'Columna de las observaciones (letra).' },
      { grupo: 'Personal', hoja: 'Todas', clave: 'TIEMPO_ENTREGA', descripcion: 'Tiempo de entrega.' },
      { grupo: 'Personal', hoja: 'Todas', clave: 'ELABORADO_POR', descripcion: 'Nombre de quien elaboró.' },
      { grupo: 'Personal', hoja: 'Todas', clave: 'CARGO_ELABORADO_POR', descripcion: 'Cargo de quien elaboró.' },
      { grupo: 'Personal', hoja: 'Todas', clave: 'APROBADO_POR', descripcion: 'Nombre de quien revisó y aprobó.' },
      { grupo: 'Personal', hoja: 'Todas', clave: 'ASESOR_COMERCIAL', descripcion: 'Nombre del asesor comercial.' },
      { grupo: 'OIS', hoja: 'OIS', clave: 'OIS_COT_CODIGO', descripcion: 'Código de la cotización padre.' },
      { grupo: 'OIS', hoja: 'OIS', clave: 'OIS_CODIGO', descripcion: 'Código de la OIS.' },
      { grupo: 'OIS', hoja: 'OIS', clave: 'OIS_FECHA_ANIO', descripcion: 'Año de la OIS.' },
      { grupo: 'OIS', hoja: 'OIS', clave: 'OIS_FECHA_MES', descripcion: 'Mes de la OIS.' },
      { grupo: 'OIS', hoja: 'OIS', clave: 'OIS_FECHA_DIA', descripcion: 'Día de la OIS.' },
      { grupo: 'OIS', hoja: 'OIS', clave: 'OIS_TAREAS_FILA_BASE', descripcion: 'Fila de la tarea #1 (las demás siguen hacia abajo).' },
      { grupo: 'OIS', hoja: 'OIS', clave: 'OIS_TAREAS_COL_TAREA', descripcion: 'Columna de la tarea (letra).' },
      { grupo: 'OIS', hoja: 'OIS', clave: 'OIS_TAREAS_COL_RESPONSABLE', descripcion: 'Columna del responsable (letra).' },
      { grupo: 'OIS', hoja: 'OIS', clave: 'OIS_TAREAS_COL_FECHA_INICIO', descripcion: 'Columna de la fecha de inicio (letra).' },
      { grupo: 'OIS', hoja: 'OIS', clave: 'OIS_TAREAS_COL_FECHA_ENTREGA', descripcion: 'Columna de la fecha de entrega (letra).' },
      { grupo: 'OIS', hoja: 'OIS', clave: 'OIS_TAREAS_COL_OBSERVACION', descripcion: 'Columna de la observación (letra).' },
      { grupo: 'OIP', hoja: 'OIP', clave: 'OIP_COT_CODIGO', descripcion: 'Código de la cotización padre.' },
      { grupo: 'OIP', hoja: 'OIP', clave: 'OIP_CODIGO', descripcion: 'Código de la OIP.' },
      { grupo: 'OIP', hoja: 'OIP', clave: 'OIP_FECHA_ANIO', descripcion: 'Año de la OIP.' },
      { grupo: 'OIP', hoja: 'OIP', clave: 'OIP_FECHA_MES', descripcion: 'Mes de la OIP.' },
      { grupo: 'OIP', hoja: 'OIP', clave: 'OIP_FECHA_DIA', descripcion: 'Día de la OIP.' },
      { grupo: 'OIP', hoja: 'OIP', clave: 'OIP_TAREAS_FILA_BASE', descripcion: 'Fila de la tarea #1 (cada tarea siguiente inserta una fila debajo).' },
      { grupo: 'OIP', hoja: 'OIP', clave: 'OIP_TAREAS_COL_TAREA', descripcion: 'Columna de la tarea (letra).' },
      { grupo: 'OIP', hoja: 'OIP', clave: 'OIP_TAREAS_COL_RESPONSABLE', descripcion: 'Columna del responsable (letra).' },
      { grupo: 'OIP', hoja: 'OIP', clave: 'OIP_TAREAS_COL_FECHA_INICIO', descripcion: 'Columna de la fecha de inicio (letra).' },
      { grupo: 'OIP', hoja: 'OIP', clave: 'OIP_TAREAS_COL_FECHA_ENTREGA', descripcion: 'Columna de la fecha de entrega (letra).' },
      { grupo: 'OIP', hoja: 'OIP', clave: 'OIP_TAREAS_COL_OBSERVACION', descripcion: 'Columna de la observación (letra).' }
    ]
  };
}

/** Valor de una clave con puntos ("LIMITS.MAX_SERVICIOS") dentro de un objeto. */
function cfgs_get_(obj, path) {
  return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
}

// ---------------------------------------------------------------------
// Creación y formato de las hojas (admin_crearHojasConfig)
// ---------------------------------------------------------------------

/**
 * Crea o completa las hojas CONFIG_* con forma de tabla. Idempotente:
 *   - Hoja que no existe -> se crea con sus encabezados.
 *   - Fila (CLAVE) que no existe -> se agrega con VALOR = valor actual del código.
 *   - Fila que ya existe -> su VALOR (y los textos de correo) NO se tocan;
 *     solo se refrescan las columnas de ayuda (GRUPO, DESCRIPCION, VALOR POR
 *     DEFECTO, TIPO, ENLACE...).
 * Devuelve un resumen por hoja.
 */
function cfgs_crearHojas_() {
  var tabs = cfgs_tabs_();
  var cat = cfgs_catalogo_();
  // Valores por defecto = los del CÓDIGO, sin lo que diga la hoja.
  var defs = cfgs_sinHoja_(function () { return { cfg: CFG_(), celdas: CELLMAP_() }; });
  var ss = SpreadsheetApp.openById(cfgs_sheetId_());
  var resumen = [];

  function linkFormula(tipo, fila, colLetra) {
    var ref = colLetra + fila;
    var base = tipo === 'Carpeta' ? 'https://drive.google.com/drive/folders/'
      : tipo === 'Archivo' ? 'https://drive.google.com/file/d/'
        : 'https://docs.google.com/spreadsheets/d/';
    return '=IF(' + ref + '="","",HYPERLINK("' + base + '"&' + ref + ',"Abrir"))';
  }

  function kvSpec(nombre, items, extras, fuente) {
    return {
      nombre: nombre,
      columnas: ['GRUPO', 'CLAVE', 'VALOR', 'VALOR POR DEFECTO', 'DESCRIPCION'].concat(extras || []),
      anchos: [170, 260, 300, 220, 420].concat((extras || []).map(function () { return 160; })),
      valorTexto: nombre !== tabs.GENERAL,
      filas: items.map(function (f) {
        var def = fuente === 'celdas' ? defs.celdas[f.clave] : cfgs_get_(defs.cfg, f.clave);
        var defTxt = def == null ? '' : def;
        var fila = { GRUPO: f.grupo, CLAVE: f.clave, VALOR: defTxt, 'VALOR POR DEFECTO': defTxt, DESCRIPCION: f.descripcion };
        if (f.nombre) fila.NOMBRE = f.nombre;
        if (f.tipo) fila.TIPO = f.tipo;
        if (f.hoja) fila['HOJA DE PLANTILLA'] = f.hoja;
        if (f.soloLectura) fila.DESCRIPCION = '(Solo lectura) ' + f.descripcion;
        fila.__tipoId = f.tipo;
        return fila;
      })
    };
  }

  var textos = mail_textosDefault_();
  var specs = [
    kvSpec(tabs.IDS, cat.IDS, ['NOMBRE', 'TIPO', 'ENLACE'], 'valores'),
    kvSpec(tabs.HOJAS, cat.HOJAS, ['TIPO'], 'valores'),
    kvSpec(tabs.GENERAL, cat.GENERAL, ['TIPO'], 'valores'),
    kvSpec(tabs.CORREO, cat.CORREO, ['TIPO'], 'valores'),
    {
      nombre: tabs.CORREO_TEXTOS,
      columnas: ['CLAVE', 'DESCRIPCION', 'DESTINATARIO', 'VARIABLES'].concat(mail_camposTexto_()),
      anchos: [200, 280, 240, 300, 300, 300, 180, 260, 200, 520, 220, 380],
      valorTexto: true,
      filas: Object.keys(textos).map(function (k) {
        var t = textos[k];
        var fila = { CLAVE: k, DESCRIPCION: t.DESCRIPCION, DESTINATARIO: t.DESTINATARIO, VARIABLES: t.VARIABLES };
        mail_camposTexto_().forEach(function (c) { fila[c] = t[c]; });
        return fila;
      }),
      // Columnas que se refrescan siempre (las demás son del usuario).
      ayuda: ['DESCRIPCION', 'DESTINATARIO', 'VARIABLES']
    },
    kvSpec(tabs.CELDAS, cat.CELDAS, ['HOJA DE PLANTILLA'], 'celdas')
  ];
  specs.forEach(function (s) {
    if (!s.ayuda) s.ayuda = s.columnas.filter(function (c) { return c !== 'CLAVE' && c !== 'VALOR'; });
  });

  specs.forEach(function (spec) {
    var sh = ss.getSheetByName(spec.nombre) || ss.insertSheet(spec.nombre);
    var res = cfgs_sincronizarTabla_(sh, spec, linkFormula);
    resumen.push(spec.nombre + ': ' + res.agregadas + ' fila(s) nuevas, ' + res.existentes + ' ya existían (sus valores no se tocaron).');
  });

  cfgs_escribirLeeme_(ss);

  // Orden de las pestañas: después de las que no son de configuración.
  var orden = [tabs.LEEME, tabs.IDS, tabs.HOJAS, tabs.GENERAL, tabs.CORREO, tabs.CORREO_TEXTOS, tabs.CELDAS];
  var otras = ss.getSheets().filter(function (s) { return orden.indexOf(s.getName()) < 0; }).length;
  orden.forEach(function (n, i) {
    var sh = ss.getSheetByName(n);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(otras + i + 1);
  });

  SpreadsheetApp.flush();
  return resumen;
}

/** Sincroniza una hoja de tabla: encabezados, filas faltantes, columnas de ayuda y formato. */
function cfgs_sincronizarTabla_(sh, spec, linkFormula) {
  // Encabezados: los que falten se agregan al final, nunca se reordenan los del usuario.
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var headers = sh.getLastRow() >= 1 ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (x) { return String(x).trim(); }) : [];
  if (headers.every(function (x) { return !x; })) headers = [];
  spec.columnas.forEach(function (c) {
    if (headers.map(normText_).indexOf(normText_(c)) < 0) headers.push(c);
  });
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  var col = {};
  headers.forEach(function (x, i) { col[normText_(x)] = i; });

  // VALOR (y textos de correo) como texto plano, para que Sheets no convierta "0.19", "A7", IDs, etc.
  var maxRows = sh.getMaxRows();
  if (spec.valorTexto) {
    spec.columnas.forEach(function (c) {
      if (spec.ayuda.indexOf(c) < 0 && c !== 'CLAVE') sh.getRange(2, col[normText_(c)] + 1, Math.max(maxRows - 1, 1), 1).setNumberFormat('@');
    });
  }

  var lastRow = sh.getLastRow();
  var data = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];
  var filaPorClave = {};
  data.forEach(function (r, i) {
    var k = String(r[col.CLAVE] || '').trim();
    if (k) filaPorClave[k] = i;
  });

  var agregadas = 0, existentes = 0;
  spec.filas.forEach(function (f) {
    var idx = filaPorClave[f.CLAVE];
    if (idx === undefined) {
      var nueva = headers.map(function (hd) { var v = f[hd]; return v == null ? '' : v; });
      data.push(nueva);
      filaPorClave[f.CLAVE] = data.length - 1;
      agregadas++;
    } else {
      existentes++;
      spec.ayuda.forEach(function (c) {
        if (f[c] !== undefined && col[normText_(c)] !== undefined) data[idx][col[normText_(c)]] = f[c];
      });
    }
  });

  // Enlaces de CONFIG_IDS: fórmula que sigue a la celda VALOR de la misma fila.
  var hayEnlace = col.ENLACE !== undefined;
  if (hayEnlace) {
    var letraValor = cfgs_colLetra_(col.VALOR + 1);
    var tipoPorClave = {};
    spec.filas.forEach(function (f) { tipoPorClave[f.CLAVE] = f.__tipoId; });
    data.forEach(function (r, i) {
      var t = tipoPorClave[String(r[col.CLAVE]).trim()] || String(r[col.TIPO] || '');
      r[col.ENLACE] = linkFormula(t, i + 2, letraValor);
    });
  }

  if (data.length) sh.getRange(2, 1, data.length, headers.length).setValues(data);
  cfgs_formatoTabla_(sh, headers, spec, data.length);
  return { agregadas: agregadas, existentes: existentes };
}

/** Formato de "tabla": encabezado verde KGP, filas alternas, filtro, columnas fijas y anchos. */
function cfgs_formatoTabla_(sh, headers, spec, nFilas) {
  var nCols = headers.length;
  var total = Math.max(nFilas + 1, 2);
  sh.setFrozenRows(1);
  var head = sh.getRange(1, 1, 1, nCols);
  head.setFontWeight('bold').setFontColor('#ffffff').setBackground('#436b0a')
    .setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(1, 32);

  var cuerpo = sh.getRange(2, 1, total - 1, nCols);
  cuerpo.setVerticalAlignment('top').setWrap(true);

  sh.getBandings().forEach(function (b) { b.remove(); });
  var banding = sh.getRange(1, 1, total, nCols).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);
  banding.setHeaderRowColor('#436b0a').setFirstRowColor('#ffffff').setSecondRowColor('#eef4e4');

  var filtro = sh.getFilter();
  if (filtro) filtro.remove();
  sh.getRange(1, 1, total, nCols).createFilter();

  // CLAVE en negrita (es lo que lee el código: no se debe cambiar).
  var iClave = headers.map(normText_).indexOf('CLAVE');
  if (iClave >= 0) {
    sh.getRange(2, iClave + 1, total - 1, 1).setFontWeight('bold').setFontFamily('Roboto Mono');
    sh.setFrozenColumns(iClave + 1);
  }

  headers.forEach(function (hd, i) {
    var j = spec.columnas.map(normText_).indexOf(normText_(hd));
    if (j >= 0 && spec.anchos[j]) sh.setColumnWidth(i + 1, spec.anchos[j]);
  });

  // Aviso suave (no bloquea) si alguien edita la columna CLAVE.
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
    if (p.getDescription() === 'KGP: columna CLAVE') p.remove();
  });
  if (iClave >= 0) {
    sh.getRange(2, iClave + 1, total - 1, 1).protect()
      .setDescription('KGP: columna CLAVE').setWarningOnly(true);
  }
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

/** Hoja CONFIG_LEEME: qué hay en cada hoja y las reglas de edición. Se reescribe completa cada vez. */
function cfgs_escribirLeeme_(ss) {
  var tabs = cfgs_tabs_();
  var sh = ss.getSheetByName(tabs.LEEME) || ss.insertSheet(tabs.LEEME);
  sh.clear();
  var filas = [
    ['HOJA', 'QUÉ CONTIENE', 'CÓMO SE EDITA'],
    [tabs.IDS, 'IDs de los spreadsheets, carpetas y archivos de Drive que usa la app (con enlace para abrirlos).', 'Cambie la columna VALOR por el nuevo ID (la parte larga del enlace de Drive).'],
    [tabs.HOJAS, 'Nombres de las pestañas de la base de datos, de la plantilla y del historial de correos.', 'Si renombra una pestaña en su archivo, escriba aquí el nombre nuevo en VALOR.'],
    [tabs.GENERAL, 'Plazos, IVA, límites, días de aviso "por vencer", actualización del Dashboard y caché.', 'Solo números en VALOR (salvo TZ). El grupo "Avanzado" no se toca sin necesidad.'],
    [tabs.CORREO, 'Quién recibe el recordatorio de facturación OIP, nombre del remitente, firma y datos del pie del correo.', 'Texto libre en VALOR. Varios correos: separados por coma.'],
    [tabs.CORREO_TEXTOS, 'Asunto, título, párrafos, botón y datos destacados de CADA correo que envía la app (una fila por correo).', 'Use {{variable}} (ver columna VARIABLES), {{#var}}texto{{/var}} = solo si la variable tiene valor, {{^var}}texto{{/var}} = solo si está vacía. PARRAFOS: separe párrafos con una línea en blanco. DESTACADOS: una línea por dato, "Título | valor".'],
    [tabs.CELDAS, 'Celdas de la plantilla donde se escribe cada dato de la cotización, OIS y OIP.', 'Celdas como A7, columnas como B, filas como 39. Cambie solo si cambió la plantilla.'],
    ['', '', ''],
    ['REGLA', 'DETALLE', ''],
    ['Cuándo se aplica', 'La app lee estas hojas cada vez que se carga o recarga la página (F5). Los disparadores automáticos usan la última copia leída.', ''],
    ['Celda VALOR vacía', 'Se usa el valor por defecto del código (columna VALOR POR DEFECTO). Igual para un texto de correo vacío.', ''],
    ['Valor no válido', 'Si un valor no se puede interpretar (p. ej. letras donde va un número), se ignora y se usa el valor por defecto: la app nunca se cae por la configuración.', ''],
    ['Columna CLAVE', 'Es lo que lee el código: no la cambie (Sheets avisa si lo intenta). Puede reordenar filas y columnas libremente.', ''],
    ['Verificar', 'En el editor de Apps Script, ejecute admin_verConfig(): lista lo que se ignoró y los valores vigentes.', ''],
    ['Agregar parámetros', 'admin_crearHojasConfig() agrega las filas nuevas sin tocar los valores ya escritos.', '']
  ];
  sh.getRange(1, 1, filas.length, 3).setValues(filas);
  sh.getRange(1, 1, 1, 3).setFontWeight('bold').setFontColor('#ffffff').setBackground('#436b0a');
  sh.getRange(9, 1, 1, 3).setFontWeight('bold').setFontColor('#ffffff').setBackground('#436b0a');
  sh.getRange(2, 1, filas.length - 1, 1).setFontWeight('bold');
  sh.getRange(1, 1, filas.length, 3).setWrap(true).setVerticalAlignment('top');
  sh.setColumnWidth(1, 220);
  sh.setColumnWidth(2, 560);
  sh.setColumnWidth(3, 560);
  sh.setFrozenRows(1);
}

/**
 * Relee la hoja y devuelve qué se aplicó y qué se ignoró (para
 * admin_verConfig). No escribe nada.
 */
function cfgs_verificar_() {
  var data = cfgs_refresh_();
  var avisos = (data.avisos || []).slice();
  var defs = cfgs_sinHoja_(function () { return { cfg: CFG_(), celdas: CELLMAP_() }; });
  cfgs_aplicar_(defs.cfg, 'valores', avisos, data);
  cfgs_aplicar_(defs.celdas, 'celdas', avisos, data);
  var textos = mail_textosDefault_();
  Object.keys(data.correos || {}).forEach(function (k) {
    if (!textos[k]) avisos.push('Correo desconocido en ' + cfgs_tabs_().CORREO_TEXTOS + ': ' + k + ' (se ignoró).');
  });
  return {
    leidoEn: data.leidoEn,
    clavesEnHoja: Object.keys(data.valores || {}).length + Object.keys(data.celdas || {}).length,
    correosEnHoja: Object.keys(data.correos || {}).length,
    avisos: avisos,
    efectivo: { CFG: CFG_(), CELLMAP: CELLMAP_(), CLIENTE: cfgs_clientConfig_() }
  };
}
