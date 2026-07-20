'use strict';

const db = window.db;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const limpiarCedula = valor => String(valor || '').replace(/\D/g, '').slice(0, 14);
const escapar = valor => String(valor ?? '').replace(/[&<>'"]/g, caracter => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[caracter]));
const esVerdadero = valor => valor === true || ['true', '1', 'si', 'sí'].includes(String(valor).toLowerCase());
const moneda = valor => Number(valor || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const state = {
  config: {},
  promos: [],
  promoSeleccionada: null,
  jugador: null,
  elegidos: new Set(),
  ocupados: new Set(),
  reservaExpira: null,
  enviando: false,
  refresco: null,
  renovacion: null
};

function mostrarEstado(mensaje, tipo = '') {
  const nodo = $('#estado-envio');
  nodo.textContent = mensaje;
  nodo.className = `status-msg ${tipo}`.trim();
}

async function ir(id) {
  $$('.pantalla').forEach(pantalla => {
    pantalla.classList.add('oculto');
    pantalla.classList.remove('activa');
  });
  const destino = document.getElementById(id);
  if (!destino) return;
  destino.classList.remove('oculto');
  destino.classList.add('activa');
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (id === 'lista-aprobados') await cargarAprobados();
  if (id === 'ganadores') await cargarGanadores();
  if (id === 'top-compradores') await cargarTop();
  if (id === 'bienvenida') await actualizarProgreso();
}

async function cargarConfig() {
  const { data, error } = await db.rpc('rpc_configuracion_publica');
  if (error) throw error;
  state.config = Object.fromEntries((data || []).map(fila => [fila.clave, fila.valore ?? fila.valor]));
  state.promos = [1, 2, 3, 4].map(id => ({
    id,
    activa: esVerdadero(state.config[`promo${id}_activa`]),
    descripcion: state.config[`promo${id}_descripcion`] || `Promoción ${id}`,
    cantidad: Math.max(0, Number(state.config[`promo${id}_cantidad`] || 0)),
    precio: Math.max(0, Number(state.config[`promo${id}_precio`] || 0))
  })).filter(promo => promo.activa && promo.cantidad > 0);
  aplicarConfigVisual();
}

function aplicarConfigVisual() {
  const ventasAbiertas = esVerdadero(state.config.ventas_abierta);
  $('#estado-ventas').textContent = ventasAbiertas ? 'Ventas abiertas' : 'Ventas cerradas';
  $('#estado-ventas').className = `badge ${ventasAbiertas ? 'abierto' : 'cerrado'}`;
  $('#precio-inicio').textContent = `${moneda(precioUnitario())} Bs por cartón`;

  const enlaces = {
    '#red-whatsapp': state.config.whatsapp_contacto,
    '#red-youtube': state.config.youtube_url,
    '#red-facebook': state.config.facebook_url,
    '#red-instagram': state.config.instagram_url
  };
  for (const [selector, url] of Object.entries(enlaces)) {
    const enlace = $(selector);
    if (url) enlace.href = url;
    else enlace.classList.add('oculto');
  }

  if (state.config.link_whatsapp) {
    $('#btnWhatsapp').href = state.config.link_whatsapp;
    $('#btnWhatsapp').classList.remove('oculto');
  }
  if (state.config.youtube_live) {
    $('#btn-en-vivo').href = state.config.youtube_live;
    $('#btn-en-vivo').classList.remove('oculto');
  }
  if (state.config.imagen_premios_inicio) {
    $('#imagenPremiosInicio').src = state.config.imagen_premios_inicio;
    $('#imagenPremiosInicio').classList.remove('oculto');
  }

  $('#adminPagoBanco').textContent = state.config.pago_banco || 'Consulta con la administración';
  $('#adminPagoTelefono').textContent = state.config.pago_telefono || '';
  $('#adminPagoCedula').textContent = state.config.pago_cedula || '';
}

function totalCartones() {
  return Math.min(5000, Math.max(1, Number(state.config.total_cartones || 300)));
}

function precioUnitario() {
  return Math.max(0, Number(state.config.precio_carton || 0));
}

function cantidadDeseada() {
  if ((state.config.modo_cartones || 'libre') === 'fijo') {
    return Math.max(1, Number(state.config.cartones_obligatorios || 1));
  }
  return Math.min(100, Math.max(1, Number($('#cantidad').value || 1)));
}

function montoActual() {
  const promo = state.promos.find(item => item.id === state.promoSeleccionada);
  if (promo && promo.cantidad === cantidadDeseada()) return promo.precio;
  return cantidadDeseada() * precioUnitario();
}

function renderPromociones() {
  const contenedor = $('#lista-promociones');
  const modoFijo = (state.config.modo_cartones || 'libre') === 'fijo';
  if (!state.promos.length || modoFijo) {
    $('#promociones').classList.add('oculto');
    contenedor.innerHTML = '';
    return;
  }
  contenedor.innerHTML = state.promos.map(promo => `
    <button type="button" class="promo-card" data-promo="${promo.id}">
      <strong>${escapar(promo.descripcion)}</strong>
      <span>${promo.cantidad} cartones · ${moneda(promo.precio)} Bs</span>
    </button>
  `).join('');
  $('#promociones').classList.remove('oculto');
  $$('[data-promo]').forEach(boton => boton.addEventListener('click', () => seleccionarPromo(Number(boton.dataset.promo))));
}

function seleccionarPromo(id) {
  const promo = state.promos.find(item => item.id === id);
  if (!promo) return;
  if (state.elegidos.size > promo.cantidad) {
    alert('Primero desmarca algunos cartones para usar esta promoción.');
    return;
  }
  state.promoSeleccionada = state.promoSeleccionada === id ? null : id;
  if (state.promoSeleccionada) $('#cantidad').value = promo.cantidad;
  $$('[data-promo]').forEach(boton => boton.classList.toggle('seleccionado', Number(boton.dataset.promo) === state.promoSeleccionada));
  renderCartones();
}

async function cargarOcupados() {
  const { data, error } = await db.rpc('rpc_cartones_ocupados');
  if (error) throw error;
  state.ocupados = new Set((data || []).map(fila => Number(fila.numero)));
}

async function actualizarProgreso() {
  try {
    await cargarOcupados();
    const total = totalCartones();
    const disponibles = Math.max(0, total - state.ocupados.size);
    const porcentaje = total ? Math.round((disponibles / total) * 100) : 0;
    $('#textoProgresoCartones').textContent = `${disponibles} de ${total} · ${porcentaje}%`;
    $('#rellenoProgresoCartones').style.width = `${porcentaje}%`;
    $('#barraProgresoInicio .barra')?.setAttribute('aria-valuenow', String(porcentaje));
    $('#barraProgresoInicio').classList.toggle('oculto', !esVerdadero(state.config.mostrar_barra_progreso));
  } catch (error) {
    console.error('No se pudo actualizar el progreso:', error);
  }
}

function renderCartones() {
  const contenedor = $('#contenedor-cartones');
  const fragmento = document.createDocumentFragment();
  contenedor.innerHTML = '';

  for (let numero = 1; numero <= totalCartones(); numero += 1) {
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'carton';
    boton.dataset.numero = String(numero);
    boton.textContent = String(numero);
    boton.setAttribute('aria-label', `Cartón ${numero}`);
    const ocupadoPorOtro = state.ocupados.has(numero) && !state.elegidos.has(numero);
    boton.classList.toggle('ocupado', ocupadoPorOtro);
    boton.classList.toggle('seleccionado', state.elegidos.has(numero));
    boton.disabled = ocupadoPorOtro;
    boton.addEventListener('click', () => alternarCarton(numero, boton));
    fragmento.appendChild(boton);
  }
  contenedor.appendChild(fragmento);
  actualizarResumen();
}

async function alternarCarton(numero, boton) {
  if (!state.jugador || boton.dataset.procesando === 'true') return;
  boton.dataset.procesando = 'true';
  boton.disabled = true;
  try {
    if (state.elegidos.has(numero)) {
      const { error } = await db.rpc('rpc_liberar_reserva', { _numero: numero, _cedula: state.jugador.cedula });
      if (error) throw error;
      state.elegidos.delete(numero);
      state.ocupados.delete(numero);
      boton.classList.remove('seleccionado');
      actualizarResumen();
      return;
    }

    if (state.elegidos.size >= cantidadDeseada()) {
      alert(`Debes elegir exactamente ${cantidadDeseada()} cartones.`);
      return;
    }

    const { data, error } = await db.rpc('rpc_reservar_carton', { _numero: numero, _cedula: state.jugador.cedula });
    if (error) throw error;
    if (!data?.exito) {
      state.ocupados.add(numero);
      boton.classList.add('ocupado');
      alert(data?.mensaje || 'Ese cartón ya no está disponible.');
      return;
    }
    state.elegidos.add(numero);
    state.ocupados.add(numero);
    state.reservaExpira = data.expira ? new Date(data.expira) : nuevaExpiracionLocal();
    boton.classList.add('seleccionado');
    iniciarMantenimientoReserva();
    actualizarResumen();
  } catch (error) {
    alert(error.message || 'No se pudo cambiar la selección.');
  } finally {
    boton.dataset.procesando = 'false';
    boton.disabled = state.ocupados.has(numero) && !state.elegidos.has(numero);
  }
}

async function elegirAleatorios() {
  if (!state.jugador) return;
  const faltan = cantidadDeseada() - state.elegidos.size;
  if (faltan <= 0) return alert('Ya seleccionaste la cantidad indicada.');
  const boton = $('#aleatorios');
  boton.disabled = true;
  try {
    const { data, error } = await db.rpc('rpc_reservar_cartones_aleatorios', {
      _cantidad: faltan,
      _cedula: state.jugador.cedula,
      _partida_id: null
    });
    if (error) throw error;
    if (!data?.exito) throw new Error(data?.mensaje || 'No se pudieron reservar cartones.');
    for (const numero of data.cartones || []) {
      state.elegidos.add(Number(numero));
      state.ocupados.add(Number(numero));
    }
    state.reservaExpira = data.expira ? new Date(data.expira) : nuevaExpiracionLocal();
    iniciarMantenimientoReserva();
    renderCartones();
  } catch (error) {
    alert(error.message);
    await cargarOcupados();
    renderCartones();
  } finally {
    boton.disabled = false;
  }
}

function nuevaExpiracionLocal() {
  const minutos = Math.max(5, Number(state.config.tiempo_reserva_minutos || 10));
  return new Date(Date.now() + minutos * 60_000);
}

function iniciarMantenimientoReserva() {
  if (!state.renovacion) {
    state.renovacion = setInterval(renovarReservas, 3 * 60_000);
  }
  if (!state.refresco) {
    state.refresco = setInterval(actualizarContadorReserva, 1000);
  }
  actualizarContadorReserva();
}

async function renovarReservas() {
  if (!state.jugador || !state.elegidos.size || state.enviando) return;
  const { data, error } = await db.rpc('rpc_renovar_reservas', {
    _cedula: state.jugador.cedula,
    _cartones: [...state.elegidos]
  });
  if (!error && data) state.reservaExpira = new Date(data);
}

function actualizarContadorReserva() {
  const nodo = $('#contador-reserva');
  if (!state.elegidos.size || !state.reservaExpira) {
    nodo.classList.add('oculto');
    return;
  }
  const restante = Math.max(0, state.reservaExpira.getTime() - Date.now());
  const minutos = Math.floor(restante / 60_000);
  const segundos = Math.floor((restante % 60_000) / 1000);
  nodo.textContent = `Reserva activa · ${minutos}:${String(segundos).padStart(2, '0')}`;
  nodo.classList.remove('oculto');
  if (restante === 0) renovarReservas();
}

function actualizarResumen() {
  const cantidad = cantidadDeseada();
  const promo = state.promos.find(item => item.id === state.promoSeleccionada);
  const textoPromo = promo ? ` · ${promo.descripcion}` : '';
  $('#resumen-seleccion').innerHTML = `<strong>${state.elegidos.size} de ${cantidad}</strong> seleccionados${escapar(textoPromo)}<br><strong>${moneda(montoActual())} Bs</strong>`;
  $('#continuar-pago').disabled = state.elegidos.size !== cantidad;
}

async function liberarCompra() {
  if (state.jugador?.cedula && state.elegidos.size) {
    await db.rpc('rpc_liberar_todas_reservas', { _cedula: state.jugador.cedula });
  }
  state.elegidos.clear();
  state.ocupados.clear();
  state.promoSeleccionada = null;
  state.reservaExpira = null;
  await ir('bienvenida');
}

function prepararPago() {
  if (state.elegidos.size !== cantidadDeseada()) return;
  $('#monto-pago').textContent = moneda(montoActual());
  const guardado = JSON.parse(localStorage.getItem('bingo_pago_ganador') || '{}');
  $('#pago-banco').value = guardado.banco || '';
  $('#pago-telefono').value = guardado.telefono || '';
  $('#pago-cedula').value = guardado.cedula || state.jugador.cedula;
  ir('pago');
}

async function optimizarImagen(archivo) {
  const tipos = ['image/jpeg', 'image/png', 'image/webp'];
  if (!archivo || !tipos.includes(archivo.type)) throw new Error('Selecciona una imagen JPG, PNG o WebP.');
  if (archivo.size > 5 * 1024 * 1024) throw new Error('El comprobante no puede superar 5 MB.');
  if (!('createImageBitmap' in window)) return { archivo, extension: archivo.name.split('.').pop()?.toLowerCase() || 'jpg', tipo: archivo.type };

  try {
    const bitmap = await createImageBitmap(archivo);
    const escala = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * escala));
    canvas.height = Math.max(1, Math.round(bitmap.height * escala));
    canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.82));
    if (blob) return { archivo: blob, extension: 'webp', tipo: 'image/webp' };
  } catch (error) {
    console.warn('Se usará la imagen original:', error);
  }
  return { archivo, extension: archivo.name.split('.').pop()?.toLowerCase() || 'jpg', tipo: archivo.type };
}

