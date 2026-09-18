/**
 * Configuración central de la Web App de Cotizaciones KGP.
 *
 * Regla del proyecto: cero código ejecutable a nivel top-level.
 * Toda la configuración vive dentro de funciones accesoras (CFG, SCHEMA,
 * CELLMAP) para no depender del orden de carga de los archivos de Apps
 * Script (namespace global plano, sin import/export).
 *
 * IMPORTANTE — namespace compartido con src/otherFunctions.js (respaldo del
 * Code.js original, nunca se llama pero SÍ se sube a Apps Script). Ningún
 * símbolo nuevo debe llamarse igual que:
 *   FOLDER_ID  DEST_SHEET_ID  DEST_TAB_NAME  SOURCE_TAB_NAME
 *   MAX_ROWS_ADDED_PER_RUN  fillCotizaciones  openSourceSpreadsheet_
 *   cleanupTemporaryFile_  getErrorMessage_  addSkipped_  getCodigo_
 *   buildFechaCreacion_  getExistingCodes_  getExistingFileUrls_
 */

/**
 * Configuración general de la aplicación.
 * TEMPLATE_SHEET_ID se completa tras ejecutar admin_convertTemplate()
 * (Fase 2) y TEMPLATE_TAB_NAME tras ejecutar admin_health().
 */
