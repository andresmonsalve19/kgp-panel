# KGP Panel — Guía de trabajo para Claude

Este archivo se carga automáticamente en cada sesión de Claude Code sobre
este repo. Contiene reglas que **no se deben olvidar** entre tareas.

## 1. Verificar antes de dar por terminado un cambio

Después de CUALQUIER cambio de código (backend o frontend), antes de decir
que algo "ya quedó":

1. Releer el archivo modificado para confirmar que el cambio quedó como se
   pretendía — no asumir que un Edit se aplicó bien sin mirarlo.
2. Verificar sintaxis de los `.html` con script embebido: extraer el
   contenido de `<script>` a un `.js` temporal dentro del propio proyecto
   (`/tmp` no existe en este entorno Windows) y correr `node --check`.
   Borrar el temporal después.
3. Grep por referencias rotas: si se elimina o renombra un `id` de HTML, una
   función, o una clave de `CFG()`/`SCHEMA()`, buscar TODOS los usos antes de
   confirmar que no quedó nada colgando (funciones huérfanas, endpoints
   `api_*` que ya nadie llama, ids de DOM referenciados por JS que ya no
   existen en el HTML).
4. Si se tocan endpoints `api_*`, confirmar que el contrato
   `{ok, data, error, meta}` se mantiene y que ningún `undefined` cruza
   `google.script.run` (se pierde en silencio del lado del cliente).
5. Repasar el archivo completo modificado una vez más buscando efectos
   secundarios en otras vistas o funciones que comparten el namespace
   global plano de Apps Script.
6. `clasp push --force` al final. Recordarle al usuario que `/dev` se
   actualiza al instante, pero `/exec` (producción) necesita elegir
   explícitamente **"Nueva versión"** en Implementar → Administrar
   implementaciones (no basta con editar la Descripción).

## 2. Rendimiento — pensar siempre en "esto va a crecer"

- **Nunca escanear una hoja completa en una ruta que se ejecuta en cada
  carga de página** si se puede evitar. `COTIZACIONES` crece una fila por
  servicio: cualquier función llamada desde `api_bootstrap` (o equivalente)
  que recorra esa hoja entera se va a poner más lenta con el tiempo. Prioriza
  `ScriptProperties` o caché antes que un escaneo completo cuando el dato no
  necesita ser exacto al segundo. Ejemplo ya aplicado:
  `code_previewNext_` (20_Ids.js) es solo informativo para la UI y no
  reserva nada, así que lee la marca de agua en `ScriptProperties` en vez de
  escanear `COTIZACIONES` fila por fila; el escaneo completo y autoritativo
  (sheet + marca de agua) solo ocurre dentro del lock, en `code_reserve_`,
  una vez por transacción real de creación.
- **Una sola lectura por hoja por ejecución.** Usa `repo_readTable_` (ya
  memoiza por `ssId+tabName` en `repo_memo_()`, ver 10_SheetRepo.js) en vez
  de `sheet.getRange(...)` suelto. Si un caso no puede usar
  `repo_readTable_` (p. ej. una hoja sin encabezados fijos, como
  `TIPOS DE SERVICIOS`), igual memoiza el resultado a mano con
  `repo_memo_()` para no repetir la misma lectura dos veces en la misma
  ejecución (ver `cat_readCatalogo_` en 11_CatalogRepo.js: antes leía la
  columna A y la columna B por separado, con dos llamadas a Sheets; ahora
  lee ambas de una vez).
