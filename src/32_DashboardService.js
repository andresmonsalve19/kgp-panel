/**
 * Snapshot y KPIs del dashboard.
 *
 * ⚠️ TRAMPA CENTRAL DEL PROYECTO: COTIZACIONES tiene una fila POR SERVICIO.
 * Todo lo que cuenta "cotizaciones" agrupa primero por ID COTIZACION
 * distinto (ds_groupCotizaciones_) y calcula KPIs sobre ese agregado
 * (ds_computeKpis_), nunca sobre las filas crudas.
 *
 * Dos endpoints, dos consumidores:
 *
 *  - ds_getDashboard_  → listado paginado y filtrado EN EL SERVIDOR. Lo usa
 *    "Gestionar cotización" (JsGestion.js.html), que solo necesita una
 *    página de la tabla a la vez.
 *
 *  - ds_getSnapshot_   → snapshot COMPLETO y enriquecido, una sola vez por
 *    versión de datos. Lo usa el Dashboard (JsDashboard.js.html), que
 *    filtra, ordena, pagina y grafica en el cliente: cambiar un filtro,
 *    ordenar, cambiar de página o pulsar un KPI no cuesta ningún
 *    round-trip.
 *
 * Ambos comparten el protocolo de versión (si sinceVersion coincide con la
 * versión vigente devuelven {unchanged:true} sin tocar ningún Sheet) y la
 * caché por versión, así que el costo real es UNA lectura de hojas por cada
 * escritura efectiva en la base, no una por carga de página.
 */

// =====================================================================
// Endpoint 1 — listado paginado (Gestionar cotización)
// =====================================================================

/**
 * params: {sinceVersion, anio, estado, q, page, pageSize, sortBy, sortDir}.
 * Si sinceVersion coincide con la versión vigente, devuelve
 * {unchanged:true, version} sin tocar ningún Sheet.
 */
function ds_getDashboard_(params) {
  params = params || {};
  var currentVersion = dataVersion_();

  if (params.sinceVersion != null && Number(params.sinceVersion) === currentVersion) {
    return ok_({ unchanged: true, version: currentVersion });
  }

  var filters = {
    anio: params.anio ? Number(params.anio) : null,
    estado: params.estado || null,
    q: normText_(params.q || ''),
    page: clamp_(params.page || 1, 1, 100000),
    pageSize: clamp_(params.pageSize || 20, 1, 200),
    sortBy: ds_sortFields_().indexOf(params.sortBy) !== -1 ? params.sortBy : 'codigo',
    sortDir: params.sortDir === 'desc' ? 'desc' : 'asc'
  };

  var cacheKey = 'dash:' + JSON.stringify(filters) + ':v' + currentVersion;
  var cached = cacheGetJson_(cacheKey);
  if (cached) return ok_(cached);

  var snapshot = ds_buildSnapshot_();

  var filtered = snapshot.all.filter(function (c) {
    if (filters.anio && c.anio !== filters.anio) return false;
    if (filters.estado && c.estado !== filters.estado) return false;
    if (filters.q) {
      var hay = normText_(c.codigo + ' ' + c.clienteNombre);
      if (hay.indexOf(filters.q) === -1) return false;
    }
    return true;
  });

  // Por defecto, orden por CODIGO ascendente (a petición explícita del
  // usuario: antes siempre ordenaba por fecha, sin importar la columna
  // elegida en la UI). El resto de columnas son elegibles desde los
  // controles de ordenado del Dashboard / "Gestionar cotización".
  var dir = filters.sortDir === 'desc' ? -1 : 1;
  filtered.sort(function (a, b) { return dir * ds_compare_(a, b, filters.sortBy); });

  var total = filtered.length;
  var start = (filters.page - 1) * filters.pageSize;
  var pageRows = filtered.slice(start, start + filters.pageSize);

  var payload = {
    version: currentVersion,
    kpis: snapshot.kpis,
    rows: pageRows,
    total: total,
    page: filters.page,
    pageSize: filters.pageSize
  };

  cachePutJson_(cacheKey, payload, CFG_().CACHE_TTL.DASHBOARD_S);
  return ok_(payload);
}

/** Columnas por las que se puede ordenar la tabla (Dashboard / "Gestionar cotización"). */
function ds_sortFields_() {
  return ['codigo', 'cliente', 'fechaElaboracion', 'fechaVencimiento', 'estado', 'numServicios'];
}

