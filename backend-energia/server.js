// server.js
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// Configuración de datos del titular (según tu especificación)
const TITULAR = {
  nombre: 'Alfa Centauro Centauro',
  dni: '24929048S',
  telefono: '676045344',
  email: 'LEGACY333@gmail.com',
};

// URL de la pasarela de Naturgy (tu enlace exacto)
const NATURGY_URL = 'https://checkout.naturgy.es/?src=hogar&origen=web&nnss=false&id=es&vn=907008091&agv=GRWEBCOL&company=nycli&tipo=luz&sel=E0003&idCal%5B%5D=7be556a2-18f2-4d5e-9f89-de0865bfc026&idCampaign%5B%5D=019e20cb-1206-7e90-8b40-a743e214d065';

// URL de la calculadora de Pepeenergy
const PEPEENERGY_URL = 'https://www.pepeenergy.com/calculadora-luz';

// ---------------------------------------------------------------------------
// Helpers de scraping
// ---------------------------------------------------------------------------

/**
 * Espera a que un selector aparezca y sea visible.
 * @param {Page|Frame} context - page o frame de Puppeteer.
 * @param {string} selector - Selector CSS.
 * @param {number} timeout - Tiempo máximo de espera en ms.
 */
async function waitVisible(context, selector, timeout = 20000) {
  await context.waitForSelector(selector, { visible: true, timeout });
}

/**
 * Simula escritura humana: hace clic en el campo, limpia y escribe carácter por carácter.
 * @param {Page|Frame} context
 * @param {string} selector
 * @param {string} text
 */
async function typeHuman(context, selector, text) {
  await context.click(selector, { clickCount: 3 }); // selecciona todo
  await context.keyboard.press('Backspace');        // borra
  await context.type(selector, text, { delay: 50 }); // escribe con retardo
}

/**
 * Busca el selector en la página principal y en todos los iframes.
 * @param {Page} page
 * @param {string} selector
 * @param {number} timeout
 * @returns {Promise<{context: Page|Frame, element: ElementHandle}>}
 */
async function findInFrames(page, selector, timeout = 20000) {
  const start = Date.now();

  // 1. Intentar en la página principal
  try {
    const element = await page.waitForSelector(selector, { visible: true, timeout: 5000 });
    if (element) return { context: page, element };
  } catch (_) { /* continuar */ }

  // 2. Buscar en todos los frames
  const frames = page.frames();
  for (const frame of frames) {
    if (Date.now() - start > timeout) break;
    try {
      const element = await frame.waitForSelector(selector, { visible: true, timeout: 5000 });
      if (element) return { context: frame, element };
    } catch (_) { /* continuar con el siguiente frame */ }
  }

  throw new Error(`No se encontró el selector "${selector}" en ningún frame.`);
}

/**
 * Extrae el texto de un elemento (útil para dirección, potencia, consumo).
 * @param {Page|Frame} context
 * @param {string} selector
 * @returns {Promise<string>}
 */
async function getText(context, selector) {
  const el = await context.waitForSelector(selector, { visible: true, timeout: 10000 });
  return (await el.evaluate(node => node.innerText.trim()));
}

// ---------------------------------------------------------------------------
// Scraping Naturgy
// ---------------------------------------------------------------------------

/**
 * Realiza todo el flujo en la pasarela de Naturgy.
 * @param {string} cups - Código CUPS introducido por el usuario.
 * @returns {Promise<{direccion: string, distribuidora?: string}>}
 */
async function scrapeNaturgy(page, cups) {
  // 1. Navegar a la pasarela
  await page.goto(NATURGY_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // 2. Rellenar datos del titular si aparece el formulario inicial
  //    Los selectores son orientativos; ajústalos si es necesario.
  try {
    await waitVisible(page, 'input[name="dni"], input[id*="dni"], input[placeholder*="DNI"]', 8000);
    // DNI
    await typeHuman(page, 'input[name="dni"], input[id*="dni"], input[placeholder*="DNI"]', TITULAR.dni);
    // Nombre
    await typeHuman(page, 'input[name="nombre"], input[id*="nombre"], input[placeholder*="Nombre"]', TITULAR.nombre);
    // Teléfono
    await typeHuman(page, 'input[name="telefono"], input[id*="telefono"], input[placeholder*="Teléfono"]', TITULAR.telefono);
    // Email
    await typeHuman(page, 'input[type="email"], input[name="email"], input[id*="email"]', TITULAR.email);
    // Botón de continuar (ajusta el selector)
    const submitBtn = await page.waitForSelector('button[type="submit"], button:has-text("Continuar"), button:has-text("Siguiente")', { visible: true });
    await submitBtn.click();
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  } catch (_) {
    // Si no hay formulario, continuamos (puede que ya estemos dentro con una oferta precargada)
  }

  // 3. Localizar el botón naranja de "Editar" para cambiar el CUPS.
  //    Buscamos en todos los frames por si estuviera en un iframe.
  const { context: editContext, element: editBtn } = await findInFrames(
    page,
    'button:has-text("Editar"), a:has-text("Editar"), [class*="edit"]:has-text("Editar")',
    20000
  );
  await editBtn.click();
  await new Promise(r => setTimeout(r, 2000)); // esperar a que se despliegue el campo

  // 4. Campo de CUPS: borrar el anterior y escribir el nuevo.
  //    El selector puede variar; usamos varios patrones.
  const cupsSelector = 'input[name*="cups" i], input[id*="cups" i], input[placeholder*="CUPS" i]';
  const { context: cupsContext, element: cupsInput } = await findInFrames(page, cupsSelector, 15000);
  await cupsInput.click({ clickCount: 3 });
  await cupsInput.press('Backspace');
  await cupsInput.type(cups, { delay: 80 });
  // Confirmar (puede ser un botón o Enter)
  await cupsInput.press('Enter');
  await new Promise(r => setTimeout(r, 5000)); // esperar a que se actualice la dirección

  // 5. Extraer la dirección postal completa.
  //    Buscamos cualquier elemento que contenga texto de dirección.
  const direccion = await page.evaluate(() => {
    // Intenta encontrar el bloque de dirección por palabras clave.
    const possible = Array.from(document.querySelectorAll('div, p, span'))
      .find(el => /calle|c\/|avenida|avda|plaza|pza|dirección|direccion/i.test(el.innerText) && el.innerText.length < 300);
    return possible ? possible.innerText.trim() : 'Dirección no encontrada';
  });

  // 6. (Opcional) Intentar extraer distribuidora.
  let distribuidora = 'No disponible';
  try {
    distribuidora = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('div, span, p'))
        .find(e => /distribuidora|comercializadora|e-distribución|i-de|UFD|Viesgo/i.test(e.innerText));
      return el ? el.innerText.trim() : 'No disponible';
    });
  } catch (_) {}

  return { direccion, distribuidora };
}