async function subirComprobante(archivoOriginal) {
  const preparado = await optimizarImagen(archivoOriginal);
  const fecha = new Date().toISOString().slice(0, 10);
  const ruta = `${fecha}/${crypto.randomUUID()}.${preparado.extension}`;
  const { error } = await db.storage.from('comprobantes').upload(ruta, preparado.archivo, {
    contentType: preparado.tipo,
    cacheControl: '3600',
    upsert: false
  });
  if (error) throw error;
  return ruta;
}

async function enviarInscripcion(evento) {
  evento.preventDefault();
  if (state.enviando) return;
  if (!evento.currentTarget.reportValidity()) return;
  if (!/^[0-9]{4}$/.test($('#referencia').value.trim())) return mostrarEstado('La referencia debe tener exactamente 4 dígitos.', 'error');
  if (state.elegidos.size !== cantidadDeseada()) return mostrarEstado('La selección de cartones está incompleta.', 'error');

  state.enviando = true;
  $('#enviar').disabled = true;
  mostrarEstado('Optimizando y subiendo el comprobante…');
  try {
    const datosGanador = {
      banco: $('#pago-banco').value.trim(),
      telefono: $('#pago-telefono').value.trim(),
      cedula: limpiarCedula($('#pago-cedula').value)
    };
    localStorage.setItem('bingo_pago_ganador', JSON.stringify(datosGanador));
    const ruta = await subirComprobante($('#comprobante').files[0]);
    mostrarEstado('Registrando tu inscripción…');
    const cartones = [...state.elegidos].sort((a, b) => a - b);
    const { data, error } = await db.rpc('rpc_crear_inscripcion', {
      _nombre: state.jugador.nombre,
      _telefono: state.jugador.telefono,
      _cedula: state.jugador.cedula,
      _referido: state.jugador.referido || '',
      _cartones: cartones,
      _referencia4dig: $('#referencia').value.trim(),
      _comprobante: ruta,
      _monto_bs: montoActual(),
      _pago_banco: datosGanador.banco,
      _pago_telefono: datosGanador.telefono,
      _pago_cedula: datosGanador.cedula,
      _promo_id: state.promoSeleccionada,
      _acepta_terminos: true
    });
    if (error) throw error;
    state.elegidos.clear();
    state.reservaExpira = null;
    evento.currentTarget.reset();
    mostrarEstado(`Inscripción #${data} enviada correctamente. La administración verificará tu pago.`, 'success');
    setTimeout(() => ir('usuario'), 2200);
  } catch (error) {
    mostrarEstado(error.message || 'No se pudo enviar la inscripción.', 'error');
    $('#enviar').disabled = false;
  } finally {
    state.enviando = false;
  }
}