function CFG() {
  // TEMPLATE_SHEET_ID y TEMPLATE_TAB_NAME se autoconfiguran en
  // ScriptProperties: admin_convertTemplate() escribe TEMPLATE_SHEET_ID la
  // primera vez que se ejecuta, y admin_health()/la UI pueden fijar
  // TEMPLATE_TAB_NAME una vez se conoce el nombre real de la hoja. Así el
  // descubrimiento de Fase 2 (ejecutado por el usuario desde el editor) no
  // requiere editar este archivo a mano.
  var props = PropertiesService.getScriptProperties();
  var templateSheetId = props.getProperty('TEMPLATE_SHEET_ID') || '';
  var templateTabName = props.getProperty('TEMPLATE_TAB_NAME') || null;
  // Pestaña de la ORDEN DE INSPECCIÓN DE SERVICIO dentro del MISMO archivo
  // plantilla (el que convirtió admin_convertTemplate). A diferencia de
  // TEMPLATE_TAB_NAME, esta sí tiene un valor por defecto: el documento de la
  // OIS es una copia de esa única hoja, así que no hay un "usar la primera
  // hoja" sensato al que degradar. admin_setOisTabName('...') lo corrige si
  // el nombre real de la pestaña cambia.
  var templateTabOis = props.getProperty('TEMPLATE_TAB_OIS') || 'OIS V-4';

  return {
    TZ: 'America/Bogota',
    APP_VERSION: '1.0.0',

    DB_SHEET_ID: '141ZCKO24f6Yp1NEt-yZ3_Fm0XXlzcyD_RcRZXoeGwGI',
    CAT_SHEET_ID: '1n87Kj1wgP7PQ3jZXunHgiR7EK2MqG7zcDzhHwCCkaqM',

    TEMPLATE_FILE_ID: '1sFMDek6vK1m1r8QLOndkFJ3qFjNEV0lH',
    // Vacío hasta que se ejecute admin_convertTemplate() (Fase 2). Mientras
    // esté vacío, 31_DocService.js falla con un mensaje claro en vez de
    // intentar usar el .xlsx original directamente.
    TEMPLATE_SHEET_ID: templateSheetId,
    // null => usar la primera hoja de la plantilla (ss.getSheets()[0]).
    TEMPLATE_TAB_NAME: templateTabName,
    TEMPLATE_TAB_OIS: templateTabOis,

    OUT_FOLDER_ID: '1pAKD2vtrBat8pjos9d3rbRDIPcSK8fkB',

    // Carpeta raíz de las OIS. Cada OIS crea DENTRO de esta su propia
    // subcarpeta "OIS-KGP-NNN-YY-NOMBRE DEL CLIENTE", y el spreadsheet de la
    // OIS (con el mismo nombre) vive dentro de esa subcarpeta.
    OIS_FOLDER_ID: '1I-eadY9XYn1Ye9QkiFvoa2IfnmsbCXMx',

    TABS: {
      COTIZACIONES: 'COTIZACIONES',
      SERVICIOS: 'SERVICIOS',
      CLIENTES: 'CLIENTES',
      CONTACTOS: 'CONTACTOS_CLIENTES',
      ESTABLECIMIENTOS: 'ESTABLECIMIENTOS_CLIENTES',
      ERRORES: '_ERRORES',
      TIPOS_SERVICIO: 'TIPOS DE SERVICIOS',
      PERSONAL: 'PERSONAL_KGP',
      OIS: 'OIS',
      TAREAS_OIS: 'TAREAS_OIS'
    },

    LIMITS: {
      MAX_SERVICIOS: 10,
      MAX_ACTIVIDADES: 10,
      // Tareas por OIS: la plantilla solo tiene 20 filas (229..248), ver
      // CELLMAP().OIS_TAREAS_FILA_BASE.
      MAX_TAREAS: 20,
      LOCK_MS: 30000,
      CELL_MAX: 5000,
      MAX_PLAZO_DIAS: 365,
      // Techo del snapshot completo que el Dashboard descarga de una sola
      // vez (ver ds_getSnapshot_, 32_DashboardService.js). El Dashboard
      // filtra/ordena/pagina en el cliente, así que necesita todas las
      // cotizaciones; este tope evita que el payload crezca sin control
      // cuando COTIZACIONES tenga años de historia. Al superarlo se envían
      // las más recientes y la UI avisa que hay historial más viejo fuera
      // del snapshot.
      DASHBOARD_MAX_COTIZACIONES: 2000
    },

    // Flujo de estado (Gestionar cotización): toda cotización nace en
    // ESTADO_INICIAL y solo puede pasar UNA vez a ESTADO_APROBADA o
    // ESTADO_RECHAZADA con los botones "Garantía aprobada/rechazada". Las
    // filas antiguas con "Aprobado"/"Rechazado" (masculino) se leen como sus
    // equivalentes actuales vía qs_normEstado_ (30_QuoteService.js).
    ESTADOS: ['En revisión', 'Aprobada', 'Rechazada'],
    ESTADO_INICIAL: 'En revisión',
    ESTADO_APROBADA: 'Aprobada',
    ESTADO_RECHAZADA: 'Rechazada',

    // Flujo de estado de una OIS (Gestionar OIS). Nace en OIS_ESTADO_INICIAL
    // y NUNCA se edita a mano: se deriva de sus tareas y de la fecha de
    // vencimiento (ver ois_deriveEstado_ en 35_OisService.js). Regla
    // confirmada con el usuario: "Finalizada" gana sobre "Vencida" — una OIS
    // con todas sus tareas finalizadas queda Finalizada aunque ya haya pasado
    // la fecha de vencimiento.
    ESTADOS_OIS: ['En curso', 'Finalizada', 'Vencida'],
    OIS_ESTADO_INICIAL: 'En curso',
    OIS_ESTADO_FINALIZADA: 'Finalizada',
    OIS_ESTADO_VENCIDA: 'Vencida',

    // Estado de una tarea individual (TAREAS_OIS.ESTADO). Nace "En curso" y
    // el botón "Marcar como finalizada" la pasa a "Finalizada". Eliminar una
    // tarea la borra de la hoja, no le cambia el estado.
    TAREA_ESTADO_INICIAL: 'En curso',
    TAREA_ESTADO_FINALIZADA: 'Finalizada',

    // Tarifas (Gestionar cotización): IVA sobre el SUBTOTAL de la cotización.
    IVA_TASA: 0.19,
    TARIFA_MAX: 9999999999,   // 10 dígitos: tarifa * cantidad sigue siendo un entero seguro en JS
    CANTIDAD_MAX: 99999,

    CACHE_TTL: {
      CATALOGO_S: 21600,   // 6h, máximo permitido por CacheService
      CLIENTES_S: 900,     // 15 min
      DASHBOARD_S: 30,
      // El snapshot completo se invalida por versión de datos (la key la
      // incluye), así que puede vivir mucho más que la consulta paginada:
      // mientras nadie escriba, se sirve de caché sin tocar ningún Sheet.
      DASHBOARD_SNAPSHOT_S: 3600,
      EMPLEADOS_S: 900     // 15 min, mismo criterio que CLIENTES_S
    }
  };
}

