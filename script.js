var supabase = window.supabase;

// La página se identifica por el bloque original del administrador, sin alterar el diseño.
const ES_PAGINA_ADMIN = Boolean(document.getElementById('admin-panel'));

// ==================== API BINGO GANGA ====================
const BINGO_GANGA_SUPABASE_URL = 'https://yuwsktbtdweirzopowhf.supabase.co';
const BINGO_GANGA_SUPABASE_KEY = 'sb_publishable_oi-vZmq97DcHzPet79cwqA_3pJjB3nd';

const ADMIN_AUTH_URL = `${BINGO_GANGA_SUPABASE_URL}/functions/v1/admin-auth`;
const VERIFY_SESSION_URL = `${BINGO_GANGA_SUPABASE_URL}/functions/v1/verify-session`;
const UPDATE_SESSION_URL = `${BINGO_GANGA_SUPABASE_URL}/functions/v1/update-session`;

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

const EDGE_FUNCTION_HEADERS = {
  'Content-Type': 'application/json',
  'apikey': BINGO_GANGA_SUPABASE_KEY,
  'Authorization': `Bearer ${BINGO_GANGA_SUPABASE_KEY}`
};

// Configuración del administrador
let sistemaListo = false;
// Variables globales
let cartonesOcupados = [];
let precioPorCarton = 0;
let cantidadPermitida = 0;
let promocionSeleccionada = null;
let modoCartones = "libre";
let cantidadFijaCartones = 1;
let detectorIniciado = false;

// Variables de sesión
let adminSession = null;
let sesionActiva = false;

const ultimoEstadoProcesado = new Map();
const estadoEnProceso = new Set();

async function procesarEstadoUnaVez(id, fila, nuevoEstado, accion) {
  const claveProceso = `${id}-${nuevoEstado}`;

  const estadoActualFila = fila?.dataset?.estadoActual || '';
  const ultimoEstado = ultimoEstadoProcesado.get(id) || estadoActualFila;

  // Si ya está en ese mismo estado, no hace nada
  if (ultimoEstado === nuevoEstado) {
    console.log(`Inscripción ${id} ya está en estado ${nuevoEstado}. No se repite.`);
    return;
  }

  // Si ya se está procesando esa misma acción, no repite
  if (estadoEnProceso.has(claveProceso)) {
    console.log(`Ya se está procesando ${nuevoEstado} para inscripción ${id}`);
    return;
  }

  estadoEnProceso.add(claveProceso);

  try {
    const ok = await accion();

    if (ok !== false) {
      ultimoEstadoProcesado.set(id, nuevoEstado);

      if (fila) {
        fila.dataset.estadoActual = nuevoEstado;
      }
    }
  } catch (error) {
    console.error('Error procesando estado:', error);
  } finally {
    estadoEnProceso.delete(claveProceso);
  }
}
// Timeout de sesión del administrador (30 minutos)
const SESSION_TIMEOUT = 30 * 60 * 1000;
console.log(
  '✅ SESSION_TIMEOUT =',
  SESSION_TIMEOUT,
  'ms =',
  SESSION_TIMEOUT / 60000,
  'minutos'
);
let inactivityTimer;

const promociones = [
  { id: 1, activa: false, descripcion: '', cantidad: 0, precio: 0 },
  { id: 2, activa: false, descripcion: '', cantidad: 0, precio: 0 },
  { id: 3, activa: false, descripcion: '', cantidad: 0, precio: 0 },
  { id: 4, activa: false, descripcion: '', cantidad: 0, precio: 0 }
];

let usuario = {
  nombre: '',
  telefono: '',
  cedula: '',
  referido: '',
  cartones: [],
};

function claveTokenReserva(cedula) {
  const cedulaLimpia = String(cedula || '').replace(/\D+/g, '');
  return cedulaLimpia ? `bingo_reserva_token_${cedulaLimpia}` : '';
}

function obtenerTokenReserva(cedula) {
  const clave = claveTokenReserva(cedula);
  if (!clave) return '';

  let token = sessionStorage.getItem(clave);

  if (!/^[0-9a-f]{64}$/.test(token || '')) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    token = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem(clave, token);
  }

  return token;
}

function borrarTokenReserva(cedula) {
  const clave = claveTokenReserva(cedula);
  if (clave) sessionStorage.removeItem(clave);
}

let totalCartones = 0;
let timerReserva = null;
// ==================== VERSIÓN MÁS SIMPLE ====================
let contador = 0;

// Registrar listener en el logo después de cargar
setTimeout(() => {
  const logo = document.querySelector('#bienvenida img, .logo, h1');

  if (logo) {
    logo.addEventListener('click', () => {
      contador++;

      // Reset del contador en 3 segundos
      setTimeout(() => { contador = 0; }, 3000);

      // Si son 7 clicks
      if (contador === 7) {
        contador = 0;

        const botonAdmin = document.getElementById('boton-admin-oculto');
        if (botonAdmin) {
          botonAdmin.style.display = 'inline-block';
          alert('🔓 Botón Admin activado');
        }
      }
    });
  }
}, 1000);

// Registrar listener del botón Admin **solo una vez**
const botonAdmin = document.getElementById('boton-admin-oculto');
if (botonAdmin) {
  botonAdmin.addEventListener('click', () => {
    window.location.href = 'admin.html';
  });
}
// ==================== FUNCIONES DE CONFIGURACIÓN ====================
let configuracionPublicaCache = null;
let configuracionPublicaCargando = null;

async function cargarConfiguracionPublica(forzar = false) {
  if (!forzar && configuracionPublicaCache) return configuracionPublicaCache;
  if (!forzar && configuracionPublicaCargando) return configuracionPublicaCargando;

  configuracionPublicaCargando = (async () => {
    const { data, error } = await supabase.rpc('rpc_configuracion_publica');

    if (error) {
      console.error('Error cargando la configuración pública:', error);
      return new Map();
    }

    configuracionPublicaCache = new Map(
      (data || []).map(item => [item.clave, item.valore ?? item.valor ?? null])
    );

    return configuracionPublicaCache;
  })();

  try {
    return await configuracionPublicaCargando;
  } finally {
    configuracionPublicaCargando = null;
  }
}

async function getConfigValue(clave, fallback = null) {
  const configuracion = await cargarConfiguracionPublica();
  return configuracion.has(clave) ? configuracion.get(clave) : fallback;
}

async function setConfigValue(clave, value) {
  const { error } = await supabase
    .from('configuracion')
    .upsert([{ clave, valore: value }], { onConflict: 'clave' });

  if (!error) configuracionPublicaCache = null;
  return !error;
}

async function cargarDatosPagoVenta() {
  const banco = await getConfigValue('pago_banco', '');
  const telefono = await getConfigValue('pago_telefono', '');
  const cedula = await getConfigValue('pago_cedula', '');
  const bancoNumero = banco.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  const bancoElemento = document.getElementById('adminPagoBanco');

  if (bancoElemento && banco) {
    const tituloBanco = bancoElemento.closest('p')?.querySelector('strong');

    if (bancoNumero) {
      if (tituloBanco) tituloBanco.textContent = bancoNumero[1];
      bancoElemento.textContent = bancoNumero[2];
    } else {
      if (tituloBanco) tituloBanco.textContent = 'Banco:';
      bancoElemento.textContent = banco;
    }
  }

  if (telefono) {
    const telefonoElemento = document.getElementById('adminPagoTelefono');
    if (telefonoElemento) telefonoElemento.textContent = telefono;
  }

  if (cedula) {
    const cedulaElemento = document.getElementById('adminPagoCedula');
    if (cedulaElemento) cedulaElemento.textContent = cedula;
  }
}

// ==================== SISTEMA DE SESIÓN ÚNICA ====================
// Función para cerrar sesión
 async function cerrarSesionAdmin() {
  // Cierre “silencioso” para expiración / sesión inválida
  // No pedir confirmación, solo cerrar.
  await logoutAdminSilencioso();
}

// Igual que logoutAdmin, pero sin confirm()
async function logoutAdminSilencioso() {
  const email = sessionStorage.getItem('admin_email');
  const deviceId =
    sessionStorage.getItem('device_id') ||
    localStorage.getItem('admin_device_id') ||
    localStorage.getItem('device_id');

  const sessionToken = sessionStorage.getItem('admin_session_token');

  try {
    if (email && deviceId) {
      await fetch(ADMIN_AUTH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': BINGO_GANGA_SUPABASE_KEY
        },
        body: JSON.stringify({ action: 'logout', email, deviceId, sessionToken })
      });
    }
  } catch (e) {
    console.warn('Logout silencioso falló (red), limpiando local igual:', e);
  } finally {
    clearAdminSession();
    resetToLoginState();
  }
}

// ========== FUNCIÓN LOGOUT COMPATIBLE CON TU CÓDIGO ==========
async function logoutAdmin() {
  // TÚ usas sessionStorage, no localStorage:
  const email = sessionStorage.getItem('admin_email');
  const deviceId = localStorage.getItem('admin_device_id');
  const sessionToken = sessionStorage.getItem('admin_session_token');
  
  console.log('🔍 Datos para logout:', { email, deviceId, sessionToken });
  
  if (!email || !deviceId) {
    console.log("⚠️ No hay sesión activa completa");
    // Aún así redirigir
    resetToLoginState();
    return;
  }

  try {
    // Opcional: confirmación
    if (!confirm('¿Estás seguro de cerrar sesión?\n\n✅ Esto liberará tu dispositivo para iniciar en otro lugar.')) {
      return;
    }
    
    console.log('🔄 Enviando logout al servidor...');
    
    const response = await fetch(
      ADMIN_AUTH_URL,
      {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'apikey': BINGO_GANGA_SUPABASE_KEY
        },
        body: JSON.stringify({
          action: 'logout',
          email: email,
          deviceId: deviceId,
          sessionToken: sessionToken
        })
      }
    );
    
    console.log('📡 Estado respuesta logout:', response.status);
    const result = await response.json();
    console.log('📦 Resultado logout:', result);
    
    if (result.success) {
      console.log('✅ Logout exitoso en servidor');
      clearAdminSession();
      alert('✅ Sesión cerrada. Ahora puedes iniciar en otro dispositivo.');
      resetToLoginState();
    } else {
      console.error("❌ Error del servidor al cerrar sesión:", result.error);
      // Aún así limpiar localmente
      clearAdminSession();
      resetToLoginState();
    }
    
  } catch (error) {
    console.error("❌ Error en logout:", error);
    // Aún así limpiar localmente
    clearAdminSession();
    resetToLoginState();
  }
}

// ========== FUNCIÓN PARA LIMPIAR SESIÓN (COMPATIBLE) ==========
function clearAdminSession() {
  console.log('🧹 Limpiando sesión...');

  // Cerrar también la sesión de Supabase Auth que autoriza las operaciones RLS.
  void supabase.auth.signOut({ scope: 'local' }).catch(error => {
    console.warn('No se pudo cerrar Supabase Auth localmente:', error);
  });
  
  // Limpiar sessionStorage (lo que TÚ usas)
  sessionStorage.removeItem('admin_session_token');
  sessionStorage.removeItem('admin_email');
  sessionStorage.removeItem('session_expires');
  sessionStorage.removeItem('device_id');
  
  // NO limpiar el device_id de localStorage, se reutiliza
  // localStorage.removeItem('admin_device_id');  // ← NO hacer esto
  
  // Limpiar variables globales (si las tienes)
  if (typeof adminSession !== 'undefined') {
    adminSession = null;
  }
  if (typeof sesionActiva !== 'undefined') {
    sesionActiva = false;
  }
  
  // Detener timers si existen
  if (typeof inactivityTimer !== 'undefined' && inactivityTimer) {
    clearTimeout(inactivityTimer);
  }
  if (typeof sessionCheckInterval !== 'undefined' && sessionCheckInterval) {
    clearInterval(sessionCheckInterval);
  }
  
  // Eliminar elementos del DOM que puedan existir
  const sessionInfo = document.getElementById('session-info');
  if (sessionInfo) sessionInfo.remove();
  
  console.log('✅ Sesión limpiada localmente');
}

// ========== FUNCIÓN PARA VOLVER A LOGIN (COMPATIBLE) ==========
function resetToLoginState() {
  console.log('🔄 Regresando a estado de login...');
  
  // Ocultar panel, mostrar login
  const adminPanel = document.getElementById('admin-panel');
  const adminLogin = document.getElementById('admin-login');
  
  if (adminPanel) adminPanel.classList.add('oculto');
  if (adminLogin) adminLogin.classList.remove('oculto');
  
  // Limpiar campos
  const adminPassword = document.getElementById('admin-password');
  const adminError = document.getElementById('admin-error');
  
  if (adminPassword) adminPassword.value = '';
  if (adminError) {
    adminError.textContent = '';
    adminError.className = '';
  }
}

// ========== CONFIGURAR EVENT LISTENER ==========
document.addEventListener('DOMContentLoaded', function() {
  const logoutBtn = document.getElementById('logoutBtn');
  
  if (logoutBtn) {
    logoutBtn.addEventListener('click', logoutAdmin);
    console.log('✅ Botón de logout configurado');
  }
});



// ==================== NUEVA: VERIFICACIÓN SESIÓN ÚNICA POR USUARIO ====================
// Función para verificar si el usuario YA tiene sesión activa (en cualquier navegador)
async function verificarSesionAdmin() {
 const sessionToken = sessionStorage.getItem('admin_session_token');

const deviceId =
  sessionStorage.getItem('device_id') ||
  localStorage.getItem('admin_device_id');
  if (!sessionToken || !deviceId) return false;

  try {
    const response = await fetch(
      VERIFY_SESSION_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': BINGO_GANGA_SUPABASE_KEY,
          'Authorization': `Bearer ${BINGO_GANGA_SUPABASE_KEY}`
        },
        body: JSON.stringify({ sessionToken, deviceId })
      }
    );

    if (!response.ok) return false;

    const result = await response.json();
    console.log('VERIFY SESSION:', result);

    if (result.expiresAt) {
      sessionStorage.setItem('session_expires', result.expiresAt);
      localStorage.setItem('session_expires', result.expiresAt);
    }

    return result.valid === true && result.sameDevice === true;
  } catch (err) {
    console.error('Error verificando sesión:', err);
    return false;
  }
}


// Función para mostrar alerta de sesión duplicada
function mostrarAlertaSesionDuplicada() {
  // Crear overlay bloqueante
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.8);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 9999;
  `;
  
  const alerta = document.createElement('div');
  alerta.style.cssText = `
    background: white;
    padding: 30px;
    border-radius: 10px;
    text-align: center;
    max-width: 500px;
    width: 90%;
    box-shadow: 0 5px 15px rgba(0,0,0,0.3);
  `;
  
  
  overlay.appendChild(alerta);
  document.body.appendChild(overlay);
}

// ==================== FIN NUEVAS FUNCIONES ====================


// ==================== LOGIN ADMIN SIN CÓDIGO DE VERIFICACIÓN ====================
async function loginAdmin() {
  const emailInput = document.getElementById('admin-email');
  const passwordInput = document.getElementById('admin-password');
  const errorDiv = document.getElementById('admin-error');

  const email = emailInput?.value.trim().toLowerCase() || '';
  const password = passwordInput?.value || '';

  if (!errorDiv) {
    console.error('No se encontró el elemento #admin-error');
    return;
  }

  errorDiv.textContent = '';
  errorDiv.className = '';
  errorDiv.style.whiteSpace = 'pre-line';

  if (!email || !password) {
    errorDiv.textContent = 'Por favor ingresa email y contraseña';
    errorDiv.className = 'error';
    return;
  }

  let deviceId = localStorage.getItem('admin_device_id');

  if (!deviceId) {
    deviceId = `device_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    localStorage.setItem('admin_device_id', deviceId);
  }

  try {
    errorDiv.textContent = '🔐 Verificando email y contraseña...';
    errorDiv.className = 'info';

    const credentialsResponse = await fetch(ADMIN_AUTH_URL, {
      method: 'POST',
      headers: EDGE_FUNCTION_HEADERS,
      body: JSON.stringify({
        email,
        password,
        deviceId,
        action: 'verify_credentials'
      })
    });

    const credentialsResult = await credentialsResponse
      .json()
      .catch(() => ({}));

    if (!credentialsResponse.ok) {
      if (
        credentialsResult.error === 'SESION_ACTIVA_OTRO_DISPOSITIVO' ||
        credentialsResult.error === 'SESION_ACTIVA'
      ) {
        errorDiv.innerHTML = `
          ⚠️ <strong>Ya existe una sesión activa.</strong><br><br>
          Cierra la sesión en el otro dispositivo o navegador y vuelve a intentarlo.
        `;
        errorDiv.className = 'warning';
      } else {
        errorDiv.textContent =
          credentialsResult.error || 'Correo o contraseña incorrectos';
        errorDiv.className = 'error';
      }

      if (passwordInput) passwordInput.value = '';
      return;
    }

    errorDiv.textContent = '✅ Credenciales correctas. Creando sesión...';
    errorDiv.className = 'success';

    // Algunas versiones de admin-auth ya devuelven la sesión al verificar.
    let sessionResult = credentialsResult;

    // Compatibilidad con la Edge Function actualmente instalada.
    if (!sessionResult.sessionToken) {
      const sessionResponse = await fetch(ADMIN_AUTH_URL, {
        method: 'POST',
        headers: EDGE_FUNCTION_HEADERS,
        body: JSON.stringify({
          email,
          deviceId,
          action: 'create_session_otp'
        })
      });

      sessionResult = await sessionResponse.json().catch(() => ({}));

      if (!sessionResponse.ok) {
        throw new Error(
          sessionResult.error || 'No se pudo crear la sesión del administrador'
        );
      }
    }

    if (!sessionResult.sessionToken) {
      throw new Error('El servidor no devolvió un token de sesión');
    }

    if (!sessionResult.accessToken || !sessionResult.refreshToken) {
      throw new Error('El servidor no devolvió una sesión de Supabase Auth');
    }

    const { error: authSessionError } = await supabase.auth.setSession({
      access_token: sessionResult.accessToken,
      refresh_token: sessionResult.refreshToken
    });

    if (authSessionError) {
      throw new Error('No se pudo activar la sesión segura del administrador');
    }

    const sessionEmail = sessionResult.email || email;
    const sessionDeviceId = sessionResult.deviceId || deviceId;
    const expiresAt =
      sessionResult.expiresAt ||
      new Date(Date.now() + SESSION_TIMEOUT).toISOString();

    sessionStorage.setItem(
      'admin_session_token',
      sessionResult.sessionToken
    );
    sessionStorage.setItem('admin_email', sessionEmail);
    sessionStorage.setItem('session_expires', expiresAt);
    sessionStorage.setItem('device_id', sessionDeviceId);

    localStorage.setItem('admin_device_id', sessionDeviceId);
    localStorage.removeItem('admin_session_token');
    localStorage.removeItem('admin_email');
    localStorage.removeItem('session_expires');

    adminSession = {
      email: sessionEmail,
      token: sessionResult.sessionToken
    };
    sesionActiva = true;

    if (passwordInput) passwordInput.value = '';

    errorDiv.innerHTML =
      '✅ <strong>Acceso concedido.</strong><br>Abriendo panel de administración...';
    errorDiv.className = 'success';

    const emailDisplay = document.getElementById('admin-email-display');
    if (emailDisplay) emailDisplay.textContent = sessionEmail;

    const loginSection = document.getElementById('admin-login');
    const adminPanel = document.getElementById('admin-panel');

    if (loginSection) loginSection.classList.add('oculto');
    if (adminPanel) adminPanel.classList.remove('oculto');

    iniciarDetectorActividad();
    resetInactivityTimer();

    await cargarPanelAdmin();
    activarRefrescoAutomaticoAdmin();
  } catch (error) {
    console.error('❌ Error en loginAdmin:', error);

    errorDiv.textContent =
      error?.message === 'Failed to fetch'
        ? 'Error de red. Verifica tu conexión a internet.'
        : `Error de acceso: ${error?.message || 'desconocido'}`;
    errorDiv.className = 'error';

    if (passwordInput) passwordInput.value = '';
  }
}