- **Minimiza los round-trips `google.script.run` en la carga inicial.** Si
  dos llamadas siempre se necesitan juntas al entrar a una vista (como pasaba
  antes con `api_bootstrap` + `api_previewCodigo`, dos llamadas secuenciales
  donde la segunda hacía que el código de la cotización fuera "lo último en
  aparecer"), fusiónalas en una sola función del servidor. Cada
  `google.script.run` adicional suma latencia percibida, no solo tiempo de
  cómputo.
- El catálogo `TIPOS DE SERVICIOS` se lee **sin caché entre requests a
  propósito** (requisito explícito del usuario: una fila nueva en esa hoja
  debe verse de inmediato en los desplegables la próxima vez que se cargue
  el formulario). No le agregues `CacheService`/TTL sin que el usuario lo
  pida explícitamente. Memoizar dentro de la misma ejecución con
  `repo_memo_()` sí está bien — no es lo mismo que cachear entre requests.
- Todo lo demás (`cli_listClientes_`, `cli_getDetalleCompleto_`) ya usa el
  patrón de invalidación por `dataVersion_()` — reutilízalo si agregas algo
  parecido, no inventes otro mecanismo de caché en paralelo.

## 2.1 Módulos de frontend compartidos — no dupliques, reutiliza

Tres vistas (`Crear cotización`, `Gestionar cotización`, y cualquier futura)
comparten el mismo formulario de cliente/contacto/establecimiento y el mismo
catálogo. Antes de escribir un modal o un listado nuevo, revisa si ya existe:

- **`KGP.catalog`** (`ui/JsCore.js.html`): cache en memoria de
  `api_bootstrap()` (tipos de servicio, catálogo UNSPSC, clientes, estados).
  `KGP.catalog.load()` reutiliza el resultado si ya se pidió;
  `KGP.catalog.load(true)` fuerza refresco (usar tras crear/editar un cliente
  o al entrar a una vista que necesita ver cambios recientes). Nunca llames
  `api_bootstrap` directo desde una vista nueva — pasa por aquí, si no vuelve
  el problema de round-trips duplicados que esto reemplazó.
- **`KGP.ui`** (`ui/JsCore.js.html`): helpers de `<select>`
  (`rebuildSelect`, `addOption`, `addOptionAndSelect`, `updateOptionLabel`),
  formateadores de etiqueta (`clientLabel`, `contactoLabel`,
  `establecimientoLabel`), `buildUnspscMap(pares)` (arma `{tipo: codigo}` a
  partir de `catalogoPares` de `api_bootstrap`, preservando la
  correspondencia por fila del catálogo) y `wirePhoneInputs`.
- **`KGP.entityModal`** (`ui/JsCore.js.html`): el único modal de
  alta/edición rápida de cliente, contacto (solicitante/encargado) y
  establecimiento — un solo `#modal-overlay`/`#modal-body` y las plantillas
  `tpl-modal-*` (viven en `ui/ViewCotizacion.html` pero son globales, no
  atadas a esa vista). Se abre con
  `KGP.entityModal.open({type, mode, target, editId, initial, onSave(datos)})`;
  `onSave` es tuyo: hace la llamada `api_create*`/`api_update*` y actualiza
  el `<select>`/estado local de TU vista. El modal solo valida
  requerido/correo/teléfono y maneja el ciclo de vida del diálogo — no le
  añadas otra copia de esa validación en una vista nueva.
- **Servicios/actividades**: las plantillas `tpl-servicio` y `tpl-actividad`
  (también en `ui/ViewCotizacion.html`, también globales) las usan tanto
  "Crear cotización" como "Gestionar cotización", cada una con su propia
  orquestación de agregar/quitar bloques (son ~80 líneas por vista; no vale
  la pena abstraerlas más allá de esto — ver `addServicioBlock`/
  `addActividadRow` en ambos `Js*.js.html` si necesitas replicar el patrón
  en una tercera vista).
- **Listados de cotizaciones**: `api_getDashboard(params)` ya agrega por
  `ID COTIZACION` distinto, filtra por año/estado/texto y pagina. Cualquier
  tabla nueva de cotizaciones (como la de "Gestionar cotización") debe
  reutilizarlo con `sinceVersion: null` en vez de escribir otro endpoint de
  listado — la única vista que necesita el protocolo de versión para no
  volver a tocar el Sheet es el Dashboard con polling en vivo.
- El código UNSPSC de un servicio **no es una elección independiente**: es
  el de la misma fila que el tipo de servicio en la hoja
  `TIPOS DE SERVICIOS` (columna A = tipo, columna B = código, misma fila).
  Por eso en la UI es un campo de solo lectura que se autocompleta a través
  de `KGP.ui.buildUnspscMap` — nunca lo vuelvas a convertir en un `<select>`
  independiente.
- El **ESTADO de una cotización solo se edita desde "Gestionar cotización"**,
  y ya no es un campo del formulario: toda cotización nace
  `CFG().ESTADO_INICIAL` ("En revisión", forzado en el servidor al crear) y
  los botones "Garantía aprobada" / "Garantía rechazada" del resumen del
  detalle lo cambian **una sola vez** a "Aprobada"/"Rechazada" (con
  confirmación en línea), enviando `payload.estado` en el mismo
  `api_updateQuotation`. `payload.estado` vacío = conservar el actual;
  `qs_updateQuotation` rechaza (CONFLICT) cualquier cambio si la cotización
  ya no está en revisión. Filas antiguas con "Aprobado"/"Rechazado"
  (masculino) se leen como sus equivalentes vía `qs_normEstado_`.
  El Dashboard lo muestra como una insignia de solo lectura (misma
  `estadoBadgeClass` duplicada a propósito en `JsDashboard.js.html` y
  `JsGestion.js.html` — son ~4 líneas, no vale la pena compartirlas). No
  existe `api_updateEstado` ni `qs_updateEstado`: se eliminaron por quedar
  huérfanos al quitarle a la tabla del dashboard el `<select>` inline: si
  necesitas cambiar el estado por separado del resto del formulario, hazlo
  reutilizando `api_updateQuotation`, no resucites ese endpoint aparte.

## 2.2 Caché local (stale-while-revalidate) — Dashboard y "Gestionar cotización"

Ambas vistas usan `KGP.localCache` (`ui/JsCore.js.html`, sobre
`localStorage`) para no dejar al usuario mirando un loader cada vez que
abre la vista, sin sacrificar frescura:

1. Al entrar a la vista **por primera vez en la sesión** (`state.everLoaded`
   en Dashboard / `listState.everLoaded` en Gestión), si hay algo en caché
   se pinta de inmediato (tabla + KPIs) — sin loader, sin "Cargando…".
2. Inmediatamente después, sin excepción, se dispara igual la llamada real
   al servidor (`fetchDashboard(true)` / `fetchList()`), que sobreescribe la
   caché con el dato fresco de la BD y vuelve a pintar si algo cambió. Por
   eso una recarga de página (F5) o cerrar y volver a abrir la pestaña
   **siempre termina reflejando la base de datos real** — la caché solo
   evita la espera visible mientras esa llamada vuelve, nunca sustituye la
   llamada.
3. Solo se cachea la consulta "por defecto" (sin filtros, página 1) — ver
   `isDefaultView()` / `isDefaultListQuery()`. Cambiar de filtro o de
   página siempre pide el dato fresco (con el loader/placeholder de
   "Cargando…" normal), nunca lee de la caché.
4. Volver a entrar a la vista **dentro de la misma sesión** (navegar a otra
   vista y regresar) NO repite la consulta a menos que el usuario pida
   "Actualizar" (`dash-refresh-btn` / `ge-refresh-btn`, ambos con spinner
   propio) — evita el patrón "se recarga todo el tiempo" que se reportó.
   `fetchList({silent:true})` / `fetchDashboard(false)` refrescan sin pisar
   la tabla ya visible con un placeholder de carga.
5. La vista de **detalle/edición de Gestión nunca usa esta caché** — al
   editar, siempre se trae `api_getCotizacion` fresco (decisión deliberada:
   editar sobre un dato posiblemente viejo es más riesgoso que una espera
   de un segundo). Por eso el detalle tiene su propio bloqueo total
   (`ge-detail-loading` / `ge-detail-content` en `ViewGestion.html`, ver
   sección 3) en vez de participar del stale-while-revalidate.

## 3. Experiencia de carga (loader)

- La app tiene un loader de pantalla completa: `#page-loader` en
  `ui/Index.html` (visible por defecto en el HTML, no depende de JS para
  aparecer — así no hay flash de contenido vacío al abrir o recargar la
  página), estilos en `ui/Styles.css.html`, y se oculta con
  `KGP.hideLoader()` (definido en `ui/JsCore.js.html`).
- `KGP.hideLoader()` se llama desde el `.finally()` del primer fetch de la
  vista inicial (`bootstrap()` en JsCotizacion.js.html, `fetchDashboard()` en
  JsDashboard.js.html) — cubre tanto el caso de éxito como el de error, para
  que el loader nunca quede pegado. Es idempotente y seguro de llamar varias
  veces (el elemento se remueve del DOM tras la primera vez). Hay además un
  timeout de seguridad de 20s en `KGP.init()` por si algo bloquea ese
  camino.
- Si agregas una vista nueva o cambias el bootstrap de una existente,
  asegúrate de que `KGP.hideLoader()` se siga llamando quede como quede la
  promesa (éxito o error).
- El loader de pantalla completa es **solo para la carga inicial de una
  vista**. Cualquier acción puntual nueva (guardar, editar, generar
  documento) debe mostrar su propio estado de carga local (spinner en el
  botón, texto "Guardando…", disabled mientras corre) — no reutilices
  `#page-loader` para eso.
- **Detalle de "Gestionar cotización"**: entrar al detalle (clic en una fila
  del listado, o el botón "Gestionar cotización" del resumen tras crear)
  bloquea toda la vista hasta que termina de cargar — nunca se ve un
  formulario vacío o a medio llenar. Patrón: `#ge-detail-loading` (spinner)
  y `#ge-detail-content` (todo el formulario) en `ViewGestion.html`, uno
  visible y el otro oculto según `setDetailBusy()` en `JsGestion.js.html`.
  Si la carga falla, no se revela el contenido — se vuelve al listado con un
  toast de error. No es el `#page-loader` global (esta vista no es la carga
  inicial de la app), pero sí bloquea de forma similar porque mostrar un
  formulario de edición a medio poblar es peor que un spinner de un
  instante.

## 4. Diseño responsive

- Breakpoint móvil: `max-width: 760px` (definido en `ui/Styles.css.html`).
- En móvil todo el texto va centrado (`body { text-align: center; }` dentro
  del media query, más ajustes puntuales de `flex-direction`/
  `justify-content` en headers, modales, filtros, etc.) — requisito
  explícito del usuario. Si agregas un componente nuevo, verifica que se vea
  centrado y utilizable en ese ancho antes de darlo por terminado.
- Paleta: blanco + verde oliva (`--primary: #6b7c3f` y variables asociadas
  en `:root` de `ui/Styles.css.html`). No introduzcas otro color de acento
  sin que el usuario lo pida.

## 5. Reglas heredadas de la arquitectura del proyecto (no romper)

- Cero código ejecutable a nivel top-level en los archivos del servidor —
  toda la config vive dentro de funciones accesoras (`CFG()`, `SCHEMA()`,
  `CELLMAP()`). El orden de subida de `clasp` no debe importar para que el
  código funcione.
- `src/otherFunctions.js` es el respaldo literal del `Code.js` original.
  Nunca se llama, nunca se modifica, y ningún símbolo nuevo debe llamarse
  igual que los 14 nombres reservados listados en el encabezado de
  `00_Config.js`.
- Resolución de columnas de Sheets siempre por nombre normalizado
  (`normText_`), nunca por índice fijo — el esquema real de las hojas puede
  variar.
- Toda función `api_*` devuelve `{ok, data, error, meta}` vía `safeCall_`;
  nunca debe dejar escapar una excepción cruda al cliente.
- La sección crítica de escritura (script lock) es corta: solo cubre
  reserva de consecutivo + appends a las hojas, nunca la generación del
  documento Excel (eso va en una segunda fase, fuera del lock).

## 6. Mapa de celdas de servicios en la plantilla (hasta 10 servicios)

- Los hasta `CFG().LIMITS.MAX_SERVICIOS` (10) servicios de una cotización
  **se escriben todos en la plantilla**, no solo el #1. Cada servicio repite
  el mismo layout de 3 celdas (tipo/UNSPSC/descripción) + su lista de
  actividades, desplazado `CELLMAP().SERVICIOS_FILA_PASO` (18) filas hacia
  abajo del anterior — confirmado celda por celda con el usuario: Servicio
  #1 en la fila 39 (actividades desde B42), #2 en la fila 57 (actividades
  desde B60), ... #10 en la fila 201 (actividades desde B204). Ver
  `doc_writeServicioCells_` en `31_DocService.js`: la fila ancla de cada
  servicio es `SERVICIOS_FILA_BASE + indice * SERVICIOS_FILA_PASO`, nunca
  hardcodees una fila para un servicio puntual — si el usuario confirma un
  nuevo layout, ajusta el paso/base en `CELLMAP()`, no cada celda a mano.