async function consultar(evento) {
  evento.preventDefault();
  const cedula = limpiarCedula($('#consulta-cedula').value);
  if (cedula.length < 5) return;
  const salida = $('#resultado-consulta');
  salida.innerHTML = '<div class="panel-section">Consultando…</div>';
  const [jugadas, referidos] = await Promise.all([
    db.rpc('rpc_consultar_jugadas', { _cedula: cedula }),
    db.rpc('rpc_resumen_referidos', { _cedula: cedula })
  ]);
  if (jugadas.error) {
    salida.textContent = jugadas.error.message;
    return;
  }
  salida.innerHTML = (jugadas.data || []).length ? jugadas.data.map(item => `
    <article class="panel-section jugada">
      <span class="badge estado-${escapar(item.estado)}">${escapar(item.estado || 'pendiente')}</span>
      <h2>Cartones ${escapar((item.cartones || []).join(', '))}</h2>
      <p>Monto: ${moneda(item.monto_bs)} Bs · ${new Date(item.created_at).toLocaleString('es-VE')}</p>
    </article>
  `).join('') : '<div class="panel-section">No se encontraron compras para esta cédula.</div>';

  if (!referidos.error) mostrarReferidos(cedula, referidos.data || {});
}

function mostrarReferidos(cedula, resumen) {
  const aprobados = Math.max(0, Number(resumen.aprobados || 0));
  const meta = Math.max(1, Number(resumen.meta || 10));
  const porcentaje = Math.min(100, Math.round((aprobados / meta) * 100));
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('ref', cedula);
  $('#texto-referidos').textContent = `${aprobados} de ${meta} amigos con compra aprobada.`;
  $('#relleno-referidos').style.width = `${porcentaje}%`;
  $('#enlace-referido').value = url.toString();
  $('#whatsapp-referido').href = `https://wa.me/?text=${encodeURIComponent(`Juega Bingo Ganga conmigo: ${url}`)}`;
  $('#programa-referidos').classList.remove('oculto');
}