// Función para forzar cierre remoto
async function forzarCerrarSesionRemota() {
  const errorDiv = document.getElementById('admin-error');
  
  try {
    errorDiv.textContent = '🔄 Forzando cierre de sesión remota...';
    errorDiv.className = 'info';
    
    // Aquí necesitarías crear otra   Edge Function o modificar la existente
    // para forzar el cierre de todas las sesiones
    
    // Por ahora, usamos un enfoque simple: limpiar la tabla
    const { data: authData } = await supabase.auth.getSession();
    const accessToken = authData.session?.access_token;

    if (!accessToken) {
      throw new Error('No hay una sesión administrativa autenticada');
    }

    const response = await fetch(
      UPDATE_SESSION_URL,
      {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'apikey': BINGO_GANGA_SUPABASE_KEY,
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({ 
          action: "force_logout_all"
        })
      }
    );
    if (response.ok) {
      errorDiv.innerHTML = '✅ Sesiones remotas cerradas.<br>Ahora puedes iniciar sesión.';
      errorDiv.className = 'success';
      
      // recargar la página después de 2 segundos
      setTimeout(() => {
        location.reload();
      }, 2000);
    } else {
      throw new Error('Error forzando cierre');
    }
    
  } catch (error) {
    console.error('❌ Error forzando cierre:', error);
    errorDiv.textContent = 'Error al forzar cierre remoto';
    errorDiv.className = 'error';
  }
}

// Función para cancelar login
function cancelarLogin() {
  const errorDiv = document.getElementById('admin-error');
  errorDiv.textContent = '';
  errorDiv.className = '';
  document.getElementById('admin-password').value = '';
}
// Función auxiliar para generar ID de dispositivo
function generateDeviceId() {
  let deviceId = localStorage.getItem('admin_device_id');

  if (!deviceId) {
    deviceId =
      'device_' +
      btoa(navigator.userAgent).substring(0, 20) + '_' +
      Date.now() + '_' +
      Math.random().toString(36).substr(2, 9);

    localStorage.setItem('admin_device_id', deviceId);
  }

  return deviceId;
}


// Función pa obtener IP del cliente (simplificada)
async function getClientIP() {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    return data.ip;
  } catch {
    return 'unknown';
  }
}

// Función para continuar con sesión exitosa
function proceedWithSession(sessionToken, email, expiresAt) {
  console.log('✅ Sesión única creada exitosamente');
  
  // Guardar sesión localmente
  sessionStorage.setItem('admin_session_token', sessionToken);
  sessionStorage.setItem('admin_email', email);
  sessionStorage.setItem('session_expires', expiresAt);
  sessionStorage.setItem('device_id', generateDeviceId());
  
  // Actualizar variables globales
  adminSession = { email: email, token: sessionToken };
  sesionActiva = true;
  
  // Mostrar mensaje de éxito
  const errorDiv = document.getElementById('admin-error');
  errorDiv.innerHTML = '✅ <strong>Autenticación exitosa!</strong><br><small>Sesión única activa</small>';
  errorDiv.className = 'success';
  
  setTimeout(() => {
    document.getElementById('admin-email-display').textContent = email;
    mostrarPanelAdminSeguro(sessionToken);
    
    // Iniciar controles de sesión
    iniciarDetectorActividad();
    resetInactivityTimer();
  }, 1000);
}
// Nueva función para mostrar panel seguro
async function mostrarPanelAdminSeguro(sessionToken) {
  console.log('🎉 Mostrando panel admin seguro');

  // Ocultar todas las secciones visibles
  document.querySelectorAll('section').forEach(sec => sec.classList.add('oculto'));

  // Ocultar login si estaba abierto
  document.getElementById('admin-login').classList.add('oculto');

  // Mostrar panel admin
  const panel = document.getElementById('admin-panel');
  panel.classList.remove('oculto');

  // Insertar info de sesión
  document.getElementById('session-info')?.remove();
  const sessionInfo = document.createElement('div');
  sessionInfo.id = 'session-info';
  sessionInfo.style.cssText = `
    margin: 10px 0;
    padding: 10px;
    border-radius: 5px;
    font-size: 14px;
    background: #d4edda;
    color: #155724;
    border: 1px solid #c3e6cb;
  `;
  sessionInfo.innerHTML = `
    🔒 <strong>SESIÓN SEGURA ACTIVA</strong><br>
    <small>Autenticación vía Edge Function</small><br>
    <small>Token: ${sessionToken?.substring(0, 25)}...</small>
  `;
  const adminHeader = panel.querySelector('.admin-header');
  if (adminHeader) {
    adminHeader.insertAdjacentElement('afterend', sessionInfo);
  } else {
    panel.prepend(sessionInfo);
  }

  // Cargar datos del panel y refresco automático
  await cargarPanelAdmin();
  activarRefrescoAutomaticoAdmin();

  // Llevar la ventana al top
  
}
// Función para actualizar actividad de sesión
function actualizarActividadSesion() {
  if (!sesionActiva) return;
  
  console.log('👀 Actividad detectada, actualizando sesión...');
  
  // Opcional: Notificar al servidor que la sesión sigue activa
  const sessionToken = sessionStorage.getItem('admin_session_token');
  if (sessionToken) {
    // Aquí puedes hacer una llamada a tu Edge Function si quieres
    // registrar la actividad en el servidor
    console.log('Sesión activa, token:', sessionToken.substring(0, 20) + '...');
  }
}
// Timer de inactividad
function resetInactivityTimer() {
  clearTimeout(inactivityTimer);
  if (sesionActiva) {
    console.log('⏰ Reiniciando timer de inactividad (30 minutos)');
    inactivityTimer = setTimeout(async () => {
      if (sesionActiva) {
        console.log('⏰ Sesión expirada por inactividad');
        alert('Sesión expirada por inactividad (30 minutos)');
        await cerrarSesionAdmin();
      }
    }, SESSION_TIMEOUT);
  }
}

// Eventos para detectar actividad
function iniciarDetectorActividad() {
  if (detectorIniciado) return; // ⛔ evita doble ejecución
  detectorIniciado = true;

  console.log('👀 Iniciando detector de actividad');

 ['click', 'keypress', 'scroll', 'touchstart'].forEach(event => {
    document.addEventListener(event, () => {
      if (sesionActiva) {
        actualizarActividadSesion();
        resetInactivityTimer();
      }
    });
  });
}


// Limpiar storage temporal
function limpiarStorageTemporal() {
  sessionStorage.removeItem('admin_email_temp');
  
  // Limpiar tokens temporales de Supabase
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.includes('sb-')) {
      keysToRemove.push(key);
    }
  }
  
  keysToRemove.forEach(key => localStorage.removeItem(key));
}

// ==================== VERIFICACIÓN INICIAL ====================
async function verificarSesionInicial() {
  console.log('🔍 Verificando sesión inicial al cargar...');

  // Ocultar panel y login mientras se verifica
  document.getElementById('admin-panel')?.classList.add('oculto');
  document.getElementById('admin-login')?.classList.add('oculto');
  document.getElementById('bienvenida')?.classList.remove('oculto');

  const sessionToken = sessionStorage.getItem('admin_session_token');

  if (!sessionToken) {
    console.log('ℹ️ No hay token guardado');
    return;
  }

  try {
    const esValida = await verificarSesionAdmin();

    if (esValida) {
     const email = sessionStorage.getItem('admin_email');

      console.log('✅ Sesión válida guardada para:', email);

      adminSession = { email, token: sessionToken };
      sesionActiva = true;

      if (document.getElementById('admin-email-display')) {
        document.getElementById('admin-email-display').textContent = email;
      }

      await cargarPanelAdmin();
      activarRefrescoAutomaticoAdmin();
      iniciarDetectorActividad();
      resetInactivityTimer();

      // **IMPORTANTE:** No abrir el panel automáticamente
      // Solo deja la sesión activa lista para cuando el usuario haga clic en Admin
      return;

    } else {
  console.log('⚠️ Sesión inválida, limpiando...');

  sessionStorage.removeItem('admin_session_token');
  sessionStorage.removeItem('admin_email');
  sessionStorage.removeItem('session_expires');
  sessionStorage.removeItem('device_id');

  localStorage.removeItem('admin_session_token');
  localStorage.removeItem('admin_email');
  localStorage.removeItem('session_expires');

  sesionActiva = false;
  adminSession = null;

  document.getElementById('admin-login')?.classList.add('oculto');
  document.getElementById('admin-panel')?.classList.add('oculto');
  document.getElementById('bienvenida')?.classList.remove('oculto');
}
 } catch (error) {
  console.error('❌ Error verificando sesión inicial:', error);

  sessionStorage.removeItem('admin_session_token');
  sessionStorage.removeItem('admin_email');
  sessionStorage.removeItem('session_expires');
  sessionStorage.removeItem('device_id');

  localStorage.removeItem('admin_session_token');
  localStorage.removeItem('admin_email');
  localStorage.removeItem('session_expires');

  sesionActiva = false;
  adminSession = null;

  document.getElementById('admin-login')?.classList.add('oculto');
  document.getElementById('admin-panel')?.classList.add('oculto');
  document.getElementById('bienvenida')?.classList.remove('oculto');
}
}
// ==================== FUNCIONES FALTANTES QUE NECESITA EL HTML ====================

// Función para ver lista de aprobados
async function verListaAprobados() {
  const { data, error } = await supabase
    .from('inscripciones')
    .select('*')
    .eq('estado', 'aprobado');

  const listaDiv = document.getElementById('listaAprobados');
  if (!listaDiv) {
    console.error('Elemento listaAprobados no encontrado');
    return;
  }

  listaDiv.innerHTML = '';

  if (error) {
    console.error('Error al obtener aprobados:', error);
    listaDiv.innerHTML = '<p>Error al obtener la lista.</p>';
    return;
  }

  if (data.length === 0) {
    listaDiv.innerHTML = '<p>No hay personas aprobadas.</p>';
    return;
  }

  const tabla = document.createElement('table');
  tabla.style.width = '100%';
  tabla.style.borderCollapse = 'collapse';

  tabla.innerHTML = `
    <thead>
      <tr>
        <th style="border: 1px solid #ccc; padding: 8px;">Nombre</th>
        <th style="border: 1px solid #ccc; padding: 8px;">Cédula</th>
        <th style="border: 1px solid #ccc; padding: 8px;">Cartones</th>
        <th style="border: 1px solid #ccc; padding: 8px;">Pago Móvil</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = tabla.querySelector('tbody');

  data.forEach(item => {
    const tr = document.createElement('tr');

    tr.innerHTML = `
      <td style="border: 1px solid #ccc; padding: 8px;">${escapeHTML(item.nombre)}</td>
      <td style="border: 1px solid #ccc; padding: 8px;">${escapeHTML(item.cedula)}</td>
      <td style="border: 1px solid #ccc; padding: 8px;">
        ${escapeHTML(Array.isArray(item.cartones) ? item.cartones.join(', ') : '')}
      </td>
      <td style="border: 1px solid #ccc; padding: 8px;">
  ${escapeHTML(item.pago_banco)}<br>
  ${escapeHTML(item.pago_telefono)}<br>
  ${escapeHTML(item.pago_cedula)}
</td>
    `;

    tbody.appendChild(tr);
  });

  listaDiv.appendChild(tabla);
}

// Función para detectar cartones duplicados
async function detectarCartonesDuplicados() {
  const boton = document.getElementById('btnDuplicados');
  if (!boton) return;
  
  const prev = boton.textContent;
  boton.disabled = true;
  boton.textContent = 'Buscando duplicados...';

  try {
    const { data, error } = await supabase
      .from('inscripciones')
      .select('id,nombre,cedula,estado,cartones')
      .in('estado', ['pendiente', 'aprobado']);

    if (error) throw error;

    const indice = new Map();

    (data || []).forEach(ins => {
      if (!Array.isArray(ins.cartones)) return;

      const únicos = new Set(
        ins.cartones
          .map(x => {
            if (typeof x === 'number') return x;
            if (typeof x === 'string') return parseInt(x, 10);
            try {
              const s = (x && typeof x === 'object') ? JSON.stringify(x) : String(x);
              return parseInt(s.replace(/[^0-9\-]/g,''), 10);
            } catch { return NaN; }
          })
          .filter(n => Number.isFinite(n))
      );

      únicos.forEach(n => {
        if (!indice.has(n)) indice.set(n, []);
        indice.get(n).push({ id: ins.id, nombre: ins.nombre || '', cedula: ins.cedula || '' });
      });
    });

    const duplicados = [];
    const duplicadosSet = new Set();
    
    for (const [numero, dueños] of indice.entries()) {
      if (dueños.length > 1) {
        duplicados.push({
          numero,
          personas: dueños,
          veces: dueños.length
        });
        duplicadosSet.add(numero);
      }
    }

    duplicados.sort((a, b) => (b.veces - a.veces) || (a.numero - b.numero));

    renderDuplicados(duplicados);
    resaltarCeldasDuplicadas(duplicadosSet);

  } catch (e) {
    console.error(e);
    const cont = document.getElementById('duplicadosResultado');
    if (cont) {
      cont.innerHTML = '<p style="color:#f44336;">Error buscando duplicados. Revisa la consola.</p>';
    }
  } finally {
    boton.disabled = false;
    boton.textContent = prev;
  }
}

// Función auxiliar para renderizar duplicados
function renderDuplicados(lista) {
  const cont = document.getElementById('duplicadosResultado');
  if (!cont) return;
  
  cont.innerHTML = '';

  if (!lista.length) {
    cont.innerHTML = '<p style="color:#4caf50;font-weight:bold;">No se encontraron cartones duplicados en inscripciones activas.</p>';
    return;
  }

  const tabla = document.createElement('table');
  tabla.style.width = '100%';
  tabla.style.borderCollapse = 'collapse';
  tabla.innerHTML = `
    <thead>
      <tr>
        <th style="border:1px solid #ccc;padding:6px;">Cartón</th>
        <th style="border:1px solid #ccc;padding:6px;">Personas</th>
        <th style="border:1px solid #ccc;padding:6px;">Veces</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  
  const tbody = tabla.querySelector('tbody');

  lista.forEach(row => {
    const tr = document.createElement('tr');
    
    const tdNumero = document.createElement('td');
    tdNumero.style.border = '1px solid #ccc';
    tdNumero.style.padding = '6px';
    tdNumero.textContent = String(row.numero);
    
    const tdPersonas = document.createElement('td');
    tdPersonas.style.border = '1px solid #ccc';
    tdPersonas.style.padding = '6px';
    tdPersonas.textContent = row.personas.map(p => `${p.nombre} (${p.cedula})`).join(', ');
    
    const tdVeces = document.createElement('td');
    tdVeces.style.border = '1px solid #ccc';
    tdVeces.style.padding = '6px';
    tdVeces.textContent = String(row.veces);
    
    tr.appendChild(tdNumero);
    tr.appendChild(tdPersonas);
    tr.appendChild(tdVeces);
    tbody.appendChild(tr);
  });

  cont.appendChild(tabla);
}

// Función auxiliar para resaltar celdas duplicadas
function resaltarCeldasDuplicadas(duplicadosSet) {
  const cartonesCells = document.querySelectorAll('#tabla-comprobantes tbody tr td:nth-child(5)');
  cartonesCells.forEach(td => {
    const nums = td.textContent
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n));

    const tieneDuplicado = nums.some(n => duplicadosSet.has(n));
    td.style.backgroundColor = tieneDuplicado ? 'rgba(255,0,0,0.18)' : '';
  });
}