- Las actividades se guardan en la hoja `SERVICIOS` con un prefijo de
  numeración interna ("1.1 texto", "1.2 texto", ...) para que la columna se
  lea de un vistazo en el sheet (`qr_formatActividades_`, 13_QuoteRepo.js).
  Ese prefijo **nunca debe llegar a la plantilla**: `doc_stripActividadPrefix_`
  (31_DocService.js) lo quita antes de escribir cada celda, dejando solo el
  texto que la persona escribió en el textarea. Si necesitas mostrar una
  actividad ya guardada de vuelta en un formulario de edición, usa el mismo
  patrón (ver `stripActPrefix` en `JsGestion.js.html`, versión cliente del
  mismo strip).

## 7. Tarifas por servicio y totales de la cotización

- Solo se editan en "Gestionar cotización": `KGP.servicioModal.open({showTarifas: true})`
  muestra la sección Tarifas (Crear cotización no la pasa, así que no la ve).
- SERVICIOS: `TARIFA` (entero, sin formato — el `$120.000` es solo visual,
  `KGP.ui.formatMoney`/`wireMoneyInput`), `CANTIDAD` (entero ≥ 1),
  `TOTAL` (= tarifa × cantidad, siempre recalculado en el servidor) y
  `OBSERVACIONES` (acumulativo: cada observación nueva se agrega en una
  línea nueva; las anteriores se muestran en solo lectura y nunca se
  reemplazan).
