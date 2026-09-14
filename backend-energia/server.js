// server.js
// ============================================================================
// Servidor Express + Puppeteer (stealth) para consulta de CUPS
// - Naturgy: checkout + bono social + dirección
// - Pepeenergy: calculadora de potencia y consumo
// ============================================================================

const express = require('express');
const cors = require('cors');

// Puppeteer con stealth para evadir detección de bots
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middlewares
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Datos fijos del titular
// ---------------------------------------------------------------------------
const TITULAR = {
  nombre: 'Alfa Centauro Centauro',
  dni: '24929048S',
  telefono: '676045344',
  email: 'LEGACY333@gmail.com',
};

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------
const NATURGY_URL =
  'https://checkout.naturgy.es/?src=hogar&origen=web&nnss=false&id=es&vn=907008091&agv=GRWEBCOL&company=nycli&tipo=luz&sel=E0003&idCal%5B%5D=7be556a2-18f2-4d5e-9f89-de0865bfc026&idCampaign%5B%5D=019e20cb-1206-7e90-8b40-a743e214d065';

const PEPEENERGY_URL = 'https://www.pepeenergy.com/calculadora-luz';

// ---------------------------------------------------------------------------
// Helpers genéricos
// ---------------------------------------------------------------------------

/**
 * Pausa asíncrona.
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pausa aleatoria (para simular comportamiento humano).
 */
function randomDelay(min = 800, max = 2000) {
  return delay(min + Math.random() * (max - min));
}

/**
 * Normaliza el CUPS recibido del frontend para asegurarnos de que tenga
 * el formato correcto que esperan Naturgy y Pepeenergy.
 *
 * Reglas:
 *  - Sin espacios ni guiones, en mayúsculas.
 *  - Debe empezar por "ES".
 *  - Si tiene 20 caracteres, añadir sufijo "1P" (Unión Fenosa, 0022) o "0F" (resto).
 *  - Longitud final esperada: 22 (o hasta 24 en casos raros).
 */
function normalizarCUPS(cupsRaw) {
  if (!cupsRaw || typeof cupsRaw !== 'string') {
    throw new Error('CUPS vacío o inválido.');
  }

  // Limpieza
  let cups = cupsRaw.replace(/[\s\-]/g, '').toUpperCase();

  // Asegurar prefijo ES
  if (!cups.startsWith('ES')) {
    cups = 'ES' + cups;
  }

  // Si tiene 20 caracteres, añadir sufijo según distribuidora
  if (cups.length === 20) {
    // El código de distribuidora está en la posición 4-8 (ES + país + distribuidora)
    const codDistribuidora = cups.substring(4, 8);
    cups += codDistribuidora === '0022' ? '1P' : '0F';
  }

  // Validación final
  if (cups.length < 22 || cups.length > 24) {
    throw new Error(
      `El CUPS "${cupsRaw}" no tiene un formato válido (debe tener 20 o 22 caracteres útiles).`
    );
  }

  return cups;
}

/**
 * Espera a que un selector aparezca y sea visible.
 */
async function waitVisible(context, selector, timeout = 20000) {
  return context.waitForSelector(selector, { visible: true, timeout });
}

/**
 * Simula escritura humana: clic, borrar y escribir con retardo.
 */
async function typeHuman(context, selector, text) {
  const el = await context.waitForSelector(selector, { visible: true, timeout: 15000 });
  await el.click({ clickCount: 3 });
  await context.keyboard.press('Backspace');
  await randomDelay(200, 500);
  await el.type(text, { delay: 60 + Math.random() * 60 });
}

/**
 * Realiza un clic simulando movimiento de ratón humano.
 */
async function clickHuman(context, selector) {
  const el = await context.waitForSelector(selector, { visible: true, timeout: 15000 });
  const box = await el.boundingBox();
  if (box && context.mouse) {
    await context.mouse.move(
      box.x + box.width * (0.3 + Math.random() * 0.4),
      box.y + box.height * (0.3 + Math.random() * 0.4),
      { steps: 10 }
    );
    await randomDelay(200, 500);
  }
  await el.click();
  await randomDelay(400, 900);
}

