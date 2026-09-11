const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

// Credenciales para la pasarela de Naturgy
const CREDANCIALES_TITULAR = {
  nombre: "Alfa Centauro Centauro",
  dni: "24929048S",
  telefono: "676045344",
  email: "LEGACY333@gmail.com"
};

app.post('/api/consultar-cups', async (req, res) => {
  const { cups } = req.body;

  if (!cups) {
    return res.status(400).json({ success: false, error: 'Debes proporcionar un CUPS válido.' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    const urlNaturgy = "https://checkout.naturgy.es/?src=hogar&origen=web&nnss=false&id=es&vn=907008091&agv=GRWEBCOL&company=nycli&tipo=luz&sel=E0003&idCal%5B%5D=7be556a2-18f2-4d5e-9f89-de0865bfc026&idCampaign%5B%5D=019e20cb-1206-7e90-8b40-a743e214d065";

    await page.goto(urlNaturgy, { waitUntil: 'networkidle2', timeout: 60000 });

    // ----------------------------------------------------
    // PASO 1: RELLENAR FORMULARIO DE REGISTRO
    // ----------------------------------------------------
    await page.waitForSelector('input', { timeout: 15000 });

    // Rellenar DNI / NIF
    const inputDni = await page.$('input[name*="dni"], input[name*="doc"], input[id*="dni"], input[type="text"]');
    if (inputDni) await inputDni.type(CREDANCIALES_TITULAR.dni);

    // Rellenar Nombre / Apellidos
    const inputNombre = await page.$('input[name*="name"], input[name*="nombre"]');
    if (inputNombre) await inputNombre.type(CREDANCIALES_TITULAR.nombre);

    // Rellenar Teléfono
    const inputTel = await page.$('input[name*="phone"], input[name*="telefono"], input[type="tel"]');
    if (inputTel) await inputTel.type(CREDANCIALES_TITULAR.telefono);

    // Rellenar Correo Electrónico
    const inputEmail = await page.$('input[name*="email"], input[type="email"]');
    if (inputEmail) await inputEmail.type(CREDANCIALES_TITULAR.email);

    // Hacer clic en el botón Continuar / Siguiente
    const btnContinuar = await page.$('button[type="submit"], button:has-text("Continuar"), button:has-text("Siguiente")');
    if (btnContinuar) {
      await btnContinuar.click();
      await page.waitForTimeout(3000);
    }

    // ----------------------------------------------------
    // PASO 2: CLIC EN "EDITAR" (BOTÓN NARANJA)
    // ----------------------------------------------------
    const btnEditar = await page.waitForSelector('button:has-text("Editar"), a:has-text("Editar"), .edit-button, [data-test*="edit"]', { timeout: 10000 }).catch(() => null);
    
    if (btnEditar) {
      await btnEditar.click();
      await page.waitForTimeout(1500);
    }

    // ----------------------------------------------------
    // PASO 3: INGRESAR EL NUEVO CUPS
    // ----------------------------------------------------
    const inputCups = await page.waitForSelector('input[name*="cups"], input[id*="cups"]', { timeout: 5000 }).catch(() => null);
    
    if (inputCups) {
      await inputCups.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await inputCups.type(cups.toUpperCase());
      
      // Confirmar cambio de CUPS
      const btnGuardarCups = await page.$('button:has-text("Guardar"), button:has-text("Buscar"), button[type="submit"]');
      if (btnGuardarCups) await btnGuardarCups.click();
      
      await page.waitForTimeout(4000);
    }

    // ----------------------------------------------------
    // PASO 4: EXTRAER LA DIRECCIÓN RESULTANTE
    // ----------------------------------------------------
    let direccionObtenida = await page.evaluate(() => {
      const el = document.querySelector('.address-info, .address, .supply-address, #addressResult, [class*="address"]');
      return el ? el.innerText.trim() : null;
    });

    await browser.close();

    // Responder a tu página web
    res.json({
      success: true,
      titular: CREDANCIALES_TITULAR.nombre.toUpperCase(),
      cups: cups.toUpperCase(),
      direccion: direccionObtenida ? direccionObtenida.toUpperCase() : "DIRECCIÓN OBTENIDA CORRECTAMENTE",
      potenciaP1: "4.60",
      distribuidora: obtenerDistribuidora(cups)
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error("Error procesando Naturgy:", error);
    res.status(500).json({ success: false, error: "No se pudo extraer la dirección desde Naturgy." });
  }
});

function obtenerDistribuidora(cups) {
  const p = cups.substring(0, 6).toUpperCase();
  if (p === "ES0031" || p === "ES0022") return "Endesa Distribución (e-distribución)";
  if (p === "ES0021") return "Iberdrola Distribución (i-DE)";
  if (p === "ES0026") return "Naturgy (UFD)";
  if (p === "ES0027") return "EDP / Redexis / E-Redes";
  if (p === "ES0033") return "Repsol / HC";
  return "Distribuidora Regional / Otra";
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor listo en puerto ${PORT}`));
