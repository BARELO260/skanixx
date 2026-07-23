# Skanix — Escáner inteligente de documentos (PWA)

Aplicación web progresiva (PWA) que convierte tu cámara o galería en un
escáner de documentos: detecta y corrige la perspectiva de la página,
aplica filtros tipo "documento", y exporta a PDF, JPG o PNG. Funciona
sin conexión y es instalable en móvil y escritorio.

## ✨ Funcionalidades

- **Captura**: cámara en vivo (frontal/trasera) o subida de imágenes desde galería/archivos.
- **Recorte inteligente**: detección automática de bordes (heurística de gradiente Sobel) con
  4 esquinas ajustables manualmente.
- **Corrección de perspectiva**: transformación homográfica (proyectiva) real vía Canvas 2D,
  sin dependencias externas de visión por computadora.
- **Filtros**: Documento, Blanco y negro, Escala de grises, Color mejorado, Alta nitidez, Original.
- **Ajustes manuales**: brillo, contraste, saturación, rotación 90°.
- **Multi-página**: añade varias páginas a un mismo documento, reordénalas arrastrando.
- **Exportación**: PDF (una o varias páginas), JPG o PNG, con control de calidad/compresión,
  nombre de archivo personalizado y botón de compartir (Web Share API).
- **Historial**: documentos guardados en IndexedDB (en el propio dispositivo), con
  renombrar/eliminar/volver a exportar.
- **PWA offline**: Service Worker cachea el app shell; instalable como app nativa.
- **Modo claro/oscuro** con detección de preferencia del sistema.
- **Sonido de captura** sintetizado con Web Audio (no requiere archivos de audio).

## 📁 Estructura del proyecto

```
skanix/
├── index.html              # Marcado de todas las vistas (home, cámara, recorte, edición, revisión, historial)
├── manifest.json           # Manifest de la PWA (icono, nombre, colores, display)
├── sw.js                   # Service Worker: cachea el app shell para uso offline
├── css/
│   └── styles.css          # Sistema de diseño (tokens), layout responsive, temas claro/oscuro
├── js/
│   ├── app.js               # Enrutador de vistas + lógica de la app (estado, UI, exportación)
│   ├── camera.js             # Wrapper de getUserMedia (cámara en vivo, cambio frontal/trasera)
│   ├── imageProcessing.js    # Homografía/perspectiva, detección de bordes, filtros, ajustes
│   ├── db.js                  # Wrapper de IndexedDB para el historial de documentos
│   └── sound.js               # Sonido de obturador sintetizado con Web Audio API
└── icons/                   # Iconos de la PWA (192, 512, maskable, apple-touch, favicon)
```

## 🚀 Cómo ejecutarla

Es una app 100% estática (sin backend). Solo necesitas servirla con HTTP
(los Service Workers y `getUserMedia` no funcionan bajo `file://`).

**Opción rápida — Python:**
```bash
cd skanix
python3 -m http.server 8080
```
Abre `http://localhost:8080` en tu navegador.

**Opción con Node:**
```bash
cd skanix
npx serve .
```

**Para probar la cámara en un móvil real**, necesitas HTTPS (o `http://localhost`
en el propio dispositivo). Puedes usar túneles como `npx localtunnel --port 8080`
o desplegarla en cualquier hosting estático (Netlify, Vercel, GitHub Pages, Cloudflare Pages).

## 📲 Instalar como app

Al abrir la app en Chrome/Edge (Android/escritorio) o Safari (iOS, vía
"Compartir → Añadir a pantalla de inicio"), verás la opción de instalarla.
En escritorio, aparecerá un botón "Instalar" en la barra superior cuando el
navegador lo permita.

## 🧠 Notas técnicas

- **Sin librerías de visión por computadora pesadas** (no se usa OpenCV.js): la
  corrección de perspectiva se resuelve calculando manualmente una matriz de
  homografía 3×3 (resolviendo un sistema lineal de 8 ecuaciones por eliminación
  gaussiana) y remapeando cada píxel de salida a su origen con interpolación
  bilineal — ver `computeHomography` / `warpPerspective` en `imageProcessing.js`.
- **Detección de bordes automática** es una heurística ligera (Sobel + perfiles
  de proyección por fila/columna) pensada para documentos sobre fondos con
  contraste; siempre se puede corregir arrastrando las esquinas manualmente.
- **Todo el procesamiento ocurre en el dispositivo** (Canvas API): no se sube
  ninguna imagen a un servidor.
- **Exportación PDF** usa `jsPDF` (cargado desde CDN y cacheado por el Service
  Worker para que también funcione offline tras la primera visita).

## 🛠️ Personalización rápida

- Colores y tipografía: variables CSS en `:root` / `[data-theme="light"]` al
  inicio de `css/styles.css`.
- Nuevos filtros: añade un `case` en `ImageProcessing.applyFilter` y un chip
  en el `#filterStrip` de `index.html`.
- Calidad/tamaño máximo de render: constante `maxDim` en `renderPage` (`js/app.js`).
