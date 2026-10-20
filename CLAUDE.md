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
   función, o una clave de `CFG_()`/`SCHEMA_()`, buscar TODOS los usos antes de
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
- **Escrituras en lote.** `repo_updateCells_`/`repo_updateCellsMany_`
  escriben cada tramo de columnas contiguas con UN `setValues` (nunca tocan
  una celda que no esté en el patch) y actualizan la memo de `repo_readTable_`
  EN SITIO, así una segunda escritura sobre la misma hoja no la relee entera.
  Para varias filas usa `repo_updateCellsMany_` (una sola llamada), nunca
  `repo_updateCells_` en un bucle. `repo_deleteRows_` agrupa filas
  consecutivas en un `deleteRows`. Appends y borrados sí descartan la memo.
- **`CFG_()` está memoizada y congelada** (`Object.freeze`) por ejecución: no
  la guardes en variables "por rendimiento" (ya no hace falta, se quitaron
  `ois_cfg_`, `oip_cfg_` y el memo de `qs_normEstado_`) y nunca intentes
  modificar el objeto que devuelve. Tras escribir una propiedad que lee
  (`TEMPLATE_*`) llama `cfg_invalidar_()`. `normText_` también está
  memoizada: úsala sin miedo en bucles.
- **Documentos:** escribe celdas con `doc_escritor_(sheet)` (`w.texto`,
  `w.numero`, `w.fecha`, `w.aplicar()`): el formato `@` y el vaciado de celdas
  van en lote (`RangeList`). Llama `w.aplicar()` ANTES de insertar o borrar
  filas (las direcciones A1 se fijan al acumular).
- **Verificación sin tocar producción:** antes de subir un cambio de servidor
  grande, la revisión de octubre 2026 usó un simulador en Node (mocks de
  SpreadsheetApp/Drive/Cache/Mail, ver la sesión) que corre un escenario
  completo y compara respuestas, hojas, celdas de los documentos y correos
  contra una línea base. Si repites algo así, deja los scripts fuera del repo
  (scratchpad) y compara antes/después; no basta con `node --check`.

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
  `CFG_().ESTADO_INICIAL` ("En revisión", forzado en el servidor al crear) y
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
  toda la config vive dentro de funciones accesoras (`CFG_()`, `SCHEMA_()`,
  `CELLMAP_()`). El orden de subida de `clasp` no debe importar para que el
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
- **Toda escritura pasa por `tx_conLock_(etapa, fn, opts)`**
  (`07_Transaccion.js`): toma el lock, ejecuta `fn` (que devuelve
  `ok_`/`fail_`), hace `flush` + `bumpDataVersion_` solo si fue `ok`, convierte
  excepciones en `fail_` y registra en `_ERRORES` todo menos los rechazos
  esperados (CONFLICT / NOT_FOUND / VALIDATION). No vuelvas a escribir el
  bloque `LockService ... try/finally` a mano. Lo que va DESPUÉS del lock
  (correos, por ejemplo) se hace con el resultado que devuelve.
- **Funciones privadas = terminan en `_`.** `google.script.run` puede llamar
  CUALQUIER función global sin `_` y la web app está publicada para cualquiera
  con el enlace. Por eso los accesores de configuración se llaman `CFG_()`,
  `SCHEMA_()` y `CELLMAP_()` (antes `CFG()`, ...: exponían IDs y correos), y
  toda función `admin_*` empieza con `admin_soloEditor_()` (solo corre si la
  ejecuta la cuenta dueña, es decir, desde el editor). Una función nueva que no
  sea `api_*`, `admin_*`, `doGet`, `include` o un servicio ya existente, debe
  terminar en `_`. No vuelvas a exponer un endpoint de diagnóstico (se quitó
  `api_health`).

## 6. Mapa de celdas de servicios en la plantilla (hasta 10 servicios)

- Los hasta `CFG_().LIMITS.MAX_SERVICIOS` (10) servicios de una cotización
  **se escriben todos en la plantilla**, no solo el #1. Cada servicio repite
  el mismo layout de 3 celdas (tipo/UNSPSC/descripción) + su lista de
  actividades, desplazado `CELLMAP_().SERVICIOS_FILA_PASO` (18) filas hacia
  abajo del anterior — confirmado celda por celda con el usuario: Servicio
  #1 en la fila 39 (actividades desde B42), #2 en la fila 57 (actividades
  desde B60), ... #10 en la fila 201 (actividades desde B204). Ver
  `doc_writeServicioCells_` en `31_DocService.js`: la fila ancla de cada
  servicio es `SERVICIOS_FILA_BASE + indice * SERVICIOS_FILA_PASO`, nunca
  hardcodees una fila para un servicio puntual — si el usuario confirma un
  nuevo layout, ajusta el paso/base en `CELLMAP_()`, no cada celda a mano.
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
  `IVA` = SUBTOTAL × `CFG_().IVA_TASA` (0.19), `TOTAL` = SUBTOTAL + IVA — el
  mismo valor en todas las filas de la cotización. El resumen del detalle
  de Gestión recalcula lo mismo en vivo (`computeTotales`) y avisa si hay
  cambios sin guardar; el servidor es la fuente de verdad.
