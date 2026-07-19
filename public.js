'use strict';
const db = window.db;
const state = { config: {}, jugador: null, elegidos: new Set(), ocupados: new Set() };
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const limpiarCedula = (v) => String(v || '').replace(/\D/g, '');
const escapar = (v) => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

function ir(id) {
  $$('.pantalla').forEach(x => { x.classList.add('oculto'); x.classList.remove('activa'); });
  const destino = document.getElementById(id);
  destino?.classList.remove('oculto'); destino?.classList.add('activa');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (id === 'aprobados') cargarAprobados();
  if (id === 'ganadores') cargarGanadores();
}

async function cargarConfig() {
  const { data, error } = await db.from('configuracion').select('clave,valore,valor');
  if (error) throw error;
  state.config = Object.fromEntries((data || []).map(x => [x.clave, x.valore ?? x.valor]));
  const link = state.config.link_whatsapp;
  if (link) { $('#btnWhatsapp').href = link; $('#btnWhatsapp').classList.remove('oculto'); }
}

function totalCartones() { return Math.max(1, Number(state.config.total_cartones || 300)); }
function precio() { return Math.max(0, Number(state.config.precio_carton || 0)); }

async function cargarOcupados() {
  const { data, error } = await db.from('cartones').select('numero');
  if (error) throw error;
  state.ocupados = new Set((data || []).map(x => Number(x.numero)));
}

function renderCartones() {
  const cont = $('#contenedor-cartones'); cont.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= totalCartones(); n++) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'carton'; b.textContent = n;
    if (state.ocupados.has(n) && !state.elegidos.has(n)) { b.classList.add('ocupado'); b.disabled = true; }
    if (state.elegidos.has(n)) b.classList.add('seleccionado');
    b.addEventListener('click', () => alternarCarton(n, b)); frag.appendChild(b);
  }
  cont.appendChild(frag); resumen();
}

function cantidadDeseada() {
  const modo = state.config.modo_cartones || 'libre';
  return modo === 'fijo' ? Math.max(1, Number(state.config.cartones_obligatorios || 1)) : Math.max(1, Number($('#cantidad').value || 1));
}

async function alternarCarton(numero, boton) {
  if (state.elegidos.has(numero)) {
    await db.rpc('rpc_liberar_reserva', { _numero: numero, _cedula: state.jugador.cedula });
    state.elegidos.delete(numero); state.ocupados.delete(numero); boton.classList.remove('seleccionado'); resumen(); return;
  }
  if (state.elegidos.size >= cantidadDeseada()) return alert(`Solo debes elegir ${cantidadDeseada()} cartones.`);
  boton.disabled = true;
  const { data, error } = await db.rpc('rpc_reservar_carton', { _numero: numero, _cedula: state.jugador.cedula });
  boton.disabled = false;
  if (error || !data?.exito) { boton.classList.add('ocupado'); state.ocupados.add(numero); return alert(data?.mensaje || error?.message || 'No disponible'); }
  state.elegidos.add(numero); state.ocupados.add(numero); boton.classList.add('seleccionado'); resumen();
}

function resumen() {
  const cant = cantidadDeseada();
  $('#resumen-seleccion').textContent = `${state.elegidos.size} de ${cant} seleccionados · ${(state.elegidos.size * precio()).toFixed(2)} Bs`;
  $('#continuar-pago').disabled = state.elegidos.size !== cant;
}

async function elegirAleatorios() {
  const disponibles = Array.from({length: totalCartones()}, (_,i)=>i+1).filter(n=>!state.ocupados.has(n));
  disponibles.sort(()=>Math.random()-.5);
  for (const n of disponibles.slice(0, Math.max(0, cantidadDeseada()-state.elegidos.size))) {
    const boton = $$('.carton').find(x=>Number(x.textContent)===n); await alternarCarton(n, boton);
  }
}