/** Comparador para el ordenado de la tabla (Dashboard / "Gestionar cotización"), ascendente por defecto. */
function ds_compare_(a, b, sortBy) {
  switch (sortBy) {
    case 'cliente':
      return String(a.clienteNombre || '').localeCompare(String(b.clienteNombre || ''));
    case 'fechaElaboracion':
      return String(a.fechaElaboracion || '').localeCompare(String(b.fechaElaboracion || ''));
    case 'fechaVencimiento':
      return String(a.fechaVencimiento || '').localeCompare(String(b.fechaVencimiento || ''));
    case 'estado':
      return String(a.estado || '').localeCompare(String(b.estado || ''));
    case 'numServicios':
      return (a.numServicios || 0) - (b.numServicios || 0);
    case 'codigo':
    default:
      return String(a.codigo || '').localeCompare(String(b.codigo || ''));
  }
}

// =====================================================================
// Endpoint 2 — snapshot completo (Dashboard)
// =====================================================================

/**
 * Snapshot completo para el Dashboard reactivo: TODAS las cotizaciones
 * agregadas por ID COTIZACION, con lo necesario para que el cliente pueda
 * derivar KPIs, gráficas, filtros, orden y paginación sin volver al
 * servidor. Una sola llamada por versión de datos.
 *
 * params: {sinceVersion}. Si coincide con la versión vigente devuelve
 * {unchanged:true, version} — lectura de ScriptProperties, ~20 ms, sin
 * abrir ninguna hoja.
 *
 * El detalle por servicio (descripción, actividades, observaciones) NO
 * viaja aquí: se pide bajo demanda con api_getCotizacion al expandir una
 * fila. Lo que sí viaja es el resumen por tipo de servicio
 * (`tipos: [[tipo, n, total], ...]`), que es lo único que la gráfica
 * "Servicios por tipo" necesita y cabe en unos pocos bytes por cotización.
 */
function ds_getSnapshot_(params) {
  params = params || {};
  var currentVersion = dataVersion_();

  if (params.sinceVersion != null && Number(params.sinceVersion) === currentVersion) {
    return ok_({ unchanged: true, version: currentVersion });
  }

  var cacheKey = 'dash:snap:v' + currentVersion;
  var cached = cacheGetJson_(cacheKey);
  if (cached) return ok_(cached);

  var payload = ds_buildFullSnapshot_(currentVersion);
  cachePutJson_(cacheKey, payload, CFG_().CACHE_TTL.DASHBOARD_SNAPSHOT_S);
  return ok_(payload);
}

/**
 * Arma el payload de ds_getSnapshot_. Lee cada hoja UNA sola vez
 * (repo_readTable_ memoiza por ssId+tabName dentro de la ejecución) y
 * resuelve los nombres de cliente / contacto / establecimiento con mapas en
 * memoria, nunca con una llamada por cotización.
 */
function ds_buildFullSnapshot_(version) {
  var cfg = CFG_();
  var todas = ds_buildSnapshot_({ enriquecer: true }).all;

  // Más recientes primero: si hay que recortar por el tope, lo que se pierde
  // es el historial más viejo, no lo que el usuario mira todos los días.
  todas.sort(function (a, b) {
    return String(b.fechaElaboracion || '').localeCompare(String(a.fechaElaboracion || '')) ||
      String(b.codigo || '').localeCompare(String(a.codigo || ''));
  });

  var tope = cfg.LIMITS.DASHBOARD_MAX_COTIZACIONES;
  var truncado = todas.length > tope;
  var cotizaciones = truncado ? todas.slice(0, tope) : todas;

  // Catálogos derivados del propio snapshot: así los desplegables de la UI
  // solo ofrecen valores que de verdad producen resultados.
  var clientesVistos = {};
  var aniosVistos = {};
  cotizaciones.forEach(function (c) {
    if (c.idCliente && !clientesVistos[c.idCliente]) clientesVistos[c.idCliente] = c.clienteNombre || c.idCliente;
    if (c.anio) aniosVistos[c.anio] = true;
  });

  return {
    version: version,
    generadoEn: new Date().toISOString(),
    hoy: toISODate_(new Date()),
    ivaTasa: cfg.IVA_TASA,
    estados: cfg.ESTADOS.slice(),
    truncado: truncado,
    totalReal: todas.length,
    cotizaciones: cotizaciones,
    clientes: Object.keys(clientesVistos).map(function (id) {
      return { idCliente: id, nombre: clientesVistos[id] };
    }).sort(function (a, b) { return a.nombre.localeCompare(b.nombre); }),
    anios: Object.keys(aniosVistos).map(Number).sort(function (a, b) { return b - a; })
  };
}