// Función para r huérfanos
async function verHuerfanos() {
  const btn = document.getElementById('btnVerHuerfanos');
  if (!btn) return;
  
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Buscando...';
  
  try {
    const { data, error } = await supabase.rpc('rpc_listar_cartones_huerfanos', {
      _min_age: '5 minutes'
    });
    
    if (error) throw error;
    
    renderTablaHuerfanos(data || []);
    
  } catch (e) {
    console.error(e);
    const resultado = document.getElementById('huerfanosResultado');
    if (resultado) {
      resultado.innerHTML = '<p style="color:#f44336;">Error buscando huérfanos. Revisa consola.</p>';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// Función para renderizar tabla de huérfanos
function renderTablaHuerfanos(rows) {
  const cont = document.getElementById('huerfanosResultado');
  if (!cont) return;
  
  cont.innerHTML = '';

  if (!rows || rows.length === 0) {
    cont.innerHTML = '<p style="color:#4caf50;font-weight:bold;">No hay cartones huérfanos.</p>';
    return;
  }

  const tabla = document.createElement('table');
  tabla.style.width = '100%';
  tabla.style.borderCollapse = 'collapse';
  tabla.innerHTML = `
    <thead>
      <tr>
        <th style="border:1px solid #ccc;padding:6px;">Cartón</th>
        <th style="border:1px solid #ccc;padding:6px;">Reservado desde</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  
  const tbody = tabla.querySelector('tbody');

  rows.forEach(r => {
    const tr = document.createElement('tr');
    
    const tdNumero = document.createElement('td');
    tdNumero.style.border = '1px solid #ccc';
    tdNumero.style.padding = '6px';
    tdNumero.textContent = r.numero;
    
    const tdFecha = document.createElement('td');
    tdFecha.style.border = '1px solid #ccc';
    tdFecha.style.padding = '6px';
    tdFecha.textContent = r.reservado_at ? new Date(r.reservado_at).toLocaleString() : '';
    
    tr.appendChild(tdNumero);
    tr.appendChild(tdFecha);
    tbody.appendChild(tr);
  });

  cont.appendChild(tabla);
}

// Función para liberar huérfanos
async function liberarHuerfanos() {
  if (!confirm('¿Liberar todos los cartones huérfanos?')) return;
  
  const btn = document.getElementById('btnLiberarHuerfanos');
  if (!btn) return;
  
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Limpiando...';
  
  try {
    const { data, error } = await supabase.rpc('rpc_liberar_cartones_huerfanos', {
      _min_age: '5 minutes'
    });
    
    if (error) throw error;

    alert(`Listo. Cartones liberados: ${data ?? 0}`);
    
    await verHuerfanos();
    await cargarCartones();
    await contarCartonesVendidos();
    
  } catch (e) {
    console.error(e);
    alert('Error al liberar huérfanos.');
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// Función para guardar precio por cartón
async function guardarPrecioPorCarton() {
  const nuevoPrecio = parseFloat(document.getElementById('precioCarton').value);
  if (isNaN(nuevoPrecio) || nuevoPrecio < 0) {
    alert('Ingrese un precio válido');
    return;
  }

  const { error } = await supabase
    .from('configuracion')
    .upsert({ clave: 'precio_carton', valore: nuevoPrecio.toString() }, { onConflict: 'clave' });

  if (error) {
    alert('Error guardando el precio');
    console.error(error);
  } else {
    alert('Precio actualizado correctamente');
    precioPorCarton = nuevoPrecio;
    configuracionPublicaCache = null;
    await cargarPrecioPorCarton();
  }
}

// ==================== FUNCIONES EXISTENTES ====================

async function obtenerMontoTotalRecaudado() {
   const { data, error } = await supabase
    .from('inscripciones')
    .select('monto_bs, cartones')
    .eq('estado', 'aprobado'); 

  if (error) {
    console.error('Error al obtener inscripciones:', error.message);
    return;
  }

  let total = 0;
  
  for (const ins of (data || [])) {
    let m = Number(ins.monto_bs);
    if (!(m > 0)) {
      const unidades = Array.isArray(ins.cartones) ? ins.cartones.length : 0;
      m = unidades * (precioPorCarton || 0);
    }
    total += m;
  }

  const totalElement = document.getElementById('totalMonto');
  if (totalElement) {
    totalElement.textContent = new Intl.NumberFormat('es-VE', { 
      style: 'currency', 
      currency: 'VES' 
    }).format(total);
  }
}

async function contarCartonesVendidos() {
  await obtenerTotalCartones();

  const ocupados = await fetchTodosLosOcupados();
  const count = ocupados.filter(numero => numero >= 1 && numero <= totalCartones).length;
  
  const totalVendidosElement = document.getElementById('total-vendidos');
  if (totalVendidosElement) {
    totalVendidosElement.textContent = count || 0;
  }
  
  return count || 0;
}

function renderizarBotonesPromociones() {
  const promoBox = document.getElementById('promoBox');
  if (!promoBox) return;

  let algunaActiva = false;
  
  promociones.forEach((promo, index) => {
    const boton = document.querySelector(`[data-promo="${index + 1}"]`);
    const descElement = document.getElementById(`promo-desc-${index + 1}`);
    const precioElement = document.getElementById(`promo-precio-${index + 1}`);
    
    if (boton && descElement && precioElement) {
      if (promo.activa && promo.cantidad > 0 && promo.precio > 0) {
        descElement.textContent = promo.descripcion;
        precioElement.textContent = `${promo.precio.toFixed(2)} Bs`;
        boton.classList.remove('desactivado');
        algunaActiva = true;
        boton.title = `${promo.cantidad} cartones por ${promo.precio.toFixed(2)} Bs`;
        
        boton.onclick = () => seleccionarPromocion(index + 1);
      } else {
        descElement.textContent = `Promo ${index + 1} (No disponible)`;
        precioElement.textContent = 'No disponible';
        boton.classList.add('desactivado');
        boton.onclick = null;
      }
      
      boton.classList.remove('seleccionado');
    }
  });
  
  promoBox.classList.toggle('oculto', !algunaActiva);
}

// ==================== FUNC PINCILES ====================
window.addEventListener('DOMContentLoaded', async () => {
  console.log('🚀 Inicializando sistema...');
  sistemaListo = false;

  // En admin.html se conserva el panel original y se evita inicializar el DOM público.
  if (ES_PAGINA_ADMIN) {
    sistemaListo = true;

    document.getElementById('guardarPromocionesBtn')?.addEventListener('click', guardarPromociones);
    document.getElementById('btnDupNombreAprobados')?.addEventListener('click', detectarDuplicadosAprobadosPorNombre);
    document.getElementById('btnDupReferenciaAprobados')?.addEventListener('click', detectarDuplicadosAprobadosPorReferencia);
    document.getElementById('btnDuplicados')?.addEventListener('click', detectarCartonesDuplicados);
    document.getElementById('btnVerHuerfanos')?.addEventListener('click', verHuerfanos);
    document.getElementById('btnLiberarHuerfanos')?.addEventListener('click', liberarHuerfanos);
    document.getElementById('guardarPrecioBtn')?.addEventListener('click', guardarPrecioPorCarton);
    document.getElementById('cerrarVentasBtn')?.addEventListener('click', cerrarVentas);
    document.getElementById('abrirVentasBtn')?.addEventListener('click', abrirVentas);
    document.getElementById('imprimirListaBtn')?.addEventListener('click', imprimirLista);
    document.getElementById('verListaBtn')?.addEventListener('click', verListaAprobados);
    document.getElementById('guardarModoCartonesBtn')?.addEventListener('click', guardarModoCartones);
    document.getElementById('modoCartonesSelect')?.addEventListener('change', cambiarModoCartones);

    await cargarConfigBarraProgresoAdmin();
    document.getElementById('overlay-carga')?.style.setProperty('display', 'none');
    await entrarAdmin();
    return;
  }

  // Crear ta¿'bl ses nxiste
   document.getElementById('modal-terminos').classList.remove('oculto');
  await obtenerTotalCartones();
  await cargarLinkWhatsapp();
  await cargarLinkYoutube();
  activarCanalCelebraciones();
  document.getElementById('overlay-carga').style.display = 'none';

  await Promise.all([
    cargarDatosClienteLocal(),
  activarProgresoCartonesRealtime(),
  generarCartones(),
    cargarBarraProgresoInicio(),
    cargarDatosPagoVenta(),
    cargarConfigBarraProgresoAdmin(),
    cargarImagenPremiosInicio(),
    cargarPrecioPorCarton(),
    cargarConfiguracionModoCartones(),
    cargarPromocionesConfig()
  ]);

  configurarEventosReferidos();

  // Event listes pefos
  document.getElementById('guardarPromocionesBtn')?.addEventListener('click', guardarPromociones);
  document.getElementById('btnDupNombreAprobados')?.addEventListener('click', detectarDuplicadosAprobadosPorNombre);
  document.getElementById('btnDupReferenciaAprobados')?.addEventListener('click', detectarDuplicadosAprobadosPorReferencia);
  document.getElementById('btnDuplicados')?.addEventListener('click', detectarCartonesDuplicados);
  document.getElementById('btnVerHuerfanos')?.addEventListener('click', verHuerfanos);
  document.getElementById('btnLiberarHuerfanos')?.addEventListener('click', liberarHuerfanos);
  document.getElementById('guardarPrecioBtn')?.addEventListener('click', guardarPrecioPorCarton);
  document.getElementById('cerrarVentasBtn')?.addEventListener('click', cerrarVentas);
  document.getElementById('abrirVentasBtn')?.addEventListener('click', abrirVentas);
  document.getElementById('imprimirListaBtn')?.addEventListener('click', imprimirLista);
  document.getElementById('verListaBtn')?.addEventListener('click', verListaAprobados);
  document.getElementById('guardarModoCartonesBtn')?.addEventListener('click', guardarModoCartones);
  document.getElementById('modoCartonesSelect')?.addEventListener('change', cambiarModoCartones);
  
  // Cargar likde WhatsApp
    sistemaListo = true;
  // Mostrar términos

  document.getElementById('overlay-carga').style.display = 'none';
  console.log('✅ Sistema inicializado correctamente');
});

async function obtenerTotalCartones() {
  totalCartones = parseInt(await getConfigValue('total_cartones', '0'), 10) || 0;
}

async function cargarPrecioPorCarton() {
  precioPorCarton = parseFloat(await getConfigValue('precio_carton', '0')) || 0;
}

function generarCartones() {
  console.log(`Sistema de bingo inicializado con ${totalCartones} cartones disponibles`);
}

function actualizarPreseleccion() {
  const input = document.getElementById('cantidadCartones');
  const monto = document.getElementById('monto-preseleccion');

  if (!input || !monto) return;

  let cant = parseInt(input.value, 10);
  if (isNaN(cant)) cant = 1;

  // Solo contar cartones válidos dentro del rango configurado
  const ocupadosValidos = cartonesOcupados
    .map(Number)
    .filter(n => n >= 1 && n <= totalCartones).length;

  const maxDisponibles = Math.max(0, totalCartones - ocupadosValidos);

  // Si ya no quedan cartones
  if (maxDisponibles <= 0) {
    input.value = 0;
    monto.textContent = '0.00';
    return;
  }

  if (modoCartones === 'fijo') {
    cant = Math.min(cantidadFijaCartones, maxDisponibles);
  } else {
    cant = Math.max(1, Math.min(cant, maxDisponibles));
  }

  input.value = cant;
  monto.textContent = (cant * precioPorCarton).toFixed(2);
}

document.addEventListener('DOMContentLoaded', () => {

  const btnMas = document.getElementById('btnMas');
  const btnMenos = document.getElementById('btnMenos');
  const inputCantidad = document.getElementById('cantidadCartones');

  if (inputCantidad) {
    inputCantidad.min = '1';
  }

  if (btnMas && inputCantidad) {
    btnMas.onclick = () => {
      if (modoCartones === 'fijo') return;

      let actual = parseInt(inputCantidad.value, 10);
      if (isNaN(actual)) actual = 1;

      const ocupadosValidos = cartonesOcupados
        .map(Number)
        .filter(n => n >= 1 && n <= totalCartones).length;

      const maxDisponibles = Math.max(0, totalCartones - ocupadosValidos);

      inputCantidad.value = Math.min(actual + 1, maxDisponibles);
      limpiarPromoPorCambioCantidad();
    };
  }

  if (btnMenos && inputCantidad) {
    btnMenos.onclick = () => {
      if (modoCartones === 'fijo') return;

      let actual = parseInt(inputCantidad.value, 10);
      if (isNaN(actual)) actual = 1;

      inputCantidad.value = Math.max(1, actual - 1);
      limpiarPromoPorCambioCantidad();
    };
  }

  if (inputCantidad) {
    inputCantidad.addEventListener('input', function () {
      let valor = parseInt(this.value, 10);

      if (isNaN(valor)) valor = 1;

      if (modoCartones === 'fijo') {
        this.value = cantidadFijaCartones;
      } else {
        this.value = Math.max(1, valor);
      }

      limpiarPromoPorCambioCantidad();
    });
  }

  // ⏰ Hora Venezuela
  actualizarHoraVenezuela();
  setInterval(actualizarHoraVenezuela, 1000);

  // 🛡️ Detector de actividad
  iniciarDetectorActividad();

});

function limpiarPromoPorCambioCantidad() {
  if (promocionSeleccionada) {
    deseleccionarPromocion();
  }
  actualizarPreseleccion();
}

function isTrue(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

async function mostrarVentana(id) {
  if (!sistemaListo) return;
  if (id === 'top-compradores') {
  await cargarTopCompradores();
     activarTopCompradoresRealtime()
}
  if (id === 'admin') {
    await entrarAdmin();
    return;
  }
  
  // 1) Si va a CARTONES, valida ventas_abierta
  if (id === 'cartones') {
    const ventasAbierta = await getConfigValue('ventas_abierta', 'true');
    if (!isTrue(ventasAbierta)) {
      alert('Las ventas están cerradas');
      document.querySelectorAll('section').forEach(s => s.classList.add('oculto'));
      document.getElementById('bienvenida').classList.remove('oculto');
      return;
    }
  }

  // 2) Si va a PAGO, valida cantidad exacta
  if (id === 'pago') {
    const requerido = (modoCartones === 'fijo') ? cantidadFijaCartones : cantidadPermitida;
    if (usuario.cartones.length !== requerido) {
      alert(`Debes elegir exactamente ${requerido} cartones antes de continuar.`);
      return;
      
    }
  }

  // 3) Mostrar la ventana solicitada
  document.querySelectorAll('section').forEach(s => s.classList.add('oculto'));
  const target = document.getElementById(id);
  if (target) target.classList.remove('oculto');
requestAnimationFrame(() => {
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
});

  if (id === 'cantidad') {
    promocionSeleccionada = null;
    await cargarPromocionesConfig();
    actualizarPreseleccion();
  }
  
  if (id === 'pago') {
    const promo = getPromocionSeleccionada();
    const monto = promo ? promo.precio : (usuario.cartones.length * (precioPorCarton || 0));
    document.getElementById('monto-pago').textContent = monto.toFixed(2);
    const minutosReserva = Math.min(
      30,
      Math.max(5, parseInt(await getConfigValue('tiempo_reserva_minutos', '10'), 10) || 10)
    );
    iniciarContadorReserva(minutosReserva);
  }
  
  if (id === 'cartones') {
    await cargarCartones();
  }

  if (id === 'lista-aprobados') {
    await cargarListaAprobadosSeccion();
  }
}

// Guardar datos del formulario
function guardarDatosInscripcion() {
  usuario.nombre = document.getElementById('nombre').value.trim();
  usuario.telefono = document.getElementById('telefono').value.trim();
  usuario.cedula = document.getElementById('cedula').value.trim();
  usuario.referido = normalizarCedulaReferidos(
    document.getElementById('referido')?.value || ''
  );
  usuario.cartones = [];

  if (!usuario.nombre || !usuario.telefono || !usuario.cedula) {
    alert('Completa tu nombre, teléfono y cédula.');
    return;
  }

  if (
    usuario.referido &&
    normalizarCedulaReferidos(usuario.cedula) === usuario.referido
  ) {
    alert('No puedes usar tu propia cédula como referido.');
    return;
  }

  mostrarVentana('cantidad');
  actualizarPreseleccion();
  guardarDatosClienteLocal();
}

function confirmarCantidad() {
  const promo = getPromocionSeleccionada();
  let cant;
  
  if (promo) {
    cant = promo.cantidad;
  } else {
    cant = parseInt(document.getElementById('cantidadCartones').value);
    const ocupadosValidos = cartonesOcupados
  .map(Number)
  .filter(n => n >= 1 && n <= totalCartones).length;

const maxDisponibles = Math.max(0, totalCartones - ocupadosValidos);

if (maxDisponibles <= 0) {
  return alert('No quedan cartones disponibles.');
}
    
    if (modoCartones === 'fijo') {
      if (cant !== cantidadFijaCartones) {
        document.getElementById('cantidadCartones').value = cantidadFijaCartones;
        cant = cantidadFijaCartones;
      }
    } else {
      if (isNaN(cant) || cant < 1) {
        return alert('Ingresa un número válido');
      }
      if (cant > maxDisponibles) {
        return alert(`Solo quedan ${maxDisponibles} cartones disponibles`);
      }
    }
  }
  
  cantidadPermitida = cant;
  usuario.cartones = [];
  mostrarVentana('cartones');
}

// ==================== FUNCIONES DE CARTONES ====================
async function cargarCartones() {
  if (ES_PAGINA_ADMIN) {
    const { error: errorHuerfanos } = await supabase.rpc('rpc_liberar_cartones_huerfanos', {
      _min_age: '5 minutes'
    });

    if (errorHuerfanos) {
      console.error('Error liberando huérfanos:', errorHuerfanos);
    }
  }

  cartonesOcupados = await fetchTodosLosOcupados();
  const ocupadosSet = new Set(cartonesOcupados);

  const contenedor = document.getElementById('contenedor-cartones');
  if (contenedor) {
    contenedor.innerHTML = '';

    for (let i = 1; i <= totalCartones; i++) {
      const carton = document.createElement('div');
      carton.textContent = i;
      carton.classList.add('carton');

      if (ocupadosSet.has(i)) {
        carton.classList.add('ocupado');
      } else {
        carton.onclick = () => abrirModalCarton(i, carton);
      }

      contenedor.appendChild(carton);
    }
  }

  await contarCartonesVendidos();

  actualizarContadorCartones(
    totalCartones,
    Number(document.getElementById('total-vendidos')?.textContent) || cartonesOcupados.length,
    usuario.cartones.length
  );

  actualizarMonto();
}

async function toggleCarton(num, elem) {
  num = Number(num);
  const cedulaLimpia = String(usuario.cedula || '').trim();
  const reservaToken = obtenerTokenReserva(cedulaLimpia);

  const index = usuario.cartones.map(Number).indexOf(num);

  // Deseleccionar
  if (index >= 0) {
    usuario.cartones.splice(index, 1);
    elem.classList.remove('seleccionado');

  

const { data: liberado, error: errorLiberar } = await supabase.rpc('rpc_liberar_reserva', {
  _numero: num,
  _cedula: cedulaLimpia,
  _reserva_token: reservaToken
});
    
    console.log('Liberar cartón:', {
      numero: num,
      cedula: cedulaLimpia,
      liberado,
      errorLiberar
    });

    if (errorLiberar) {
      console.error('Error liberando reserva:', errorLiberar);
      alert('No se pudo liberar el cartón. Intenta otra vez.');
      return;
    }

    if (liberado !== true) {
      console.warn('El cartón no se liberó. Puede que no coincidía la cédula o ya estaba en inscripción.');
    }

    cartonesOcupados = cartonesOcupados.filter(n => Number(n) !== num);

    document.querySelectorAll('.carton.bloqueado').forEach(c => {
      const n = Number(c.textContent);
      if (!cartonesOcupados.map(Number).includes(n) && !usuario.cartones.map(Number).includes(n)) {
        c.classList.remove('bloqueado');
        c.onclick = () => abrirModalCarton(n, c);
      }
    });

    actualizarContadorCartones(totalCartones, cartonesOcupados.length, usuario.cartones.length);
    actualizarMonto();
    return;
  }

  // No permitir más de la cantidad elegida
  if (usuario.cartones.length >= cantidadPermitida) return;

  const { data, error } = await supabase.rpc('rpc_reservar_carton', {
    _numero: num,
    _cedula: cedulaLimpia,
    _reserva_token: reservaToken
  });

  if (error || data?.exito !== true) {
    alert(data?.mensaje || 'Ese cartón ya fue tomado por otra persona. Elige otro.');
    await cargarCartones();
    return;
  }

  usuario.cartones.push(num);
  elem.classList.add('seleccionado');

  if (usuario.cartones.length === cantidadPermitida) {
    document.querySelectorAll('.carton').forEach(c => {
      const n = Number(c.textContent);
      const yaSeleccionado = usuario.cartones.map(Number).includes(n);
      const yaOcupado = cartonesOcupados.map(Number).includes(n);

      if (!yaSeleccionado && !yaOcupado) {
        c.classList.add('bloqueado');
        c.onclick = null;
      }
    });
  }

  actualizarContadorCartones(totalCartones, cartonesOcupados.length, usuario.cartones.length);
  actualizarMonto();
}
function actualizarMonto() {
  let total;
  const promo = getPromocionSeleccionada();
  
  if (promo && usuario.cartones.length === promo.cantidad) {
    total = promo.precio;
  } else {
    total = (usuario.cartones.length || 0) * (precioPorCarton || 0);
  }
  
  const nodo = document.getElementById('monto-total');
  if (nodo) nodo.textContent = total.toFixed(2);
}

// ==================== FUNCIONES DE PAGO ====================
function limpiarNombreArchivo(nombre) {
  return String(nombre || 'archivo')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
}

async function crearFuenteImagen(archivo) {
  if (!archivo) {
    throw new Error('No se recibió ninguna imagen');
  }

  // createImageBitmap suele ser más estable y consume menos memoria.
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(archivo, {
        imageOrientation: 'from-image'
      });

      if (bitmap.width > 0 && bitmap.height > 0) {
        return {
          imagen: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          liberar() {
            if (typeof bitmap.close === 'function') bitmap.close();
          }
        };
      }

      if (typeof bitmap.close === 'function') bitmap.close();
    } catch (errorBitmap) {
      console.warn('createImageBitmap no pudo leer la imagen; se usará Image():', errorBitmap);
    }
  }

  const objectUrl = URL.createObjectURL(archivo);
  const img = new Image();
  img.decoding = 'async';

  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('No se pudo leer la imagen seleccionada'));
      img.src = objectUrl;
    });

    if (typeof img.decode === 'function') {
      try {
        await img.decode();
      } catch {
        // onload ya confirmó que el navegador pudo leer la imagen.
      }
    }

    if (!img.naturalWidth || !img.naturalHeight) {
      throw new Error('La imagen no tiene dimensiones válidas');
    }

    return {
      imagen: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      liberar() {
        URL.revokeObjectURL(objectUrl);
      }
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function verificarImagenGenerada(archivo) {
  let fuente = null;

  try {
    fuente = await crearFuenteImagen(archivo);

    // La revisión se hace en un canvas pequeño para evitar problemas de memoria.
    const maxAnchoPrueba = 240;
    const maxAltoPrueba = 480;
    const escala = Math.min(
      1,
      maxAnchoPrueba / fuente.width,
      maxAltoPrueba / fuente.height
    );

    const width = Math.max(1, Math.round(fuente.width * escala));
    const height = Math.max(1, Math.round(fuente.height * escala));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true
    });

    if (!ctx) {
      throw new Error('No se pudo crear el verificador de imagen');
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(fuente.imagen, 0, 0, width, height);

    const pixeles = ctx.getImageData(0, 0, width, height).data;

    let sumaBrillo = 0;
    let sumaBrilloCuadrado = 0;
    let pixelesNoBlancos = 0;
    let pixelesMuyOscuros = 0;
    let total = 0;

    for (let i = 0; i < pixeles.length; i += 4) {
      const r = pixeles[i];
      const g = pixeles[i + 1];
      const b = pixeles[i + 2];

      // Brillo perceptual aproximado.
      const brillo = (r * 0.2126) + (g * 0.7152) + (b * 0.0722);

      sumaBrillo += brillo;
      sumaBrilloCuadrado += brillo * brillo;
      total++;

      if (r < 245 || g < 245 || b < 245) {
        pixelesNoBlancos++;
      }

      if (r < 12 && g < 12 && b < 12) {
        pixelesMuyOscuros++;
      }
    }

    if (!total) {
      return {
        valida: false,
        pareceBlanca: true,
        motivo: 'La imagen no contiene píxeles visibles'
      };
    }

    const brilloPromedio = sumaBrillo / total;
    const varianza = Math.max(
      0,
      (sumaBrilloCuadrado / total) - (brilloPromedio * brilloPromedio)
    );
    const desviacion = Math.sqrt(varianza);
    const porcentajeNoBlanco = pixelesNoBlancos / total;
    const porcentajeMuyOscuro = pixelesMuyOscuros / total;

    // No se marca como blanca solo por tener fondo blanco.
    // También debe tener casi cero variación y casi ningún píxel con contenido.
    const pareceBlanca =
      brilloPromedio > 251.5 &&
      desviacion < 4 &&
      porcentajeNoBlanco < 0.005;

    const pareceNegra =
      brilloPromedio < 3 &&
      desviacion < 3 &&
      porcentajeMuyOscuro > 0.995;

    return {
      valida: !pareceBlanca && !pareceNegra,
      pareceBlanca,
      pareceNegra,
      motivo: pareceBlanca
        ? 'La imagen quedó prácticamente blanca'
        : pareceNegra
          ? 'La imagen quedó prácticamente negra'
          : '',
      brilloPromedio: Number(brilloPromedio.toFixed(2)),
      desviacion: Number(desviacion.toFixed(2)),
      porcentajeNoBlanco: Number((porcentajeNoBlanco * 100).toFixed(3)),
      pesoKB: Number((archivo.size / 1024).toFixed(2)),
      dimensiones: `${fuente.width}x${fuente.height}`
    };
  } finally {
    if (fuente) fuente.liberar();
  }
}

async function convertirImagenAWebP(
  file,
  calidad = 0.85,
  maxWidth = 1600,
  maxHeight = 5000,
  maxPixels = 8000000
) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    throw new Error('El archivo debe ser una imagen');
  }

  let fuente = null;
  let canvas = null;

  try {
    fuente = await crearFuenteImagen(file);

    const anchoOriginal = fuente.width;
    const altoOriginal = fuente.height;

    let escala = Math.min(
      1,
      maxWidth / anchoOriginal,
      maxHeight / altoOriginal
    );

    const pixelesEscalados = anchoOriginal * altoOriginal * escala * escala;

    if (pixelesEscalados > maxPixels) {
      escala *= Math.sqrt(maxPixels / pixelesEscalados);
    }

    const width = Math.max(1, Math.round(anchoOriginal * escala));
    const height = Math.max(1, Math.round(altoOriginal * escala));

    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d', {
      alpha: false
    });

    if (!ctx) {
      throw new Error('El navegador no pudo preparar la conversión');
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(fuente.imagen, 0, 0, width, height);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        resultado => {
          if (!resultado) {
            reject(new Error('No se pudo generar el archivo WebP'));
            return;
          }
          resolve(resultado);
        },
        'image/webp',
        calidad
      );
    });

    if (blob.type && blob.type !== 'image/webp') {
      throw new Error('El navegador no pudo generar un WebP válido');
    }

    const nombreWebP =
      limpiarNombreArchivo(file.name).replace(/\.[^.]+$/, '') + '.webp';

    const archivoWebP = new File([blob], nombreWebP, {
      type: 'image/webp',
      lastModified: Date.now()
    });

    // Se vuelve a abrir el WebP antes de devolverlo.
    const verificacion = await verificarImagenGenerada(archivoWebP);

    console.log('🔍 Verificación WebP:', {
      archivo: file.name,
      original: `${anchoOriginal}x${altoOriginal}`,
      convertido: `${width}x${height}`,
      calidad,
      maxWidth,
      ...verificacion
    });

    if (!verificacion.valida) {
      throw new Error(
        verificacion.motivo || 'La conversión generó una imagen inválida'
      );
    }

    return archivoWebP;
  } finally {
    if (fuente) fuente.liberar();

    // Libera la memoria del canvas en teléfonos con poca RAM.
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

function obtenerExtensionImagenOriginal(archivo) {
  const tipos = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  };

  if (tipos[archivo.type]) return tipos[archivo.type];

  const extension = String(archivo.name || '')
    .split('.')
    .pop()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  return extension || 'jpg';
}

async function prepararComprobanteSeguro(archivoOriginal, actualizarEstado) {
  const intentos = [
    { calidad: 0.85, maxWidth: 1600, maxHeight: 5000, maxPixels: 8000000 },
    { calidad: 0.82, maxWidth: 1200, maxHeight: 4000, maxPixels: 6000000 },
    { calidad: 0.80, maxWidth: 1000, maxHeight: 3200, maxPixels: 4000000 }
  ];

  for (let i = 0; i < intentos.length; i++) {
    const intento = intentos[i];

    if (typeof actualizarEstado === 'function') {
      actualizarEstado(`Verificando comprobante (${i + 1}/${intentos.length})...`);
    }

    try {
      const archivoWebP = await convertirImagenAWebP(
        archivoOriginal,
        intento.calidad,
        intento.maxWidth,
        intento.maxHeight,
        intento.maxPixels
      );

      return {
        archivo: archivoWebP,
        extension: 'webp',
        contentType: 'image/webp',
        convertidoAWebP: true,
        intento: i + 1
      };
    } catch (error) {
      console.warn(`⚠️ Conversión WebP intento ${i + 1} falló:`, error);

      // Da tiempo al navegador para liberar memoria antes del próximo intento.
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  if (typeof actualizarEstado === 'function') {
    actualizarEstado('Verificando imagen original...');
  }

  const verificacionOriginal = await verificarImagenGenerada(archivoOriginal);

  console.log('🔍 Verificación del comprobante original:', verificacionOriginal);

  if (!verificacionOriginal.valida) {
    throw new Error(
      'El comprobante no contiene información visible. Selecciona otra imagen.'
    );
  }

  alert(
    '⚠️ La conversión a WebP no pudo completarse correctamente. ' +
    'Para evitar un comprobante blanco, se enviará la imagen original.'
  );

  return {
    archivo: archivoOriginal,
    extension: obtenerExtensionImagenOriginal(archivoOriginal),
    contentType: archivoOriginal.type || 'image/jpeg',
    convertidoAWebP: false,
    intento: 0
  };
}

function nombreCartonWebP(numero) {
  return `SERIAL_BINGOGANGA_CARTON_${String(numero).padStart(5, '0')}.webp`;
}

function urlCartonWebP(numero) {
  return `${supabaseUrl}/storage/v1/object/public/cartones/${nombreCartonWebP(numero)}`;
}
async function enviarComprobante() {
  const boton = document.getElementById('btnEnviarComprobante');
  const textoOriginal = boton.textContent;
  let rutaComprobanteSubida = '';
  let cedulaReservaActual = '';
  let tokenReservaActual = '';
  boton.disabled = true;
  boton.textContent = 'Cargando comprobante...';

  try {
    if (!usuario.nombre || !usuario.telefono || !usuario.cedula) {
      throw new Error('Debes completar primero los datos de inscripción');
    }

    const referencia4dig = document.getElementById('referencia4dig').value.trim();
    if (!/^\d{4}$/.test(referencia4dig)) {
      throw new Error('Debes ingresar los últimos 4 dígitos de la referencia bancaria.');
    }
const PagoBanco = document.getElementById('pago_banco').value.trim();
const PagoTelefono = document.getElementById('pago_telefono').value.trim();
const PagoCedula = document.getElementById('pago_cedula').value.trim();

if (!PagoBanco || !PagoTelefono || !PagoCedula) {
  throw new Error('Debes registrar tu Pago Móvil para el pago ganador.');
}

guardarDatosPagoClienteAutomatico();
   const archivoOriginal = document.getElementById('comprobante').files[0];
if (!archivoOriginal) throw new Error('Debes subir un comprobante');

// Convierte, verifica y reintenta antes de subir a Supabase.
const resultadoComprobante = await prepararComprobanteSeguro(
  archivoOriginal,
  mensaje => {
    boton.textContent = mensaje;
  }
);

const archivoFinal = resultadoComprobante.archivo;
const extensionFinal = resultadoComprobante.extension;
const tipoFinal = resultadoComprobante.contentType;

const idArchivo = crypto.randomUUID
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const carpetaFecha = new Date().toISOString().slice(0, 10);
const nombreArchivo = `${carpetaFecha}/${idArchivo}.${extensionFinal}`;
rutaComprobanteSubida = nombreArchivo;

boton.textContent = 'Subiendo comprobante...';

const { error: errorUpload } = await supabase.storage
  .from('comprobantes')
  .upload(nombreArchivo, archivoFinal, {
    contentType: tipoFinal,
    upsert: false,
    cacheControl: '31536000'
  });

if (errorUpload) {
  throw new Error('Error subiendo comprobante: ' + errorUpload.message);
}

    const promo = getPromocionSeleccionada();
    const monto = promo ? promo.precio : (usuario.cartones.length * (precioPorCarton || 0));
    const cartonesEnviar = (usuario.cartones || []).map(n => Number(n));

if (cartonesEnviar.length === 0) {
  throw new Error('Debes seleccionar al menos un cartón.');
}

if (cartonesEnviar.length !== cantidadPermitida) {
  throw new Error('La cantidad de cartones seleccionados no coincide con la cantidad elegida.');
}

const cedulaLimpia = String(usuario.cedula || '').trim();
cedulaReservaActual = cedulaLimpia;
tokenReservaActual = obtenerTokenReserva(cedulaLimpia);

const { error: errorInsert } = await supabase.rpc('rpc_crear_inscripcion', {
  _nombre: usuario.nombre,
  _telefono: usuario.telefono,
  _cedula: cedulaLimpia,
  _referido: usuario.referido || '',
  _cartones: cartonesEnviar,
  _referencia4dig: referencia4dig,
  _comprobante: nombreArchivo,
  _monto_bs: monto,
  _pago_banco: PagoBanco,
  _pago_telefono: PagoTelefono,
  _pago_cedula: PagoCedula,
  _promo_id: promocionSeleccionada,
  _acepta_terminos: true,
  _reserva_token: tokenReservaActual
});

if (errorInsert) {
  throw new Error(errorInsert.message || 'Error guardando la inscripción');
}
clearInterval(timerReserva);
    borrarTokenReserva(cedulaLimpia);
    alert('Inscripción y comprobante enviados con éxito');
    location.reload();
  } catch (err) {
    console.error(err);

    if (rutaComprobanteSubida) {
      await supabase.storage.from('comprobantes').remove([rutaComprobanteSubida]);
    }

    if (cedulaReservaActual) {
      await supabase.rpc('rpc_liberar_todas_reservas', {
        _cedula: cedulaReservaActual,
        _reserva_token: tokenReservaActual
      });
    }

    alert(err.message || 'Ocurrió un error inesperado');
  } finally {
    boton.disabled = false;
    boton.textContent = textoOriginal;
  }
}


// ==================== PROGRAMA DE REFERIDOS ====================
let META_REFERIDOS_CARTON_GRATIS = 10;
let cedulaReferidosActiva = '';

function normalizarCedulaReferidos(valor) {
  return String(valor || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[.\-]/g, '')
    .replace(/[^0-9VEJPG]/g, '');
}

function construirEnlaceReferido(cedula) {
  const cedulaLimpia = normalizarCedulaReferidos(cedula);
  if (!cedulaLimpia) return '';

  const url = new URL(window.location.href);
  url.hash = '';
  url.search = '';
  url.searchParams.set('ref', cedulaLimpia);

  return url.toString();
}

function aplicarReferidorAlFormulario(cedulaReferidor) {
  const referidoLimpio = normalizarCedulaReferidos(cedulaReferidor);
  if (!referidoLimpio) return;

  const inputReferido = document.getElementById('referido');
  const aviso = document.getElementById('aviso-referido-registro');
  const vista = document.getElementById('cedula-referidor-vista');
  const ayuda = document.getElementById('ayuda-referido');

  sessionStorage.setItem('bingo_ganga_referidor', referidoLimpio);
  localStorage.setItem('cliente_referido', referidoLimpio);

  if (inputReferido) {
    inputReferido.value = referidoLimpio;
    inputReferido.readOnly = true;
    inputReferido.classList.add('referido-desde-enlace');
  }

  if (vista) vista.textContent = referidoLimpio;
  if (aviso) aviso.classList.remove('oculto');

  if (ayuda) {
    ayuda.textContent = 'La cédula de la persona que te invitó quedó registrada automáticamente.';
  }
}

function cargarReferidoDesdeEnlace() {
  const params = new URLSearchParams(window.location.search);
  const referidoUrl = normalizarCedulaReferidos(params.get('ref'));
  const referidoGuardado = normalizarCedulaReferidos(
    sessionStorage.getItem('bingo_ganga_referidor')
  );

  const referido = referidoUrl || referidoGuardado;

  if (referido) {
    aplicarReferidorAlFormulario(referido);
  }
}

function ocultarProgramaReferidos() {
  document.getElementById('programa-referidos')?.classList.add('oculto');
  cedulaReferidosActiva = '';
}

async function actualizarProgramaReferidos(cedula) {
  const cedulaLimpia = normalizarCedulaReferidos(cedula);
  const tarjeta = document.getElementById('programa-referidos');
  const contador = document.getElementById('contador-referidos');
  const meta = document.getElementById('meta-referidos');
  const relleno = document.getElementById('relleno-referidos');
  const mensaje = document.getElementById('mensaje-referidos');
  const enlaceInput = document.getElementById('enlace-referido');
  const barra = tarjeta?.querySelector('.barra-referidos');

  if (!cedulaLimpia || !tarjeta) return;

  cedulaReferidosActiva = cedulaLimpia;
  tarjeta.classList.remove('oculto');

  if (contador) contador.textContent = '…';
  if (meta) meta.textContent = String(META_REFERIDOS_CARTON_GRATIS);
  if (mensaje) mensaje.textContent = 'Calculando tus invitaciones aprobadas…';
  if (enlaceInput) enlaceInput.value = construirEnlaceReferido(cedulaLimpia);

  try {
    const { data, error } = await supabase.rpc('rpc_resumen_referidos', {
      _cedula: cedulaLimpia
    });

    if (error) throw error;

    const totalAprobados = Number(data?.aprobados) || 0;
    META_REFERIDOS_CARTON_GRATIS = Math.max(1, Number(data?.meta) || 10);
    if (meta) meta.textContent = String(META_REFERIDOS_CARTON_GRATIS);
    const progresoVisible = Math.min(
      totalAprobados,
      META_REFERIDOS_CARTON_GRATIS
    );
    const porcentaje = Math.min(
      100,
      (progresoVisible / META_REFERIDOS_CARTON_GRATIS) * 100
    );

    if (contador) contador.textContent = String(progresoVisible);
    if (relleno) relleno.style.width = `${porcentaje}%`;

    if (barra) {
      barra.setAttribute('aria-valuenow', String(progresoVisible));
    }

    if (mensaje) {
      if (totalAprobados >= META_REFERIDOS_CARTON_GRATIS) {
        mensaje.innerHTML =
          '🎉 <strong>¡Meta completada!</strong> Ya conseguiste tu cartón gratis. Comunícate con el administrador para recibirlo.';
        tarjeta.classList.add('meta-completada');
      } else {
        const faltan = META_REFERIDOS_CARTON_GRATIS - totalAprobados;
        mensaje.innerHTML =
          faltan === 1
            ? '🔥 Te falta <strong>1 amigo aprobado</strong> para conseguir tu cartón gratis.'
            : `Te faltan <strong>${faltan} amigos aprobados</strong> para conseguir tu cartón gratis.`;
        tarjeta.classList.remove('meta-completada');
      }
    }
  } catch (error) {
    console.error('Error cargando progreso de referidos:', error);

    if (contador) contador.textContent = '0';
    if (relleno) relleno.style.width = '0%';
    if (mensaje) {
      mensaje.textContent =
        'No se pudo cargar el progreso de invitaciones. Intenta nuevamente.';
    }
  }
}

async function copiarEnlaceReferido() {
  const enlace =
    document.getElementById('enlace-referido')?.value ||
    construirEnlaceReferido(cedulaReferidosActiva);

  if (!enlace) {
    alert('Primero consulta tus cartones con tu cédula.');
    return;
  }

  try {
    await navigator.clipboard.writeText(enlace);
    alert('✅ Enlace de invitación copiado.');
  } catch (error) {
    const input = document.getElementById('enlace-referido');
    if (input) {
      input.focus();
      input.select();
      document.execCommand('copy');
      alert('✅ Enlace de invitación copiado.');
    }
  }
}

function obtenerMensajeCompartirReferido() {
  return '🎁 ¡Juega conmigo en Bingo Ganga! Regístrate con mi enlace de invitación:';
}

async function compartirEnlaceReferido() {
  const enlace =
    document.getElementById('enlace-referido')?.value ||
    construirEnlaceReferido(cedulaReferidosActiva);

  if (!enlace) {
    alert('Primero consulta tus cartones con tu cédula.');
    return;
  }

  const datos = {
    title: 'Bingo Ganga',
    text: obtenerMensajeCompartirReferido(),
    url: enlace
  };

  try {
    if (navigator.share) {
      await navigator.share(datos);
    } else {
      await navigator.clipboard.writeText(
        `${datos.text}\n${datos.url}`
      );
      alert('✅ Invitación copiada. Ya puedes enviarla a tus amigos.');
    }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error('Error compartiendo invitación:', error);
      await copiarEnlaceReferido();
    }
  }
}

function compartirReferidoWhatsApp() {
  const enlace =
    document.getElementById('enlace-referido')?.value ||
    construirEnlaceReferido(cedulaReferidosActiva);

  if (!enlace) {
    alert('Primero consulta tus cartones con tu cédula.');
    return;
  }

  const texto = `${obtenerMensajeCompartirReferido()}\n${enlace}`;
  const urlWhatsapp = `https://wa.me/?text=${encodeURIComponent(texto)}`;

  window.open(urlWhatsapp, '_blank', 'noopener,noreferrer');
}

function configurarEventosReferidos() {
  const consultaCedula = document.getElementById('consulta-cedula');

  consultaCedula?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      consultarCartones();
    }
  });

  cargarReferidoDesdeEnlace();
}