// ---------------------------------------------------------------------------
// Scraping Pepeenergy
// ---------------------------------------------------------------------------

/**
 * Extrae potencia y consumo de la calculadora de Pepeenergy.
 * @param {string} cups
 * @returns {Promise<{potenciaP1: string, consumoAnual: string}>}
 */
async function scrapePepeenergy(page, cups) {
  await page.goto(PEPEENERGY_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // 1. Localizar el campo de CUPS (puede estar en un iframe o directamente)
  const cupsSelector = 'input[name*="cups" i], input[id*="cups" i], input[placeholder*="CUPS" i]';
  const { context: cupsContext, element: cupsInput } = await findInFrames(page, cupsSelector, 20000);
  await cupsInput.click({ clickCount: 3 });
  await cupsInput.press('Backspace');
  await cupsInput.type(cups, { delay: 80 });

  // 2. Botón de calcular / comprobar
  const calcBtnSelector = 'button:has-text("Calcular"), button:has-text("Comprobar"), button[type="submit"]';
  const { element: calcBtn } = await findInFrames(page, calcBtnSelector, 15000);
  await calcBtn.click();

  // 3. Esperar a que aparezcan los resultados (potencia y consumo).
  //    Los selectores son orientativos; ajústalos según la web real.
  await new Promise(r => setTimeout(r, 8000)); // dar tiempo a que carguen los datos vía AJAX

  // 4. Extraer potencia y consumo.
  const potencia = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('div, span, p, td'))
      .find(e => /potencia/i.test(e.innerText) && /kW/i.test(e.innerText));
    return el ? el.innerText.replace(/[^\d.,]/g, '').trim() : 'No disponible';
  });

  const consumo = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('div, span, p, td'))
      .find(e => /consumo/i.test(e.innerText) && /kWh/i.test(e.innerText));
    return el ? el.innerText.replace(/[^\d.,]/g, '').trim() : 'No disponible';
  });

  return { potenciaP1: potencia, consumoAnual: consumo };
}

// ---------------------------------------------------------------------------
// Endpoint principal
// ---------------------------------------------------------------------------

app.post('/api/consultar-cups', async (req, res) => {
  const { cups } = req.body;
  if (!cups || typeof cups !== 'string') {
    return res.status(400).json({ success: false, error: 'CUPS no proporcionado o inválido.' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new', // modo headless moderno
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
      ],
      defaultViewport: { width: 1366, height: 768 },
    });

    // ------- FASE 1: NATURGY -------
    const pageNaturgy = await browser.newPage();
    await pageNaturgy.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    const { direccion, distribuidora } = await scrapeNaturgy(pageNaturgy, cups);

    // ------- FASE 2: PEPEENERGY -------
    const pagePepe = await browser.newPage();
    await pagePepe.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    const { potenciaP1, consumoAnual } = await scrapePepeenergy(pagePepe, cups);

    // ------- RESPUESTA -------
    res.json({
      success: true,
      titular: TITULAR.nombre.toUpperCase(),
      cups: cups,
      direccion: direccion,
      potenciaP1: potenciaP1,
      consumoAnual: consumoAnual,
      distribuidora: distribuidora,
    });
  } catch (error) {
    console.error('Error en scraping:', error);
    res.status(500).json({
      success: false,
      error: 'Error al consultar los datos. Inténtalo de nuevo más tarde.',
      detalle: error.message, // puedes omitirlo en producción
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ---------------------------------------------------------------------------
// Inicio del servidor
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
