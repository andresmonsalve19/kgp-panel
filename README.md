# KGP Panel

Panel web interno de **KGP** para gestionar el ciclo comercial y operativo de sus servicios: desde la **cotización** hasta la **orden interna** que la ejecuta (**OIS**, orden interna de servicio, u **OIP**, orden interna de proyectos), con sus tareas, su facturación mensual, sus documentos Excel generados a partir de la plantilla oficial y avisos por correo.

Es una **Web App de Google Apps Script**: no requiere servidores propios ni base de datos externa. Los datos viven en Google Sheets, los documentos en Google Drive y la configuración en hojas `CONFIG_*` editables a mano.

---

## Tabla de contenido

1. [Funcionalidades](#funcionalidades)
2. [Flujos y reglas de negocio](#flujos-y-reglas-de-negocio)
3. [Arquitectura](#arquitectura)
4. [Estructura del repositorio](#estructura-del-repositorio)
5. [Modelo de datos (Google Sheets)](#modelo-de-datos-google-sheets)
6. [Configuración](#configuración)
7. [Correos](#correos)
8. [Seguridad](#seguridad)
9. [Instalación paso a paso](#instalación-paso-a-paso)
10. [Despliegue y actualizaciones](#despliegue-y-actualizaciones)
11. [Funciones de administración](#funciones-de-administración)
12. [Convenciones de desarrollo](#convenciones-de-desarrollo)
13. [Solución de problemas](#solución-de-problemas)

---

## Funcionalidades

| Vista | Qué permite hacer |
|---|---|
| **Crear cotización** | Cliente, solicitante, establecimiento y encargado (con alta/edición rápida en un modal), plazo, descripción y hasta 10 servicios con 10 actividades cada uno. El código UNSPSC se autocompleta. Al guardar se genera el documento `.xlsx`. |
| **Gestionar cotización** | Listado filtrable y detalle: servicios, **tarifas** (tarifa × cantidad), observaciones acumulativas, asesor comercial y tiempo de entrega. Calcula SUBTOTAL, IVA y TOTAL. Botones **"Cotización aprobada"** (crea su OIS u OIP) y **"Cotización rechazada"**. "Guardar cambios" regenera el **mismo** documento. |
| **Gestionar OIS** | Órdenes internas de servicio: tareas (responsable interno o tercero, fechas, observación), plazo y datos compartidos con la cotización. Estado derivado: En curso / Vencida / Finalizada. |
| **Gestionar OIP** | Órdenes internas de proyectos: como la OIS, más la **facturación mensual** (cuota, número de factura, estado) y un recordatorio automático el día 1 de cada mes. Tareas agrupadas por mes de entrega. |
| **Gestionar tareas** | Todas las tareas de OIS y OIP en una sola tabla, con filtros, KPIs y alta/edición/finalización al instante. |
| **Gestión de clientes** | Clientes con sus contactos, establecimientos (y su encargado) e historial de cotizaciones. Borrar solo se permite si ninguna cotización usa el registro. |
| **Gestión de empleados** | Personal interno (`PERSONAL_KGP`) y terceros/independientes (`PERSONAL_TERCEROS`). |
| **Dashboard** | Pestañas Cotizaciones / OIS / OIP: KPIs, gráficas, filtros, tabla y actualización automática. |

## Flujos y reglas de negocio

```
Cotización:  En revisión ──► Aprobada  (crea su OIS u OIP en la MISMA transacción)
                         └─► Rechazada
             La decisión es única; después la cotización solo se edita desde su orden.

OIS / OIP:   En curso ──► Finalizada  (todas sus tareas finalizadas)
                     └─► Vencida     (pasó la fecha de vencimiento sin finalizar)
             Una OIS Finalizada queda de solo lectura; una OIP no (factura ~1 año).
```

| | Cotización | OIS | OIP |
|---|---|---|---|
| Código | `CTZ-KGP-NNN-YY` | `OIS-KGP-NNN-YY` | `OIP-KGP-NNN-YY` |
| ¿NNN reinicia cada año? | Sí | Sí | **No** (consecutivo continuo) |
| Plazo inicial | Formulario (15 días) | El de la cotización | 365 días |
| Tareas en la plantilla | — | 20 filas fijas | Se insertan filas |

Los consecutivos se reservan dentro de un lock (dos usuarios nunca obtienen el mismo número) y una marca de agua en las Propiedades del script evita reutilizar números si se borra una fila a mano.

## Arquitectura

```
┌───────────────────────────── Navegador ──────────────────────────────┐
│  SPA (HTML + CSS + JS vanilla) servida por HtmlService               │
│  ui/Index.html → Sidebar + 8 vistas + módulos compartidos KGP.*      │
│  window.KGP_CONFIG (parámetros de la config, inyectados por doGet)   │
│  Caché local stale-while-revalidate (localStorage)                   │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ google.script.run → api_*()
                                │ respuesta {ok, data, error, meta}
┌───────────────────────────────▼──────────────────────────────────────┐
│  Google Apps Script (V8)                                             │
│  5x  Web y admin   → doGet, api_* (safeCall_), admin_* (protegidas)  │
│  3x/4x Servicios   → reglas de negocio, transacciones (tx_conLock_)  │
│  2x  IDs/validación→ consecutivos, IDs internos, payloads            │
│  1x  Repositorios  → una hoja cada uno, lectura memoizada            │
│  0x  Base          → CFG_(), respuestas, utilidades, caché, correo,  │
│                      configuración desde hojas, transacciones        │
└──────┬─────────────────────────────┬──────────────────────┬──────────┘
       │ SpreadsheetApp              │ Drive API v2         │ CacheService / ScriptProperties /
       ▼                             ▼                      ▼ LockService / MailApp
  Google Sheets (BD, catálogo,   Google Drive (plantilla,   Caché entre requests, consecutivos,
  configuración, historial)      documentos y carpetas)     versión de datos, correos
```

### Decisiones clave

- **Contrato único de API**: toda `api_*` responde `{ok, data, error, meta}` a través de `safeCall_`; ninguna excepción llega cruda al navegador y los errores quedan en la hoja `_ERRORES`.
- **Transacciones cortas** (`tx_conLock_`, `07_Transaccion.js`): validar + escribir en las hojas dentro del script lock, con `flush` y `bumpDataVersion_` antes de soltarlo. Los documentos y los correos van **después**, fuera del lock.
- **Idempotencia**: crear una cotización, aprobarla o generar su documento usa un `requestId` del navegador; un reintento nunca duplica nada.
- **Columnas por nombre, nunca por índice** (`normText_`): el orden de columnas del Sheet puede cambiar. `SCHEMA_()` separa columnas requeridas y opcionales.
- **Rendimiento**:
  - Una sola lectura por hoja y por ejecución (`repo_readTable_`); las escrituras actualizan esa copia en memoria en vez de obligar a releer la hoja, y agrupan las columnas contiguas en un solo `setValues`.
  - `CFG_()` se construye una vez por ejecución; `normText_` está memoizada.
  - Cachés entre peticiones invalidadas por **versión de datos** (`dataVersion_`).
  - Documentos: el formato de texto y el vaciado de celdas van en lote (`RangeList`), la mitad de llamadas que celda por celda.
  - Sin escaneos de hojas completas en la carga de la página (el código tentativo sale de la marca de agua).
- **OIS y OIP comparten código** (`41_OrdenComun.js`): un adaptador `ord_spec_(tipo)` declara lo que las distingue; los archivos de cada orden solo exponen sus funciones públicas.
- **Documentos**: la plantilla `.xlsx` se convierte una vez a Google Sheet nativo; cada documento se genera sobre una copia temporal y al editar se **sobrescribe el mismo archivo** (nunca se crean duplicados).
- **Frontend sin frameworks**: módulos compartidos en `ui/JsCore.js.html` (`KGP.apiCall`, `KGP.catalog`, `KGP.ui`, `KGP.entityModal`, `KGP.servicioModal`, `KGP.tareaModal`, `KGP.localCache`, `KGP.nav`, `KGP.cfg`).

## Estructura del repositorio

```
kgp-panel/
├── .clasp.json / .claspignore   # Vínculo con Apps Script (rootDir: src) y qué se sube
├── .gitattributes               # Finales de línea LF
├── CLAUDE.md                    # Reglas de trabajo y decisiones de diseño detalladas
├── .claude/skills/, .agents/skills/, skills-lock.json   # Skills de IA versionadas
├── assets/
│   ├── LOGO KGP.png
│   └── Plantilla Correo KGP (standalone).html   # Diseño fuente de los correos
└── src/
    ├── appsscript.json          # Manifiesto: zona horaria, scopes, Drive API v2, webapp
    ├── 00_Config.js             # CFG_(), SCHEMA_(), CELLMAP_() (valores por defecto)
    ├── 01_Result.js             # ok_, fail_, safeCall_
    ├── 02_Utils.js              # Texto, fechas y helpers
    ├── 03_Cache.js              # CacheService en trozos + versión de datos
    ├── 04_MailTemplate.js       # Plantilla única de correo, textos, historial
    ├── 05_MailAssets.js         # Imágenes del correo en base64 (archivo generado)
    ├── 06_ConfigSheet.js        # Lectura/creación de las hojas CONFIG_*
    ├── 07_Transaccion.js        # tx_conLock_: sección crítica común
    ├── 10_SheetRepo.js          # Acceso genérico a hojas por encabezado
    ├── 11_CatalogRepo.js        # TIPOS DE SERVICIOS (tipo ↔ UNSPSC)
    ├── 12_ClientRepo.js         # Clientes, contactos, establecimientos
    ├── 13_QuoteRepo.js          # COTIZACIONES y SERVICIOS
    ├── 14_EmpleadoRepo.js       # PERSONAL_KGP y PERSONAL_TERCEROS
    ├── 15_OisRepo.js            # OIS y TAREAS_OIS
    ├── 16_OipRepo.js            # OIP, TAREAS_OIP y OIP_FACTURACION
    ├── 20_Ids.js                # IDs internos y consecutivos
    ├── 21_Validation.js         # Validación de payloads
    ├── 30_QuoteService.js       # Cotizaciones y altas rápidas
    ├── 31_DocService.js         # Generación de documentos .xlsx
    ├── 32_DashboardService.js   # Snapshots del Dashboard
    ├── 33_ErrorLog.js           # Hoja _ERRORES
    ├── 34_EmpleadoService.js    # CRUD de empleados
    ├── 35_OisService.js         # API de la OIS
    ├── 36_OipService.js         # API de la OIP + facturación
    ├── 37_OipNotify.js          # Recordatorio mensual de facturación
    ├── 38_TareaService.js       # Gestionar tareas
    ├── 39_NotifyService.js      # Cuándo y a quién se envía cada correo
    ├── 40_ClienteService.js     # Gestión de clientes (listado, detalle, bajas)
    ├── 41_OrdenComun.js         # Lógica común de OIS y OIP
    ├── 50_WebApp.js             # doGet, include, endpoints api_*
    ├── 51_Admin.js              # Funciones admin_* (solo desde el editor)
    ├── otherFunctions.js        # Respaldo literal del Code.js original (no se usa ni se modifica)
    └── ui/
        ├── Index.html, Sidebar.html, Styles.css.html, JsCore.js.html
        ├── ViewCotizacion / JsCotizacion     ├── ViewGestion  / JsGestion
        ├── ViewOis        / JsOis            ├── ViewOip      / JsOip
        ├── ViewTareas     / JsTareas         ├── ViewClientes / JsClientes
        ├── ViewEmpleados  / JsEmpleados
        └── ViewDashboard  / JsDashboard + JsDashboardOrdenes
```

Prefijos de funciones (Apps Script tiene un namespace global plano): `repo_`, `cat_`, `cli_`/`con_`/`est_`, `qr_`, `emp_`, `ois_`/`tar_`, `oip_`/`tarp_`/`fac_` (repos); `id_`, `code_`, `validate*_` ; `qs_`, `doc_`, `ds_`, `emps_`, `ord_`, `tg_`, `ntf_`, `oipn_`, `clis_` (servicios); `mail_`, `cfgs_`, `tx_` (base); `api_*`, `admin_*`. Las funciones privadas terminan en `_`.

## Modelo de datos (Google Sheets)

Base de datos (`DB_SHEET_ID`). Los nombres de columna se buscan sin importar tildes ni mayúsculas; las opcionales degradan funcionalidad puntual si faltan.

| Hoja | Una fila por… | Columnas requeridas | Opcionales |
|---|---|---|---|
| `COTIZACIONES` | servicio de una cotización | ID COTIZACION, CODIGO, FECHA ELABORACION, PLAZO, FECHA VENCIMIENTO, ID CLIENTE, ID SOLICITANTE, ID ESTABLECIMIENTO, NUMERO SERVICIO, ID SERVICIO, DESCRIPCION, ESTADO | REQUEST ID, URL DOCUMENTO, DOC ESTADO, CREADO POR, ACTUALIZADO EN, DOC FILE ID, SUBTOTAL, IVA, TOTAL, ELABORADO POR, CARGO, REVISADO Y APROBADO POR, ASESOR COMERCIAL, TIEMPO DE ENTREGA |
| `SERVICIOS` | servicio | ID SERVICIO, ID COTIZACION, TIPO, CODIGO UNSPSC, DESCRIPCION, ACTIVIDADES | TARIFA, CANTIDAD, TOTAL, OBSERVACIONES |
| `CLIENTES` | cliente | ID CLIENTE, RAZON SOCIAL, TIPO IDENTIFICACION, NUMERO IDENTIFICACION, DIRECCION, CIUDAD, DEPARTAMENTO, PAIS, TELEFONO, CODIGO CIIU, ACTIVIDAD PRINCIPAL, ACTIVO | — |
| `CONTACTOS_CLIENTES` | contacto | ID CONTACTO, ID CLIENTE, NOMBRE, TELEFONO, CORREO, CARGO | ID ESTABLECIMIENTO (encargado) |
| `ESTABLECIMIENTOS_CLIENTES` | establecimiento | ID ESTABLECIMIENTO, ID CLIENTE, NOMBRE, DIRECCION, CIUDAD, DEPARTAMENTO, PAIS | — |
| `PERSONAL_KGP` / `PERSONAL_TERCEROS` | persona | ID EMPLEADO, NOMBRE, CORREO, TELEFONO, CARGO | CEDULA |
| `OIS` / `OIP` | orden | ID OIS / ID OIP, ID COTIZACION, FECHA ELABORACION, CODIGO, PLAZO, FECHA VENCIMIENTO, ESTADO | REQUEST ID, URL DOCUMENTO, DOC ESTADO, ACTUALIZADO EN, ELABORADO POR, ACTUALIZADO POR, DOC FILE ID |
| `TAREAS_OIS` / `TAREAS_OIP` | tarea | ID TAREA, ID OIS / ID OIP, TAREA, RESPONSABLE, ID EMPLEADO, FECHA INICIO, FECHA ENTREGA, ESTADO, OBSERVACION | TIPO RESPONSABLE |
| `OIP_FACTURACION` | mes facturado | ID FACTURACION OIP, ID OIP, MES, YEAR, CUOTA, NUMERO FACTURA, ESTADO | FECHA NOTIFICACION |
| `_ERRORES` | error | *(se crea sola)* | — |

Otros spreadsheets: el de **catálogo y configuración** (`TIPOS DE SERVICIOS`: columna A = tipo, B = UNSPSC, misma fila; y las hojas `CONFIG_*`) y el de **historial de correos** (pestaña `HISTORIAL`).

```
CLIENTES 1───* CONTACTOS_CLIENTES
CLIENTES 1───* ESTABLECIMIENTOS_CLIENTES 1───0..1 CONTACTOS_CLIENTES (encargado)
COTIZACIONES (por ID COTIZACION) 1───* SERVICIOS
COTIZACIONES 1───0..1 (OIS | OIP) 1───* TAREAS_*      OIP 1───* OIP_FACTURACION
PERSONAL_KGP / PERSONAL_TERCEROS ──► responsables de tareas y trazabilidad
```

## Configuración

**Nada se configura editando el código.** Todo parámetro tiene un valor por defecto en `CFG_()` / `CELLMAP_()` / `mail_textosDefault_()` y se puede sobrescribir en las hojas del spreadsheet de catálogo:

| Hoja | Contenido |
|---|---|
| `CONFIG_LEEME` | Instrucciones de edición. |
| `CONFIG_IDS` | IDs de spreadsheets, carpetas y archivos (con enlace). |
| `CONFIG_HOJAS` | Nombres de las pestañas. |
| `CONFIG_GENERAL` | Plazos, IVA, límites, días "por vencer", prefijos de IDs y códigos, Dashboard, caché. |
| `CONFIG_CORREO` | Destinatarios, remitente, firma y pie de los correos. |
| `CONFIG_CORREO_TEXTOS` | Asunto, título, párrafos, botón y datos destacados de cada correo. |
| `CONFIG_CELDAS` | Mapa de celdas de la plantilla. |

- Se leen **en cada carga de la página** y se guardan en caché para el resto de la sesión.
- Una celda vacía o un valor que no se puede interpretar se ignora (queda el valor del código): la app nunca se cae por la configuración. `admin_verConfig()` lista lo que se ignoró.
- `admin_crearHojasConfig()` crea las hojas y agrega las filas de parámetros nuevos **sin tocar los valores ya escritos**.

Propiedades del script (automáticas): `TEMPLATE_SHEET_ID`, `TEMPLATE_TAB_*`, marcas de agua `SEQ_YY` / `SEQ_OIS_YY` / `SEQ_OIP`, `DATA_VERSION`, `OIP_NOTIF_LAST`, `NTF_PEND_*`.

## Correos

Todos usan **una sola plantilla** (`src/04_MailTemplate.js`, diseño de `assets/Plantilla Correo KGP (standalone).html`) y se registran en la hoja `HISTORIAL`.

| Correo | Cuándo | A quién |
|---|---|---|
| Cotización creada | Al generarse su documento | Quien la creó |
| Cotización aprobada | Al generarse el documento de su OIS/OIP | Quien la creó |
| Cotización rechazada | Al rechazarla | Quien la creó |
| Tarea asignada | Al crear una tarea | Su responsable (interno o tercero) |
| Recordatorio de facturación OIP | Día 1 de cada mes | `OIP_NOTIF_EMAIL` |

Un correo que falla nunca rompe la operación que lo disparó; queda en `_ERRORES`. Para ver cómo se ven: `admin_probarCorreos('correo@dominio.com')`.

## Seguridad

- La web app se ejecuta como el propietario (`executeAs: USER_DEPLOYING`). `google.script.run` puede invocar cualquier función global que **no** termine en `_`, por eso:
  - la configuración (`CFG_`, `SCHEMA_`, `CELLMAP_`) y toda la lógica interna son privadas;
  - las `admin_*` solo corren si quien las ejecuta es la cuenta dueña del proyecto (`admin_soloEditor_`), es decir, desde el editor;
  - el navegador solo recibe los parámetros numéricos/etiquetas que necesita (`cfgs_clientConfig_`), nunca IDs ni correos de configuración.
- Todo texto que llega del servidor se escapa antes de insertarse en el HTML (`KGP.escapeHtml`) y en los correos (`mail_esc_`).
- El acceso a la URL lo define la implementación (`ANYONE` en el manifiesto). Si la cuenta es de Google Workspace, se recomienda restringirlo al dominio.

## Instalación paso a paso

### Requisitos

- Cuenta de Google con acceso de edición a los spreadsheets (BD, catálogo/configuración, historial), la plantilla `.xlsx` (pestañas `CTZ-V-4`, `OIS V-4`, `OIP V-4`) y las carpetas de salida.
- [Node.js](https://nodejs.org/) 18+, [clasp](https://github.com/google/clasp) y Git.

### Pasos

```bash
git clone https://github.com/andresmonsalve19/kgp-panel.git
cd kgp-panel
npm install -g @google/clasp
clasp login            # y activar la Apps Script API en https://script.google.com/home/usersettings
clasp push --force
```

`.clasp.json` ya apunta al proyecto existente; para un entorno nuevo: `clasp create --type standalone --title "KGP Panel" --rootDir src`.

Luego, desde el editor de Apps Script (**Ejecutar → seleccionar función**):

1. `admin_convertTemplate()` — convierte la plantilla a Google Sheet nativo (una vez).
2. `admin_crearHojasConfig()` — crea las hojas `CONFIG_*`; ajusta allí los IDs de la BD, carpetas, etc.
3. `admin_health()` — verifica hojas, columnas y pestañas de la plantilla.
4. `admin_installOipFacturacionTrigger()` — instala el recordatorio mensual de la OIP.
5. **Implementar → Nueva implementación → Aplicación web** (Ejecutar como: Yo).
6. En **Gestión de empleados**, registra al personal con el mismo correo con el que inicia sesión en Google (así se llena "Elaborado por").

## Despliegue y actualizaciones

```bash
clasp push --force
```

- `/dev` refleja los cambios **al instante** (solo editores del script).
- `/exec` (producción) **no cambia** hasta publicar: **Implementar → Administrar implementaciones → editar → Versión: "Nueva versión" → Implementar**.

## Funciones de administración

Solo desde el editor de Apps Script, con la cuenta dueña del proyecto. Dejan su resumen en **Ver → Registros**.

| Función | Uso |
|---|---|
| `admin_convertTemplate()` | Convierte la plantilla `.xlsx` a Sheet nativo (no duplica si ya existe). |
| `admin_smokeTestTemplate()` | Genera un documento vacío para validar visualmente la plantilla. |
| `admin_health()` | Diagnóstico de hojas, columnas, catálogo y plantilla. |
| `admin_setTemplateTabName / admin_setOisTabName / admin_setOipTabName(nombre)` | Fijan la pestaña de la plantilla de cada documento. |
| `admin_crearHojasConfig()` | Crea/completa las hojas `CONFIG_*` sin pisar valores. |
| `admin_verConfig()` | Configuración efectiva y lo que se ignoró. |
| `admin_probarCorreos(destino)` | Envía un ejemplo de cada correo. |
| `admin_installOipFacturacionTrigger()` / `admin_listTriggers()` | Instala / lista el recordatorio mensual. |
| `admin_probarRecordatorioOip()` | Corre el recordatorio ya (crea filas y envía el correo de verdad). |
| `admin_dumpSample()` | 3 filas reales por hoja para verificar el mapeo de columnas. |
| `admin_cleanTempFiles()` | Borra temporales `__TMP_*` huérfanos de más de 24 h. |
| `admin_clearCaches()` | Invalida las cachés y relee la configuración. |

## Convenciones de desarrollo

Las reglas completas están en [CLAUDE.md](CLAUDE.md). Las principales:

- **Nunca un valor quemado en el código**: todo parámetro va a `CFG_()`/`CELLMAP_()` y a su fila en `cfgs_catalogo_()`; el navegador lo lee con `KGP.cfg`.
- **Cero código ejecutable a nivel top-level** en el servidor (solo constantes literales).
- **No tocar `src/otherFunctions.js`** ni reutilizar sus nombres.
- **Columnas por nombre normalizado** (`normText_`), nunca por índice.
- **Escrituras dentro de `tx_conLock_`**; documentos y correos fuera del lock.
- **Toda `api_*` pasa por `safeCall_`**; las funciones internas terminan en `_`.
- **Reutilizar los módulos `KGP.*`** antes de escribir un modal, un select o una llamada nueva.
- **Correos**: siempre con `mail_enviar_` y textos en `mail_textosDefault_`.
- **Menú lateral**: Dashboard siempre de último.
- **Antes de subir**: `node --check` de cada `.js` y de los `<script>` de los `.html`, y `clasp push --force`.

### Skills de IA incluidas

`.claude/skills/` (las lee Claude Code), `.agents/skills/` (mismo contenido para el CLI `skills`) y `skills-lock.json` (origen y hash). Son copias reales, no enlaces simbólicos.

## Solución de problemas

| Síntoma | Causa probable / solución |
|---|---|
| "La plantilla del documento aún no se ha preparado" | Falta `admin_convertTemplate()`. |
| `DOC ESTADO = ERROR` | Revisa `_ERRORES`; "Guardar cambios" (o "Regenerar") reintenta sobre el mismo archivo. |
| "El sistema está ocupado" | Otro usuario tiene el lock de escritura (máx. 30 s). Reintenta. |
| Errores de esquema / columnas faltantes | `admin_health()` y agregar las columnas indicadas. |
| Cambios hechos a mano en el Sheet no se ven | Recarga la página (F5). Si persiste, `admin_clearCaches()`. |
| Un cambio en `CONFIG_*` no se aplica | Recarga la página; `admin_verConfig()` dice si el valor se ignoró. |
| Los cambios de código no se ven en `/exec` | Publica una **Nueva versión** de la implementación. |
| "Elaborado por" vacío o no llega el correo al creador | El correo del usuario no está en **Gestión de empleados**, o Google no expone el correo de usuarios externos al dominio. |
| Una función `admin_*` dice que solo se ejecuta desde el editor | Ejecútala desde el editor de Apps Script con la cuenta dueña del proyecto. |

---

**Stack:** Google Apps Script (V8) · HtmlService · Google Sheets · Google Drive API v2 · CacheService / PropertiesService / LockService · MailApp · HTML/CSS/JavaScript vanilla · clasp