window.copiarEnlaceReferido = copiarEnlaceReferido;
window.compartirEnlaceReferido = compartirEnlaceReferido;
window.compartirReferidoWhatsApp = compartirReferidoWhatsApp;


// ==================== fUNCIONES DE USUARIO ====================
async function consultarCartones() {
  const cedulaIngresada = document.getElementById('consulta-cedula').value.trim();
  const cedula = normalizarCedulaReferidos(cedulaIngresada);

  const cont = document.getElementById('cartones-usuario');
  cont.innerHTML = '';
  ocultarProgramaReferidos();

  if (!cedula) {
    cont.innerHTML = `
      <p class="mensaje-consulta-error">
        Ingresa una cédula válida.
      </p>
    `;
    return;
  }

  const { data: todas, error } = await supabase.rpc('rpc_consultar_jugadas', {
    _cedula: cedula
  });

  if (error) {
    console.error('Error consultando cartones:', error);
    cont.innerHTML = `
      <p class="mensaje-consulta-error">
        No se pudo realizar la consulta. Intenta nuevamente.
      </p>
    `;
    return;
  }

  if (!todas || todas.length === 0) {
    cont.innerHTML = `
      <p class="mensaje-consulta-error">
        No se encontró ninguna compra registrada con esta cédula.
      </p>
    `;
    return;
  }

  await actualizarProgramaReferidos(cedula);

  const tieneAprobada = todas.some(i => i.estado === 'aprobado');
  const tienePendiente = todas.some(i => i.estado === 'pendiente');
  const tieneRechazada = todas.some(i => i.estado === 'rechazado');
  
  const mensaje = document.createElement('div');
  mensaje.style.textAlign = 'center';
  mensaje.style.marginBottom = '15px';
  mensaje.style.fontWeight = 'bold';

  if (tieneAprobada && tienePendiente && tieneRechazada) {
  mensaje.innerHTML =
    '✅ Tienes compras aprobadas.<br>⏳ También tienes compras pendientes de aprobación.<br>❌ También tienes compras rechazadas(consulta con soporte).';
}
 else if (tieneAprobada && tieneRechazada) {
  mensaje.innerHTML =
    '✅ Tienes compras aprobadas.<br>❌ También tienes compras rechazadas, consulta a soporte.';
}
else if (tieneAprobada && tienePendiente) {
  mensaje.innerHTML =
    '✅ Tienes compras aprobadas.<br>⏳ También tienes compras pendientes de aprobación.';
}
else if (tieneRechazada && tienePendiente) {
  mensaje.innerHTML =
    '❌ Tienes compras rechazadas.<br>⏳ También tienes compras pendientes de aprobación.';
}
else if (tieneAprobada) {
  mensaje.innerHTML =
    '✅ Tu compra ha sido aprobada.';
}
else if (tieneRechazada) {
  mensaje.innerHTML =
    '❌ Tu compra fue rechazada.';
}
else {
  mensaje.innerHTML =
    '⏳ Tu compra está pendiente de aprobación.';
}

  cont.appendChild(mensaje);
  mensaje.classList.add('estado-consulta');

  // Mostrar cartones aunque esté pendiente
  todas.forEach(item => {
    (item.cartones || []).forEach(num => {
      const img = document.createElement('img');
    img.src = urlCartonWebP(num);
img.loading = 'lazy';
img.alt = `Cartón ${num}`;
      img.classList.add('carton-consulta-img');
      img.style.margin = '5px';
      cont.appendChild(img);
    });
  });
}