/**
 * Busca un selector primero en la página principal y luego en todos los iframes.
 * Devuelve el contexto donde se encontró.
 */
async function findInFrames(page, selector, timeout = 20000) {
  const start = Date.now();

  // 1. Página principal
  try {
    const element = await page.waitForSelector(selector, { visible: true, timeout: 4000 });
    if (element) return { context: page, element };
  } catch (_) {
    /* seguir buscando */
  }

  // 2. Todos los frames
  const frames = page.frames();
  for (const frame of frames) {
    if (Date.now() - start > timeout) break;
    try {
      const element = await frame.waitForSelector(selector, { visible: true, timeout: 4000 });
      if (element) return { context: frame, element };
    } catch (_) {
      /* siguiente frame */
    }
  }

  throw new Error(`No se encontró el selector "${selector}" en ningún frame.`);
}

/**
 * Intenta extraer mensajes de error visibles en la página.
 */
async function extraerMensajeError(page) {
  try {
    return await page.evaluate(() => {
      const posibles = Array.from(
        document.querySelectorAll('div, p, span, [role="alert"], [class*="error"], [class*="Error"]')
      ).filter((el) => {
        const txt = (el.innerText || '').trim();
        return (
          txt.length > 5 &&
          txt.length < 300 &&
          /error|fallo|no se ha podido|no encontrado|inválido|no válido|no disponible/i.test(txt)
        );
      });
      return posibles.map((el) => el.innerText.trim()).join(' | ') || null;
    });
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scraping Naturgy
// ---------------------------------------------------------------------------

/**
 * Ejecuta el flujo completo en la pasarela de Naturgy.
 * @param {import('puppeteer').Page} page
 * @param {string} cupsNormalizado
 * @returns {Promise<{direccion:string, distribuidora:string}>}
 */
async function scrapeNaturgy(page, cupsNormalizado) {
  // Capturamos errores de consola para depuración
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[Naturgy console]', msg.text());
  });
  page.on('pageerror', (err) => console.log('[Naturgy pageerror]', err.message));

  // 1. Navegar
  console.log('[Naturgy] Navegando...');
  await page.goto(NATURGY_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await randomDelay(1500, 3000);

  // 2. Rellenar datos del titular si aparece el formulario inicial
  try {
    const dniSelector =
      'input[name="dni"], input[id*="dni" i], input[placeholder*="DNI" i], input[placeholder*="NIF" i]';
    await waitVisible(page, dniSelector, 8000);

    console.log('[Naturgy] Rellenando formulario del titular...');
    await typeHuman(page, dniSelector, TITULAR.dni);

    const nombreSelector =
      'input[name="nombre"], input[id*="nombre" i], input[placeholder*="Nombre" i]';
    await typeHuman(page, nombreSelector, TITULAR.nombre);

    const telSelector =
      'input[type="tel"], input[name*="telefono" i], input[placeholder*="Teléfono" i]';
    await typeHuman(page, telSelector, TITULAR.telefono);

    const emailSelector =
      'input[type="email"], input[name*="email" i], input[placeholder*="Correo" i]';
    await typeHuman(page, emailSelector, TITULAR.email);

    // Botón continuar / siguiente
    const submitSelector =
      'button[type="submit"], button[data-testid*="continue"], button';
    await clickHuman(page, submitSelector);

    // Espera a que la SPA avance
    await page
      .waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
      .catch(() => {});
    await randomDelay(2000, 4000);
  } catch (_) {
    console.log('[Naturgy] No se encontró formulario inicial, continuamos.');
  }

  // 3. Verificación de bono social (si aparece)
  try {
    const bonoSelectors = [
      'input[type="checkbox"][id*="bono" i]',
      'label:has-text("bono social")',
      'button:has-text("Consultar bono")',
      'button:has-text("Bono social")',
    ].join(', ');

    const { context: bonoCtx, element: bonoEl } = await findInFrames(page, bonoSelectors, 8000);
    console.log('[Naturgy] Interactuando con bono social...');
    await bonoEl.click();
    await randomDelay(1500, 2500);

    // Esperar a que la consulta termine (puede tardar)
    await Promise.race([
      bonoCtx.waitForFunction(
        () =>
          document.body.innerText.includes('derecho') ||
          document.body.innerText.includes('no cumple') ||
          document.body.innerText.includes('no tiene') ||
          document.body.innerText.includes('bono social'),
        { timeout: 20000 }
      ),
      delay(20000),
    ]);
  } catch (_) {
    console.log('[Naturgy] No se encontró el bloque de bono social o ya estaba resuelto.');
  }

  // Comprobar si hay mensaje de error en este punto
  const errorBono = await extraerMensajeError(page);
  if (errorBono && /bono|social/i.test(errorBono)) {
    console.log('[Naturgy] Error de bono social:', errorBono);
  }

  // 4. Botón naranja "Editar" para cambiar el CUPS
  try {
    const editSelectors = [
      'button:has-text("Editar")',
      'a:has-text("Editar")',
      '[class*="edit" i]:has-text("Editar")',
      'button[aria-label*="editar" i]',
    ].join(', ');

    const { element: editBtn } = await findInFrames(page, editSelectors, 15000);
    console.log('[Naturgy] Pulsando "Editar"...');
    await editBtn.click();
    await randomDelay(1500, 2500);
  } catch (e) {
    console.log('[Naturgy] No se encontró botón Editar, puede que ya esté abierto.');
  }

  // 5. Escribir el CUPS nuevo
  const cupsSelector =
    'input[name*="cups" i], input[id*="cups" i], input[placeholder*="CUPS" i]';

  // Localizamos contexto y elemento
  const { context: cupsCtx } = await findInFrames(page, cupsSelector, 15000);

  // Limpiar el campo
  const cupsInput = await cupsCtx.waitForSelector(cupsSelector, { visible: true, timeout: 10000 });
  await cupsInput.click({ clickCount: 3 });
  await cupsCtx.keyboard.press('Backspace');
  await randomDelay(300, 600);

  // Escribir CUPS con escritura humana
  await cupsInput.type(cupsNormalizado, { delay: 80 + Math.random() * 80 });
  await randomDelay(500, 900);

  // Confirmar (Enter + posible botón)
  await cupsInput.press('Enter');
  try {
    const confirmSelectors = [
      'button:has-text("Confirmar")',
      'button:has-text("Aceptar")',
      'button:has-text("Guardar")',
      'button[type="submit"]',
    ].join(', ');
    const { element: confirmBtn } = await findInFrames(page, confirmSelectors, 5000);
    await confirmBtn.click();
  } catch (_) {
    /* puede que con Enter sea suficiente */
  }

  // 6. Esperar a que la dirección aparezca
  console.log('[Naturgy] Esperando dirección...');
  await Promise.race([
    page.waitForFunction(
      () => {
        const el = document.querySelector(
          '[class*="address" i], [class*="direccion" i], [data-testid*="address" i], [data-testid*="direccion" i]'
        );
        if (el && el.innerText.trim().length > 15) return true;
        // Fallback: buscar texto que parezca dirección
        return Array.from(document.querySelectorAll('div, p, span')).some(
          (n) =>
            /calle|c\/|avenida|avda|plaza|pza|paseo|carretera/i.test(n.innerText || '') &&
            n.innerText.length < 250
        );
      },
      { timeout: 25000 }
    ),
    delay(25000),
  ]);

  // Extraer dirección
  const direccion = await page.evaluate(() => {
    // 1. Buscar contenedor específico
    const contenedor = document.querySelector(
      '[class*="address" i], [class*="direccion" i], [data-testid*="address" i], [data-testid*="direccion" i]'
    );
    if (contenedor && contenedor.innerText.trim().length > 10) {
      return contenedor.innerText.trim();
    }
    // 2. Fallback: cualquier bloque con pinta de dirección
    const posible = Array.from(document.querySelectorAll('div, p, span')).find(
      (el) =>
        /calle|c\/|avenida|avda|plaza|pza|paseo|carretera/i.test(el.innerText || '') &&
        el.innerText.length < 300
    );
    return posible ? posible.innerText.trim() : 'Dirección no encontrada';
  });

  // Extraer distribuidora (opcional)
  let distribuidora = 'No disponible';
  try {
    distribuidora = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('div, span, p')).find((e) =>
        /distribuidora|e-distribución|i-de|UFD|Viesgo|Unión Fenosa|Endesa|Iberdrola/i.test(
          e.innerText || ''
        )
      );
      return el ? el.innerText.trim() : 'No disponible';
    });
  } catch (_) {
    /* ignorar */
  }

  // Comprobar errores finales
  const errorFinal = await extraerMensajeError(page);
  if (errorFinal && direccion === 'Dirección no encontrada') {
    throw new Error(`Naturgy no devolvió la dirección. Mensaje: ${errorFinal}`);
  }

  return { direccion, distribuidora };
}

