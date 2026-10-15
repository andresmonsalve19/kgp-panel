/**
 * Recordatorio mensual de facturación de las OIP.
 *
 * El día 1 de cada mes (disparador de tiempo instalado con
 * admin_installOipFacturacionTrigger, ver 51_Admin.js) corre
 * oipn_recordatorioFacturacion: para cada OIP que estuvo vigente durante el
 * mes que acaba de terminar, se asegura de que exista su fila en
 * OIP_FACTURACION (la crea PENDIENTE DE FACTURAR si no está, con FECHA
 * NOTIFICACION = hoy) y envía UN correo resumen a CFG_().OIP_NOTIF_EMAIL.
 *
 * Decisiones confirmadas con el usuario:
 *   - El proceso SÍ crea la fila del mes anterior si no existe (así, al abrir
 *     la OIP, la fila ya está esperando y solo hay que ponerle cuota y número
 *     de factura).
 *   - Un solo correo con todas las OIP pendientes, no uno por OIP.
 *
 * Protecciones: una marca en ScriptProperties ('OIP_NOTIF_LAST' = 'yyyy-MM'
 * del mes facturado) evita que una segunda ejecución el mismo mes duplique
 * filas o reenvíe el correo, y todo el trabajo de escritura va dentro del
 * script lock.
 */

/**
 * Punto de entrada del disparador de tiempo. No recibe parámetros reales (el
 * evento del trigger se ignora) y nunca lanza: un error aquí queda en
 * _ERRORES, no se pierde en silencio ni rompe el disparador.
 *
 * Devuelve un resumen ({mes, year, oips, filasCreadas, correoEnviado}) para
 * poder ejecutarlo a mano desde el editor y ver qué hizo.
 */
function oipn_recordatorioFacturacion() {
  try {
    return oipn_run_(new Date());
  } catch (e) {
    logError_('oipn_recordatorioFacturacion', null, null, null, e);
    return { error: errMsg_(e) };
  }
}

/**
 * Cuerpo real, con la fecha de "hoy" inyectada para poder probarlo sin
 * esperar al día 1 (ver admin_probarRecordatorioOip).
 */
function oipn_run_(hoy) {
  var cfg = CFG_();
  var periodo = oipn_mesAnterior_(hoy);
  var marca = periodo.year + '-' + pad2_(periodo.mes);

  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('OIP_NOTIF_LAST') === marca) {
    return { mes: periodo.mes, year: periodo.year, oips: 0, filasCreadas: 0, correoEnviado: false, yaEjecutado: true };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(cfg.LIMITS.LOCK_MS)) {
    throw new AppError_('BUSY', 'No se pudo tomar el lock para el recordatorio de facturación.');
  }

  var pendientes;
  var filasCreadas = 0;
  try {
    // Volver a mirar la marca ya dentro del lock (dos disparadores solapados).
    if (props.getProperty('OIP_NOTIF_LAST') === marca) {
      return { mes: periodo.mes, year: periodo.year, oips: 0, filasCreadas: 0, correoEnviado: false, yaEjecutado: true };
    }

    var vigentes = oipn_oipsVigentesEn_(periodo);
    var facPorOip = fac_getAllByOip_();

    var aCrear = [];
    var aSellar = [];
    pendientes = [];

    vigentes.forEach(function (o) {
      var filas = facPorOip[o.idOip] || [];
      var yaDelMes = filas.filter(function (f) {
        return Number(f.obj.mes) === periodo.mes && Number(f.obj.year) === periodo.year;
      })[0];

      if (!yaDelMes) {
        aCrear.push({
          idOip: o.idOip,
          factura: {
            mes: periodo.mes,
            year: periodo.year,
            cuota: '',
            numeroFactura: '',
            estado: cfg.FACT_ESTADO_PENDIENTE,
            fechaNotificacion: hoy
          }
        });
        pendientes.push({ codigo: o.codigo, cliente: o.clienteNombre, estado: cfg.FACT_ESTADO_PENDIENTE, nueva: true });
      } else {
        // Ya existe: no se sobreescribe nada. Solo se sella la fecha de
        // notificación si está vacía, y se reporta su estado real.
        if (!yaDelMes.obj.fechaNotificacion) aSellar.push({ rowIndex: yaDelMes.rowIndex, fecha: hoy });
        if (yaDelMes.obj.estado !== cfg.FACT_ESTADO_FACTURADO) {
          pendientes.push({ codigo: o.codigo, cliente: o.clienteNombre, estado: yaDelMes.obj.estado, nueva: false });
        }
      }
    });

    if (aCrear.length) {
      fac_createMany_(aCrear);
      filasCreadas = aCrear.length;
    }
    fac_stampNotificacionMany_(aSellar);

    SpreadsheetApp.flush();
    bumpDataVersion_();
    props.setProperty('OIP_NOTIF_LAST', marca);
  } finally {
    lock.releaseLock();
  }

  var enviado = oipn_enviarCorreo_(periodo, pendientes, filasCreadas);
  return {
    mes: periodo.mes,
    year: periodo.year,
    oips: pendientes.length,
    filasCreadas: filasCreadas,
    correoEnviado: enviado
  };
}