// =====================================================================
// Construcción del agregado por cotización (compartido)
// =====================================================================

/**
 * Agrupa las filas de COTIZACIONES por ID COTIZACION y calcula KPIs sobre
 * el agregado.
 *
 * opts.enriquecer: agrega lo que solo necesita el Dashboard (totales,
 * contacto, establecimiento, resumen por tipo de servicio). Se deja
 * opt-in para que "Gestionar cotización", que no muestra nada de eso, no
 * pague la lectura de SERVICIOS / CONTACTOS / ESTABLECIMIENTOS.
 */
function ds_buildSnapshot_(opts) {
  opts = opts || {};
  var enriquecer = !!opts.enriquecer;

  var all = ds_groupCotizaciones_(enriquecer);
  var hoy = toISODate_(new Date());
  var cfg = CFG_();

  all.forEach(function (c) {
    c.anio = c.fechaElaboracion ? Number(c.fechaElaboracion.slice(0, 4)) : null;
    c.diasRestantes = c.fechaVencimiento ? ds_diffDays_(hoy, c.fechaVencimiento) : null;
    c.vencidaSinDecision = c.estado === cfg.ESTADO_INICIAL && c.diasRestantes != null && c.diasRestantes < 0;
    c.porVencer = c.estado === cfg.ESTADO_INICIAL && c.diasRestantes != null && c.diasRestantes >= 0 && c.diasRestantes <= cfg.DIAS_POR_VENCER_COTIZACION;
  });

  return { all: all, kpis: ds_computeKpis_(all, hoy) };
}

/**
 * Colapsa las N filas de COTIZACIONES de una misma cotización en un solo
 * objeto. Devuelve el array en el orden de aparición en la hoja.
 */
function ds_groupCotizaciones_(enriquecer) {
  var table = qr_tableCotizaciones_();
  var COL = {
    id: normText_('ID COTIZACION'),
    codigo: normText_('CODIGO'),
    idCliente: normText_('ID CLIENTE'),
    idSolicitante: normText_('ID SOLICITANTE'),
    idEstablecimiento: normText_('ID ESTABLECIMIENTO'),
    fechaElab: normText_('FECHA ELABORACION'),
    fechaVenc: normText_('FECHA VENCIMIENTO'),
    plazo: normText_('PLAZO'),
    estado: normText_('ESTADO'),
    url: normText_('URL DOCUMENTO'),
    docEstado: normText_('DOC ESTADO'),
    subtotal: normText_('SUBTOTAL'),
    iva: normText_('IVA'),
    total: normText_('TOTAL')
  };

  var groups = {};
  var order = [];

  table.rows.forEach(function (row) {
    var id = row[COL.id];
    if (!id) return;
    if (!groups[id]) {
      var c = {
        idCotizacion: id,
        codigo: row[COL.codigo],
        idCliente: row[COL.idCliente],
        fechaElaboracion: qs_dateToISO_(row[COL.fechaElab]),
        fechaVencimiento: qs_dateToISO_(row[COL.fechaVenc]),
        estado: qs_normEstado_(row[COL.estado]),
        urlDocumento: row[COL.url] || '',
        docEstado: row[COL.docEstado] || '',
        numServicios: 0
      };
      if (enriquecer) {
        c.idSolicitante = row[COL.idSolicitante] || '';
        c.idEstablecimiento = row[COL.idEstablecimiento] || '';
        c.plazo = qr_num_(row[COL.plazo]);
        // Los totales se escriben iguales en todas las filas de la
        // cotización: basta leerlos de la primera.
        c.subtotal = qr_num_(row[COL.subtotal]);
        c.iva = qr_num_(row[COL.iva]);
        c.total = qr_num_(row[COL.total]);
      }
      groups[id] = c;
      order.push(id);
    }
    groups[id].numServicios++;
  });

  var all = order.map(function (id) { return groups[id]; });
  ds_resolverNombres_(all, enriquecer);
  if (enriquecer) ds_resolverTiposServicio_(all);
  return all;
}