/**
 * Encabezados esperados por hoja. `required` deben existir siempre;
 * `optional` se usan si están presentes y se ignoran si no (con warning
 * en admin_health / api_bootstrap). Los nombres se comparan normalizados
 * (ver 02_Utils.js normText_ / repo_normHeader_): sin acentos, mayúsculas,
 * espacios colapsados.
 */
function SCHEMA() {
  return {
    COTIZACIONES: {
      required: [
        'ID COTIZACION', 'CODIGO', 'FECHA ELABORACION', 'PLAZO',
        'FECHA VENCIMIENTO', 'ID CLIENTE', 'ID SOLICITANTE',
        'ID ESTABLECIMIENTO', 'NUMERO SERVICIO', 'ID SERVICIO',
        'DESCRIPCION', 'ESTADO'
      ],
      // Columnas aceptadas por el plan aprobado; si faltan, el sistema
      // degrada funcionalidad puntual en vez de fallar por completo.
      // DOC FILE ID: id de Drive del .xlsx ya generado. Sin esta columna,
      // cada regeneración no tiene forma de saber qué archivo actualizar y
      // crea uno nuevo cada vez (duplicados en la carpeta de salida); con
      // ella, doc_generateForQuotation_ sobrescribe el mismo archivo
      // (Drive.Files.update) en vez de crear otro (Drive.Files.insert).
      optional: [
        'REQUEST ID', 'URL DOCUMENTO', 'DOC ESTADO', 'CREADO POR',
        'ACTUALIZADO EN', 'DOC FILE ID',
        // Totales de la cotización (se escriben igual en todas sus filas).
        // Opcionales para no romper la creación ni el dashboard, pero
        // qs_updateQuotation exige que existan (ver qr_requireTarifaCols_).
        'SUBTOTAL', 'IVA', 'TOTAL',
        // Trazabilidad de personal (ver 34_EmpleadoService.js / qs_createQuotation
        // / qs_updateQuotation). ELABORADO POR y CARGO se fijan una sola vez, al
        // crear la cotización (ID EMPLEADO y CARGO de PERSONAL_KGP resueltos por
        // correo del usuario activo) y nunca cambian después. REVISADO Y
        // APROBADO POR se fija una sola vez, cuando la garantía pasa de "En
        // revisión" a Aprobada/Rechazada (mismo criterio que ESTADO, ver
        // CFG().ESTADO_INICIAL). ASESOR COMERCIAL es el único de los 4 editable
        // libremente desde "Gestionar cotización" (selección manual en un
        // desplegable de PERSONAL_KGP).
        'ELABORADO POR', 'CARGO', 'REVISADO Y APROBADO POR', 'ASESOR COMERCIAL',
        // TIEMPO DE ENTREGA: texto libre, editable únicamente desde
        // "Gestionar cotización" (ver ge-tiempo-entrega en ViewGestion.html)
        // — igual que ASESOR COMERCIAL, nunca se llena al crear la
        // cotización (ViewCotizacion.html no tiene este campo, así que
        // qs_createQuotation nunca le pasa un valor y queda en blanco hasta
        // la primera edición). Se escribe también en la plantilla, ver
        // CELLMAP().TIEMPO_ENTREGA.
        'TIEMPO DE ENTREGA'
      ]
    },
    SERVICIOS: {
      required: [
        'ID SERVICIO', 'ID COTIZACION', 'TIPO', 'CODIGO UNSPSC',
        'DESCRIPCION', 'ACTIVIDADES'
      ],
      // Tarifas por servicio (solo se editan en "Gestionar cotización").
      // Mismo criterio que SUBTOTAL/IVA/TOTAL en COTIZACIONES.
      optional: ['TARIFA', 'CANTIDAD', 'TOTAL', 'OBSERVACIONES']
    },
    CLIENTES: {
      required: [
        'ID CLIENTE', 'RAZON SOCIAL', 'TIPO IDENTIFICACION',
        'NUMERO IDENTIFICACION', 'DIRECCION', 'CIUDAD', 'DEPARTAMENTO',
        'PAIS', 'TELEFONO', 'CODIGO CIIU', 'ACTIVIDAD PRINCIPAL',
        'ACTIVO'
      ],
      optional: []
    },
    CONTACTOS_CLIENTES: {
      required: [
        'ID CONTACTO', 'ID CLIENTE', 'NOMBRE', 'TELEFONO', 'CORREO', 'CARGO'
      ],
      // ID ESTABLECIMIENTO: FK opcional al establecimiento del que este
      // contacto es encargado (vacía si el contacto no es encargado de
      // ninguno). Se usa para autoseleccionar el encargado al elegir un
      // establecimiento en las vistas de cotización (ver KGP.ui /
      // Js*.js.html: refreshEncargadoOptions). Opcional para no romper el
      // bootstrap si por algún motivo la columna no está presente.
      optional: ['ID ESTABLECIMIENTO']
    },
    ESTABLECIMIENTOS_CLIENTES: {
      // ID CONTACTO se eliminó de la hoja: el encargado de un establecimiento
      // ahora se rastrea solo desde el otro lado de la relación, con
      // CONTACTOS_CLIENTES.ID ESTABLECIMIENTO (ver con_findEncargadoByEstablecimiento_
      // en 12_ClientRepo.js).
      required: [
        'ID ESTABLECIMIENTO', 'ID CLIENTE', 'NOMBRE',
        'DIRECCION', 'CIUDAD', 'DEPARTAMENTO', 'PAIS'
      ],
      optional: []
    },
    PERSONAL_KGP: {
      required: ['ID EMPLEADO', 'NOMBRE', 'CORREO', 'TELEFONO', 'CARGO'],
      optional: []
    },
    // Una fila por OIS (a diferencia de COTIZACIONES, que tiene una por
    // servicio). Los datos de cliente/servicios NO se duplican aquí: se leen
    // de la cotización padre por ID COTIZACION (ver 35_OisService.js).
    OIS: {
      required: [
        'ID OIS', 'ID COTIZACION', 'FECHA ELABORACION', 'CODIGO', 'PLAZO',
        'FECHA VENCIMIENTO', 'ESTADO'
      ],
      // DOC FILE ID no está en la hoja entregada por el usuario: sin ella,
      // la regeneración saca el id del link de URL DOCUMENTO (mismo fallback
      // que COTIZACIONES, ver doc_fileIdFromCotizacion_), así que sigue
      // actualizando SIEMPRE el mismo archivo (CLAUDE.md §8).
      optional: [
        'REQUEST ID', 'URL DOCUMENTO', 'DOC ESTADO', 'ACTUALIZADO EN',
        'ELABORADO POR', 'ACTUALIZADO POR', 'DOC FILE ID'
      ]
    },
    TAREAS_OIS: {
      required: [
        'ID TAREA', 'ID OIS', 'TAREA', 'RESPONSABLE', 'ID EMPLEADO',
        'FECHA INICIO', 'FECHA ENTREGA', 'ESTADO', 'OBSERVACION'
      ],
      optional: []
    }
  };
}