// ---------------------------------------------------------------------------
// Scraping Pepeenergy
// ---------------------------------------------------------------------------

/**
 * Ejecuta la calculadora de Pepeenergy para obtener potencia y consumo.
 */
async function scrapePepeenergy(page, cupsNormalizado) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[Pepe console]', msg.text());
  });
  page.on('pageerror', (err) => console.log('[Pepe pageerror]', err.message));

  console.log('[Pepeenergy] Navegando...');
  await page.goto(PEPEENERGY_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await randomDelay(1500, 3000);

  // Aceptar cookies si aparece el banner
  try {
    const cookieSelectors = [
      'button:has-text("Aceptar")',
      'button:has-text("Aceptar todas")',
      'button[id*="cookie" i]',
      'button[class*="cookie" i]',
    ].join(', ');
    const btn = await page.$(cookieSelectors);
    if (btn) {
      await btn.click();
      await randomDelay(800, 1500);
    }
  } catch (_) {
    /* sin banner */
  }

  // Campo CUPS
  const cupsSelector =
    'input[name*="cups" i], input[id*="cups" i], input[placeholder*="CUPS" i]';
  const { context: cupsCtx } = await findInFrames(page, cupsSelector, 20000);

  console.log('[Pepeenergy] Escribiendo CUPS...');
  const cupsInput = await cupsCtx.waitForSelector(cupsSelector, { visible: true, timeout: 10000 });
  await cupsInput.click({ clickCount: 3 });
  await cupsCtx.keyboard.press('Backspace');
  await randomDelay(300, 600);
  await cupsInput.type(cupsNormalizado, { delay: 80 + Math.random() * 60 });
  await randomDelay(500, 900);

  // Botón calcular / comprobar
  const calcSelector = [
    'button:has-text("Calcular")',
    'button:has-text("Comprobar")',
    'button:has-text("Consultar")',
    'button[type="submit"]',
  ].join(', ');

  try {
    const { element: calcBtn } = await findInFrames(page, calcSelector, 10000);
    await calcBtn.click();
  } catch (_) {
    await cupsInput.press('Enter');
  }

  // Esperar resultados
  console.log('[Pepeenergy] Esperando resultados...');
  await Promise.race([
    page.waitForFunction(
      () => {
        const txt = document.body.innerText;
        return /kW/i.test(txt) && /kWh/i.test(txt);
      },
      { timeout: 25000 }
    ),
    delay(25000),
  ]);

  await randomDelay(1500, 2500);

  // Extraer potencia
  const potencia = await page.evaluate(() => {
    const candidatos = Array.from(document.querySelectorAll('div, span, p, td, li'));
    // Buscar primero un contenedor con "Potencia"
    const pot = candidatos.find((el) => /potencia/i.test(el.innerText || '') && /kW/i.test(el.innerText || ''));
    if (pot) {
      const m = pot.innerText.match(/([\d.,]+)\s*kW/i);
      if (m) return m[1].replace(',', '.');
    }
    // Fallback: cualquier número seguido de kW
    const m = document.body.innerText.match(/([\d.,]+)\s*kW/i);
    return m ? m[1].replace(',', '.') : 'No disponible';
  });

  // Extraer consumo
  const consumo = await page.evaluate(() => {
    const candidatos = Array.from(document.querySelectorAll('div, span, p, td, li'));
    const cons = candidatos.find(
      (el) => /consumo/i.test(el.innerText || '') && /kWh/i.test(el.innerText || '')
    );
    if (cons) {
      const m = cons.innerText.match(/([\d.,]+)\s*kWh/i);
      if (m) return m[1].replace(',', '.');
    }
    const m = document.body.innerText.match(/([\d.,]+)\s*kWh/i);
    return m ? m[1].replace(',', '.') : 'No disponible';
  });

  return { potenciaP1: potencia, consumoAnual: consumo };
}