async function elegirMasCartones() {
  const cedula = normalizarCedulaReferidos(
    document.getElementById('consulta-cedula').value
  );

  if (!cedula) return alert('Ingresa una cédula válida');

  usuario.cedula = cedula;
  usuario.cartones = [];

  const inputCedula = document.getElementById('cedula');
  if (inputCedula) inputCedula.value = cedula;

  if (usuario.nombre && usuario.telefono) {
    mostrarVentana('cantidad');
    actualizarPreseleccion();
  } else {
    alert('Confirma tu nombre y teléfono para continuar con la nueva compra.');
    mostrarVentana('inscripcion');
  }
}

// ==================== FUNCIOS DEL PANEL ADMIN ====================
function obtenerRutaComprobante(valor) {
  if (!valor) return '';

  if (!/^https?:\/\//i.test(valor)) return valor;

  try {
    const url = new URL(valor);
    const marcas = [
      '/storage/v1/object/public/comprobantes/',
      '/storage/v1/object/sign/comprobantes/',
      '/storage/v1/object/comprobantes/'
    ];

    for (const marca of marcas) {
      const posicion = url.pathname.indexOf(marca);
      if (posicion >= 0) {
        return decodeURIComponent(url.pathname.slice(posicion + marca.length));
      }
    }
  } catch (error) {
    console.warn('No se pudo interpretar la ruta del comprobante:', error);
  }

  return '';
}

async function cargarPanelAdmin() {
await Promise.all([
  obtenerTotalCartones(),
  obtenerMontoTotalRecaudado(),
  contarCartonesVendidos(),
  cargarModoCartonesAdmin(),
  cargarPromocionesAdmin(),
  cargarEnlacesAdmin()
]);

cartonesOcupados = await fetchTodosLosOcupados();
  
 
  const { data, error } = await supabase
    .from('inscripciones')
    .select(`
      id,
      nombre,
      telefono,
      cedula,
      referido,
      cartones,
      referencia4dig,
      comprobante,
      pago_banco,
      pago_telefono,
      pago_cedula,
      estado
    `)
    .order('id', { ascending: false });

  if (error) {
    console.error(error);
    return alert('Error cargando inscripciones');
  }

  const rutasComprobantes = [...new Set(
    (data || [])
      .map(item => obtenerRutaComprobante(item.comprobante))
      .filter(Boolean)
  )];
  const urlsComprobantes = new Map();

  if (rutasComprobantes.length) {
    const { data: firmadas, error: errorFirmas } = await supabase.storage
      .from('comprobantes')
      .createSignedUrls(rutasComprobantes, 15 * 60);

    if (errorFirmas) {
      console.error('No se pudieron firmar los comprobantes:', errorFirmas);
    } else {
      (firmadas || []).forEach(item => {
        if (item.path && item.signedUrl) {
          urlsComprobantes.set(item.path, item.signedUrl);
        }
      });
    }
  }

  const tbody = document.querySelector('#tabla-comprobantes tbody');
  tbody.innerHTML = '';

  data.forEach(item => {
    const tr = document.createElement('tr');
    const rutaComprobante = obtenerRutaComprobante(item.comprobante);
    const urlComprobante = urlsComprobantes.get(rutaComprobante) || '';
    const enlaceWhatsapp = buildWhatsAppLink(
      item.telefono,
      `Hola ${item.nombre}, te escribo de parte del equipo de bingoandino75.`
    );
    tr.dataset.estadoActual = item.estado || 'pendiente';
    tr.innerHTML = `
      <td>${escapeHTML(item.nombre)}</td>
      <td>
        <a href="${escapeHTML(enlaceWhatsapp)}"
           target="_blank" rel="noopener">
          ${escapeHTML(item.telefono)}
        </a>
      </td>
      <td>${escapeHTML(item.cedula)}</td>
      <td>${escapeHTML(item.referido)}</td>
      <td>${escapeHTML(Array.isArray(item.cartones) ? item.cartones.join(', ') : '')}</td>
      <td class="celda-ref" data-id="${item.id}">
        <span class="ref-text">${escapeHTML(item.referencia4dig)}</span>
        <button class="btn-accion btn-edit-ref" title="Editar">&#9998;</button>
      </td>
      <td><a href="${escapeHTML(urlComprobante || '#')}" target="_blank" rel="noopener">
            <img src="${escapeHTML(urlComprobante)}" alt="Comp." loading="lazy">
          </a></td>
          <td class="pago-ganador-admin">
  <strong>${escapeHTML(item.pago_banco || 'Sin banco')}</strong><br>
  📱 ${escapeHTML(item.pago_telefono || 'Sin número')}<br>
  🪪 ${escapeHTML(item.pago_cedula || 'Sin cédula')}
   <button class="btn-copiar-pago">
    📋 Copiar
  </button>
</td>
      <td>
        <span class="estado-circulo ${
  item.estado === 'aprobado'
    ? 'verde'
    : item.estado === 'rechazado'
      ? 'naranja'
      : 'rojo'
}"></span>
        <button class="btn-accion btn-aprobar" title="Aprobar">&#x2705;</button>
        <button class="btn-accion btn-rechazar" title="Rechazar">&#x274C;</button>
        <button class="btn-accion btn-eliminar" title="Eliminar">&#x1F5D1;</button>
      </td>
    `;

    const btnAprobar = tr.querySelector('.btn-aprobar');
    const btnRechazar = tr.querySelector('.btn-rechazar');
    const btnEliminar = tr.querySelector('.btn-eliminar');
    const btnEditRef = tr.querySelector('.btn-edit-ref');
    const btnCopiarPago = tr.querySelector('.btn-copiar-pago');

   btnAprobar.onclick = () => procesarEstadoUnaVez(
  item.id,
  tr,
  'aprobado',
  () => aprobarInscripcion(item.id, tr)
);

btnRechazar.onclick = () => procesarEstadoUnaVez(
  item.id,
  tr,
  'rechazado',
  () => rechazarInscripcion(item, tr)
);
    btnEliminar.onclick = () => eliminarInscripcion(item, tr);
    btnEditRef.onclick = () => editarReferencia(tr.querySelector('.celda-ref'));
    btnCopiarPago.onclick = () => copiarPagoMovil(
      item.pago_banco || '',
      item.pago_telefono || '',
      item.pago_cedula || ''
    );
    
  

    tbody.appendChild(tr);
  });

  document.getElementById('contador-clientes').textContent = data.length;
  const contadorCartones = document.getElementById('contadorCartones');
  if (contadorCartones) {
    contadorCartones.innerText =
      `Cartones disponibles: ${totalCartones - cartonesOcupados.length} de ${totalCartones}`;
  }
  const pendientes = data.filter(item => item.estado === 'pendiente').length;
document.getElementById('pendientes-count').textContent = pendientes;
}
document.getElementById('btn-recargar-panel')?.addEventListener('click', () => {
  cargarPanelAdmin();  // Llama directamente a la función que refresca el contenido
});
function ordenarPendientesArriba() {
  const tbody = document.querySelector('#tabla-comprobantes tbody');
  if (!tbody) return;

  const prioridad = {
    pendiente: 0,
    rechazado: 1,
    aprobado: 2
  };

  const filas = Array.from(tbody.querySelectorAll('tr')).map((fila, index) => ({
    fila,
    index
  }));

  filas.sort((a, b) => {
    const estadoA = obtenerEstadoFila(a.fila);
    const estadoB = obtenerEstadoFila(b.fila);

    const prioridadA = prioridad[estadoA] ?? 99;
    const prioridadB = prioridad[estadoB] ?? 99;

    return prioridadA - prioridadB || a.index - b.index;
  });

  filas.forEach(({ fila }) => tbody.appendChild(fila));
}

function obtenerEstadoFila(fila) {
  const estadoDataset = fila.dataset.estadoActual;

  if (estadoDataset) {
    return estadoDataset.toLowerCase();
  }

  const circulo = fila.querySelector('.estado-circulo');

  if (circulo?.classList.contains('verde')) return 'aprobado';
  if (circulo?.classList.contains('naranja')) return 'rechazado';

  return 'pendiente';
}
async function aprobarInscripcion(id, fila) {
  const puedeCambiar = await confirmarCambioEstado(id, 'aprobado');
  if (!puedeCambiar) return false;

  // Buscar inscripción actual
  const { data: actual, error: errorActual } = await supabase
    .from('inscripciones')
    .select('cartones,nombre')
    .eq('id', id)
    .single();

  if (errorActual || !actual) {
    alert('No se pudo verificar la inscripción');
    return false;
  }

  const misCartones = (actual.cartones || []).map(String);

  // Buscar aprobados
  const { data: aprobados, error: errorAprobados } = await supabase
    .from('inscripciones')
    .select('id,nombre,cartones')
    .eq('estado', 'aprobado')
    .neq('id', id);

  if (errorAprobados) {
    alert('No se pudieron verificar duplicados');
    return false;
  }

  const duplicados = [];

  (aprobados || []).forEach(ins => {
    const otros = (ins.cartones || []).map(String);

    misCartones.forEach(c => {
      if (otros.includes(c)) {
        duplicados.push({
          carton: c,
          nombre: ins.nombre
        });
      }
    });
  });

  if (duplicados.length > 0) {
    const mensaje = duplicados
      .map(d => `Cartón ${d.carton} ya aprobado para ${d.nombre}`)
      .join('\n');

    alert(
      '⚠️ No se puede aprobar.\n\n' +
      mensaje
    );

    return false;
  }

  // Aprobar
  const { error } = await supabase.rpc('rpc_admin_cambiar_estado', {
    _id: id,
    _estado: 'aprobado'
  });

  if (error) {
    console.error(error);
    alert('No se pudo aprobar');
    return false;
  }

  const circulo = fila.querySelector('.estado-circulo');
  if (circulo) {
    circulo.classList.remove('rojo', 'naranja');
    circulo.classList.add('verde');
  }

  fila.dataset.estadoActual = 'aprobado';

  alert('¡Inscripción aprobada!');
  return true;
}
async function confirmarCambioEstado(id, nuevoEstado) {
  const { data } = await supabase
    .from('inscripciones')
    .select('estado')
    .eq('id', id)
    .single();

  if (!data) return false;

  if (data.estado !== 'pendiente' && data.estado !== nuevoEstado) {
    return confirm(`Esta inscripción está ${data.estado}. ¿Seguro quieres cambiarla a ${nuevoEstado}?`);
  }

  return true;
}
async function rechazarInscripcion(item, fila) {
  const puedeCambiar = await confirmarCambioEstado(item.id, 'rechazado');
  if (!puedeCambiar) return false;

  const confirma = confirm('¿Seguro que deseas rechazar? Sus cartones quedarán disponibles nuevamente.');
  if (!confirma) return false;

  const { error: errUpd } = await supabase.rpc('rpc_admin_cambiar_estado', {
    _id: item.id,
    _estado: 'rechazado'
  });

  if (errUpd) {
    console.error(errUpd);
    alert('Error actualizando inscripción');
    return false;
  }

  const circulo = fila.querySelector('.estado-circulo');
  if (circulo) {
    circulo.classList.remove('rojo', 'verde');
    circulo.classList.add('naranja');
  }

  fila.dataset.estadoActual = 'rechazado';

  alert('Inscripción rechazada');
  return true;
}

async function eliminarInscripcion(item, fila) {
  const confirmar = confirm('¿Eliminar esta inscripción? Se liberarán solo los cartones que nadie más tenga.');
  if (!confirmar) return;

  try {
    const { data, error } = await supabase.rpc('rpc_eliminar_inscripcion_seguro', { _id: item.id });
    if (error) throw error;

    const rutaComprobante = data || obtenerRutaComprobante(item.comprobante);
    if (rutaComprobante) {
      const { error: comprobanteError } = await supabase.storage
        .from('comprobantes')
        .remove([rutaComprobante]);

      if (comprobanteError) {
        alert('La inscripción fue eliminada, pero no se pudo borrar su comprobante.');
        console.error(comprobanteError);
      }
    }

    fila.remove();
    await contarCartonesVendidos();
    await obtenerMontoTotalRecaudado();
    await cargarCartones();

    alert('Inscripción eliminada y cartones liberados.');
  } catch (e) {
    console.error(e);
    alert('Error al eliminar inscripción.');
  }
}

async function cerrarVentas() {
  const confirmacion = confirm("¿Estás seguro que quieres cerrar las ventas?");
  if (!confirmacion) return;

  const { error } = await supabase
    .from('configuracion')
    .update({ valor: false })
    .eq('clave', 'ventas_abierta');

  if (error) {
    alert("Error al cerrar las ventas");
    console.error(error);
  } else {
    alert("Ventas cerradas correctamente");
    location.reload();
  }
}

async function abrirVentas() {
  const confirmacion = confirm("¿Estás seguro que quieres abrir las ventas?");
  if (!confirmacion) return;

  const { error } = await supabase
    .from('configuracion')
    .update({ valor: true })
    .eq('clave', 'ventas_abierta');

  if (error) {
    alert("Error al abrir las ventas");
    console.error(error);
  } else {
    alert("Ventas abiertas correctamente");
    location.reload();
  }
}

async function verificarClaveAdmin(password) {
  const email = sessionStorage.getItem('admin_email') ||
    document.getElementById('admin-email')?.value.trim();

  if (!email || !password) return false;

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  return !error && data?.user?.app_metadata?.role === 'admin';
}

async function listarArchivosStorage(bucket, prefijo = '') {
  const rutas = [];
  const limite = 100;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefijo, {
        limit: limite,
        offset,
        sortBy: { column: 'name', order: 'asc' }
      });

    if (error) throw error;
    if (!data?.length) break;

    for (const item of data) {
      const ruta = prefijo ? `${prefijo}/${item.name}` : item.name;

      if (item.id) {
        rutas.push(ruta);
      } else {
        rutas.push(...await listarArchivosStorage(bucket, ruta));
      }
    }

    if (data.length < limite) break;
    offset += limite;
  }

  return rutas;
}