- COTIZACIONES: `SUBTOTAL` = suma de los `TOTAL` de sus servicios,
  `IVA` = SUBTOTAL × `CFG().IVA_TASA` (0.19), `TOTAL` = SUBTOTAL + IVA — el
  mismo valor en todas las filas de la cotización. El resumen del detalle
  de Gestión recalcula lo mismo en vivo (`computeTotales`) y avisa si hay
  cambios sin guardar; el servidor es la fuente de verdad.
- Esas 7 columnas son `optional` en `SCHEMA()` (creación y dashboard
  funcionan sin ellas), pero `qs_updateQuotation` las exige vía
  `qr_requireTarifaCols_` para no descartar tarifas en silencio.
- Plantilla: una fila por servicio desde `CELLMAP().TARIFAS_FILA_BASE`
  (223): Servicio #1 → E223/F223/H223, ... #10 → E232/F232/H232
  (tarifa/cantidad/observaciones). El TOTAL del servicio NO se escribe en la
  plantilla. Tarifa y cantidad se escriben como número con `doc_setNumber_`
  (sin el formato `@` de `doc_setText_`, para no romper el formato de
  moneda ni fórmulas de la plantilla).
- `doc_generateForQuotation_` solo usa la caché de idempotencia cuando hay
  `requestId` (generación inicial). La regeneración de "Guardar cambios"
  siempre reescribe el documento.