/**
 * Resuelve los nombres legibles (cliente siempre; contacto y
 * establecimiento solo al enriquecer) con un mapa por hoja, no con N
 * llamadas a cli_getCliente_ / con_getContacto_ / est_getEstablecimiento_.
 */
function ds_resolverNombres_(all, enriquecer) {
  var nombreCliente = ds_indexarPorId_(cli_table_(), 'ID CLIENTE', function (r) {
    return r[normText_('RAZON SOCIAL')];
  });

  // CONTACTOS y ESTABLECIMIENTOS son secundarios para el dashboard: solo
  // aportan la etiqueta bajo el nombre del cliente y una línea del detalle.
  // Si alguna de esas hojas tiene un problema de esquema, el panel degrada
  // esas etiquetas a vacío en vez de dejar de funcionar por completo (mismo
  // criterio que las columnas `optional` de SCHEMA_()).
  var nombreContacto = {}, nombreEstablecimiento = {};
  if (enriquecer) {
    nombreContacto = ds_indexarSeguro_('CONTACTOS_CLIENTES', function () {
      return ds_indexarPorId_(con_table_(), 'ID CONTACTO', function (r) {
        return joinNonEmpty_([r[normText_('NOMBRE')], r[normText_('CARGO')]], ' · ');
      });
    });
    nombreEstablecimiento = ds_indexarSeguro_('ESTABLECIMIENTOS_CLIENTES', function () {
      return ds_indexarPorId_(est_table_(), 'ID ESTABLECIMIENTO', function (r) {
        return joinNonEmpty_([r[normText_('NOMBRE')], r[normText_('CIUDAD')]], ', ');
      });
    });
  }

  all.forEach(function (c) {
    c.clienteNombre = nombreCliente[c.idCliente] || '';
    if (!enriquecer) return;
    c.contactoNombre = nombreContacto[c.idSolicitante] || '';
    c.establecimientoNombre = nombreEstablecimiento[c.idEstablecimiento] || '';
  });
}

/**
 * Ejecuta un indexado que depende de una hoja secundaria. Si la hoja falta o
 * su esquema no cuadra, devuelve un mapa vacío y deja el rastro en _ERRORES
 * en vez de tumbar el dashboard entero.
 */
function ds_indexarSeguro_(nombreHoja, fn) {
  try {
    return fn();
  } catch (e) {
    logError_('ds_indexarSeguro_', null, { hoja: nombreHoja }, null, e);
    return {};
  }
}

/** {valorDeLaColumnaId: etiqueta} a partir de una tabla ya leída. */
function ds_indexarPorId_(table, idColName, labelFn) {
  var col = normText_(idColName);
  var map = {};
  table.rows.forEach(function (r) {
    var id = r[col];
    if (id) map[id] = labelFn(r);
  });
  return map;
}

/**
 * Agrega los servicios de cada cotización por TIPO:
 * `c.tipos = [[tipo, cantidadDeServicios, sumaDeTotales], ...]`.
 *
 * Tuplas en vez de objetos a propósito: es lo único que la gráfica
 * "Servicios por tipo" necesita y viaja mucho más liviano en el JSON que
 * va al cliente.
 */
function ds_resolverTiposServicio_(all) {
  var table = qr_tableServicios_();
  var COL = {
    idCot: normText_('ID COTIZACION'),
    tipo: normText_('TIPO'),
    total: normText_('TOTAL')
  };

  var porCotizacion = {};
  table.rows.forEach(function (r) {
    var idCot = r[COL.idCot];
    if (!idCot) return;
    var tipo = String(r[COL.tipo] || '').trim() || 'Sin tipo';
    var total = qr_num_(r[COL.total]) || 0;
    var acc = porCotizacion[idCot] || (porCotizacion[idCot] = {});
    var t = acc[tipo] || (acc[tipo] = [tipo, 0, 0]);
    t[1]++;
    t[2] += total;
  });

  all.forEach(function (c) {
    var acc = porCotizacion[c.idCotizacion];
    c.tipos = acc ? Object.keys(acc).map(function (k) { return acc[k]; }) : [];
  });
}

// =====================================================================
// Endpoint 3 — snapshot de órdenes (Dashboard → pestañas OIS / OIP)
// =====================================================================