/**
 * Mapa de celdas de la plantilla de cotización. Ver 31_DocService.js para
 * la lógica de escritura (siempre setValue sobre la celda ancla, nunca
 * setValues sobre un rango, por las celdas combinadas).
 */
function CELLMAP() {
  return {
    FECHA_ANIO: 'A7',
    FECHA_MES: 'B7',
    FECHA_DIA: 'C7',
    CODIGO: 'E7',

    CLIENTE_RAZON_SOCIAL: 'C10',
    CLIENTE_NUMERO_ID: 'C11',
    CLIENTE_DIRECCION: 'C12',
    CLIENTE_CIUDAD_DEPTO_PAIS: 'C13',
    CLIENTE_TELEFONO: 'C14',

    SOLICITANTE_NOMBRE: 'C15',
    SOLICITANTE_CARGO: 'C16',
    SOLICITANTE_TELEFONO: 'C17',
    SOLICITANTE_CORREO: 'C18',

    CLIENTE_CIIU: 'C19',
    CLIENTE_ACTIVIDAD_PRINCIPAL: 'C20',

    COTIZACION_DESCRIPCION: 'A24',

    ESTABLECIMIENTO_NOMBRE: 'C27',
    ESTABLECIMIENTO_DIRECCION: 'C28',
    ESTABLECIMIENTO_CIUDAD_DEPTO_PAIS: 'C29',

    ENCARGADO_NOMBRE: 'C30',
    ENCARGADO_CARGO: 'C31',
    ENCARGADO_TELEFONO: 'C32',
    ENCARGADO_CORREO: 'C33',

    // Bloque de servicios: el Servicio #1 ancla en la fila 39 (tipo/UNSPSC/
    // descripción en A39/B39/C39, actividades desde B42). Cada servicio
    // siguiente repite el mismo layout 18 filas más abajo — confirmado con
    // el usuario celda por celda: #2 en la fila 57, #3 en 75, ... #10 en
    // 201. Ver doc_writeServicioCells_ en 31_DocService.js.
    SERVICIOS_FILA_BASE: 39,
    SERVICIOS_FILA_PASO: 18,
    SERVICIOS_COL_TIPO: 'A',
    SERVICIOS_COL_UNSPSC: 'B',
    SERVICIOS_COL_DESCRIPCION: 'C',
    SERVICIOS_ACT_COL: 'B',
    SERVICIOS_ACT_OFFSET_FILA: 3, // la lista de actividades empieza 3 filas debajo de la fila del servicio
    SERVICIOS_ACT_MAX: 10,

    // Tabla de tarifas: una fila por servicio, sin el paso de 18 filas del
    // bloque de arriba — Servicio #1 en la fila 223, #2 en 224, ... #10 en
    // 232. TOTAL del servicio NO se escribe en la plantilla (solo en BD).
    TARIFAS_FILA_BASE: 223,
    TARIFAS_COL_TARIFA: 'E',
    TARIFAS_COL_CANTIDAD: 'F',
    TARIFAS_COL_OBSERVACIONES: 'H',

    // COTIZACIONES.TIEMPO DE ENTREGA (editable solo desde "Gestionar
    // cotización", ver SCHEMA()) — confirmado con el usuario: celda C216 de
    // la hoja CTZ-V-4. doc_setText_ con '' limpia la celda si el campo se
    // deja vacío en vez de dejar un valor de un guardado anterior.
    TIEMPO_ENTREGA: 'C216',

    // Trazabilidad de personal (ver COTIZACIONES.ELABORADO POR/CARGO/
    // REVISADO Y APROBADO POR/ASESOR COMERCIAL en SCHEMA() y qs_getCotizacion
    // en 30_QuoteService.js) — se escribe el NOMBRE del empleado (no el ID),
    // confirmado celda por celda con el usuario. APROBADO_POR y
    // ASESOR_COMERCIAL quedan vacías hasta que corresponda (garantía sin
    // decidir / sin asesor asignado todavía) — doc_setText_ con '' limpia la
    // celda en vez de dejar un valor viejo tras un "Guardar cambios".
    ELABORADO_POR: 'D260',
    CARGO_ELABORADO_POR: 'D261',
    APROBADO_POR: 'D262',
    ASESOR_COMERCIAL: 'D263',

    // ---- Solo hoja OIS V-4 (CFG().TEMPLATE_TAB_OIS) ----
    // Fila de identificación de la OIS, confirmada con el usuario: código de
    // la cotización padre, código de la OIS, y año/mes/día iguales a
    // A7/B7/C7 (FECHA_ANIO/MES/DIA de arriba).
    OIS_COT_CODIGO: 'A225',
    OIS_CODIGO: 'B225',
    OIS_FECHA_ANIO: 'C225',
    OIS_FECHA_MES: 'D225',
    OIS_FECHA_DIA: 'E225',

    // Tareas: una fila por tarea, #1 en la fila 229 ... #20 en la 248 (sin
    // paso, a diferencia de los servicios). Nunca se escriben en CTZ-V-4.
    OIS_TAREAS_FILA_BASE: 229,
    OIS_TAREAS_COL_TAREA: 'A',
    OIS_TAREAS_COL_RESPONSABLE: 'B',
    OIS_TAREAS_COL_FECHA_INICIO: 'C',
    OIS_TAREAS_COL_FECHA_ENTREGA: 'D',
    OIS_TAREAS_COL_OBSERVACION: 'E'
  };
}