## 8. Regeneración del documento: siempre el MISMO archivo

- "Guardar cambios" nunca crea un documento nuevo si la cotización ya tiene
  uno. El id sale de `DOC FILE ID` o, si esa columna no existe o está
  vacía, del link en `URL DOCUMENTO` (`doc_fileIdFromCotizacion_`).
- `.xlsx` → `Drive.Files.update` sobre ese id (nueva revisión, mismo link).
  Hoja nativa de Google → se reemplaza su pestaña dentro del mismo archivo
  (`doc_replaceNativeSheet_`).
- Solo se crea uno nuevo si no hay documento previo o si el previo fue
  borrado / está en la papelera (`doc_findExistingFile_`). Cualquier otro
  error de Drive se reporta (DOC ESTADO = ERROR) sin crear duplicados.
- En la ruta de error NUNCA se borran `URL DOCUMENTO` ni `DOC FILE ID`
  (`qr_updateDocInfo_` con `undefined` = no tocar).

## 9. Orden del menú lateral — Dashboard siempre de último

- Orden fijo, requisito explícito del usuario: **Crear cotización → Gestionar
  cotización → Gestionar OIS → Gestión de empleados → Dashboard**. Dashboard va siempre en la
  última posición.
- Los `.nav-item` viven en `ui/Sidebar.html` (`data-nav="cotizacion"`,
  `"gestion"`, `"ois"`, `"empleados"`, `"dashboard"`, en ese orden) — el orden visual
  es simplemente el orden en que aparecen esos `<div class="nav-item">` en el
  HTML, no hay lógica de JS que los reordene.