/**
 * Snapshot COMPLETO de las OIS y OIP para las pestañas "OIS" / "OIP" del
 * Dashboard (JsDashboardOrdenes.js.html). Mismo contrato que
 * ds_getSnapshot_: el cliente deriva KPIs, gráficas, filtros, orden y
 * paginación sin volver al servidor, y hace polling barato con el protocolo
 * de versión.
 *
 * A diferencia de las cotizaciones, el ESTADO de una orden ("Vencida") y sus
 * tareas vencidas dependen del día, no solo de las escrituras: por eso el
 * token de versión es dataVersion + fecha de hoy (cambia solo a medianoche,
 * mismo criterio que los listados de OIS/OIP).
 *
 * params: {sinceVersion}. Si coincide con el token vigente devuelve
 * {unchanged:true, version} sin abrir ninguna hoja.
 */
function ds_getOrdenesSnapshot_(params) {
  params = params || {};
  var hoy = toISODate_(new Date());
  var token = 'v' + dataVersion_() + ':' + hoy;

  if (params.sinceVersion && String(params.sinceVersion) === token) {
    return ok_({ unchanged: true, version: token });
  }

  var cacheKey = 'dash:ordenes:' + token;
  var cached = cacheGetJson_(cacheKey);
  if (cached) return ok_(cached);

  var payload = ds_buildOrdenesSnapshot_(token, hoy);
  cachePutJson_(cacheKey, payload, CFG_().CACHE_TTL.DASHBOARD_SNAPSHOT_S);
  return ok_(payload);
}

/**
 * Una entrada por orden (OIS u OIP), con su estado derivado para hoy, el
 * resumen de sus tareas, la carga pendiente por responsable y (solo OIP) su
 * facturación — todo en tuplas compactas, igual que `tipos` del snapshot de
 * cotizaciones. Cada hoja se lee una sola vez.
 *
 * Degradación: si las hojas de un tipo de orden fallan (p. ej. falta una
 * columna), ese tipo queda vacío con un aviso en `avisos` en vez de tumbar
 * también el otro; lo mismo con OIP_FACTURACION.
 */
function ds_buildOrdenesSnapshot_(token, hoy) {
  var cfg = CFG_();
  var avisos = [];

  var cotPorId = ord_indiceCotizaciones_();
  var clientePorId = ord_indiceClientes_();
  // Tareas "por vencer": entrega dentro de DIAS_POR_VENCER_TAREAS (hoja CONFIG_GENERAL).
  var semana = toISODate_(addDays_(parseISODate_(hoy), cfg.DIAS_POR_VENCER_TAREAS));

  function construir(spec, factPorOrden) {
    var tipo = spec.tipo;
    var idKey = spec.idKey;
    var tareasPorOrden = ord_tareasPorOrden_(spec, function (t) { return ord_tareaToDto_(t); });
    return spec.listAll().map(function (o) {
      var tareas = tareasPorOrden[o[idKey]] || [];
      var dto = ord_toDto_(spec, o, tareas, hoy);
      var cot = cotPorId[o.idCotizacion] || {};

      var resumen = { total: tareas.length, finalizadas: 0, vencidas: 0, porVencer: 0 };
      var carga = {};
      tareas.forEach(function (t) {
        if (t.estado === cfg.TAREA_ESTADO_FINALIZADA) { resumen.finalizadas++; return; }
        var vencida = !!t.fechaEntrega && t.fechaEntrega < hoy;
        if (vencida) resumen.vencidas++;
        else if (t.fechaEntrega && t.fechaEntrega <= semana) resumen.porVencer++;
        var nombre = t.responsable || 'Sin responsable';
        var c = carga[nombre] || (carga[nombre] = [nombre, 0, 0]);
        c[1]++;
        if (vencida) c[2]++;
      });

      var item = {
        tipo: tipo,
        idOrden: o[idKey],
        codigo: dto.codigo || '',
        idCotizacion: dto.idCotizacion || '',
        codigoCotizacion: cot.codigo || '',
        idCliente: cot.idCliente || '',
        clienteNombre: (cot.idCliente && clientePorId[cot.idCliente]) || '',
        fechaElaboracion: dto.fechaElaboracion || '',
        fechaVencimiento: dto.fechaVencimiento || '',
        plazo: dto.plazo,
        estado: dto.estado,
        anio: dto.fechaElaboracion ? Number(String(dto.fechaElaboracion).slice(0, 4)) : null,
        diasRestantes: dto.fechaVencimiento ? ds_diffDays_(hoy, dto.fechaVencimiento) : null,
        urlDocumento: dto.urlDocumento || '',
        docEstado: dto.docEstado || '',
        tareas: resumen,
        // [[responsable, pendientes, vencidas], ...]
        carga: Object.keys(carga).map(function (k) { return carga[k]; })
      };
      // [[año, mes, cuota, facturado (1|0)], ...]
      if (factPorOrden) item.fact = factPorOrden[o[idKey]] || [];
      return item;
    });
  }

  var ordenes = [];
  try {
    ordenes = ordenes.concat(construir(ord_spec_('OIS'), null));
  } catch (e) {
    logError_('ds_buildOrdenesSnapshot_', null, { tipo: 'OIS' }, null, e);
    avisos.push('No se pudieron leer las OIS: ' + errMsg_(e));
  }

  try {
    var factPorOip = null;
    try {
      factPorOip = {};
      var todas = fac_getAllByOip_();
      Object.keys(todas).forEach(function (idOip) {
        factPorOip[idOip] = todas[idOip].map(function (f) {
          var dto = oip_facturaToDto_(f.obj);
          return [dto.year, dto.mes, Number(dto.cuota) || 0, dto.estado === cfg.FACT_ESTADO_FACTURADO ? 1 : 0];
        });
      });
    } catch (eFac) {
      logError_('ds_buildOrdenesSnapshot_', null, { hoja: 'OIP_FACTURACION' }, null, eFac);
      avisos.push('No se pudo leer la facturación de las OIP: ' + errMsg_(eFac));
      factPorOip = {};
    }
    ordenes = ordenes.concat(construir(ord_spec_('OIP'), factPorOip));
  } catch (e2) {
    logError_('ds_buildOrdenesSnapshot_', null, { tipo: 'OIP' }, null, e2);
    avisos.push('No se pudieron leer las OIP: ' + errMsg_(e2));
  }

  return {
    version: token,
    generadoEn: new Date().toISOString(),
    hoy: hoy,
    estados: cfg.ESTADOS_OIS.slice(), // mismas 3 etiquetas para OIS y OIP
    ordenes: ordenes,
    avisos: avisos
  };
}

