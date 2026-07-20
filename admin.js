'use strict';

const db = window.db;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapar = valor => String(valor ?? '').replace(/[&<>'"]/g, caracter => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[caracter]));
const esAdmin = usuario => usuario?.app_metadata?.role === 'admin';
const esVerdadero = valor => valor === true || ['true', '1', 'si', 'sí'].includes(String(valor).toLowerCase());
const moneda = valor => Number(valor || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const state = {
  usuario: null,
  config: {},
  inscripciones: [],
  urlsComprobantes: new Map(),
  ganadores: [],
  realtime: null,
  recargaPendiente: null,
  inactividad: null
};

function estado(selector, mensaje, tipo = '') {
  const nodo = $(selector);
  if (!nodo) return;
  nodo.textContent = mensaje;
  nodo.className = `status-msg ${tipo}`.trim();
}

async function autenticar(evento) {
  evento.preventDefault();
  const boton = evento.currentTarget.querySelector('button[type="submit"]');
  boton.disabled = true;
  estado('#login-estado', 'Verificando…');
  const { data, error } = await db.auth.signInWithPassword({
    email: $('#admin-email').value.trim(),
    password: $('#admin-password').value
  });
  if (error || !esAdmin(data.user)) {
    await db.auth.signOut();
    estado('#login-estado', error?.message || 'Esta cuenta no tiene rol de administrador.', 'error');
    boton.disabled = false;
    return;
  }
  mostrarPanel(data.user);
}

async function recuperarClave() {
  const email = $('#admin-email').value.trim();
  if (!email) return estado('#login-estado', 'Escribe primero tu correo.', 'error');
  const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: new URL('admin.html', location.href).href });
  estado('#login-estado', error ? error.message : 'Revisa tu correo para restablecer la contraseña.', error ? 'error' : 'success');
}

async function verificarSesion() {
  const { data: { user }, error } = await db.auth.getUser();
  if (!error && esAdmin(user)) mostrarPanel(user);
}

function mostrarPanel(usuario) {
  state.usuario = usuario;
  $('#login').classList.add('oculto');
  $('#panel').classList.remove('oculto');
  $('#admin-identidad').textContent = usuario.email;
  iniciarControlInactividad();
  activarRealtime();
  cargarTodo();
}

async function cerrarSesion() {
  await db.auth.signOut({ scope: 'local' });
  location.reload();
}

function iniciarControlInactividad() {
  const reiniciar = () => {
    clearTimeout(state.inactividad);
    state.inactividad = setTimeout(cerrarSesion, 30 * 60_000);
  };
  ['click', 'keydown', 'pointerdown', 'touchstart'].forEach(evento => document.addEventListener(evento, reiniciar, { passive: true }));
  reiniciar();
}

async function cargarTodo() {
  $('#recargar').disabled = true;
  try {
    await Promise.all([cargarConfiguracion(), cargarInscripciones(), cargarGanadores()]);
  } catch (error) {
    alert(`No se pudo cargar el panel: ${error.message}`);
  } finally {
    $('#recargar').disabled = false;
  }
}

async function cargarConfiguracion() {
  const { data, error } = await db.from('configuracion').select('clave,valore,valor');
  if (error) throw error;
  state.config = Object.fromEntries((data || []).map(fila => [fila.clave, fila.valore ?? fila.valor]));

  $('#cfg-total').value = state.config.total_cartones || 300;
  $('#cfg-precio').value = state.config.precio_carton || 0;
  $('#cfg-modo').value = state.config.modo_cartones || 'libre';
  $('#cfg-fijos').value = state.config.cartones_obligatorios || 1;
  $('#cfg-reserva').value = state.config.tiempo_reserva_minutos || 10;
  $('#cfg-ventas').checked = esVerdadero(state.config.ventas_abierta);
  $('#cfg-progreso').checked = esVerdadero(state.config.mostrar_barra_progreso);
  $('#cfg-meta-referidos').value = state.config.meta_referidos || 10;
  $('#cfg-whatsapp').value = state.config.link_whatsapp || '';
  $('#cfg-youtube-live').value = state.config.youtube_live || '';
  $('#cfg-whatsapp-contacto').value = state.config.whatsapp_contacto || '';
  $('#cfg-youtube').value = state.config.youtube_url || '';
  $('#cfg-facebook').value = state.config.facebook_url || '';
  $('#cfg-instagram').value = state.config.instagram_url || '';
  $('#cfg-pago-banco').value = state.config.pago_banco || '';
  $('#cfg-pago-telefono').value = state.config.pago_telefono || '';
  $('#cfg-pago-cedula').value = state.config.pago_cedula || '';
  $('#estado-ventas-admin').innerHTML = `Estado actual: <strong>${esVerdadero(state.config.ventas_abierta) ? 'ventas abiertas' : 'ventas cerradas'}</strong>`;

  for (let numero = 1; numero <= 4; numero += 1) {
    $(`#promo${numero}-activa`).checked = esVerdadero(state.config[`promo${numero}_activa`]);
    $(`#promo${numero}-descripcion`).value = state.config[`promo${numero}_descripcion`] || '';
    $(`#promo${numero}-cantidad`).value = state.config[`promo${numero}_cantidad`] || '';
    $(`#promo${numero}-precio`).value = state.config[`promo${numero}_precio`] || '';
  }

  if (state.config.imagen_premios_inicio) {
    $('#vista-premios').src = state.config.imagen_premios_inicio;
    $('#vista-premios').classList.remove('oculto');
  } else {
    $('#vista-premios').classList.add('oculto');
  }
}

async function guardarFilasConfiguracion(filas) {
  const { error } = await db.from('configuracion').upsert(filas, { onConflict: 'clave' });
  if (error) throw error;
  await cargarConfiguracion();
}

async function guardarCartonesConfig(evento) {
  evento.preventDefault();
  const total = Math.min(5000, Math.max(1, Number($('#cfg-total').value)));
  const precio = Math.max(0, Number($('#cfg-precio').value));
  const fijos = Math.min(100, Math.max(1, Number($('#cfg-fijos').value || 1)));
  const minutos = Math.min(30, Math.max(5, Number($('#cfg-reserva').value || 10)));
  await guardarFilasConfiguracion([
    { clave: 'total_cartones', valore: String(total), valor: null },
    { clave: 'precio_carton', valore: String(precio), valor: null },
    { clave: 'modo_cartones', valore: $('#cfg-modo').value, valor: null },
    { clave: 'cartones_obligatorios', valore: String(fijos), valor: null },
    { clave: 'tiempo_reserva_minutos', valore: String(minutos), valor: null }
  ]);
  alert('Configuración de cartones guardada.');
}

async function guardarConfigGeneral(evento) {
  evento.preventDefault();
  await guardarFilasConfiguracion([
    { clave: 'ventas_abierta', valore: null, valor: $('#cfg-ventas').checked },
    { clave: 'mostrar_barra_progreso', valore: String($('#cfg-progreso').checked), valor: null },
    { clave: 'meta_referidos', valore: String(Math.max(1, Number($('#cfg-meta-referidos').value || 10))), valor: null },
    { clave: 'link_whatsapp', valore: $('#cfg-whatsapp').value.trim(), valor: null },
    { clave: 'youtube_live', valore: $('#cfg-youtube-live').value.trim(), valor: null },
    { clave: 'whatsapp_contacto', valore: $('#cfg-whatsapp-contacto').value.trim(), valor: null },
    { clave: 'youtube_url', valore: $('#cfg-youtube').value.trim(), valor: null },
    { clave: 'facebook_url', valore: $('#cfg-facebook').value.trim(), valor: null },
    { clave: 'instagram_url', valore: $('#cfg-instagram').value.trim(), valor: null }
  ]);
  alert('Enlaces y visualización guardados.');
}

async function guardarPagoConfig(evento) {
  evento.preventDefault();
  await guardarFilasConfiguracion([
    { clave: 'pago_banco', valore: $('#cfg-pago-banco').value.trim(), valor: null },
    { clave: 'pago_telefono', valore: $('#cfg-pago-telefono').value.trim(), valor: null },
    { clave: 'pago_cedula', valore: $('#cfg-pago-cedula').value.trim(), valor: null }
  ]);
  alert('Datos de Pago Móvil guardados.');
}

async function cambiarVentas(abiertas) {
  await guardarFilasConfiguracion([{ clave: 'ventas_abierta', valore: null, valor: abiertas }]);
}

async function guardarPromos(evento) {
  evento.preventDefault();
  try {
    const filas = [];
    for (let numero = 1; numero <= 4; numero += 1) {
      const activa = $(`#promo${numero}-activa`).checked;
      const descripcion = $(`#promo${numero}-descripcion`).value.trim();
      const cantidad = Math.min(100, Math.max(0, Number($(`#promo${numero}-cantidad`).value || 0)));
      const precio = Math.max(0, Number($(`#promo${numero}-precio`).value || 0));
      if (activa && (!descripcion || cantidad < 1)) throw new Error(`Completa correctamente la promoción ${numero}.`);
      filas.push(
        { clave: `promo${numero}_activa`, valore: String(activa), valor: null },
        { clave: `promo${numero}_descripcion`, valore: descripcion, valor: null },
        { clave: `promo${numero}_cantidad`, valore: String(cantidad), valor: null },
        { clave: `promo${numero}_precio`, valore: String(precio), valor: null }
      );
    }
    await guardarFilasConfiguracion(filas);
    estado('#estado-promos', 'Promociones guardadas.', 'success');
  } catch (error) {
    estado('#estado-promos', error.message, 'error');
  }
}

async function cargarInscripciones() {
  const { data, error } = await db.from('inscripciones').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  state.inscripciones = data || [];
  await cargarUrlsComprobantes();
  actualizarEstadisticas();
  renderInscripciones();
  renderAprobados();
}

async function cargarUrlsComprobantes() {
  state.urlsComprobantes.clear();
  const rutas = [...new Set(state.inscripciones.map(item => item.comprobante).filter(Boolean))];
  if (!rutas.length) return;
  const { data, error } = await db.storage.from('comprobantes').createSignedUrls(rutas, 15 * 60);
  if (error) {
    console.error('No se pudieron firmar los comprobantes:', error);
    return;
  }
  (data || []).forEach(item => {
    const ruta = item.path || item.signedUrl?.split('/comprobantes/')[1]?.split('?')[0];
    if (ruta && item.signedUrl) state.urlsComprobantes.set(decodeURIComponent(ruta), item.signedUrl);
  });
}

function actualizarEstadisticas() {
  const activas = state.inscripciones.filter(item => ['pendiente', 'aprobado'].includes(item.estado));
  $('#stat-clientes').textContent = state.inscripciones.length;
  $('#stat-cartones').textContent = activas.reduce((total, item) => total + (item.cartones?.length || 0), 0);
  $('#stat-pendientes').textContent = state.inscripciones.filter(item => item.estado === 'pendiente').length;
  $('#stat-monto').textContent = `${moneda(state.inscripciones.filter(item => item.estado === 'aprobado').reduce((total, item) => total + Number(item.monto_bs || 0), 0))} Bs`;
}

function inscripcionesFiltradas() {
  const busqueda = $('#buscar-inscripcion').value.trim().toLowerCase();
  const filtro = $('#filtro-estado').value;
  const orden = $('#orden-inscripciones').value;
  const filas = state.inscripciones.filter(item => {
    if (filtro !== 'todos' && item.estado !== filtro) return false;
    if (!busqueda) return true;
    return [item.nombre, item.cedula, item.telefono, item.referencia4dig, ...(item.cartones || [])]
      .some(valor => String(valor || '').toLowerCase().includes(busqueda));
  });
  if (orden === 'nombre') filas.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
  if (orden === 'cedula') filas.sort((a, b) => String(a.cedula).localeCompare(String(b.cedula), 'es', { numeric: true }));
  if (orden === 'referencia') filas.sort((a, b) => String(a.referencia4dig).localeCompare(String(b.referencia4dig), 'es', { numeric: true }));
  return filas;
}

function renderInscripciones() {
  const tbody = $('#tabla-inscripciones tbody');
  const filas = inscripcionesFiltradas();
  tbody.innerHTML = filas.map(item => {
    const url = state.urlsComprobantes.get(item.comprobante);
    return `<tr data-id="${item.id}">
      <td><strong>${escapar(item.nombre)}</strong><small>${escapar(item.cedula)}</small>${item.referido ? `<small>Refirió: ${escapar(item.referido)}</small>` : ''}</td>
      <td>${escapar(item.telefono)}<small>${escapar(new Date(item.created_at).toLocaleString('es-VE'))}</small></td>
      <td>${escapar((item.cartones || []).join(', '))}<small>${item.cartones?.length || 0} cartones</small></td>
      <td><strong>${moneda(item.monto_bs)} Bs</strong><small>Ref. ${escapar(item.referencia4dig)}</small><small>${escapar(item.pago_banco || '')} · ${escapar(item.pago_telefono || '')} · ${escapar(item.pago_cedula || '')}</small>${item.usa_promo ? `<small class="promo-tag">${escapar(item.promo_desc || 'Promoción')}</small>` : ''}</td>
      <td>${url ? `<a class="btn btn-small" href="${escapar(url)}" target="_blank" rel="noopener">Ver imagen</a>` : 'Sin archivo'}</td>
      <td><span class="badge estado-${escapar(item.estado)}">${escapar(item.estado)}</span></td>
      <td><div class="table-actions"><button class="btn-small" data-estado="aprobado">Aprobar</button><button class="btn-small btn-secondary" data-estado="rechazado">Rechazar</button><button class="btn-small btn-danger" data-eliminar>Eliminar</button></div></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('tr').forEach(fila => {
    const id = Number(fila.dataset.id);
    fila.querySelectorAll('[data-estado]').forEach(boton => boton.addEventListener('click', () => cambiarEstado(id, boton.dataset.estado, boton)));
    fila.querySelector('[data-eliminar]').addEventListener('click', () => eliminarInscripcion(id));
  });
}

async function cambiarEstado(id, nuevoEstado, boton) {
  boton.disabled = true;
  try {
    const { error } = await db.rpc('rpc_admin_cambiar_estado', { _id: id, _estado: nuevoEstado });
    if (error) throw error;
    await cargarInscripciones();
  } catch (error) {
    alert(error.message);
  } finally {
    boton.disabled = false;
  }
}

async function eliminarInscripcion(id) {
  const item = state.inscripciones.find(fila => fila.id === id);
  if (!item || !confirm(`¿Eliminar la inscripción de ${item.nombre} y liberar sus cartones?`)) return;
  const { data: ruta, error } = await db.rpc('rpc_eliminar_inscripcion_seguro', { _id: id });
  if (error) return alert(error.message);
  if (ruta) {
    const borrado = await db.storage.from('comprobantes').remove([ruta]);
    if (borrado.error) console.warn('La inscripción se borró, pero no el archivo:', borrado.error);
  }
  await cargarInscripciones();
}

function renderAprobados() {
  const filas = state.inscripciones
    .filter(item => item.estado === 'aprobado')
    .flatMap(item => (item.cartones || []).map(carton => ({ carton: Number(carton), nombre: item.nombre, cedula: item.cedula })))
    .sort((a, b) => a.carton - b.carton);
  $('#lista-aprobados-admin > div').innerHTML = filas.length ? `<div class="table-wrapper"><table><thead><tr><th>Cartón</th><th>Nombre</th><th>Cédula</th></tr></thead><tbody>${filas.map(item => `<tr><td>${item.carton}</td><td>${escapar(item.nombre)}</td><td>${escapar(item.cedula)}</td></tr>`).join('')}</tbody></table></div>` : '<p>No hay aprobados.</p>';
}

function buscarCarton() {
  const numero = Number($('#buscar-carton').value);
  const item = state.inscripciones.find(fila => (fila.cartones || []).map(Number).includes(numero));
  $('#resultado-carton').innerHTML = item ? `<div class="result-box"><strong>${escapar(item.nombre)}</strong><p>Cédula: ${escapar(item.cedula)} · Teléfono: ${escapar(item.telefono)}</p><p>Estado: ${escapar(item.estado)} · Cartones: ${escapar(item.cartones.join(', '))}</p></div>` : `<p>El cartón ${escapar(numero)} no aparece en ninguna inscripción.</p>`;
}

function detectarDuplicados(tipo) {
  const mapa = new Map();
  for (const item of state.inscripciones.filter(fila => fila.estado !== 'rechazado')) {
    const claves = tipo === 'carton' ? (item.cartones || []).map(String) : [tipo === 'nombre' ? normalizarNombre(item.nombre) : String(item.referencia4dig || '')];
    for (const clave of claves.filter(Boolean)) {
      if (!mapa.has(clave)) mapa.set(clave, []);
      mapa.get(clave).push(item);
    }
  }
  const duplicados = [...mapa.entries()].filter(([, items]) => items.length > 1);
  $('#resultado-duplicados').innerHTML = duplicados.length ? duplicados.map(([clave, items]) => `<div class="result-box"><strong>${escapar(tipo)}: ${escapar(clave)}</strong><p>${items.map(item => `${escapar(item.nombre)} (${escapar(item.cedula)})`).join(' · ')}</p></div>`).join('') : '<p>No se encontraron duplicados.</p>';
}

function normalizarNombre(valor) {
  return String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function verHuerfanos() {
  const { data, error } = await db.rpc('rpc_listar_cartones_huerfanos', { _min_age: '5 minutes' });
  if (error) return estado('#resultado-huerfanos', error.message, 'error');
  $('#resultado-huerfanos').innerHTML = data?.length ? `<p>${data.length} reserva(s) vencida(s): ${data.map(item => item.numero).join(', ')}</p>` : '<p>No hay reservas huérfanas.</p>';
}

async function liberarHuerfanos() {
  const { data, error } = await db.rpc('rpc_liberar_cartones_huerfanos', { _min_age: '5 minutes' });
  estado('#resultado-huerfanos', error ? error.message : `${data || 0} reserva(s) liberada(s).`, error ? 'error' : 'success');
  if (!error) cargarInscripciones();
}

async function reiniciarVentas() {
  const frase = prompt('Esta acción elimina inscripciones y reservas. Escribe REINICIAR para continuar:');
  if (frase !== 'REINICIAR') return;
  if (!confirm('Última confirmación: ¿reiniciar las ventas? Los ganadores y la configuración se conservarán.')) return;
  const { error } = await db.rpc('rpc_admin_reiniciar_ventas', { _incluir_ganadores: false });
  if (error) return alert(error.message);
  const archivos = await listarTodos('comprobantes');
  if (archivos.length) await db.storage.from('comprobantes').remove(archivos);
  await cargarTodo();
  alert('Ventas reiniciadas.');
}

async function convertirWebP(archivo, maximo = 1400, calidad = 0.82) {
  const bitmap = await createImageBitmap(archivo);
  const escala = Math.min(1, maximo / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * escala));
  canvas.height = Math.max(1, Math.round(bitmap.height * escala));
  canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', calidad));
  if (!blob) throw new Error(`No se pudo convertir ${archivo.name}.`);
  return blob;
}

function numeroDesdeArchivo(nombre) {
  const grupos = String(nombre).match(/\d+/g);
  return grupos?.length ? Number(grupos.at(-1)) : null;
}

async function subirCartones() {
  const archivos = [...$('#imagenes-cartones').files];
  if (!archivos.length) return estado('#estado-cartones', 'Selecciona al menos una imagen.', 'error');
  const total = Number(state.config.total_cartones || 300);
  $('#progreso-subida').classList.remove('oculto');
  $('#progreso-subida').value = 0;
  $('#subir-cartones').disabled = true;
  const errores = [];
  let exitos = 0;
  for (let indice = 0; indice < archivos.length; indice += 1) {
    const archivo = archivos[indice];
    const numero = numeroDesdeArchivo(archivo.name);
    try {
      if (!numero || numero < 1 || numero > total) throw new Error('el nombre no contiene un número de cartón válido');
      const webp = await convertirWebP(archivo, 1200, 0.8);
      const nombre = `SERIAL_BINGOANDINO75_CARTON_${String(numero).padStart(5, '0')}.webp`;
      const { error } = await db.storage.from('cartones').upload(nombre, webp, { contentType: 'image/webp', cacheControl: '31536000', upsert: true });
      if (error) throw error;
      exitos += 1;
    } catch (error) {
      errores.push(`${archivo.name}: ${error.message}`);
    }
    $('#progreso-subida').value = Math.round(((indice + 1) / archivos.length) * 100);
  }
  $('#imagenes-cartones').value = '';
  $('#subir-cartones').disabled = false;
  estado('#estado-cartones', `${exitos} imagen(es) subida(s).${errores.length ? ` Errores: ${errores.join(' | ')}` : ''}`, errores.length ? 'error' : 'success');
}

async function listarTodos(bucket, carpeta = '') {
  const nombres = [];
  let offset = 0;
  while (true) {
    const { data, error } = await db.storage.from(bucket).list(carpeta, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw error;
    if (!data?.length) break;
    for (const item of data) {
      if (!item.name) continue;
      const ruta = carpeta ? `${carpeta}/${item.name}` : item.name;
      if (item.id) nombres.push(ruta);
      else nombres.push(...await listarTodos(bucket, ruta));
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  return nombres;
}

async function borrarImagenesCartones() {
  const frase = prompt('Escribe BORRAR CARTONES para eliminar todas las imágenes:');
  if (frase !== 'BORRAR CARTONES') return;
  try {
    const nombres = await listarTodos('cartones');
    if (!nombres.length) return estado('#estado-cartones', 'No hay imágenes para borrar.');
    for (let indice = 0; indice < nombres.length; indice += 100) {
      const { error } = await db.storage.from('cartones').remove(nombres.slice(indice, indice + 100));
      if (error) throw error;
    }
    estado('#estado-cartones', `${nombres.length} imágenes eliminadas.`, 'success');
  } catch (error) {
    estado('#estado-cartones', error.message, 'error');
  }
}

async function subirPremios() {
  const archivo = $('#archivo-premios').files[0];
  if (!archivo) return estado('#estado-premios', 'Selecciona una imagen.', 'error');
  try {
    const webp = await convertirWebP(archivo, 1400, 0.85);
    const nombre = `premios-inicio-${Date.now()}-${crypto.randomUUID()}.webp`;
    const { error } = await db.storage.from('imagenes').upload(nombre, webp, { contentType: 'image/webp', cacheControl: '31536000', upsert: false });
    if (error) throw error;
    const { data } = db.storage.from('imagenes').getPublicUrl(nombre);
    const anterior = state.config.imagen_premios_inicio;
    await guardarFilasConfiguracion([{ clave: 'imagen_premios_inicio', valore: data.publicUrl, valor: null }]);
    if (anterior) await db.storage.from('imagenes').remove([decodeURIComponent(anterior.split('/imagenes/').pop())]);
    $('#archivo-premios').value = '';
    estado('#estado-premios', 'Imagen de premios actualizada.', 'success');
  } catch (error) {
    estado('#estado-premios', error.message, 'error');
  }
}

async function eliminarPremios() {
  if (!state.config.imagen_premios_inicio || !confirm('¿Eliminar la imagen de premios del inicio?')) return;
  const nombre = decodeURIComponent(state.config.imagen_premios_inicio.split('/imagenes/').pop());
  await db.storage.from('imagenes').remove([nombre]);
  await guardarFilasConfiguracion([{ clave: 'imagen_premios_inicio', valore: '', valor: null }]);
  estado('#estado-premios', 'Imagen eliminada.', 'success');
}

async function cargarGanadores() {
  const { data, error } = await db.from('ganadores').select('*').order('fecha', { ascending: false });
  if (error) throw error;
  state.ganadores = data || [];
  $('#ganadores-admin-lista').innerHTML = state.ganadores.length ? state.ganadores.map(item => `<article class="panel-section ganador-admin"><div><strong>${escapar(item.nombre)}</strong><p>${escapar(item.cartones)} · ${escapar(item.premio)} · ${escapar(item.fecha || '')}</p></div><button class="btn-danger btn-small" data-borrar-ganador="${item.id}">Eliminar</button></article>`).join('') : '<div class="panel-section">No hay ganadores.</div>';
  $$('[data-borrar-ganador]').forEach(boton => boton.addEventListener('click', () => borrarGanador(Number(boton.dataset.borrarGanador))));
}

async function guardarGanador(evento) {
  evento.preventDefault();
  const fila = {
    nombre: $('#g-nombre').value.trim(),
    cedula: $('#g-cedula').value.trim(),
    cartones: $('#g-cartones').value.trim(),
    premio: $('#g-premio').value.trim(),
    telefono: $('#g-telefono').value.trim(),
    fecha: $('#g-fecha').value
  };
  const { error } = await db.from('ganadores').insert(fila);
  if (error) return alert(error.message);
  evento.currentTarget.reset();
  await cargarGanadores();
}

async function borrarGanador(id) {
  if (!confirm('¿Eliminar este ganador del historial?')) return;
  const { error } = await db.from('ganadores').delete().eq('id', id);
  if (error) return alert(error.message);
  await cargarGanadores();
}

function activarRealtime() {
  if (state.realtime) return;
  state.realtime = db.channel('admin-bingo-ganga')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'inscripciones' }, programarRecarga)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'configuracion' }, () => cargarConfiguracion())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ganadores' }, () => cargarGanadores())
    .subscribe();
}

function programarRecarga() {
  clearTimeout(state.recargaPendiente);
  state.recargaPendiente = setTimeout(cargarInscripciones, 700);
}

function cambiarTab(id, boton) {
  $$('.admin-tabs button').forEach(item => item.classList.remove('active'));
  $$('.tab-content').forEach(item => item.classList.remove('active'));
  boton.classList.add('active');
  document.getElementById(id).classList.add('active');
}

function configurarEventos() {
  $('#login-form').addEventListener('submit', autenticar);
  $('#recuperar-clave').addEventListener('click', recuperarClave);
  $('#logout').addEventListener('click', cerrarSesion);
  $('#recargar').addEventListener('click', cargarTodo);
  $('#abrir-ventas').addEventListener('click', () => cambiarVentas(true));
  $('#cerrar-ventas').addEventListener('click', () => cambiarVentas(false));
  $('#cartones-config-form').addEventListener('submit', guardarCartonesConfig);
  $('#config-form').addEventListener('submit', guardarConfigGeneral);
  $('#pago-config-form').addEventListener('submit', guardarPagoConfig);
  $('#promos-form').addEventListener('submit', guardarPromos);
  $('#ganador-form').addEventListener('submit', guardarGanador);
  $('#buscar-inscripcion').addEventListener('input', renderInscripciones);
  $('#filtro-estado').addEventListener('change', renderInscripciones);
  $('#orden-inscripciones').addEventListener('change', renderInscripciones);
  $('#btn-buscar-carton').addEventListener('click', buscarCarton);
  $('#duplicados-nombre').addEventListener('click', () => detectarDuplicados('nombre'));
  $('#duplicados-referencia').addEventListener('click', () => detectarDuplicados('referencia'));
  $('#duplicados-carton').addEventListener('click', () => detectarDuplicados('carton'));
  $('#ver-huerfanos').addEventListener('click', verHuerfanos);
  $('#liberar-huerfanos').addEventListener('click', liberarHuerfanos);
  $('#reiniciar-ventas').addEventListener('click', reiniciarVentas);
  $('#subir-cartones').addEventListener('click', subirCartones);
  $('#borrar-imagenes-cartones').addEventListener('click', borrarImagenesCartones);
  $('#subir-premios').addEventListener('click', subirPremios);
  $('#eliminar-premios').addEventListener('click', eliminarPremios);
  $('#imprimir-aprobados').addEventListener('click', () => window.print());
  $$('.admin-tabs button').forEach(boton => boton.addEventListener('click', () => cambiarTab(boton.dataset.tab, boton)));
}

document.addEventListener('DOMContentLoaded', () => {
  configurarEventos();
  verificarSesion();
});