/** {mes (1-12), year} del mes inmediatamente anterior a `fecha`. */
function oipn_mesAnterior_(fecha) {
  var d = new Date(fecha.getFullYear(), fecha.getMonth(), 1);
  d.setMonth(d.getMonth() - 1);
  return { mes: d.getMonth() + 1, year: d.getFullYear() };
}

/**
 * OIP que estuvieron vigentes en algún momento del periodo {mes, year}: su
 * FECHA ELABORACION es anterior o igual al último día del mes y su FECHA
 * VENCIMIENTO (si la tiene) es posterior o igual al primer día del mes. Una
 * OIP creada después del mes facturado, o que ya había vencido antes de que
 * empezara, no entra en el recordatorio.
 *
 * Devuelve [{idOip, codigo, clienteNombre}] para armar el correo.
 */
function oipn_oipsVigentesEn_(periodo) {
  var primerDia = new Date(periodo.year, periodo.mes - 1, 1);
  var ultimoDia = new Date(periodo.year, periodo.mes, 0);
  var desdeISO = toISODate_(primerDia);
  var hastaISO = toISODate_(ultimoDia);

  var cotPorId = ord_indiceCotizaciones_();
  var clientePorId = ord_indiceClientes_();

  return oip_listAll_().filter(function (o) {
    var elab = qs_dateToISO_(o.fechaElaboracion);
    if (!elab || elab > hastaISO) return false;
    var venc = qs_dateToISO_(o.fechaVencimiento);
    if (venc && venc < desdeISO) return false;
    return true;
  }).map(function (o) {
    var cot = cotPorId[o.idCotizacion] || {};
    return {
      idOip: o.idOip,
      codigo: o.codigo,
      clienteNombre: (cot.idCliente && clientePorId[cot.idCliente]) || ''
    };
  });
}

/**
 * Nombre del mes (1-12) en español, para el asunto y el cuerpo del correo.
 * La lista vive dentro de la función (regla del proyecto: cero código
 * ejecutable a nivel top-level, ver CLAUDE.md §5).
 */
function oipn_nombreMes_(mes) {
  var meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return meses[Math.trunc(Number(mes)) - 1] || String(mes);
}

/**
 * Envía el correo resumen. Devuelve true si se envió. Si no hay nada
 * pendiente no se envía nada (no tiene sentido recordar facturar cero OIP).
 * Un fallo de correo no debe revertir las filas ya creadas: se registra y se
 * sigue.
 */
function oipn_enviarCorreo_(periodo, pendientes, filasCreadas) {
  if (!pendientes || !pendientes.length) return false;
  var cfg = CFG_();
  var destino = cfg.OIP_NOTIF_EMAIL;
  if (!destino) return false;

  // Plantilla única de correo con los textos de OIP_RECORDATORIO (hoja
  // CONFIG_CORREO_TEXTOS, CLAUDE.md §14-15): una OIP por "dato destacado".
  try {
    mail_enviar_('OIP_RECORDATORIO', destino, {
      mes: oipn_nombreMes_(periodo.mes) + ' de ' + periodo.year,
      total: pendientes.length,
      plural: pendientes.length === 1 ? '' : 's',
      filasCreadas: filasCreadas || '',
      estadoPendiente: cfg.FACT_ESTADO_PENDIENTE
    }, {
      items: pendientes.map(function (p) {
        return { codigo: p.codigo, cliente: p.cliente, estado: p.estado, nueva: p.nueva ? 'si' : '' };
      })
    });
    return true;
  } catch (e) {
    logError_('oipn_enviarCorreo_', null, { mes: periodo.mes, year: periodo.year }, null, e);
    return false;
  }
}