async function cargarAprobados() {
  const contenedor = $('#contenedor-aprobados');
  contenedor.innerHTML = '<div class="panel-section">Cargando…</div>';
  const { data, error } = await db.rpc('rpc_lista_aprobados');
  if (error) return contenedor.textContent = error.message;
  contenedor.innerHTML = (data || []).length ? `<div class="table-wrapper"><table><thead><tr><th>Cartón</th><th>Jugador</th><th>Cédula</th></tr></thead><tbody>${data.map(item => `<tr><td><strong>${item.carton}</strong></td><td>${escapar(item.nombre)}</td><td>${escapar(item.cedula_mascara)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="panel-section">Aún no hay cartones aprobados.</div>';
}

async function cargarGanadores() {
  const contenedor = $('#listaGanadores');
  contenedor.innerHTML = '<div class="panel-section">Cargando…</div>';
  const { data, error } = await db.rpc('rpc_ganadores_publicos');
  if (error) return contenedor.textContent = error.message;
  contenedor.innerHTML = (data || []).length ? `<div class="table-wrapper"><table><thead><tr><th>Ganador</th><th>Cartón</th><th>Premio</th><th>Fecha</th></tr></thead><tbody>${data.map(item => `<tr><td>${escapar(item.nombre)}</td><td>${escapar(item.cartones)}</td><td>${escapar(item.premio)}</td><td>${escapar(item.fecha || '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="panel-section">Aún no hay ganadores registrados.</div>';
}

async function cargarTop() {
  const contenedor = $('#listaTopCompradores');
  contenedor.innerHTML = '<div class="panel-section">Cargando…</div>';
  const { data, error } = await db.rpc('rpc_top_compradores');
  if (error) return contenedor.textContent = error.message;
  contenedor.innerHTML = (data || []).length ? data.map((item, indice) => `
    <article class="ranking-item"><span>#${indice + 1}</span><div><strong>${escapar(item.nombre)}</strong><small>${escapar(item.cedula_mascara)}</small></div><b>${item.total_cartones} cartones</b></article>
  `).join('') : '<div class="panel-section">Aún no hay compradores aprobados.</div>';
}

async function copiar(texto, mensaje = 'Copiado') {
  try {
    await navigator.clipboard.writeText(texto);
    alert(mensaje);
  } catch {
    prompt('Copia este texto:', texto);
  }
}

function cargarDatosGuardados() {
  const jugador = JSON.parse(localStorage.getItem('bingo_jugador') || '{}');
  $('#nombre').value = jugador.nombre || '';
  $('#telefono').value = jugador.telefono || '';
  $('#cedula').value = jugador.cedula || '';
  $('#referido').value = jugador.referido || '';
  const ref = limpiarCedula(new URLSearchParams(location.search).get('ref'));
  if (ref) {
    $('#referido').value = ref;
    $('#aviso-referido').textContent = `Llegaste por invitación de la cédula ${ref}.`;
    $('#aviso-referido').classList.remove('oculto');
  }
}

async function registrarJugador(evento) {
  evento.preventDefault();
  if (!evento.currentTarget.reportValidity()) return;
  if (!esVerdadero(state.config.ventas_abierta)) return alert('Las ventas están cerradas por el momento.');
  const jugador = {
    nombre: $('#nombre').value.trim(),
    telefono: $('#telefono').value.trim(),
    cedula: limpiarCedula($('#cedula').value),
    referido: limpiarCedula($('#referido').value)
  };
  if (jugador.nombre.length < 3) return alert('Ingresa tu nombre completo.');
  if (jugador.telefono.replace(/\D/g, '').length < 7) return alert('Ingresa un teléfono válido.');
  if (jugador.cedula.length < 5) return alert('Ingresa una cédula válida.');
  if (jugador.referido && jugador.referido === jugador.cedula) return alert('No puedes usar tu propia cédula como referido.');
  state.jugador = jugador;
  localStorage.setItem('bingo_jugador', JSON.stringify(jugador));
  state.elegidos.clear();
  state.promoSeleccionada = null;
  const modoFijo = (state.config.modo_cartones || 'libre') === 'fijo';
  $('#cantidad').value = modoFijo ? state.config.cartones_obligatorios || 1 : 1;
  $('#cantidad').readOnly = modoFijo;
  $('#menos').disabled = modoFijo;
  $('#mas').disabled = modoFijo;
  $('#cantidad-label').textContent = modoFijo ? 'Cantidad definida para esta venta' : 'Cantidad de cartones';
  renderPromociones();
  await cargarOcupados();
  renderCartones();
  await ir('cartones');
}

function configurarEventos() {
  $$('[data-ir]').forEach(elemento => elemento.addEventListener('click', () => ir(elemento.dataset.ir)));
  $$('[data-cancelar-compra]').forEach(elemento => elemento.addEventListener('click', () => {
    if (confirm('¿Cancelar la compra y liberar los cartones reservados?')) liberarCompra();
  }));
  $('#form-jugador').addEventListener('submit', registrarJugador);
  $('#form-pago').addEventListener('submit', enviarInscripcion);
  $('#form-consulta').addEventListener('submit', consultar);
  $('#aleatorios').addEventListener('click', elegirAleatorios);
  $('#continuar-pago').addEventListener('click', prepararPago);
  $('#mas').addEventListener('click', () => { $('#cantidad').stepUp(); state.promoSeleccionada = null; renderPromociones(); actualizarResumen(); });
  $('#menos').addEventListener('click', () => {
    if (Number($('#cantidad').value) <= state.elegidos.size) return;
    $('#cantidad').stepDown(); state.promoSeleccionada = null; renderPromociones(); actualizarResumen();
  });
  $('#cantidad').addEventListener('change', () => {
    let cantidad = Math.min(100, Math.max(1, Number($('#cantidad').value || 1)));
    if (cantidad < state.elegidos.size) cantidad = state.elegidos.size;
    $('#cantidad').value = cantidad;
    state.promoSeleccionada = null;
    renderPromociones();
    actualizarResumen();
  });
  $$('[data-copiar]').forEach(boton => boton.addEventListener('click', () => copiar(document.getElementById(boton.dataset.copiar).textContent)));
  $('#copiar-pago').addEventListener('click', () => copiar(`${$('#adminPagoBanco').textContent}\nTeléfono: ${$('#adminPagoTelefono').textContent}\nCédula: ${$('#adminPagoCedula').textContent}`));
  $('#copiar-referido').addEventListener('click', () => copiar($('#enlace-referido').value, 'Enlace de invitación copiado.'));
  ['#cedula', '#referido', '#consulta-cedula', '#pago-cedula'].forEach(selector => $(selector).addEventListener('input', evento => { evento.target.value = limpiarCedula(evento.target.value); }));
  $('#referencia').addEventListener('input', evento => { evento.target.value = evento.target.value.replace(/\D/g, '').slice(0, 4); });
}

function iniciarReloj() {
  const actualizar = () => {
    $('#hora-venezuela').textContent = new Intl.DateTimeFormat('es-VE', {
      timeZone: 'America/Caracas', dateStyle: 'full', timeStyle: 'medium'
    }).format(new Date());
  };
  actualizar();
  setInterval(actualizar, 1000);
}

document.addEventListener('DOMContentLoaded', async () => {
  configurarEventos();
  iniciarReloj();
  cargarDatosGuardados();
  try {
    await cargarConfig();
    await actualizarProgreso();
  } catch (error) {
    console.error(error);
    alert(`No se pudo conectar con Bingo Ganga: ${error.message}`);
  } finally {
    $('#overlay-carga').classList.add('oculto');
  }

  if (!localStorage.getItem('bingo_aviso_legal_20260719')) $('#aviso-legal').showModal();
  $('#aceptar-aviso').addEventListener('click', () => {
    localStorage.setItem('bingo_aviso_legal_20260719', '1');
    $('#aviso-legal').close();
  });
});