async function subirComprobante(file) {
  if (!file || file.size > 5 * 1024 * 1024) throw new Error('El comprobante debe pesar menos de 5 MB.');
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${new Date().toISOString().slice(0,10)}/${crypto.randomUUID()}.${ext}`;
  const { error } = await db.storage.from('comprobantes').upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error; return path;
}

async function enviarInscripcion(e) {
  e.preventDefault(); const btn = $('#enviar'); btn.disabled = true; $('#estado-envio').textContent = 'Enviando…';
  let path = null;
  try {
    path = await subirComprobante($('#comprobante').files[0]);
    const cartones = [...state.elegidos].sort((a,b)=>a-b);
    const { error } = await db.rpc('rpc_crear_inscripcion', {
      _nombre: state.jugador.nombre, _telefono: state.jugador.telefono, _cedula: state.jugador.cedula,
      _referido: state.jugador.referido || '', _cartones: cartones, _referencia4dig: $('#referencia').value,
      _comprobante: path, _monto_bs: cartones.length * precio(), _pago_banco: state.config.pago_banco || null,
      _pago_telefono: state.config.pago_telefono || null, _pago_cedula: state.config.pago_cedula || null
    });
    if (error) throw error;
    $('#estado-envio').textContent = 'Inscripción enviada. Será revisada por el administrador.';
    state.elegidos.clear(); $('#form-pago').reset(); setTimeout(()=>location.reload(),2500);
  } catch (error) {
    if (path) await db.storage.from('comprobantes').remove([path]);
    $('#estado-envio').textContent = error.message; btn.disabled = false;
  }
}

async function consultar(e) {
  e.preventDefault(); const cedula = limpiarCedula($('#consulta-cedula').value);
  const { data, error } = await db.rpc('rpc_consultar_jugadas', { _cedula: cedula });
  const out = $('#resultado-consulta');
  if (error) return out.textContent = error.message;
  out.innerHTML = (data || []).length ? data.map(x=>`<article class="panel-section"><b>${escapar(x.estado || 'pendiente')}</b><p>Cartones: ${escapar((x.cartones||[]).join(', '))}</p></article>`).join('') : '<p>No se encontraron jugadas.</p>';
}

async function cargarAprobados() {
  const { data, error } = await db.rpc('rpc_lista_aprobados');
  $('#lista-aprobados').innerHTML = error ? escapar(error.message) : `<div class="table-wrapper"><table><thead><tr><th>Cartón</th><th>Jugador</th><th>Cédula</th></tr></thead><tbody>${(data||[]).map(x=>`<tr><td>${x.carton}</td><td>${escapar(x.nombre)}</td><td>${escapar(x.cedula_mascara)}</td></tr>`).join('')}</tbody></table></div>`;
}

async function cargarGanadores() {
  const { data, error } = await db.from('ganadores').select('nombre,cartones,premio,fecha').order('fecha',{ascending:false});
  $('#lista-ganadores').innerHTML = error ? escapar(error.message) : (data||[]).map(x=>`<article class="panel-section"><h2>${escapar(x.nombre)}</h2><p>Cartón: ${escapar(x.cartones)} · Premio: ${escapar(x.premio)} · ${escapar(x.fecha)}</p></article>`).join('') || '<p>Aún no hay ganadores.</p>';
}

document.addEventListener('DOMContentLoaded', async () => {
  try { await cargarConfig(); await cargarOcupados(); }
  catch (e) { alert(`No se pudo iniciar: ${e.message}`); }
  $$('[data-ir]').forEach(b=>b.addEventListener('click',()=>ir(b.dataset.ir)));
  $('#form-jugador').addEventListener('submit', async e=>{ e.preventDefault();
    if (state.config.ventas_abierta === false || state.config.ventas_abierta === 'false') return alert('Las ventas están cerradas.');
    state.jugador={nombre:$('#nombre').value.trim(),telefono:$('#telefono').value.trim(),cedula:limpiarCedula($('#cedula').value),referido:limpiarCedula($('#referido').value)};
    if (state.jugador.cedula.length<5) return alert('Cédula inválida.');
    $('#cantidad').value = state.config.modo_cartones==='fijo' ? state.config.cartones_obligatorios || 1 : 1;
    $('#cantidad').readOnly = state.config.modo_cartones==='fijo'; await cargarOcupados(); renderCartones(); ir('seleccion');
  });
  $('#mas').addEventListener('click',()=>{ $('#cantidad').stepUp(); resumen(); }); $('#menos').addEventListener('click',()=>{ $('#cantidad').stepDown(); resumen(); }); $('#cantidad').addEventListener('input',resumen);
  $('#aleatorios').addEventListener('click',elegirAleatorios); $('#continuar-pago').addEventListener('click',()=>{ $('#monto-pago').textContent=(state.elegidos.size*precio()).toFixed(2); $('#datos-pago').innerHTML=`<b>${escapar(state.config.pago_banco||'')}</b><p>Teléfono: ${escapar(state.config.pago_telefono||'')}</p><p>Cédula: ${escapar(state.config.pago_cedula||'')}</p>`; ir('pago'); });
  $('#form-pago').addEventListener('submit',enviarInscripcion); $('#form-consulta').addEventListener('submit',consultar);
  const reloj=()=>$('#hora-venezuela').textContent=new Intl.DateTimeFormat('es-VE',{timeZone:'America/Caracas',dateStyle:'full',timeStyle:'medium'}).format(new Date()); reloj(); setInterval(reloj,1000);
});