/** Días de isoDesde a isoHasta ('yyyy-MM-dd'); null si alguna fecha es inválida. */
function ds_diffDays_(isoDesde, isoHasta) {
  var a = parseISODate_(isoDesde), b = parseISODate_(isoHasta);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** KPIs agregados por cotización distinta (all ya viene deduplicado por ID COTIZACION). */
function ds_computeKpis_(all, hoy) {
  var anioActual = Number(hoy.slice(0, 4));
  var semanaInicio = toISODate_(addDays_(parseISODate_(hoy), -7));
  var mesActual = hoy.slice(0, 7);

  var totalAnio = 0, enRevision = 0, aprobado = 0, rechazado = 0;
  var porVencer = 0, vencidas = 0, docError = 0, sumServicios = 0;
  var creadasHoy = 0, creadasSemana = 0, creadasMes = 0;
  var cfg = CFG_(); // una sola lectura de ScriptProperties, no una por cotización

  all.forEach(function (c) {
    if (c.anio === anioActual) totalAnio++;
    if (c.estado === cfg.ESTADO_INICIAL) enRevision++;
    else if (c.estado === cfg.ESTADO_APROBADA) aprobado++;
    else if (c.estado === cfg.ESTADO_RECHAZADA) rechazado++;
    if (c.porVencer) porVencer++;
    if (c.vencidaSinDecision) vencidas++;
    if (c.docEstado === 'ERROR') docError++;
    sumServicios += c.numServicios;
    if (c.fechaElaboracion === hoy) creadasHoy++;
    if (c.fechaElaboracion >= semanaInicio) creadasSemana++;
    if (c.fechaElaboracion && c.fechaElaboracion.slice(0, 7) === mesActual) creadasMes++;
  });

  var decididas = aprobado + rechazado;

  return {
    totalCotizaciones: all.length,
    totalAnio: totalAnio,
    porEstado: { enRevision: enRevision, aprobado: aprobado, rechazado: rechazado },
    tasaAprobacion: decididas ? Math.round((aprobado / decididas) * 1000) / 10 : null,
    porVencer7d: porVencer,
    vencidasSinDecision: vencidas,
    docConError: docError,
    creadasHoy: creadasHoy,
    creadasSemana: creadasSemana,
    creadasMes: creadasMes,
    promedioServiciosPorCotizacion: all.length ? Math.round((sumServicios / all.length) * 10) / 10 : 0
  };
}
