# KGP Panel

Panel web interno de **KGP** para gestionar el ciclo comercial y operativo de sus servicios: desde la **cotización** hasta la **orden interna de servicio (OIS)**, con generación automática de documentos Excel a partir de la plantilla oficial de la empresa.

Está construido como una **Web App de Google Apps Script**: no requiere servidores propios ni base de datos externa. Los datos viven en Google Sheets y los documentos generados en Google Drive.

---

## Tabla de contenido

1. [¿De qué se trata?](#de-qué-se-trata)
2. [Funcionalidades](#funcionalidades)
3. [Cómo se usa (guía de usuario)](#cómo-se-usa-guía-de-usuario)
4. [Arquitectura](#arquitectura)
5. [Estructura del repositorio](#estructura-del-repositorio)
6. [Modelo de datos (Google Sheets)](#modelo-de-datos-google-sheets)
7. [Instalación paso a paso](#instalación-paso-a-paso)
8. [Despliegue y actualizaciones](#despliegue-y-actualizaciones)
9. [Funciones de administración](#funciones-de-administración)
10. [Configuración](#configuración)
11. [Convenciones de desarrollo](#convenciones-de-desarrollo)
12. [Solución de problemas](#solución-de-problemas)

---

## ¿De qué se trata?

Antes de este panel, las cotizaciones se armaban a mano sobre una plantilla de Excel y se registraban por separado en una hoja de cálculo. KGP Panel une ambos pasos:

- El usuario llena un **formulario web** (cliente, solicitante, establecimiento, servicios y actividades).
- El sistema **reserva un consecutivo** (`CTZ-KGP-001-26`), guarda todo en la base de datos (Google Sheets) y **genera el documento `.xlsx`** de la cotización en Drive, con todas las celdas de la plantilla oficial llenas.
- Luego la cotización se **gestiona** (tarifas, totales con IVA, asesor comercial, tiempo de entrega) y se **aprueba o rechaza** la garantía.
- Una cotización aprobada genera su **OIS** (`OIS-KGP-001-26`), donde se planifican y siguen las tareas de ejecución del servicio, con su propio documento.
- Un **dashboard** muestra el estado de todas las cotizaciones en tiempo real.

## Funcionalidades

| Vista | Qué permite hacer |
|---|---|
| **Crear cotización** | Formulario de nueva cotización. Selección de cliente, solicitante (contacto), establecimiento y su encargado, con alta/edición rápida de cualquiera de ellos en un modal sin salir del formulario. Hasta **10 servicios** por cotización, cada uno con hasta **10 actividades**. El código UNSPSC se autocompleta según el tipo de servicio. Al guardar se genera el documento. |
| **Gestionar cotización** | Listado filtrable/paginado de cotizaciones y vista de detalle para editar datos generales, servicios, **tarifas** (tarifa × cantidad), observaciones acumulativas, asesor comercial y tiempo de entrega. Calcula **SUBTOTAL, IVA (19 %) y TOTAL**. Botones **"Garantía aprobada" / "Garantía rechazada"** para decidir el estado (una sola vez). "Guardar cambios" regenera el **mismo** documento. |
| **Gestionar OIS** | Listado y detalle de las órdenes internas de servicio. Gestión de tareas (responsable, fechas, observación, marcar como finalizada), plazo y datos compartidos con la cotización. El estado de la OIS se deriva solo: **En curso / Vencida / Finalizada**. |
| **Gestión de empleados** | Alta, edición y baja del personal de KGP (`PERSONAL_KGP`). Se usa para trazabilidad ("Elaborado por", "Revisado y aprobado por", "Asesor comercial") y como responsables de tareas de OIS. |
| **Dashboard** | KPIs, gráficos (distribución por estado, evolución mensual, vigencia, tipos de servicio), tabla con búsqueda, filtros por año/cliente/estado, ordenamiento y paginación, y panel de calidad de datos. |

### Flujo de estados

```
Cotización:  En revisión ──► Aprobada  (crea su OIS en la misma transacción)
                         └─► Rechazada
             (la decisión se toma una sola vez; después la cotización queda bloqueada
              en "Gestionar cotización" y solo se edita a través de su OIS)

OIS:         En curso ──► Finalizada  (todas sus tareas finalizadas)
                     └─► Vencida     (pasó la fecha de vencimiento sin finalizar)
```

### Consecutivos

- Cotizaciones: `CTZ-KGP-NNN-YY` (ej. `CTZ-KGP-014-26`).
- OIS: `OIS-KGP-NNN-YY`.
- `NNN` reinicia en `001` cada año; `YY` son los dos últimos dígitos del año de elaboración. La reserva ocurre dentro de un lock, así que dos usuarios simultáneos nunca obtienen el mismo número.

## Cómo se usa (guía de usuario)

1. Abre la URL de la Web App (la entrega el administrador). Si es la primera vez, Google pedirá iniciar sesión.
2. **Crear una cotización**
   1. En el menú lateral, entra a **Crear cotización**.
   2. Elige el **cliente**. Si no existe, usa el botón **+** para crearlo en el modal. Lo mismo aplica para el solicitante, el establecimiento y el encargado.
   3. Ajusta el **plazo** (días de vigencia) y escribe la **descripción** de la cotización.
   4. Agrega los **servicios**: tipo de servicio (el UNSPSC se llena solo), descripción y sus actividades.
   5. Pulsa **Guardar**. Se muestra un resumen con el código asignado y el enlace al documento `.xlsx` generado en Drive.
3. **Gestionar la cotización**
   1. Entra a **Gestionar cotización** y haz clic en la fila de la cotización.
   2. Completa **tarifas y cantidades** por servicio, asesor comercial y tiempo de entrega. El resumen muestra el subtotal, IVA y total en vivo.
   3. Pulsa **Guardar cambios**: se actualiza la base de datos y se regenera el documento sobre el mismo archivo (el enlace no cambia).
   4. Cuando el cliente responda, usa **Garantía aprobada** (y elige **OIS**) o **Garantía rechazada**.
4. **Ejecutar la OIS**
   1. Entra a **Gestionar OIS** y abre la orden.
   2. Agrega tareas (hasta 20), asigna responsables y fechas, y márcalas como finalizadas a medida que avanza el trabajo.
   3. Cuando todas las tareas estén finalizadas, la OIS pasa sola a **Finalizada** y queda de solo lectura.
5. **Seguimiento**: el **Dashboard** muestra el panorama general. El botón **Actualizar** trae los datos más recientes.

> En móvil (≤ 760 px) la interfaz se adapta y centra todo el contenido.

## Arquitectura

```
┌───────────────────────────── Navegador ──────────────────────────────┐
│  SPA (HTML + CSS + JS vanilla) servida por HtmlService               │
│  ui/Index.html → Sidebar + vistas (Cotizacion, Gestion, Ois,         │
│  Empleados, Dashboard) + módulos compartidos KGP.* (JsCore)          │
│  Caché local stale-while-revalidate (localStorage)                   │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ google.script.run → api_*()
                                │ respuesta {ok, data, error, meta}
┌───────────────────────────────▼──────────────────────────────────────┐
│  Google Apps Script (V8)                                             │
│  50_WebApp   → doGet + endpoints api_* (envueltos en safeCall_)      │
│  3x_*Service → reglas de negocio, locks, orquestación                │
│  2x_*        → consecutivos, IDs, validación                         │
│  1x_*Repo    → acceso a hojas (lectura memoizada por ejecución)      │
│  0x_*        → config, Result, utilidades, caché                     │
└──────┬─────────────────────────────┬──────────────────────┬──────────┘
       │ SpreadsheetApp              │ Drive API v2         │ CacheService /
       ▼                             ▼                      ▼ ScriptProperties
  Google Sheets (BD +          Google Drive (plantilla,   Caché entre requests,
  catálogo de servicios)       documentos .xlsx de        marcas de agua de
                               cotizaciones y OIS)        consecutivos, versión de datos
```

### Capas del servidor

Apps Script comparte un **namespace global plano** (sin `import`/`export`), así que el orden y los prefijos de nombre hacen el trabajo de los módulos:

| Prefijo de archivo | Capa | Prefijo de funciones |
|---|---|---|
| `00`–`03` | Base: configuración (`CFG()`, `SCHEMA()`, `CELLMAP()`), contrato de respuesta, utilidades, caché | `ok_`, `fail_`, `safeCall_`, `normText_`, `dataVersion_` |
| `10`–`15` | Repositorios: lectura/escritura de cada hoja | `repo_`, `cat_`, `cli_`, `con_`, `est_`, `qr_`, `emp_`, `ois_`, `tar_` |
| `20`–`21` | IDs, consecutivos y validación de payloads | `id_`, `code_`, `validate*_` |
| `30`–`35` | Servicios de negocio: cotizaciones, documentos, dashboard, errores, empleados, OIS | `qs_`, `doc_`, `ds_`, `logError_`, `emps_`, `ois_` |
| `50` | Punto de entrada web y API pública | `doGet`, `include`, `api_*` |
| `51` | Administración (se ejecuta desde el editor) | `admin_*` |

### Decisiones clave

- **Contrato único de API**: toda función `api_*` responde `{ok, data, error, meta}` a través de `safeCall_`, que captura cualquier excepción, la registra en la hoja `_ERRORES` y nunca la deja llegar cruda al cliente.
- **Escritura en dos fases**: la fase 1 (validación, reserva de consecutivo y appends a las hojas) ocurre dentro de un `LockService.getScriptLock()` corto. La generación del documento Excel es una fase 2 separada, fuera del lock, para no bloquear a otros usuarios.
- **Idempotencia**: la creación usa un `requestId` generado en el cliente para que un reintento no duplique la cotización ni el documento.
- **Columnas por nombre, nunca por índice**: los encabezados se normalizan (sin tildes, mayúsculas, espacios colapsados) y se resuelven por nombre, así el orden de columnas del Sheet puede cambiar sin romper nada. `SCHEMA()` separa columnas **requeridas** y **opcionales**.
- **Rendimiento**:
  - Una sola lectura por hoja por ejecución (`repo_readTable_` memoiza por `ssId + tabName`).
  - Cachés entre requests invalidadas por **versión de datos** (`dataVersion_()` / `bumpDataVersion_()`), que se incrementa en cada escritura y en cada recarga de página.
  - El catálogo `TIPOS DE SERVICIOS` se lee **sin caché** a propósito: una fila nueva debe verse de inmediato.
  - `api_bootstrap` concentra en un solo round-trip todo lo que necesita el formulario (catálogo, clientes, empleados, código tentativo).
- **Documentos**: la plantilla `.xlsx` se convierte una vez a Google Sheet nativo; cada documento se genera copiando esa plantilla, escribiendo celda por celda según `CELLMAP()` y exportando a `.xlsx`. Al editar, se **sobrescribe el mismo archivo** (`Drive.Files.update`), nunca se crean duplicados.
- **Frontend sin frameworks**: JS vanilla organizado en módulos compartidos (`KGP.catalog`, `KGP.ui`, `KGP.entityModal`, `KGP.servicioModal`, `KGP.localCache`, `KGP.nav`) definidos en `ui/JsCore.js.html`.
- **Stale-while-revalidate**: Dashboard y "Gestionar cotización" pintan de inmediato la última versión guardada en `localStorage` y en paralelo piden los datos frescos al servidor. El detalle de edición **nunca** usa caché.

## Estructura del repositorio

```
kgp-panel/
├── .clasp.json            # Vincula el proyecto local con el script de Apps Script (rootDir: src)
├── .claspignore           # Solo se suben .js, .html y appsscript.json
├── CLAUDE.md              # Reglas de trabajo y decisiones de diseño detalladas
├── .claude/skills/        # Skills de Claude Code (copias reales, listas al clonar)
├── .agents/skills/        # Las mismas skills en formato del CLI `skills`
├── skills-lock.json       # Origen y hash de cada skill
├── assets/
│   └── LOGO KGP.png
└── src/
    ├── appsscript.json        # Manifiesto: zona horaria, scopes OAuth, Drive API v2, config de webapp
    ├── 00_Config.js           # CFG(), SCHEMA(), CELLMAP()
    ├── 01_Result.js           # ok_, fail_, safeCall_
    ├── 02_Utils.js            # Normalización de texto, fechas, helpers
    ├── 03_Cache.js            # dataVersion_, helpers de CacheService
    ├── 10_SheetRepo.js        # Lectura/escritura genérica de hojas por encabezado
    ├── 11_CatalogRepo.js      # Catálogo TIPOS DE SERVICIOS (tipo ↔ UNSPSC)
    ├── 12_ClientRepo.js       # Clientes, contactos, establecimientos
    ├── 13_QuoteRepo.js        # COTIZACIONES y SERVICIOS
    ├── 14_EmpleadoRepo.js     # PERSONAL_KGP
    ├── 15_OisRepo.js          # OIS y TAREAS_OIS
    ├── 20_Ids.js              # IDs internos y consecutivos CTZ/OIS
    ├── 21_Validation.js       # Validación de payloads
    ├── 30_QuoteService.js     # Crear/editar cotizaciones, altas rápidas, estados
    ├── 31_DocService.js       # Generación/regeneración de documentos .xlsx
    ├── 32_DashboardService.js # Snapshot y consultas del dashboard
    ├── 33_ErrorLog.js         # Registro en la hoja _ERRORES
    ├── 34_EmpleadoService.js  # CRUD de empleados
    ├── 35_OisService.js       # Aprobación con OIS, tareas, estado derivado
    ├── 50_WebApp.js           # doGet, include, endpoints api_*
    ├── 51_Admin.js            # Funciones admin_* para el editor
    ├── otherFunctions.js      # Respaldo literal del Code.js original (no se usa ni se modifica)
    └── ui/
        ├── Index.html             # Shell de la SPA + loader de pantalla completa
        ├── Sidebar.html           # Menú lateral
        ├── Styles.css.html        # Estilos (paleta blanco + verde oliva, responsive)
        ├── JsCore.js.html         # Módulos compartidos KGP.*
        ├── ViewCotizacion.html / JsCotizacion.js.html
        ├── ViewGestion.html    / JsGestion.js.html
        ├── ViewOis.html        / JsOis.js.html
        ├── ViewEmpleados.html  / JsEmpleados.js.html
        └── ViewDashboard.html  / JsDashboard.js.html
```

## Modelo de datos (Google Sheets)

La base de datos es un spreadsheet (`CFG().DB_SHEET_ID`) con estas pestañas. Los nombres de columna son los que el sistema busca (sin importar tildes ni mayúsculas); las marcadas como *opcionales* degradan funcionalidad puntual si faltan.

| Hoja | Una fila por… | Columnas requeridas | Opcionales |
|---|---|---|---|
| `COTIZACIONES` | servicio de una cotización | ID COTIZACION, CODIGO, FECHA ELABORACION, PLAZO, FECHA VENCIMIENTO, ID CLIENTE, ID SOLICITANTE, ID ESTABLECIMIENTO, NUMERO SERVICIO, ID SERVICIO, DESCRIPCION, ESTADO | REQUEST ID, URL DOCUMENTO, DOC ESTADO, CREADO POR, ACTUALIZADO EN, DOC FILE ID, SUBTOTAL, IVA, TOTAL, ELABORADO POR, CARGO, REVISADO Y APROBADO POR, ASESOR COMERCIAL, TIEMPO DE ENTREGA |
| `SERVICIOS` | servicio | ID SERVICIO, ID COTIZACION, TIPO, CODIGO UNSPSC, DESCRIPCION, ACTIVIDADES | TARIFA, CANTIDAD, TOTAL, OBSERVACIONES |
| `CLIENTES` | cliente | ID CLIENTE, RAZON SOCIAL, TIPO IDENTIFICACION, NUMERO IDENTIFICACION, DIRECCION, CIUDAD, DEPARTAMENTO, PAIS, TELEFONO, CODIGO CIIU, ACTIVIDAD PRINCIPAL, ACTIVO | — |
| `CONTACTOS_CLIENTES` | contacto | ID CONTACTO, ID CLIENTE, NOMBRE, TELEFONO, CORREO, CARGO | ID ESTABLECIMIENTO |
| `ESTABLECIMIENTOS_CLIENTES` | establecimiento | ID ESTABLECIMIENTO, ID CLIENTE, NOMBRE, DIRECCION, CIUDAD, DEPARTAMENTO, PAIS | — |
| `PERSONAL_KGP` | empleado | ID EMPLEADO, NOMBRE, CORREO, TELEFONO, CARGO | — |
| `OIS` | orden | ID OIS, ID COTIZACION, FECHA ELABORACION, CODIGO, PLAZO, FECHA VENCIMIENTO, ESTADO | REQUEST ID, URL DOCUMENTO, DOC ESTADO, ACTUALIZADO EN, ELABORADO POR, ACTUALIZADO POR, DOC FILE ID |
| `TAREAS_OIS` | tarea | ID TAREA, ID OIS, TAREA, RESPONSABLE, ID EMPLEADO, FECHA INICIO, FECHA ENTREGA, ESTADO, OBSERVACION | — |
| `_ERRORES` | error registrado | *(se crea sola)* TIMESTAMP, REQUEST ID, ETAPA, USUARIO, ID COTIZACION, IDS GENERADOS, MENSAJE, STACK, PAYLOAD | — |

Además hay un spreadsheet de **catálogo** (`CFG().CAT_SHEET_ID`) con la pestaña `TIPOS DE SERVICIOS`: **columna A = tipo de servicio, columna B = código UNSPSC**, en la misma fila.

Relaciones principales:

```
CLIENTES 1───* CONTACTOS_CLIENTES
CLIENTES 1───* ESTABLECIMIENTOS_CLIENTES 1───0..1 CONTACTOS_CLIENTES (encargado)
COTIZACIONES (por ID COTIZACION) 1───* SERVICIOS
COTIZACIONES 1───0..1 OIS 1───* TAREAS_OIS
PERSONAL_KGP ──► responsables de tareas y trazabilidad de cotizaciones
```

## Instalación paso a paso

### Requisitos previos

- Una cuenta de Google (Workspace o personal) con acceso de edición a:
  - el spreadsheet de base de datos,
  - el spreadsheet de catálogo,
  - la plantilla `.xlsx` de cotización (con las pestañas `CTZ-V-4` y `OIS V-4`),
  - las carpetas de Drive de salida (cotizaciones y OIS).
- [Node.js](https://nodejs.org/) 18 o superior.
- [clasp](https://github.com/google/clasp) (CLI oficial de Apps Script).
- Git.

### 1. Clonar el repositorio

```bash
git clone https://github.com/andresmonsalve19/kgp-panel.git
cd kgp-panel
```

### 2. Instalar y autenticar clasp

```bash
npm install -g @google/clasp
clasp login
```

Además, activa la **Google Apps Script API** para tu cuenta en <https://script.google.com/home/usersettings>.

### 3. Vincular con un proyecto de Apps Script

**Opción A — usar el proyecto existente** (si tienes acceso de editor): `.clasp.json` ya apunta a él, no hay que hacer nada.

**Opción B — crear un proyecto nuevo** (por ejemplo, un entorno de pruebas):

```bash
clasp create --type standalone --title "KGP Panel" --rootDir src
```

Revisa que `.clasp.json` quede con `"rootDir": "src"` y el nuevo `scriptId`.

### 4. Preparar Google Sheets y Drive

1. Crea (o ubica) el spreadsheet de **base de datos** con las pestañas y encabezados de la sección [Modelo de datos](#modelo-de-datos-google-sheets). La hoja `_ERRORES` no es necesaria: se crea sola.
2. Crea (o ubica) el spreadsheet de **catálogo** con la pestaña `TIPOS DE SERVICIOS` (A = tipo, B = UNSPSC).
3. Sube la **plantilla `.xlsx`** a Drive.
4. Crea las carpetas de salida para documentos de **cotizaciones** y de **OIS**.
5. Copia los IDs (la parte de la URL entre `/d/` y `/edit`, o después de `/folders/`) en `CFG()` dentro de [src/00_Config.js](src/00_Config.js):

   ```js
   DB_SHEET_ID:      '...',  // spreadsheet de base de datos
   CAT_SHEET_ID:     '...',  // spreadsheet de catálogo
   TEMPLATE_FILE_ID: '...',  // plantilla .xlsx
   OUT_FOLDER_ID:    '...',  // carpeta de documentos de cotización
   OIS_FOLDER_ID:    '...',  // carpeta raíz de las OIS
   ```

### 5. Subir el código

```bash
clasp push --force
```

El manifiesto [src/appsscript.json](src/appsscript.json) ya habilita el servicio avanzado **Drive API v2** y declara los scopes necesarios.

### 6. Preparar la plantilla (una sola vez)

Abre el editor (`clasp open` o desde script.google.com) y ejecuta, en este orden, desde **Ejecutar → seleccionar función**:

1. `admin_convertTemplate()` — convierte la plantilla `.xlsx` a Google Sheet nativo y guarda su ID en las *Propiedades del script* (`TEMPLATE_SHEET_ID`). La primera ejecución pide autorizar los permisos.
2. `admin_smokeTestTemplate()` — genera un `.xlsx` vacío en la carpeta de salida. Ábrelo y compáralo visualmente con la plantilla original (bordes, imágenes, validaciones).
3. `admin_health()` — verifica que todas las hojas tengan las columnas requeridas y que la plantilla tenga las pestañas esperadas. Revisa el resultado en **Ver → Registros**.
4. Si la pestaña de cotización no es la primera de la plantilla, o la de OIS no se llama `OIS V-4`, corrígelas:

   ```js
   admin_setTemplateTabName('CTZ-V-4');
   admin_setOisTabName('OIS V-4');
   ```

### 7. Desplegar como Web App

1. En el editor: **Implementar → Nueva implementación → Tipo: Aplicación web**.
2. *Ejecutar como*: **Yo** (el propietario). *Quién tiene acceso*: según la política de la empresa (el manifiesto usa `ANYONE`; en Workspace suele restringirse al dominio).
3. Copia la URL `/exec` y compártela con los usuarios.

### 8. Registrar al personal

Entra a **Gestión de empleados** y registra a las personas que usarán el panel, con el **mismo correo** con el que inician sesión en Google: así el sistema llena automáticamente "Elaborado por" y "Cargo" al crear cotizaciones.

## Despliegue y actualizaciones

```bash
clasp push --force
```

- La URL de desarrollo (`/dev`) refleja los cambios **al instante** (solo para editores del script).
- La URL de producción (`/exec`) **no cambia** hasta publicar una nueva versión: **Implementar → Administrar implementaciones → editar (lápiz) → Versión: "Nueva versión" → Implementar**. Editar solo la descripción no publica el código nuevo.

## Funciones de administración

Se ejecutan desde el editor de Apps Script y dejan un resumen legible en **Ver → Registros**.

| Función | Uso |
|---|---|
| `admin_convertTemplate()` | Convierte la plantilla `.xlsx` a Sheet nativo (una sola vez; no duplica si ya existe). |
| `admin_smokeTestTemplate()` | Genera un documento vacío para validar visualmente la plantilla. |
| `admin_health()` | Diagnóstico de hojas, columnas, catálogo y plantilla. También disponible como `api_health()`. |
| `admin_setTemplateTabName(nombre)` | Fija la pestaña de la plantilla de cotización. |
| `admin_setOisTabName(nombre)` | Fija la pestaña de la plantilla de OIS. |
| `admin_dumpSample()` | Muestra 3 filas reales por hoja para verificar el mapeo de columnas. |
| `admin_cleanTempFiles()` | Borra archivos temporales `__TMP_*` de más de 24 h que hayan quedado huérfanos. |
| `admin_clearCaches()` | Invalida todas las cachés del servidor. |

## Configuración

Toda la configuración vive en [src/00_Config.js](src/00_Config.js), dentro de funciones (nunca a nivel top-level):

- **`CFG()`** — IDs de Sheets/Drive, nombres de pestañas, límites (`MAX_SERVICIOS: 10`, `MAX_ACTIVIDADES: 10`, `MAX_TAREAS: 20`, lock de 30 s…), estados, tasa de IVA (`0.19`), TTLs de caché y zona horaria (`America/Bogota`).
- **`SCHEMA()`** — columnas requeridas y opcionales de cada hoja.
- **`CELLMAP()`** — celda exacta de la plantilla donde se escribe cada dato. Los servicios se repiten cada 18 filas a partir de la fila 39 (servicio #1 en la 39, #10 en la 201); las tarifas van en una fila por servicio desde la 223; las tareas de OIS desde la 229.

Valores guardados en **Propiedades del script** (Configuración del proyecto → Propiedades del script):

| Propiedad | Descripción |
|---|---|
| `TEMPLATE_SHEET_ID` | ID de la plantilla convertida (lo escribe `admin_convertTemplate`). |
| `TEMPLATE_TAB_NAME` | Pestaña de cotización de la plantilla (opcional). |
| `TEMPLATE_TAB_OIS` | Pestaña de OIS (por defecto `OIS V-4`). |
| `SEQ_YY`, `SEQ_OIS_YY` | Marcas de agua de los consecutivos por año (automáticas). |

## Convenciones de desarrollo

Las reglas completas están en [CLAUDE.md](CLAUDE.md). Las más importantes:

- **Cero código ejecutable a nivel top-level** en el servidor: el orden en que `clasp` sube los archivos no debe importar.
- **No tocar ni reutilizar nombres de** `src/otherFunctions.js` (respaldo del código original; la lista de nombres reservados está en el encabezado de `00_Config.js`).
- **Resolver columnas siempre por nombre normalizado** (`normText_`), nunca por índice.
- **Toda `api_*` pasa por `safeCall_`** y devuelve `{ok, data, error, meta}`; nunca debe cruzar un `undefined` por `google.script.run`.
- **Lock corto**: solo reserva de consecutivo + escrituras en hojas; la generación de documentos va fuera.
- **Reutilizar los módulos de frontend** `KGP.catalog`, `KGP.ui`, `KGP.entityModal` en lugar de duplicar modales, selects o llamadas a `api_bootstrap`.
- **Loader**: `#page-loader` solo para la carga inicial; las acciones puntuales usan su propio estado de carga (spinner en el botón).
- **Menú lateral** en orden fijo: Crear cotización → Gestionar cotización → Gestionar OIS → Gestión de empleados → **Dashboard (siempre de último)**.
- **Diseño**: paleta blanco + verde oliva (`--primary: #6b7c3f`), breakpoint móvil `760px` con texto centrado.
- **Verificar sintaxis** de los `.html` con script embebido antes de subir: extraer el `<script>` a un `.js` temporal y correr `node --check`.

### Skills de IA incluidas en el repositorio

El proyecto trae versionadas las skills de diseño de UI que se usan con Claude Code: `better-ui`, `frontend-design`, `interaction-design`, `interface-design` y `web-design-guidelines`.

- `.claude/skills/`: la carpeta que lee Claude Code. Al clonar el repo y abrirlo con Claude Code, las skills ya quedan disponibles sin instalar nada.
- `.agents/skills/`: la misma copia en el formato del CLI [`skills`](https://github.com/vercel-labs/skills), para otros agentes.
- `skills-lock.json`: origen (repositorio de GitHub) y hash de cada skill.

En `.claude/skills/` hay **copias reales, no enlaces simbólicos**: los enlaces que crea el CLI apuntan a rutas absolutas de un equipo y se rompen al clonar en otro. Si actualizas o agregas una skill con el CLI, vuelve a copiar su carpeta de `.agents/skills/<skill>` a `.claude/skills/<skill>` antes de hacer commit.

## Solución de problemas

| Síntoma | Causa probable / solución |
|---|---|
| Aviso "La plantilla del documento aún no se ha preparado" | Falta ejecutar `admin_convertTemplate()`. |
| La cotización se crea pero `DOC ESTADO = ERROR` | Revisa la hoja `_ERRORES`. Luego usa "Guardar cambios" (o `api_regenerateDocument`) para reintentar; se reutiliza el mismo archivo. |
| "El sistema está ocupado. Intenta de nuevo en unos segundos." | Otro usuario tiene el lock de escritura. Reintenta; el lock dura como máximo 30 s. |
| Faltan columnas / errores de esquema | Ejecuta `admin_health()` y agrega las columnas indicadas como requeridas. |
| Cambios hechos a mano en el Sheet no se ven | Recarga la página (F5): cada recarga invalida las cachés. Si persiste, ejecuta `admin_clearCaches()`. |
| Los cambios de código no se ven en `/exec` | Publica una **Nueva versión** de la implementación (ver [Despliegue](#despliegue-y-actualizaciones)). |
| "Elaborado por" queda vacío | El correo del usuario no está registrado en **Gestión de empleados**. |
| Archivos `__TMP_*` en Drive | Restos de ejecuciones interrumpidas; `admin_cleanTempFiles()` los limpia. |

---

**Stack:** Google Apps Script (V8) · HtmlService · Google Sheets · Google Drive API v2 · CacheService / PropertiesService / LockService · HTML/CSS/JavaScript vanilla · clasp