- Esas 7 columnas son `optional` en `SCHEMA_()` (creación y dashboard
  funcionan sin ellas), pero `qs_updateQuotation` las exige vía
  `qr_requireTarifaCols_` para no descartar tarifas en silencio.
- Plantilla: una fila por servicio desde `CELLMAP_().TARIFAS_FILA_BASE`
  (223): Servicio #1 → E223/F223/H223, ... #10 → E232/F232/H232
  (tarifa/cantidad/observaciones). El TOTAL del servicio NO se escribe en la
  plantilla. Tarifa y cantidad se escriben como número (`w.numero` de
  `doc_escritor_`, sin el formato `@` de los textos, para no romper el formato de
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

## 9. Orden del menú lateral — Dashboard y luego Configuración, al final

- Orden fijo, requisito explícito del usuario: **Crear cotización → Gestionar
  cotización → Gestionar OIS → Gestionar OIP → Gestionar tareas → Gestión de
  clientes → Gestión de empleados → Dashboard → Configuración**.
  Configuración va siempre en la última posición (pedido del usuario al
  crearla) y Dashboard justo antes.
- Los `.nav-item` viven en `ui/Sidebar.html` (`data-nav="cotizacion"`,
  `"gestion"`, `"ois"`, `"oip"`, `"tareas"`, `"clientes"`, `"empleados"`,
  `"dashboard"`, `"config"`, en ese orden) — el orden visual es simplemente el
  orden en que aparecen esos `<div class="nav-item">` en el HTML, no hay
  lógica de JS que los reordene.
- **Si se agrega una vista nueva**, su `nav-item` va **antes** del de
  `data-nav="dashboard"` — Dashboard y Configuración se quedan de últimos.
  Una vista nueva sí necesita su línea `onEnter` en `KGP.nav`
  (`ui/JsCore.js.html`), pero el orden sale solo del HTML de `ui/Sidebar.html`.

## 10. OIS (orden interna de servicio)

- Aprobar una garantía **siempre** crea su orden en la misma transacción:
  "Garantía aprobada" abre el popup OIS / OIP / Cancelar, y "OIS" llama
  `api_aprobarConOis` (aprobar + crear la fila OIS dentro de UN lock, vía
  `qs_applyQuotationUpdate_`). `qs_updateQuotation` rechaza `estado =
  Aprobada` a propósito: nunca debe existir una cotización Aprobada sin su
  orden. "OIP" hace lo mismo con `api_aprobarConOip` (§11).
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
- Documento: la pestaña `CFG_().TEMPLATE_TAB_OIS` ("OIS V-4") de la misma
  plantilla, sola en un .xlsx, en su subcarpeta dentro de
  `CFG_().OIS_FOLDER_ID`. Mismos datos compartidos que CTZ-V-4 **sin** la
  tabla de tarifas (esas filas las ocupan A225..E225 y las tareas
  A229..E248). Regeneración siempre sobre el mismo archivo (§8).

## 11. OIP — en qué se parece a la OIS y en qué NO

La OIP es la otra rama del popup de aprobación y **calca la OIS** en casi
todo. En el servidor NO hay código duplicado: toda la lógica de las dos
órdenes (aprobar, leer, listar, guardar, estado derivado, DTOs, tareas) vive
UNA vez en `41_OrdenComun.js` (`ord_*`), parametrizada por el adaptador
`ord_spec_('OIS'|'OIP')`, que también usan `38_TareaService.js` y el Dashboard.
`35_OisService.js` / `36_OipService.js` solo exponen las funciones públicas
(`ois_*`/`oip_*`) y lo propio de cada una (facturación en la OIP). Una
diferencia nueva entre las dos se declara como un campo del spec, no con
`if (tipo === 'OIP')` sueltos. `16_OipRepo.js` es el espejo de `15_OisRepo.js`,
y `ui/ViewOip.html` + `ui/JsOip.js.html` el de sus equivalentes de OIS. Una cotización produce **una OIS o una OIP,
nunca las dos** (la elección del popup es única); `qs_getCotizacion` devuelve
`cotizacion.ois` y `cotizacion.oip` para los botones "Ver OIS"/"Ver OIP", y
`oip_aprobarConOip` rechaza si ya hay OIS.

Las diferencias, todas confirmadas con el usuario — no las "corrijas" por
simetría con la OIS:

1. **El consecutivo NO reinicia cada año.** `oip_codeReserve_` usa
   `code_siguienteNumero_` sin año y una sola marca de agua (`SEQ_OIP`, sin año):
   el NNN es continuo y solo el sufijo YY cambia. Efecto colateral: los 3
   dígitos son un techo **global** de 999 OIP, no 999 por año.
2. **PLAZO nace en `CFG_().OIP_PLAZO_DEFAULT` (365 días)**, no hereda el de la
   cotización como la OIS.
3. **Una OIP Finalizada NO queda de solo lectura.** Factura durante ~1 año:
   cerrar las tareas de un mes no puede congelarla. Por eso `JsOip.js.html`
   no tiene `applyLockState` y el spec de la OIP tiene `cierraAlFinalizar: false`.
4. **Las tareas no tienen bloque fijo en la plantilla.** `doc_writeOipCells_`
   escribe la #1 en `OIP_TAREAS_FILA_BASE` (235) e **inserta** las filas que
   falten para las demás (`insertRowsAfter`), así que todo lo que esté más
   abajo en la hoja se desplaza con sus etiquetas. El tope
   (`MAX_TAREAS_OIP`) es una salvaguarda, no un límite del layout. Fila de
   identificación: A231..E231.
5. **La vista agrupa las tareas por el mes de `FECHA ENTREGA`** (no de inicio),
   con filtros año/mes/estado, el mes actual por defecto y un apartado aparte
   para las de meses anteriores sin finalizar.
6. **La facturación (`OIP_FACTURACION`) se guarda al instante**, no espera al
   "Guardar cambios" (`api_saveOipFactura`/`api_deleteOipFactura`, cada una con
   su propio lock), y **nunca se escribe en el documento** — guardar una
   factura no regenera nada. `MES` se guarda como **número** (1-12), no como
   nombre, para que el recordatorio compare sin depender de acentos; la UI
   muestra la etiqueta con `KGP.ui.mesNombre`. El "# FACTURA" es el ordinal de
   la fila dentro de la OIP, no una columna de la hoja.
7. **Recordatorio mensual** (`37_OipNotify.js`): el día 1,
   `oipn_recordatorioFacturacion` crea la fila del mes que terminó para cada
   OIP vigente (PENDIENTE DE FACTURAR + FECHA NOTIFICACION) y envía **un solo
   correo resumen** a `CFG_().OIP_NOTIF_EMAIL`. Idempotente por mes
   (`OIP_NOTIF_LAST`). Se instala UNA vez con
   `admin_installOipFacturacionTrigger()`; `admin_probarRecordatorioOip()` lo
   prueba sin esperar al día 1 (pero sí crea filas y sí manda el correo).

### Módulos compartidos que salieron de este cambio (no los dupliques)

- **`KGP.tareaModal`** (`ui/JsCore.js.html`): el popup de alta/edición de
  tarea, antes privado de la OIS. Mismo contrato que `KGP.servicioModal`
  (`onSave(datos)` en memoria, nada a la BD). Su HTML
  (`#tarea-modal-overlay`) y `tpl-tarea` viven en `ui/ViewOis.html` pero son
  **globales**, igual que los `tpl-*` de `ui/ViewCotizacion.html`.
- **`KGP.ui.empleadoLabel`** ("Cédula - Nombre (Cargo)") y
  **`KGP.ui.mesNombre`**.
- **`emps_nombreUsuarioActivo_`** (`34_EmpleadoService.js`) y
  **`qs_serviciosFirma_`** (`30_QuoteService.js`): antes eran `ois_*`; las usan
  las dos órdenes. **`doc_ordenBaseName_`** (antes `doc_oisBaseName_`) arma el
  nombre de carpeta/archivo de ambas.

## 12. Gestionar tareas (todas las tareas de OIS y OIP en una vista)

- Vista `data-nav="tareas"`: `ui/ViewTareas.html` + `ui/JsTareas.js.html`,
  servidor en `38_TareaService.js` (`tg_*`). **No hay hoja nueva**: lee y
  escribe las mismas filas de `TAREAS_OIS` / `TAREAS_OIP` con los repos de
  `15_OisRepo.js` / `16_OipRepo.js`, así que un cambio aquí es el mismo dato
  que ven "Gestionar OIS/OIP" y viceversa.
- `api_listTareas` = UN snapshot (tareas + órdenes + empleados + `yo` +
  `hoy` del servidor), cacheado por `dataVersion_()` + día; filtros, KPIs,
  orden y paginación son del cliente. Mismo stale-while-revalidate de §2.2
  (`KGP.localCache` 'tareas:snapshot').
- A diferencia de Gestionar OIS/OIP (que reescriben TODA la lista de tareas
  de una orden al "Guardar cambios"), aquí cada acción toca UNA tarea y se
  guarda al instante: `api_saveTarea` (alta/edición), `api_setTareaEstado`
  (solo la celda ESTADO) y `api_deleteTarea`. Cada una, dentro del lock,
  recalcula y guarda el ESTADO derivado de la orden. Se respetan las mismas
  reglas: OIS Finalizada = solo lectura (CONFLICT), OIP Finalizada sigue
  editable, topes `MAX_TAREAS` / `MAX_TAREAS_OIP`.
- Las escrituras solo se auto-reintentan ante `BUSY` (`WRITE_OPTS`): un
  TRANSPORT/TIMEOUT pudo haber guardado, y reintentar un alta la duplicaría.
- Documentos: tras cada escritura el cliente regenera el documento de la
  orden en segundo plano, con una cola por orden y debounce (varias acciones
  seguidas sobre la misma orden = una sola regeneración, nunca dos en
  paralelo sobre el mismo archivo).
- Sincronía entre vistas: tras escribir, "Gestionar tareas" llama
  `KGP.ois.markStale(id)` / `KGP.oip.markStale(id)`; si esa orden está abierta
  en su vista, al volver se **recarga** (si no, su "Guardar cambios"
  reenviaría la lista vieja y borraría la tarea nueva). A la inversa, Gestionar
  OIS/OIP llaman `KGP.tareas.markStale()` al guardar.
- El popup es el mismo `KGP.tareaModal` (§11): con `opts.ordenes` muestra la
  sección "Orden" (tipo OIS/OIP + código; `ordenFija` al editar = no se puede
  mover una tarea de orden) y acepta un `onSave` que devuelve Promise (se
  queda abierto con "Guardando…" y no se cierra si falla). No crees otro
  formulario de tarea.

## 13. Dashboard: pestañas Cotizaciones / OIS / OIP

- Selector `#dash-modulos` arriba del Dashboard (recordado por navegador en
  `KGP.localCache` 'dashboard:modulo'). **Cotizaciones** sigue siendo
  `JsDashboard.js.html` sin cambios de lógica (solo envuelto en
  `#dash-cot-panel`); **OIS** y **OIP** son UN solo módulo,
  `JsDashboardOrdenes.js.html` (`KGP.dashboardOrdenes`), parametrizado por
  tipo: no dupliques un módulo por tipo de orden.
- `KGP.dashboard.onEnter/onLeave` (al final de `JsDashboard.js.html`) llaman a
  los dos módulos. Cada módulo tiene su propio resumen y "Actualizar" en la
  cabecera (`dash-*` vs `dord-*`), así el polling de uno nunca pisa al otro.
- Servidor: `api_getOrdenesDashboard` → `ds_getOrdenesSnapshot_`
  (`32_DashboardService.js`): UN snapshot con OIS y OIP juntas (cambiar de
  pestaña no cuesta round-trips). El token de versión es
  `dataVersion + fecha de hoy` porque "Vencida" depende del día. Si las hojas
  de un tipo (o `OIP_FACTURACION`) fallan, ese bloque queda vacío con un aviso
  en `avisos` en vez de tumbar el panel.
- KPIs = catálogo declarativo `Vistas` (cada tarjeta es también filtro
  rápido; `solo: 'OIP'` para las de facturación). Aviso "por vencer" de las
  órdenes = 15 días (`DIAS_POR_VENCER`), no 7 como las cotizaciones.
- El Dashboard es de solo lectura también para las órdenes: "Gestionar →"
  lleva a Gestionar OIS/OIP; "Regenerar" solo reintenta el documento.

## 14. Correos — SIEMPRE con la plantilla KGP (requisito permanente del usuario)

- **Todo correo que se cree en este proyecto usa la plantilla
  `assets/Plantilla Correo KGP (standalone).html`**, ya pasada a código en
  `src/04_MailTemplate.js` (`mail_render_` / `mail_send_`). Se respeta su
  diseño tal cual (logo, franja verde, tarjeta `#eef4e4`, botón, bloque
  "Dato destacado", firma "Equipo KGP" y pie verde con dirección/teléfonos/
  correo/web). Lo **único** que cambia entre correos es lo que se le pasa en
  `opts`: `asunto`, `preheader`, `etiqueta`, `titulo`, `saludo`, `parrafos`,
  `boton`, `destacados` (y opcionalmente `firma`/`nota`).
- Nunca llames `MailApp.sendEmail`/`GmailApp` directo ni armes HTML de correo
  en otro archivo. **Un correo nuevo** = (1) una clave nueva en
  `mail_textosDefault_` (04_MailTemplate.js) con ASUNTO/PREHEADER/ETIQUETA/
  TITULO/SALUDO/PARRAFOS/BOTON/DESTACADOS y sus VARIABLES documentadas;
  más `NOMBRE` (para la vista Configuración) y, si tiene destinatario fijo,
  `DESTINO_CFG` (clave de `CFG_()` con sus correos);
  (2) enviarlo con `mail_enviar_(clave, destino, vars, {url, items})`;
  (3) sus variables de muestra en `admin_muestrasCorreo_` (51_Admin.js);
  (4) nada más: su fila en `CONFIG_CORREOS` se agrega sola la próxima vez que
  se abra la vista Configuración (o con `admin_crearHojasConfig()`), y desde
  ahí se editan su asunto, cuerpo, destinatarios fijos y "copia siempre a"
  (§15). Nunca escribas el texto de un correo dentro del
  código que lo envía. Si un correo pide algo que la plantilla no tiene, se
  reutilizan sus bloques (p. ej. una lista de datos = varios `destacados`),
  no se inventa otro diseño.
- Formato (requisito del usuario): botones **centrados**; el texto del cuerpo
  (saludo, párrafos, destacados, firma) **justificado**; párrafos separados
  (un elemento de `parrafos` = un `<p>`) y `\n` = salto de línea. Etiqueta y
  título h1 van a la izquierda, como en la plantilla (un h1 justificado de dos
  líneas se ve roto). Todo texto dinámico pasa por `mail_esc_`.
- Imágenes: `src/05_MailAssets.js` (`mail_assets_()`, base64, **archivo
  generado**) viajan como `inlineImages` y el HTML las usa con `cid:`
  (Gmail no muestra `data:`). El logo está reducido a 300 px (se muestra a
  150 px). Si cambia el logo, se regenera ese archivo, no se edita a mano.
- Para ver cómo se ven: `admin_probarCorreos('correo@x.com')` (51_Admin.js)
  envía un ejemplo de cada clave de `mail_textosDefault_` con los textos
  vigentes (hoja incluida) y datos de muestra, sin tocar la BD.
- Correos que existen hoy (todos en `39_NotifyService.js`, prefijo `ntf_`,
  salvo el recordatorio OIP de §11.7 en `37_OipNotify.js`):
  1. **Cotización creada** → al creador, con código y enlace al documento.
     Sale tras generar el documento (`api_generateDocument` con `requestId`),
     no al guardar en la BD: sin documento no hay enlace.
  2. **Cotización aprobada** → al creador, con el código de la OIS/OIP y el
     enlace a SU documento (`api_generateOisDocument`/`api_generateOipDocument`
     con `requestId`). **Rechazada** → al creador, con el enlace al documento
     de la cotización (`qs_updateQuotation`, fuera del lock, gracias a
     `estadoCambio` que devuelve `qs_applyQuotationUpdate_`).
  3. **Tarea creada** → al responsable (CORREO de `PERSONAL_KGP`): desde
     `tg_saveTarea` (solo altas, editar no avisa) y desde las tareas nuevas
     (sin ID) de `ois_updateOis`/`oip_updateOip`. Título = TAREA,
     descripción = OBSERVACION (no hay otra columna de descripción).
  4. **OIS finalizada** → a contabilidad (`CFG_().OIS_FINALIZADA_EMAIL`, clave
     `OIS_FINALIZADA`): "ya está lista para facturar". El servidor NO la envía
     al escribir: la escritura que deja la OIS Finalizada (`ord_actualizar_`,
     `tg_saveTarea`/`tg_setTareaEstado`/`tg_deleteTarea`) devuelve
     `ordenFinalizada: true` solo en la transición, y el cliente llama
     `KGP.mailCc.avisarOisFinalizada` → `api_avisarOisFinalizada` →
     `ntf_oisFinalizada_` (una sola vez por OIS, marca `NTF_FIN_OIS_<id>`). Solo
     OIS (`avisaFinalizada` del spec), no OIP.
- **Copias (CC) — requisito permanente:** toda acción de usuario que dispare un
  correo debe abrir antes el selector `KGP.mailCc.pedir({...})`
  (`ui/JsCore.js.html`, HTML `#cc-modal-overlay` en `ui/Index.html`): personas
  de la BD con correo (internos + terceros, de `KGP.catalog`) y correos
  escritos a mano. Devuelve `string[]` (puede ir vacío) o `null` si se cancela
  (entonces no se hace la acción). El cliente manda `cc` en la llamada
  (`api_generateDocument`/`api_generate*Document` 3.er argumento,
  `payload.cc` en `api_updateQuotation`/`api_saveTarea`/`api_update*`) y el
  servidor lo pasa a `mail_enviar_(..., {cc})`; `mail_normalizarCc_` depura
  (válidos, sin repetidos, tope `LIMITS.MAX_CC`) y `mail_send_` no repite a
  quien ya es destinatario. Las copias van ADEMÁS del destinatario de siempre
  y el historial las anota en `TO` como `(CC: ...)`. Si el correo queda
  pendiente (documento fallido) las copias se guardan dentro de la marca
  `NTF_PEND_*`. Un correo nuevo que salga de una acción del usuario debe
  seguir este mismo patrón; los automáticos sin usuario (recordatorio OIP) no
  llevan selector.
- "Creador" = `CREADO POR` de la cotización (correo del usuario activo) o,
  si está vacío, el CORREO del empleado `ELABORADO POR`. Con
  `executeAs: USER_DEPLOYING`, `getActiveUser()` puede venir vacío para
  usuarios de fuera del dominio: entonces no hay destinatario y queda
  registrado en `_ERRORES` (etapa `ntf_*`).
- Reglas: los correos **nunca** se envían dentro del script lock y **nunca**
  rompen la operación que los dispara (todo `ntf_*` atrapa y registra con
  `logError_`). Si el documento inicial falla, el correo 1/2 queda pendiente
  (`NTF_PEND_<CTZ|OIS|OIP>_<id>` en ScriptProperties) y sale en la primera
  regeneración exitosa (`api_regenerate*`); los reintentos de la generación
  inicial no lo duplican (marca `ntf:sent:` en caché 6 h).
- **Historial (requisito permanente): todo correo enviado se registra** en
  la pestaña `HISTORIAL` del spreadsheet `CFG_().MAIL_HISTORIAL_SHEET_ID`
  (distinto de la BD principal) con `NUMERO` (autoincremental desde 1),
  `TIMESTAMP`, `FROM`, `TO`, `SUBJECT`, `BODY` (texto plano). Lo hace
  `mail_log_` dentro de `mail_send_` (04_MailTemplate.js) solo si el envío
  no lanzó; por eso un correo nuevo NO debe saltarse `mail_send_`. Nunca
  lanza (un fallo queda en `_ERRORES`); `NUMERO` sale de la última fila, no
  de escanear la columna, con un lock corto. `FROM` = cuenta con la que corre
  la app (`getEffectiveUser`).
- Cuota de `MailApp`: 100 destinatarios/día en cuentas Gmail, 1.500 en
  Workspace. `mail_send_` falla con mensaje claro si se agota.

## 15. Configuración — vista "Configuración" (requisito permanente del usuario)

- **Solo estas cosas son configurables** (decisión del usuario, oct. 2026):
  1. **IDs** de spreadsheets, carpetas y archivos (BD, historial de correos,
     plantilla, carpetas de cotizaciones/OIS/OIP) → hoja `CONFIG_IDS`
     (`GRUPO | CLAVE | NOMBRE | VALOR | DESCRIPCION | ENLACE`).
  2. **Correos**: destinatarios fijos (solo `OIS_FINALIZADA` y
     `OIP_RECORDATORIO`, vía `DESTINO_CFG`), "copia siempre a", y asunto +
     cuerpo (`mail_camposTexto_`: ASUNTO, TITULO, SALUDO, PARRAFOS, BOTON,
     DESTACADOS) → hoja `CONFIG_CORREOS`, una fila por correo. PREHEADER,
     ETIQUETA, firma, remitente y pie quedan solo en el código.
  3. **Tipos de servicio** → hoja `TIPOS DE SERVICIOS` (11_CatalogRepo.js,
     `cat_guardarTipo_` / `cat_eliminarTipo_`).
  4. **Contadores de los consecutivos** (pestaña "Consecutivos"): cotización,
     OIS y OIP. Se edita el "último número usado" (la marca de agua `SEQ_YY` /
     `SEQ_OIS_YY` / `SEQ_OIP` de ScriptProperties, `code_guardarContador_` en
     `20_Ids.js`, `api_saveConsecutivo`): el siguiente código es ese + 1. Solo
     puede subir o igualar lo que ya existe en la hoja (bajar de ahí repetiría
     códigos); 0-999. Cotización y OIS son del año en curso (reinician cada
     año); la OIP es global. `code_spec_(tipo)` define hoja/prefijo/marca de
     cada contador y lo comparten las reservas y la vista.
- **Todo lo demás vive SOLO en el código** y se cambia ahí: plazos, IVA,
  límites, días "por vencer", polling, caché, prefijos, nombres de pestañas
  (`TABS`), etiquetas, `CELLMAP_()` (celdas de la plantilla) y los datos fijos
  del correo. Las hojas antiguas `CONFIG_LEEME`, `CONFIG_HOJAS`,
  `CONFIG_GENERAL`, `CONFIG_CORREO`, `CONFIG_CORREO_TEXTOS` y `CONFIG_CELDAS`
  ya no existen: `cfgs_asegurarHojas_` las migra (lo que sigue siendo
  configurable) y las borra la primera vez que se abre la vista o con
  `admin_crearHojasConfig()`. **No vuelvas a crear hojas `CONFIG_*` para otros
  parámetros** sin que el usuario lo pida.
- Las tres hojas viven en el spreadsheet de catálogo (`cfgs_sheetId_()` =
  `CFG_().CAT_SHEET_ID`, 1n87Kj1w...) y se editan desde la vista
  **Configuración** (`ui/ViewConfig.html` + `ui/JsConfig.js.html`,
  `KGP.config`; última del menú, §9): `api_getConfiguracion` (siempre fresco,
  nunca `KGP.localCache`), `api_saveConfigIds`, `api_saveConfigCorreo`,
  `api_saveTipoServicio`, `api_deleteTipoServicio`, todos con
  `tx_conLock_`. Guardar IDs comprueba antes que cada archivo/carpeta exista
  y sea accesible (acepta el enlace completo); cambiar la BD pide doble clic.
  Tras guardar tipos, la vista refresca `KGP.catalog`.
- **Se lee SIEMPRE al cargar la página**: `doGet` llama `cfgs_refresh_()`
  (una apertura del spreadsheet, `CONFIG_IDS` + `CONFIG_CORREOS`) y lo deja en
  CacheService (`cfgsheet:data:v2`, 6 h); `google.script.run` y los
  disparadores usan esa copia (memo `repo_memo_().__cfgs`). Guardar desde la
  vista también la refresca. No quites esa lectura de `doGet` (pedido del
  usuario).
- **Cómo se aplica**: `cfgs_aplicar_(cfg)` pone sobre `CFG_()` solo las
  claves de la allowlist (`cfgs_catalogoIds_` + los `DESTINO_CFG`); celda
  vacía = valor del código. `mail_textos_(clave)`: si el correo tiene fila,
  manda la fila (un campo vacío queda vacío, p. ej. sin botón) salvo ASUNTO y
  PARRAFOS, que vacíos vuelven al texto del código; `CC` = "copia siempre a",
  que `mail_construir_` suma a las copias del popup (§14). `CAT_SHEET_ID` es
  de solo lectura. `admin_verConfig()` lista lo ignorado y la config efectiva.
- **Agregar un ID configurable**: su default en `CFG_()` + su fila en
  `cfgs_catalogoIds_()`. **Agregar un correo**: ver §14 (aparece solo en
  `CONFIG_CORREOS`). Nunca leas `CONFIG_*` por tu cuenta desde otro módulo:
  todo pasa por `CFG_()` o `mail_textos_()`.
- **Navegador**: los parámetros que usa el cliente (IVA, límites, días por
  vencer, polling...) salen del código y los inyecta `doGet` en
  `window.KGP_CONFIG` (`cfgs_clientConfig_`); se leen con
  `KGP.cfg('CLAVE', def)` / `KGP.cfgTexto`. No escribas esos números fijos en
  un `Js*.js.html`: si el servidor tiene el parámetro en `CFG_()`, el cliente
  lo toma de ahí.
- Seguridad: la web app es `access: ANYONE` sin roles, así que cualquiera con
  el enlace puede abrir Configuración (igual que el resto de la app).
- Anti-recursión: nada de lo que use `cfgs_leerHoja_`/`cfgs_overrides_` puede
  llamar `CFG_()` (por eso el ID del spreadsheet está en `cfgs_sheetId_`).
  `cfgs_sinHoja_(fn)` ejecuta `fn` viendo solo los valores del código.

## 16. Gestión de clientes y personal tercero

- **Gestión de clientes** (`data-nav="clientes"`): `ui/ViewClientes.html` +
  `ui/JsClientes.js.html`, servidor `40_ClienteService.js` (`clis_*`).
  Listado (`api_listClientesGestion`, todos los clientes con nº de contactos,
  establecimientos y cotizaciones; caché por `dataVersion_()`) y detalle
  (`api_getClienteGestion`: datos + contactos + establecimientos + historial
  de cotizaciones, siempre fresco). Altas/ediciones = `KGP.entityModal` + los
  `api_create*`/`api_update*` de siempre (no se duplican). Encargado de un
  establecimiento: desplegable por fila, `api_setEncargadoEstablecimiento`
  (la FK sigue viviendo en `CONTACTOS_CLIENTES.ID ESTABLECIMIENTO`).
  `KGP.clientes.openDetail(idCliente)` abre un cliente desde otra vista.
- **Borrar = borrar la fila** (decisión del usuario), pero el servidor lo
  rechaza (CONFLICT, con los códigos) si alguna cotización usa el registro:
  cliente (`ID CLIENTE`), contacto (`ID SOLICITANTE`), establecimiento
  (`ID ESTABLECIMIENTO`). Borrar un cliente sin cotizaciones borra también
  sus contactos y establecimientos.
- **Personal tercero**: hoja `PERSONAL_TERCEROS` (`CFG_().TABS.PERSONAL_TERCEROS`),
  mismas columnas que `PERSONAL_KGP`. `14_EmpleadoRepo.js` es UN solo código
  para las dos con el parámetro `tipo` (`CFG_().TIPO_RESPONSABLE_INTERNO` /
  `_TERCERO`; sin tipo = interno). IDs nuevos con `ID_PREFIJO_EMPLEADO` /
  `ID_PREFIJO_TERCERO`. `api_listEmpleados/create/update/delete` reciben el
  tipo como último argumento. "Gestión de empleados" tiene el selector
  Internos / Terceros (`#emp-tipos`, control `.seg-control`).
- **Responsable de una tarea** (OIS, OIP, Gestionar tareas — decisión del
  usuario: solo tareas, no servicios): el popup `KGP.tareaModal` muestra
  "¿Quién realiza la tarea?" (Interno / Tercero) y filtra el desplegable;
  envía `tipoResponsable`. Candidatos = `KGP.ui.responsables(cat)` (cliente) /
  `emp_listResponsables_()` (servidor); resolución con
  `emp_buscarResponsable_(lista, id, tipo)` (sin tipo = busca el ID en las
  dos hojas). Se guarda en la columna OPCIONAL `TIPO RESPONSABLE` de
  `TAREAS_OIS`/`TAREAS_OIP`; sin ella el tipo se deduce de la hoja donde está
  el ID. El asesor comercial, ELABORADO POR y REVISADO POR siguen siendo
  solo internos (`emp_getEmpleado_`, `emp_findByCorreo_`).
- Tras crear/editar/borrar clientes o personal, la vista llama
  `KGP.catalog.load(true)` en segundo plano: los desplegables de las demás
  vistas (cliente, responsable) salen de ahí.

## 17. Historial de cambios de las tareas (requisito del usuario, oct. 2026)

- Hoja `HISTORIAL_TAREAS` (BD principal, `CFG_().TABS.HISTORIAL_TAREAS`):
  una fila por cambio de una tarea de OIS u OIP, con `FECHA`, `USUARIO`
  (nombre en `PERSONAL_KGP` por correo, o el correo; "Usuario no
  identificado" si `getActiveUser()` viene vacío), `CORREO USUARIO`,
  `ACCION` (CREADA / EDITADA / FINALIZADA / REABIERTA / ELIMINADA) y
  `DETALLE` ("Campo: antes → después", una línea por campo). Nunca se edita
  ni se borra. Además `TAREAS_OIS`/`TAREAS_OIP` tienen `ACTUALIZADO POR` /
  `ACTUALIZADO EN` (opcionales) con el último cambio. Todo lo prepara
  `admin_prepararHistorialTareas()` (51_Admin.js, idempotente).
- Código: `42_HistorialTareas.js` (`htar_*`). **Toda escritura de tareas**
  registra con `htar_diff_` + `htar_registrar_` DENTRO de su lock:
  `tg_saveTarea` / `tg_setTareaEstado` / `tg_deleteTarea` y
  `ord_sincronizarTareas_` (Guardar cambios de OIS/OIP). Si agregas otra
  ruta que escriba tareas, haz lo mismo. Un guardado sin cambios visibles no
  deja fila ni cambia el sello; `ord_sincronizarTareas_` ya no reescribe
  tareas idénticas.
- `htar_registrar_` nunca lanza (fallo -> `_ERRORES`): el historial no puede
  tumbar una escritura de tareas que ya ocurrió.
- Lectura: `api_getHistorialTareas({tipo, idTarea | idOrden})`, bajo demanda
  (nunca desde el snapshot ni una carga de vista: la hoja solo crece), tope
  `LIMITS.MAX_HISTORIAL_TAREAS`. Por orden incluye las tareas eliminadas.
- UI: popup global `KGP.historialTareas` (`#ht-modal-overlay` en
  `ui/Index.html`): botón reloj por tarea (Gestionar tareas y `tpl-tarea`;
  en una OIS finalizada es el único que queda visible) y "Historial de
  cambios" por orden en Gestionar OIS/OIP. No lo dupliques.