async function reiniciarTodo() {
  if (!confirm('⚠️ ¿Estás seguro de reiniciar todo?\n\nEsto borrará todos los datos permanentemente.')) {
    return;
  }
  
  const claveIngresada = prompt('🔒 INGRESA LA CLAVE DE SEGURIDAD PARA CONTINUAR:');
  
  if (!claveIngresada) {
    alert('❌ Operación cancelada. No se ingresó clave.');
    return;
  }
  
  if (!await verificarClaveAdmin(claveIngresada)) {
    alert('❌ CLAVE INCORRECTA\n\nOperación cancelada por seguridad.');
    return;
  }
  
  if (!confirm('🔥 ÚLTIMA CONFIRMACIÓN\n\n¿Estás ABSOLUTAMENTE seguro?\n\nEsto NO se puede deshacer.')) {
    alert('✅ Operación cancelada.');
    return;
  }
  
  try {
    const { error: reinicioError } = await supabase.rpc('rpc_admin_reiniciar_ventas', {
      _incluir_ganadores: false
    });

    if (reinicioError) throw reinicioError;

    const comprobantes = await listarArchivosStorage('comprobantes');

    for (let i = 0; i < comprobantes.length; i += 100) {
      const { error: borrarError } = await supabase.storage
        .from('comprobantes')
        .remove(comprobantes.slice(i, i + 100));

      if (borrarError) throw borrarError;
    }

    alert(`✅ Datos reiniciados. Comprobantes eliminados: ${comprobantes.length}`);
    location.reload();
  } catch (error) {
    console.error(error);
    alert('❌ No se pudo reiniciar el juego: ' + error.message);
  }
}

// ==================== FUNCIONES DE MODAL ====================
let cartonSeleccionadoTemporal = null;
let cartonElementoTemporal = null;

function abrirModalCarton(numero, elemento) {
  cartonSeleccionadoTemporal = numero;
  cartonElementoTemporal = elemento;
  const img = document.getElementById('imagen-carton-modal');
  img.src = urlCartonWebP(numero);
img.loading = 'lazy';
img.alt = `Cartón ${numero}`;

  document.getElementById('modal-carton').classList.remove('oculto');

  const btn = document.getElementById('btnSeleccionarCarton');
  btn.onclick = async () => {
  await toggleCarton(cartonSeleccionadoTemporal, cartonElementoTemporal);
  cerrarModalCarton();
};
}

function cerrarModalCarton() {
  document.getElementById('modal-carton').classList.add('oculto');
  cartonSeleccionadoTemporal = null;
  cartonElementoTemporal = null;
}

function actualizarContadorCartones(total, ocupados, seleccionados) {
  const disponibles = Math.max(0, total - ocupados - seleccionados);
  const contador = document.getElementById('contadorCartones');

  if (contador) {
    contador.textContent = `Cartones disponibles: ${disponibles} de ${total}`;
  }
}

// ==================== FUNCIONES AUXILIARES ====================
async function guardarNuevoTotal() {
  const nuevoTotal = parseInt(document.getElementById("nuevoTotalCartones").value, 10);
  const estado = document.getElementById("estadoTotalCartones");

  if (isNaN(nuevoTotal) || nuevoTotal < 1) {
    estado.textContent = "Número inválido.";
    return;
  }

  const { error } = await supabase
    .from('configuracion')
    .upsert(
      [{ clave: 'total_cartones', valore: String(nuevoTotal) }],
      { onConflict: 'clave' }
    );

  if (error) {
    console.error('guardarNuevoTotal error:', error);
    estado.textContent = "Error al actualizar.";
  } else {
    estado.textContent = "¡Total actualizado!";
    totalCartones = nuevoTotal;
    configuracionPublicaCache = null;
  }
}

async function cargarPromocionesConfig() {
  try {
    for (let i = 0; i < promociones.length; i++) {
      const promo = promociones[i];
      const prefix = `promo${i + 1}`;
      
      promo.activa = (await getConfigValue(`${prefix}_activa`, 'false')) === 'true';
      promo.descripcion = await getConfigValue(`${prefix}_descripcion`, `Promo ${i + 1}`);
      promo.cantidad = parseInt(await getConfigValue(`${prefix}_cantidad`, '0')) || 0;
      promo.precio = parseFloat(await getConfigValue(`${prefix}_precio`, '0')) || 0;
    }
    
    console.log('Promociones cargadas:', promociones);
    renderizarBotonesPromociones();
  } catch (error) {
    console.error('Error cargando promociones:', error);
  }
}

async function cargarPromocionesAdmin() {
  try {
    for (let i = 1; i <= 4; i++) {
      document.getElementById(`promo${i}_activa`).checked = 
        (await getConfigValue(`promo${i}_activa`, 'false')) === 'true';
      document.getElementById(`promo${i}_descripcion`).value = 
        await getConfigValue(`promo${i}_descripcion`, '');
      document.getElementById(`promo${i}_cantidad`).value = 
        parseInt(await getConfigValue(`promo${i}_cantidad`, '0')) || '';
      document.getElementById(`promo${i}_precio`).value = 
        parseFloat(await getConfigValue(`promo${i}_precio`, '0')) || '';
    }
  } catch (error) {
    console.error('Error cargando promociones en admin:', error);
  }
}

async function guardarPromociones() {
  const estado = document.getElementById('estadoPromociones');
  
  try {
    const updates = [];
    
    for (let i = 1; i <= 4; i++) {
      const activa = document.getElementById(`promo${i}_activa`).checked;
      const desc = document.getElementById(`promo${i}_descripcion`).value.trim();
      const cant = parseInt(document.getElementById(`promo${i}_cantidad`).value) || 0;
      const precio = parseFloat(document.getElementById(`promo${i}_precio`).value) || 0;
      
      updates.push(
        { clave: `promo${i}_activa`, valore: String(activa) },
        { clave: `promo${i}_descripcion`, valore: desc },
        { clave: `promo${i}_cantidad`, valore: String(cant) },
        { clave: `promo${i}_precio`, valore: String(precio) }
      );
    }
    
    const { error } = await supabase.from('configuracion').upsert(updates, { onConflict: 'clave' });
    
    if (error) {
      estado.textContent = 'Error guardando promociones';
      estado.style.color = 'red';
    } else {
      estado.textContent = '✅ Todas las promociones guardadas correctamente';
      estado.style.color = 'green';
      configuracionPublicaCache = null;
      await cargarPromocionesConfig();
      setTimeout(() => { estado.textContent = ''; }, 3000);
    }
  } catch (error) {
    console.error('Error:', error);
    estado.textContent = 'Error inesperado al guardar';
    estado.style.color = 'red';
  }
}

function seleccionarPromocion(numero) {
  const promo = promociones[numero - 1];
  
  if (!promo.activa || promo.cantidad <= 0 || promo.precio <= 0) {
    alert('Esta promoción no está disponible en este momento.');
    return;
  }
  
  const ocupadosValidos = cartonesOcupados
  .map(Number)
  .filter(n => n >= 1 && n <= totalCartones).length;

const maxDisponibles = Math.max(0, totalCartones - ocupadosValidos);
  if (promo.cantidad > maxDisponibles) {
    alert(`No hay suficientes cartones disponibles para esta promoción. Disponibles: ${maxDisponibles}`);
    return;
  }
  
  if (promocionSeleccionada === numero) {
    deseleccionarPromocion();
    return;
  }
  
  promocionSeleccionada = numero;
  
  document.querySelectorAll('.btn-promo').forEach(btn => {
    btn.classList.remove('seleccionado');
  });
  
  const botonSeleccionado = document.querySelector(`[data-promo="${numero}"]`);
  if (botonSeleccionado) {
    botonSeleccionado.classList.add('seleccionado');
  }
  
  document.getElementById('cantidadCartones').value = promo.cantidad;
  actualizarPreseleccion();
}

function deseleccionarPromocion() {
  promocionSeleccionada = null;
  document.querySelectorAll('.btn-promo').forEach(btn => {
    btn.classList.remove('seleccionado');
  });
  document.getElementById('cantidadCartones').value = 1;
  actualizarPreseleccion();
}

function getPromocionSeleccionada() {
  return promocionSeleccionada ? promociones[promocionSeleccionada - 1] : null;
}

// ==================== FUNCIONES RESTANTES ====================
function mostrarSeccion(id) {
  const secciones = document.querySelectorAll('section');
  secciones.forEach(sec => sec.classList.add('oculto'));
  const target = document.getElementById(id);
  if (target) target.classList.remove('oculto');
  
    if (id === 'ganadores') {
    cargarGanadores();
  }
  
  const redes = document.getElementById('redes-sociales');
  if (redes) {
    redes.style.display = id === 'inicio' ? 'flex' : 'none';
  }
}

async function cargarListaAprobadosSeccion() {
  const { data, error } = await supabase.rpc('rpc_lista_aprobados');

  const contenedor = document.getElementById('contenedor-aprobados');
  contenedor.innerHTML = '';

  if (error || !data.length) {
    contenedor.innerHTML = '<p>No hay aprobados aún.</p>';
    return;
  }

  const tabla = document.createElement('table');
  tabla.style.width = '100%';
  tabla.style.borderCollapse = 'collapse';
  tabla.innerHTML = `
    <thead>
      <tr>
        <th>Cartón</th>
        <th>Nombre</th>
        <th>Cédula</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = tabla.querySelector('tbody');
  data.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHTML(item.carton)}</td>
      <td>${escapeHTML(item.nombre)}</td>
      <td>${escapeHTML(item.cedula_mascara)}</td>
    `;
    tbody.appendChild(tr);
  });

  contenedor.appendChild(tabla);
}

function actualizarHoraVenezuela() {
  const contenedor = document.getElementById('hora-venezuela');
  if (!contenedor) return;

  const opciones = {
    timeZone: 'America/Caracas',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  };

  const ahora = new Date();
  const formato = new Intl.DateTimeFormat('es-VE', opciones).format(ahora);
  contenedor.textContent = `📅 ${formato}`;
}

async function guardarLinkWhatsapp() {
  const link = document.getElementById('inputWhatsapp').value.trim();
  if (!link) return alert('Ingresa un enlace válido');

  const { error } = await supabase
    .from('configuracion')
    .upsert([{ clave: 'link_whatsapp', valore: link }], { onConflict: 'clave' });

  if (error) {
    alert('Error guardando el enlace');
    console.error(error);
  } else {
    configuracionPublicaCache = null;
    alert('Enlace guardado');
  }
}
async function cargarLinkWhatsapp() {
  const link = await getConfigValue('link_whatsapp', '');
  if (!link) return;

  const btn = document.getElementById('btnWhatsapp');
  if (!btn) return;

  btn.href = link;
  btn.style.display = 'inline-block';
}

async function cargarEnlacesAdmin() {
  const whatsapp = await getConfigValue('link_whatsapp', '');
  const youtube = await getConfigValue('youtube_live', '');
  const inputWhatsapp = document.getElementById('inputWhatsapp');
  const inputYoutube = document.getElementById('inputYoutube');

  if (inputWhatsapp) inputWhatsapp.value = whatsapp || '';
  if (inputYoutube) inputYoutube.value = youtube || '';
}

function cerrarTerminos() {
  document.getElementById('modal-terminos').classList.add('oculto');
}

async function guardarLinkYoutube() {
  const link = document.getElementById("inputYoutube").value.trim();
  const { error } = await supabase
    .from("configuracion")
    .upsert({ clave: "youtube_live", valore: link }, { onConflict: 'clave' });

  if (error) {
    alert("Error al guardar el enlace: " + error.message);
  } else {
    configuracionPublicaCache = null;
    alert("Enlace de YouTube guardado exitosamente.");
  }
}

async function cargarLinkYoutube() {
  const link = await getConfigValue(
    'youtube_live',
    await getConfigValue('youtube_url', '')
  );
  const boton = document.querySelector('#redes-sociales a[title="YouTube"]');

  if (boton && link) boton.href = link;
}

async function cargarConfiguracionModoCartones() {
  if (ES_PAGINA_ADMIN) return;

  modoCartones = await getConfigValue('modo_cartones', 'libre');

  if (modoCartones === "fijo") {
    cantidadFijaCartones = parseInt(
      await getConfigValue('cartones_obligatorios', '1'),
      10
    ) || 1;
    document.getElementById('cantidadCartones').value = cantidadFijaCartones;
    document.getElementById('btnMas').disabled = true;
    document.getElementById('btnMenos').disabled = true;
    document.getElementById('cantidadCartones').readOnly = true;
  } else {
    document.getElementById('btnMas').disabled = false;
    document.getElementById('btnMenos').disabled = false;
    document.getElementById('cantidadCartones').readOnly = false;
  }
}

async function cargarModoCartonesAdmin() {
  const { data: modoData } = await supabase
    .from('configuracion')
    .select('valore')
    .eq('clave', 'modo_cartones')
    .single();

  if (modoData) {
    document.getElementById('modoCartonesSelect').value = modoData.valore;
  }

  if (modoData && modoData.valore === 'fijo') {
    const { data: cantData } = await supabase
      .from('configuracion')
      .select('valore')
      .eq('clave', 'cartones_obligatorios')
      .single();

    if (cantData) {
      document.getElementById('cantidadCartonesFijos').value = cantData.valore;
    }
    document.getElementById('contenedorCartonesFijos').style.display = 'block';
  } else {
    document.getElementById('contenedorCartonesFijos').style.display = 'none';
  }
}

function cambiarModoCartones() {
  const modo = document.getElementById('modoCartonesSelect').value;
  const contenedor = document.getElementById('contenedorCartonesFijos');
  contenedor.style.display = (modo === 'fijo') ? 'block' : 'none';

  if (ES_PAGINA_ADMIN) return;
  
  if (modo === 'fijo') {
    const cantidad = document.getElementById('cantidadCartonesFijos').value || 1;
    document.getElementById('btnMas').disabled = true;
    document.getElementById('btnMenos').disabled = true;
    document.getElementById('cantidadCartones').readOnly = true;
  } else {
    document.getElementById('btnMas').disabled = false;
    document.getElementById('btnMenos').disabled = false;
    document.getElementById('cantidadCartones').readOnly = false;
  }
}

async function guardarModoCartones() {
  const modo = document.getElementById('modoCartonesSelect').value;
  const cantidad = parseInt(document.getElementById('cantidadCartonesFijos').value);

  const updates = [
    { clave: 'modo_cartones', valore: modo }
  ];

  if (modo === 'fijo') {
    if (isNaN(cantidad) || cantidad < 1) {
      return alert('Cantidad fija inválida');
    }
    updates.push({ clave: 'cartones_obligatorios', valore: cantidad });
  }

  const { error } = await supabase
    .from('configuracion')
    .upsert(updates, { onConflict: 'clave' });

  if (error) {
    alert('Error guardando configuración');
    console.error(error);
  } else {
    alert('Modo actualizado correctamente');
    configuracionPublicaCache = null;
    if (ES_PAGINA_ADMIN) {
      await cargarModoCartonesAdmin();
    } else {
      await cargarConfiguracionModoCartones();
    }
  }
}