- **Si se agrega una vista nueva**, su `nav-item` va **antes** del de
  `data-nav="dashboard"` (nunca después) — Dashboard se queda de último
  siempre. No hace falta tocar `KGP.nav` en `ui/JsCore.js.html` para esto:
  solo reordena el HTML de `ui/Sidebar.html`.

## 10. OIS (orden interna de servicio)

- Aprobar una garantía **siempre** crea su orden en la misma transacción:
  "Garantía aprobada" abre el popup OIS / OIP / Cancelar, y "OIS" llama
  `api_aprobarConOis` (aprobar + crear la fila OIS dentro de UN lock, vía
  `qs_applyQuotationUpdate_`). `qs_updateQuotation` rechaza `estado =
  Aprobada` a propósito: nunca debe existir una cotización Aprobada sin su
  orden. OIP todavía no está implementada (el botón solo avisa).
- Una cotización produce a lo sumo una OIS. La OIS **no duplica** datos de la
  cotización: cliente/solicitante/establecimiento/servicios se leen de la
  cotización padre por ID COTIZACION, y guardar la OIS los reescribe allí
  (`permitirDecidida: true` — la OIS es la única puerta de edición de una
  cotización ya aprobada; "Gestionar cotización" sigue bloqueada).
- `ois_updateOis` solo toca COTIZACIONES/SERVICIOS (y el cliente solo
  regenera el documento de la cotización) si cambió algo compartido
  (`cotizacionCambio`). Cambios solo de tareas/plazo de la OIS no tocan la
  cotización. Las tarifas nunca se ven ni se editan en la OIS: el servidor
  conserva las ya guardadas.
- ESTADO de la OIS: derivado, nunca editable. Finalizada gana (todas las
  tareas finalizadas, ≥1 tarea) > Vencida (hoy > FECHA VENCIMIENTO) > En
  curso. Una OIS Finalizada queda de solo lectura.
- Consecutivo `OIS-KGP-NNN-YY`, reinicia cada año (marca de agua
  `SEQ_OIS_YY`, `ois_codeReserve_`).
- Documento: la pestaña `CFG().TEMPLATE_TAB_OIS` ("OIS V-4") de la misma
  plantilla, sola en un .xlsx, en su subcarpeta dentro de
  `CFG().OIS_FOLDER_ID`. Mismos datos compartidos que CTZ-V-4 **sin** la
  tabla de tarifas (esas filas las ocupan A225..E225 y las tareas
  A229..E248). Regeneración siempre sobre el mismo archivo (§8).