// ---------------------------------------------------------------------------
// Endpoint principal
// ---------------------------------------------------------------------------

app.post('/api/consultar-cups', async (req, res) => {
  const { cups } = req.body;

  // Validación básica
  if (!cups || typeof cups !== 'string') {
    return res.status(400).json({ success: false, error: 'CUPS no proporcionado.' });
  }

  // Normalización
  let cupsNormalizado;
  try {
    cupsNormalizado = normalizarCUPS(cups);
    console.log('CUPS normalizado:', cupsNormalizado);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1366,768',
      ],
      defaultViewport: { width: 1366, height: 768 },
    });

    // ---------- FASE 1: NATURGY ----------
    const pageNaturgy = await browser.newPage();
    await pageNaturgy.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await pageNaturgy.setExtraHTTPHeaders({
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    });

    let naturgyResult = { direccion: 'No disponible', distribuidora: 'No disponible' };
    let naturgyError = null;

    try {
      naturgyResult = await scrapeNaturgy(pageNaturgy, cupsNormalizado);
    } catch (err) {
      naturgyError = err.message;
      console.error('[Naturgy] Error:', err.message);
    }

    // ---------- FASE 2: PEPEENERGY ----------
    const pagePepe = await browser.newPage();
    await pagePepe.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await pagePepe.setExtraHTTPHeaders({
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    });

    let pepeResult = { potenciaP1: 'No disponible', consumoAnual: 'No disponible' };
    let pepeError = null;

    try {
      pepeResult = await scrapePepeenergy(pagePepe, cupsNormalizado);
    } catch (err) {
      pepeError = err.message;
      console.error('[Pepeenergy] Error:', err.message);
    }

    // ---------- RESPUESTA ----------
    const hayExito = !naturgyError || !pepeError;

    return res.json({
      success: hayExito,
      titular: TITULAR.nombre.toUpperCase(),
      cups: cupsNormalizado,
      direccion: naturgyResult.direccion,
      potenciaP1: pepeResult.potenciaP1,
      consumoAnual: pepeResult.consumoAnual,
      distribuidora: naturgyResult.distribuidora,
      // Errores específicos por si el frontend quiere mostrarlos
      errores: {
        naturgy: naturgyError,
        pepeenergy: pepeError,
      },
    });
  } catch (error) {
    console.error('Error global:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al consultar los datos. Inténtalo de nuevo más tarde.',
      detalle: error.message,
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {
        /* ignorar */
      }
    }
  }
});

// Health check útil para Render
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'consultar-cups' });
});

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