async function guardarGanador() {
  const nombre   = document.getElementById('ganadorNombre').value.trim();
  const cedula   = document.getElementById('ganadorCedula').value.trim();
  const cartones = document.getElementById('ganadorCartones').value.trim();
  const premio   = document.getElementById('ganadorPremio').value.trim();
  const telefono  = document.getElementById('ganadorTelefono').value.trim();
  const fecha    = document.getElementById('ganadorFecha').value.trim();

  if (!nombre || !cedula || !cartones || !premio || !telefono|| !fecha) {
    return alert("Completa todos los campos del ganador.");
  }

  const { error } = await supabase
    .from('ganadores')
    .insert([{ nombre, cedula, cartones, premio, telefono, fecha }]);

  if (error) {
    console.error(error);
    alert("Error al guardar el ganador.");
  } else {
    alert("¡Ganador guardado correctamente!");
    document.getElementById('formularioGanador').reset();
    cargarGanadores();
  }
}

async function cargarGanadores() {
  const resultado = ES_PAGINA_ADMIN
    ? await supabase.from('ganadores').select('*').order('id', { ascending: false })
    : await supabase.rpc('rpc_ganadores_publicos');
  const { data, error } = resultado;

  const contenedor = document.getElementById('listaGanadores');
  if (!contenedor) return;

  contenedor.innerHTML = '';

  if (error || !data.length) {
    contenedor.innerHTML = '<p>No hay ganadores registrados aún.</p>';
    return;
  }

  const tabla = document.createElement('table');
  tabla.style.width = '100%';
  tabla.innerHTML = `
    <thead>
      <tr>
        <th>Nombre</th>
        <th>Cédula</th>
        <th>Cartones</th>
        <th>Premio</th>
        <th>Telefono</th>
        <th>Fecha</th>
      </tr>
    </thead>
    <tbody>
      ${data.map(g => `
        <tr>
          <td>${escapeHTML(g.nombre)}</td>
          <td>${escapeHTML(g.cedula || '—')}</td>
          <td>${escapeHTML(g.cartones)}</td>
          <td>${escapeHTML(g.premio)}</td>
          <td>${escapeHTML(g.telefono || '—')}</td>
          <td>${escapeHTML(g.fecha)}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
  contenedor.appendChild(tabla);
}

function toggleFormularioGanador() {
  const contenedor = document.getElementById('formularioGanadorContenedor');
  contenedor.style.display = contenedor.style.display === 'none' ? 'block' : 'none';
}

let canalCelebraciones = null;

function mostrarCohetes() {
  const escenario = document.createElement('div');
  escenario.setAttribute('aria-hidden', 'true');
  escenario.style.cssText = 'position:fixed;inset:0;z-index:999998;pointer-events:none;overflow:hidden;';
  document.body.appendChild(escenario);

  for (let i = 0; i < 24; i++) {
    const cohete = document.createElement('span');
    cohete.textContent = i % 2 ? '🎆' : '🎇';
    cohete.style.cssText = `position:absolute;left:${Math.random() * 94}%;top:${20 + Math.random() * 65}%;font-size:${28 + Math.random() * 38}px;`;
    escenario.appendChild(cohete);
    cohete.animate(
      [
        { transform: 'scale(.2) rotate(0deg)', opacity: 0 },
        { transform: 'scale(1.35) rotate(20deg)', opacity: 1, offset: .4 },
        { transform: 'scale(.8) rotate(-15deg)', opacity: 0 }
      ],
      { duration: 1800 + Math.random() * 1800, delay: Math.random() * 900, easing: 'ease-out' }
    );
  }

  setTimeout(() => escenario.remove(), 4500);
}

function activarCanalCelebraciones() {
  if (canalCelebraciones || ES_PAGINA_ADMIN) return;

  canalCelebraciones = supabase
    .channel('bingo-ganga-celebraciones')
    .on('broadcast', { event: 'cohetes' }, mostrarCohetes)
    .subscribe();
}

async function activarCohetes() {
  const { error } = await supabase.rpc('rpc_admin_lanzar_cohetes');

  if (error) {
    alert("Error activando cohetes");
  } else {
    alert("¡Cohetes activados!");
  }
}

function ordenarInscripcionesPorNombre() {
  const tabla = document.querySelector('#tabla-comprobantes tbody');
  const filas = Array.from(tabla.rows);

  filas.sort((a, b) => {
    const nombreA = a.cells[0].textContent.trim().toLowerCase();
    const nombreB = b.cells[0].textContent.trim().toLowerCase();
    return nombreA.localeCompare(nombreB);
  });

  tabla.innerHTML = '';
  filas.forEach(fila => tabla.appendChild(fila));
}

let ordenCedulaAscendente = true;

function ordenarPorCedula() {
  const tabla = document.querySelector('#tabla-comprobantes tbody');
  const filas = Array.from(tabla.rows);

  filas.sort((a, b) => {
    const cedulaA = parseInt(a.cells[2].textContent.trim());
    const cedulaB = parseInt(b.cells[2].textContent.trim());
    return ordenCedulaAscendente ? cedulaA - cedulaB : cedulaB - cedulaA;
  });

  tabla.innerHTML = '';
  filas.forEach(fila => tabla.appendChild(fila));
  ordenCedulaAscendente = !ordenCedulaAscendente;
}

let ordenReferenciaAscendente = false;
function ordenarPorReferencia() {
  const tabla = document.querySelector('#tabla-comprobantes tbody');
  const filas = Array.from(tabla.rows);

  filas.sort((a, b) => {
    const refA = a.cells[5].textContent.trim();
    const refB = b.cells[5].textContent.trim();
    const numA = parseInt(refA) || 0;
    const numB = parseInt(refB) || 0;
    return ordenReferenciaAscendente ? numA - numB : numB - numA;
  });

  tabla.innerHTML = '';
  filas.forEach(fila => tabla.appendChild(fila));
  ordenReferenciaAscendente = !ordenReferenciaAscendente;
}

function buildWhatsAppLink(rawPhone, presetMsg = '') {
  if (!rawPhone) return null;

  let s = String(rawPhone).trim().replace(/[\s\-\.\(\)]/g, '');

  if (s.startsWith('00')) s = '+' + s.slice(2);

  if (!s.startsWith('+')) {
    const digits = s.replace(/\D+/g, '');
    const m = /^(0?)(412|414|416|424|426)(\d{7})$/.exec(digits);
    if (m) {
      s = '+58' + m[2] + m[3];
    } else {
      s = '+' + digits;
    }
  }

  const waNumber = s.replace(/^\+/, '');
  const text = encodeURIComponent(presetMsg || 'Hola, te escribo de parte del equipo de bingoandino75.');
  return `https://wa.me/${waNumber}?text=${text}`;
}

async function fetchTodosLosOcupados() {
  const { data, error } = await supabase.rpc('rpc_cartones_ocupados');

  if (error) {
    console.error('Error obteniendo cartones ocupados:', error);
    return [];
  }

  return (data || []).map(item => Number(item.numero));
}

function restringirSolo4Digitos(input) {
  input.value = input.value.replace(/\D+/g, '').slice(0, 4);
}

function editarReferencia(td) {
  const id   = td.getAttribute('data-id');
  const prev = (td.querySelector('.ref-text')?.textContent || '').trim();

  td.innerHTML = `
    <input class="ref-input" type="text" maxlength="4" value="${escapeHTML(prev)}">
    <button class="btn-mini btn-guardar">Guardar</button>
    <button class="btn-mini btn-cancelar">Cancelar</button>
  `;

  const inp     = td.querySelector('.ref-input');
  const btnOk   = td.querySelector('.btn-guardar');
  const btnCancel = td.querySelector('.btn-cancelar');

  inp.addEventListener('input', () => restringirSolo4Digitos(inp));
  inp.focus();
  inp.select();

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnOk.click();
    if (e.key === 'Escape') btnCancel.click();
  });

  btnOk.onclick = async () => {
    const val = (inp.value || '').trim();
    if (!/^\d{4}$/.test(val)) {
      alert('La referencia debe tener exactamente 4 dígitos (0000–9999).');
      inp.focus();
      return;
    }

    const { error } = await supabase
      .from('inscripciones')
      .update({ referencia4dig: val })
      .eq('id', id);

    if (error) {
      console.error(error);
      alert('No se pudo guardar la referencia.');
      return;
    }

    td.innerHTML = `
      <span class="ref-text">${val}</span>
      <button class="btn-accion btn-edit-ref" title="Editar">&#9998;</button>
    `;
    td.querySelector('.btn-edit-ref').onclick = () => editarReferencia(td);
  };

  btnCancel.onclick = () => {
    td.innerHTML = `
      <span class="ref-text">${prev}</span>
      <button class="btn-accion btn-edit-ref" title="Editar">&#9998;</button>
    `;
    td.querySelector('.btn-edit-ref').onclick = () => editarReferencia(td);
  };
}

function normalizarNombre(s='') {
  return String(s)
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function solo4Digitos(s='') {
  const t = String(s).replace(/\D+/g, '').slice(0,4);
  return /^\d{4}$/.test(t) ? t : '';
}

async function fetchAprobadosBasico() {
  const { data, error } = await supabase
    .from('inscripciones')
    .select('id,nombre,cedula,telefono,cartones,referencia4dig')
    .eq('estado','aprobado');
  if (error) {
    console.error('Error cargando aprobados:', error);
    alert('No se pudieron cargar los aprobados.');
    return [];
  }
  return data || [];
}

function renderDuplicadosAprobados(lista, tipoClave) {
  const cont = document.getElementById('duplicadosAprobadosResultado');
  if (!cont) return;

  cont.innerHTML = '';

  if (!lista.length) {
    cont.innerHTML = `<p style="color:#4caf50;font-weight:600;">
      No se encontraron duplicados por ${tipoClave} entre los aprobados.
    </p>`;
    return;
  }

  lista.forEach((g, index) => {
    const card = document.createElement('div');
    card.className = 'duplicado-card';

    const titulo = tipoClave === 'nombre'
      ? `👤 Nombre: ${g.clave}`
      : `#️⃣ Referencia: ${g.clave}`;

    const detalleId = `dup-detalle-${tipoClave}-${index}`;

    card.innerHTML = `
      <div class="duplicado-header" onclick="toggleDuplicado('${detalleId}')">
      <span>${escapeHTML(titulo)}</span>
        <span>${g.items.length} veces ▼</span>
      </div>

      <div id="${detalleId}" class="duplicado-detalle">
        ${g.items.map(x => {
          const carts = Array.isArray(x.cartones) ? x.cartones.join(', ') : '';

          return `
            <div class="persona-item">
              <strong>${escapeHTML(x.nombre || 'Sin nombre')}</strong><br>
              CI: ${escapeHTML(x.cedula || 'N/A')}
              ${x.telefono ? `<br>Tel: ${escapeHTML(x.telefono)}` : ''}
              ${carts ? `<br>Cartones: ${escapeHTML(carts)}` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;

    cont.appendChild(card);
  });
}

function toggleDuplicado(id) {
  const detalle = document.getElementById(id);
  if (!detalle) return;

  detalle.style.display =
    detalle.style.display === 'block' ? 'none' : 'block';
}
async function detectarDuplicadosAprobadosPorNombre() {
  const rows = await fetchAprobadosBasico();
  const mapa = new Map();
  rows.forEach(r => {
    const k = normalizarNombre(r.nombre);
    if (!k) return;
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(r);
  });
  
  const duplicados = [];
  const dupSet = new Set();
  for (const [k, arr] of mapa.entries()) {
    if (arr.length > 1) {
      duplicados.push({ clave: k, items: arr });
      dupSet.add(k);
    }
  }
  
  duplicados.sort((a,b) => (b.items.length - a.items.length) || a.clave.localeCompare(b.clave));
  renderDuplicadosAprobados(duplicados, 'nombre');
}

async function detectarDuplicadosAprobadosPorReferencia() {
  const rows = await fetchAprobadosBasico();
  const mapa = new Map();
  rows.forEach(r => {
    const ref = solo4Digitos(r.referencia4dig);
    if (!ref) return;
    if (!mapa.has(ref)) mapa.set(ref, []);
    mapa.get(ref).push(r);
  });
  
  const duplicados = [];
  for (const [ref, arr] of mapa.entries()) {
    if (arr.length > 1) duplicados.push({ clave: ref, items: arr });
  }
  
  duplicados.sort((a,b) => (b.items.length - a.items.length) || (a.clave.localeCompare(b.clave)));
  renderDuplicadosAprobados(duplicados, 'referencia');
}

function imprimirLista() {
  const lista = document.getElementById('listaAprobados');

  if (!lista || !lista.innerHTML.trim()) {
    alert('Primero debes generar la lista de aprobados.');
    return;
  }

  const ventana = window.open('', '_blank');

  ventana.document.write(`
    <html>
      <head>
        <title>Lista de Aprobados</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            color: #000;
            padding: 00px;
          }

          h1 {
            text-align: center;
            font-size: 16px;
            margin: 0 0 4px 0;
          }

          .fecha {
            text-align: center;
            font-size: 9px;
            margin-bottom: 8px;
          }

          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 18px;
          }

          th, td {
            border: 1px solid #999;
            padding: 2px 3px;
            text-align: center;
            vertical-align: middle;
          }

          th {
            background: #eee;
            font-weight: bold;
          }

          @page {
            size: letter portrait;
            margin: 6mm;
          }
        </style>
      </head>
      <body>
        <h1>Lista de Aprobados</h1>
        <div class="fecha">${new Date().toLocaleString()}</div>
        ${lista.innerHTML}
      </body>
    </html>
  `);

  ventana.document.close();

  ventana.onload = function () {
    ventana.focus();
    ventana.print();
  };
}


// ==================== FUNCIONES FALTANTES ====================


function nombreCartonWebPDesdeArchivo(fileName) {
  const limpio = String(fileName || '')
    .trim()
    .replace(/\s+/g, '-');

  return limpio.replace(/\.[^.]+$/, '.webp');
}
async function subirCartones() {
  const input = document.getElementById('cartonImageInput');
  const files = Array.from(input.files || []);
  const status = document.getElementById('uploadStatus');
  status.innerHTML = '';

  if (!files.length) {
    alert('Selecciona al menos una imagen');
    return;
  }

  status.innerHTML = '<p style="color:blue;">Convirtiendo imágenes a WebP y subiendo...</p>';

  const errores = [];
  let subidas = 0;

  for (let i = 0; i < files.length; i++) {
    const archivoOriginal = files[i];

    try {
      const archivoWebP = await convertirImagenAWebP(archivoOriginal, 0.80, 1200);

      // Mantiene el mismo nombre, pero cambia la extensión a .webp
      // Ejemplo: SERIAL_BINGOANDINO75_CARTON_00001.jpg → SERIAL_BINGOANDINO75_CARTON_00001.webp
      const fileName = nombreCartonWebPDesdeArchivo(archivoOriginal.name);

      const { error } = await supabase.storage
        .from('cartones')
        .upload(fileName, archivoWebP, {
          cacheControl: '31536000',
          contentType: 'image/webp',
          upsert: true
        });

      if (error) {
        errores.push(`Error subiendo ${fileName}: ${error.message}`);
      } else {
        subidas++;
      }
    } catch (err) {
      errores.push(`Error inesperado en ${archivoOriginal.name}: ${err.message}`);
    }
  }

  input.value = '';

  if (errores.length) {
    status.innerHTML = `
      <p style="color:red;">Se subieron ${subidas}, pero hubo errores:</p>
      <ul>${errores.map(e => `<li>${e}</li>`).join('')}</ul>
    `;
  } else {
    status.innerHTML = `<p style="color:green;">✅ ${subidas} imágenes fueron convertidas a WebP y subidas exitosamente.</p>`;
  }

  setTimeout(() => {
    status.innerHTML = '';
  }, 7000);
}

async function borrarCartones() {
  const claveIngresada = prompt("Ingrese la clave de seguridad para borrar todos los cartones:");

  if (!claveIngresada) {
    alert("Operación cancelada.");
    return;
  }

  if (!await verificarClaveAdmin(claveIngresada)) {
    alert("Clave incorrecta. No se borraron los cartones.");
    return;
  }

  if (!confirm("⚠️ ¿ESTÁS ABSOLUTAMENTE SEGURO?\n\nEsta acción borrará TODAS las imágenes de cartones.\n\nEsto NO se puede deshacer.")) {
    alert("Operación cancelada.");
    return;
  }

  const status = document.getElementById('deleteStatus');
  status.innerHTML = '<p style="color:blue;">Cargando lista de imágenes...</p>';

  try {
    const list = await listarArchivosStorage('cartones');

    if (!list || list.length === 0) {
      status.innerHTML = '<p style="color:orange;">No hay imágenes para borrar.</p>';
      setTimeout(() => { status.innerHTML = ''; }, 3000);
      return;
    }

    const fileNames = list;
    const { error: deleteError } = await supabase.storage
      .from('cartones')
      .remove(fileNames);

    if (deleteError) throw deleteError;

    status.innerHTML = `<p style="color:green;">✅ Se borraron ${fileNames.length} imágenes exitosamente.</p>`;
    
  } catch (error) {
    console.error('Error borrando cartones:', error);
    status.innerHTML = `<p style="color:red;">❌ Error al borrar imágenes: ${error.message}</p>`;
  }

  setTimeout(() => {
    status.innerHTML = '';
  }, 5000);
}

// ==================== FUNCIÓN entrarAdmin ====================
async function entrarAdmin() {
  if (!ES_PAGINA_ADMIN) {
    window.location.href = 'admin.html';
    return;
  }

  // Verificar si ya tiene sesión válida
  const sessionToken = sessionStorage.getItem('admin_session_token');
  
  if (sessionToken && await verificarSesionAdmin()) {
    const { data: authData } = await supabase.auth.getSession();

    if (!authData.session) {
      clearAdminSession();
      mostrarVentana('admin-login');
      return;
    }

    // Ya tiene sesión válida
    const email = sessionStorage.getItem('admin_email');
    adminSession = { email, token: sessionToken };
    sesionActiva = true;
    
    document.getElementById('admin-email-display').textContent = email;
    mostrarPanelAdminSeguro(sessionToken);
    iniciarDetectorActividad();
    resetInactivityTimer();
    
    return;
  }
  
  // No tiene sesión, mostrar login
  mostrarVentana('admin-login');
  
  // Limpiar campos
  document.getElementById('admin-email').value = '';
  document.getElementById('admin-password').value = '';
  document.getElementById('admin-error').textContent = '';
}
// ==================== FUNCIÓN PARA RECUPERAR PASSWORD ====================
async function recuperarPasswordAdmin() {
  const email = document.getElementById('admin-email')?.value.trim() ||
    sessionStorage.getItem('admin_email');

  if (!email) {
    alert('Ingresa primero tu correo de administrador.');
    return;
  }
  
  if (!confirm(`¿Enviar enlace de recuperación a ${email}?`)) {
    return;
  }
  
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: new URL('admin.html', window.location.href).href,
    });
    
    if (error) throw error;
    
    alert('✅ Enlace de recuperación enviado a tu email');
    
  } catch (error) {
    console.error('Error recuperando password:', error);
    alert('❌ Error enviando enlace de recuperación');
  }
}

// ==================== AGREGAR BOTONES ADICIONALES ====================
function agregarBotonesAdicionalesAdmin() {
  const loginSection = document.getElementById('admin-login');
  if (!loginSection) return;
  
  if (!document.getElementById('botones-adicionales-admin')) {
    const botonesHTML = `
      <div id="botones-adicionales-admin" style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #eee;">
        <button onclick="forzarCerrarSesionRemota()" style="background: #ff6b6b; color: white; padding: 8px 12px; border: none; border-radius: 4px; margin-right: 10px;">
          🔓 Forzar cierre remoto
        </button>
        <button onclick="recuperarPasswordAdmin()" style="background: #6c5ce7; color: white; padding: 8px 12px; border: none; border-radius: 4px;">
          🔑 Recuperar contraseña
        </button>
      </div>
    `;
    
    loginSection.insertAdjacentHTML('beforeend', botonesHTML);
  }
}

let canalInscripciones = null;
let timerRecargaAdmin = null;
let cargandoPanelAdmin = false;

function programarRecargaAdmin() {
  clearTimeout(timerRecargaAdmin);

  timerRecargaAdmin = setTimeout(async () => {
    if (cargandoPanelAdmin) return;
    if (!sesionActiva) return;

    const panel = document.getElementById('admin-panel');
    if (!panel || panel.classList.contains('oculto')) return;

    cargandoPanelAdmin = true;

    try {
      console.log('🔄 Recargando panel admin con pausa...');
      await cargarPanelAdmin();
    } catch (error) {
      console.error('❌ Error recargando panel admin:', error);
    } finally {
      cargandoPanelAdmin = false;
    }
  }, 800);
}

function activarRefrescoAutomaticoAdmin() {
  if (canalInscripciones) return;

  canalInscripciones = supabase
    .channel('admin-inscripciones-realtime')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'inscripciones'
      },
      (payload) => {
        console.log('🔄 Cambio detectado en inscripciones:', payload);
        programarRecargaAdmin();
      }
    )
    .subscribe();
}
function iniciarContadorReserva(minutos = 5) {
  const div = document.getElementById('contadorReserva');

  let restante = minutos * 60;

  clearInterval(timerReserva);

  timerReserva = setInterval(() => {

    const min = Math.floor(restante / 60);
    const seg = restante % 60;

    div.innerHTML =
      `⏳ Reserva activa: ${min}:${seg.toString().padStart(2,'0')}`;

    if (restante <= 60) {
      div.style.background = 'rgba(239,71,111,.2)';
      div.style.borderColor = '#ef476f';
    }

    if (restante <= 0) {
      clearInterval(timerReserva);

      div.innerHTML =
        '⛔ Tiempo agotado. Los cartones fueron liberados.';

      liberarReservaPorTiempo();
    }

    restante--;

  }, 1000);
}
async function liberarReservaPorTiempo() {

  try {

    await supabase.rpc('rpc_liberar_todas_reservas', {
      _cedula: usuario.cedula,
      _reserva_token: obtenerTokenReserva(usuario.cedula)
    });

    usuario.cartones = [];
    borrarTokenReserva(usuario.cedula);

    alert(
      'Tu tiempo para enviar el comprobante expiró. Debes seleccionar nuevamente tus cartones.'
    );

    mostrarSeccion('cartones');

    await cargarCartones();

  } catch (err) {
    console.error(err);
  }
}
async function cargarTopCompradores() {
  const { data, error } = await supabase.rpc('rpc_top_compradores');

  const cont = document.getElementById('listaTopCompradores');
  cont.innerHTML = '';

  if (error) {
    console.error(error);
    cont.innerHTML = '<p>Error cargando top compradores.</p>';
    return;
  }

  const top = (data || []).map(item => ({
    nombre: item.nombre || 'Sin nombre',
    cedula: item.cedula_mascara || '',
    total: Number(item.total_cartones) || 0
  }));

  if (!top.length) {
    cont.innerHTML = '<p>No hay compradores todavía.</p>';
    return;
  }

  cont.innerHTML = `
    <ol class="top-compradores-lista">
      ${top.map((p, i) => `
        <li>
          <strong>#${i + 1} ${escapeHTML(p.nombre)}</strong><br>
          Cédula: ****${escapeHTML(String(p.cedula || '').slice(-4))}<br>
          Cartones comprados: <strong>${p.total}</strong>
        </li>
      `).join('')}
    </ol>
  `;
}

let canalTopCompradores = null;

function activarTopCompradoresRealtime() {
  if (canalTopCompradores) return;

  canalTopCompradores = setInterval(async () => {
    const seccion = document.getElementById('top-compradores');

    if (seccion && !seccion.classList.contains('oculto')) {
      await cargarTopCompradores();
    }
  }, 15000);
}

async function subirImagenPremiosInicio() {
  const input = document.getElementById('inputPremiosInicio');
  const estado = document.getElementById('estadoPremiosInicio');
  const archivoOriginal = input.files[0];

  if (!archivoOriginal) {
    alert('Selecciona una imagen');
    return;
  }

  try {
    estado.textContent = 'Convirtiendo imagen a WebP...';

    // Convierte JPG / PNG / WEBP a WebP optimizado
    const archivoWebP = await convertirImagenAWebP(archivoOriginal, 0.85, 1400);

    const idArchivo = crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const nombreArchivo = `premios-inicio-${Date.now()}-${idArchivo}.webp`;

    estado.textContent = 'Subiendo imagen...';

    const { error: uploadError } = await supabase.storage
      .from('imagenes')
      .upload(nombreArchivo, archivoWebP, {
        contentType: 'image/webp',
        cacheControl: '31536000',
        upsert: false
      });

    if (uploadError) {
      estado.textContent = 'Error subiendo imagen';
      console.error(uploadError);
      return;
    }

    // URL pública en WebP
    const { data: publicData } = supabase.storage
      .from('imagenes')
      .getPublicUrl(nombreArchivo);

    const url = publicData.publicUrl;

    estado.textContent = 'Guardando configuración...';

    const { error } = await supabase
      .from('configuracion')
      .upsert(
        [{ clave: 'imagen_premios_inicio', valore: url }],
        { onConflict: 'clave' }
      );

    if (error) {
      estado.textContent = 'Error guardando imagen';
      console.error(error);
      return;
    }

    configuracionPublicaCache = null;

    input.value = '';
    estado.textContent = '✅ Imagen guardada en WebP';

    await cargarImagenPremiosInicio();

  } catch (error) {
    console.error(error);
    estado.textContent = '❌ Error: ' + error.message;
  }
}

async function cargarImagenPremiosInicio() {
  const img = document.getElementById('imagenPremiosInicio');
  if (!img) return;

  const imagenUrl = await getConfigValue('imagen_premios_inicio', '');

  if (!imagenUrl) {
    img.classList.add('oculto');
    return;
  }

  img.src = imagenUrl;
  img.classList.remove('oculto');
}

window.subirImagenPremiosInicio = subirImagenPremiosInicio;

async function eliminarImagenPremiosInicio() {
  if (!confirm('¿Eliminar la imagen de premios?')) return;

  try {
    const { data } = await supabase
      .from('configuracion')
      .select('valore')
      .eq('clave', 'imagen_premios_inicio')
      .single();

    if (data?.valore) {
      const nombreArchivo = data.valore.split('/').pop();

      await supabase.storage
        .from('imagenes')
        .remove([nombreArchivo]);
    }

    await supabase
      .from('configuracion')
      .update({ valore: null })
      .eq('clave', 'imagen_premios_inicio');

    configuracionPublicaCache = null;

    const img = document.getElementById('imagenPremiosInicio');

    if (img) {
      img.src = '';
      img.classList.add('oculto');
    }

    alert('Imagen eliminada correctamente');

  } catch (err) {
    console.error(err);
    alert('Error eliminando imagen');
  }
}

window.eliminarImagenPremiosInicio = eliminarImagenPremiosInicio;

async function cargarBarraProgresoInicio() {
  const contenedor = document.getElementById('barraProgresoInicio');
  const texto = document.getElementById('textoProgresoCartones');
  const relleno = document.getElementById('rellenoProgresoCartones');

  if (!contenedor || !texto || !relleno) return;

  const mostrar = await getConfigValue('mostrar_barra_progreso', 'false');

  if (mostrar !== 'true') {
    contenedor.classList.add('oculto');
    return;
  }

  await obtenerTotalCartones();

  const vendidos = await contarCartonesVendidos();
  const disponibles = Math.max(totalCartones - vendidos, 0);
  const porcentaje = totalCartones > 0
    ? Math.round((disponibles / totalCartones) * 100)
    : 0;

  texto.textContent = `${porcentaje}% disponibles · ${disponibles} de ${totalCartones} cartones`;

  relleno.style.width = `${porcentaje}%`;
  contenedor.classList.remove('oculto');
}

async function guardarConfigBarraProgreso() {
  const check = document.getElementById('toggleBarraProgreso');
  if (!check) return;

  const valor = check.checked ? 'true' : 'false';

  const ok = await setConfigValue('mostrar_barra_progreso', valor);

  if (ok) {
    alert('Configuración guardada');
    await cargarBarraProgresoInicio();
  } else {
    alert('Error guardando configuración');
  }
}

async function cargarConfigBarraProgresoAdmin() {
  const check = document.getElementById('toggleBarraProgreso');
  if (!check) return;

  const valor = await getConfigValue('mostrar_barra_progreso', 'false');
  check.checked = valor === 'true';
}
let canalProgresoCartones = null;

function activarProgresoCartonesRealtime() {
  if (canalProgresoCartones) return;

  canalProgresoCartones = setInterval(async () => {
    await cargarConfiguracionPublica(true);
    await cargarBarraProgresoInicio();
  }, 15000);
}
// Función para seleccionar cartones aleatorios
let seleccionAleatoriaEnProceso = false;
async function seleccionarAleatorioSeguro() {
if (seleccionAleatoriaEnProceso) return;

  seleccionAleatoriaEnProceso = true;

  try {

  const faltan = cantidadPermitida - usuario.cartones.length;

  if (faltan <= 0) {
    alert('Ya seleccionaste todos los cartones permitidos.');
    return;
  }

  const { data, error } = await supabase.rpc('rpc_reservar_cartones_aleatorios', {
    _cantidad: faltan,
    _cedula: String(usuario.cedula || '').trim(),
    _reserva_token: obtenerTokenReserva(usuario.cedula),
    _partida_id: null
  });

  if (error) {
    console.error(error);
    alert('Error eligiendo cartones aleatorios.');
    return;
  }

  const resultado = Array.isArray(data) ? data[0] : data;

  if (!resultado?.exito) {
    alert(resultado?.mensaje || 'No se pudieron reservar cartones.');
    await cargarCartones();
    return;
  }

  usuario.cartones = [...new Set([...usuario.cartones.map(Number), ...resultado.cartones.map(Number)])];

  await cargarCartones();

  usuario.cartones.forEach(num => {
    const carton = [...document.querySelectorAll('.carton')]
      .find(c => parseInt(c.textContent) === num);

    if (carton) {
      carton.classList.remove('ocupado');
      carton.classList.add('seleccionado');
      carton.onclick = () => toggleCarton(num, carton);
    }
  });
  if (usuario.cartones.length >= cantidadPermitida) {
  document.querySelectorAll('.carton').forEach(c => {
    const n = parseInt(c.textContent);
    const yaSeleccionado = usuario.cartones.includes(n);
    const yaOcupado = cartonesOcupados.includes(n);

    if (!yaSeleccionado && !yaOcupado) {
      c.classList.add('bloqueado');

    } else if (yaSeleccionado) {
      // Si está seleccionado, asegurarse que el onclick siga llamando toggleCarton
      c.onclick = () => toggleCarton(n, c);
    }
  });
}

  actualizarContadorCartones(totalCartones, cartonesOcupados.length, usuario.cartones.length);
  actualizarMonto();

  alert(`Cartones seleccionados: ${resultado.cartones.join(', ')}`);

 } finally {
    seleccionAleatoriaEnProceso = false;
  }
}

window.seleccionarAleatorioSeguro = seleccionarAleatorioSeguro;



function guardarDatosClienteLocal() {
  localStorage.setItem('cliente_nombre', usuario.nombre || '');
  localStorage.setItem('cliente_telefono', usuario.telefono || '');
  localStorage.setItem('cliente_cedula', usuario.cedula || '');
  localStorage.setItem('cliente_referido', usuario.referido || '');
}

function cargarDatosClienteLocal() {
  const nombre = localStorage.getItem('cliente_nombre') || '';
  const telefono = localStorage.getItem('cliente_telefono') || '';
  const cedula = localStorage.getItem('cliente_cedula') || '';
  const referido = normalizarCedulaReferidos(
    localStorage.getItem('cliente_referido') || ''
  );

  if (document.getElementById('nombre')) document.getElementById('nombre').value = nombre;
  if (document.getElementById('telefono')) document.getElementById('telefono').value = telefono;
  if (document.getElementById('cedula')) document.getElementById('cedula').value = cedula;

  const inputReferido = document.getElementById('referido');
  if (inputReferido && referido) {
    inputReferido.value = referido;
  }
}

function copiarDatoPago(id) {
  const texto = document.getElementById(id).textContent.trim();

  navigator.clipboard.writeText(texto)
    .then(() => mostrarToastPago('✅ Copiado'))
    .catch(() => alert('No se pudo copiar'));
}

function mostrarToastPago(mensaje) {
  const toast = document.createElement('div');
  toast.className = 'toast-pago';
  toast.textContent = mensaje;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 1800);
}

function cargarDatosPagoCliente() {
  const datos = JSON.parse(localStorage.getItem('pago_movil_cliente') || '{}');

  const banco = document.getElementById('pago_banco');
  const telefono = document.getElementById('pago_telefono');
  const cedula = document.getElementById('pago_cedula');

  if (!banco || !telefono || !cedula) return;

  banco.value = datos.banco || '';
  telefono.value = datos.telefono || '';
  cedula.value = datos.cedula || '';

  [banco, telefono, cedula].forEach(input => {
    input.addEventListener('input', guardarDatosPagoClienteAutomatico);
  });
}

function guardarDatosPagoClienteAutomatico() {
  const datos = {
    banco: document.getElementById('pago_banco').value.trim(),
    telefono: document.getElementById('pago_telefono').value.trim(),
    cedula: document.getElementById('pago_cedula').value.trim()
  };

  localStorage.setItem('pago_movil_cliente', JSON.stringify(datos));
}

document.addEventListener('DOMContentLoaded', cargarDatosPagoCliente);


function copiarPagoMovil(banco, telefono, cedula) {
  const texto =
`Banco: ${banco}
Teléfono: ${telefono}
Cédula: ${cedula}`;

  navigator.clipboard.writeText(texto)
    .then(() => alert('✅ Datos copiados'))
    .catch(() => alert('❌ Error al copiar'));
}

function copiarTodoPagoMovil() {
    const banco = document.getElementById('adminPagoBanco')?.textContent || '';
  const telefono = document.getElementById('adminPagoTelefono')?.textContent || '';
  const cedula = document.getElementById('adminPagoCedula')?.textContent || '';
  const monto = document.getElementById('monto-pago')?.textContent || '';

  const texto = ` ${banco}
 ${telefono}
 ${cedula}
 ${monto} `;

  navigator.clipboard.writeText(texto)
    .then(() => alert('✅ Todos los datos de pago copiados al portapapeles'))
    .catch(() => alert('❌ Error al copiar'));
}


async function copiarListaAprobados() {
  const filas = document.querySelectorAll('#contenedor-aprobados tbody tr');

  let texto = 'LISTA DE APROBADOS\n\n';

  filas.forEach(fila => {
    const celdas = fila.querySelectorAll('td');

    if (celdas.length >= 3) {
      texto += `${celdas[0].innerText} | ${celdas[1].innerText} | ${celdas[2].innerText}\n`;
    }
  });

  try {
    await navigator.clipboard.writeText(texto);
    alert('✅ Lista copiada');
  } catch {
    const area = document.createElement('textarea');
    area.value = texto;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
    alert('✅ Lista copiada');
  }
}
// ─── NAEGACIÓN POR PESTAÑAS DEL ADMIN ───
function cambiarTab(tabId, evento = window.event) {
  // Ocultar todos los contenidos
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.remove('active');
  });
  
  // Desactivar todos los botones
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  
  // Activar el seccionado
  document.getElementById(tabId).classList.add('active');
  evento?.target?.classList.add('active');
}

// ================== EXPORTAR FUNCIONES ====================
window.mostrarVentana = mostrarVentana;
window.guardarDatosInscripcion = guardarDatosInscripcion;
window.confirmarCantidad = confirmarCantidad;
window.enviarComprobante = enviarComprobante;
window.consultarCartones = consultarCartones;
window.elegirMasCartones = elegirMasCartones;
window.entrarAdmin = entrarAdmin;
window.loginAdmin = loginAdmin;
window.toggleCarton = toggleCarton;
window.abrirModalCarton = abrirModalCarton;
window.cerrarModalCarton = cerrarModalCarton;
window.seleccionarPromocion = seleccionarPromocion;
window.deseleccionarPromocion = deseleccionarPromocion;
window.cerrarTerminos = cerrarTerminos;
window.toggleFormularioGanador = toggleFormularioGanador;
window.guardarGanador = guardarGanador;
window.ordenarInscripcionesPorNombre = ordenarInscripcionesPorNombre;
window.ordenarPorCedula = ordenarPorCedula;
window.ordenarPorReferencia = ordenarPorReferencia;
window.activarCohetes = activarCohetes;
window.mostrarSeccion = mostrarSeccion;
window.forzarCerrarSesionRemota = forzarCerrarSesionRemota;
window.recuperarPasswordAdmin = recuperarPasswordAdmin;

console.log('✅ Sistema de sesión única configurado correctamente');
