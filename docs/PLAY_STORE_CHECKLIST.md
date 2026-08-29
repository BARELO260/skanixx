# Skanix — checklist de lanzamiento en Google Play

Este documento resume qué ya está listo en el código y qué falta por hacer
fuera de él (Android Studio, Play Console). No puedo compilar el `.aab`
final ni tocar Play Console desde aquí — esto es una guía verificada para
que esa parte te tome el menor tiempo posible.

## ✅ Ya resuelto en el código (esta sesión)

- **`package.json`** actualizado de Capacitor 6 → **Capacitor 8**. Esto es
  urgente y no cosmético: a partir del **31 de agosto de 2026** (en dos
  días), Google Play exige que toda app nueva apunte a **Android 16 (API
  36)** para poder publicarse. Capacitor 6 solo llega a API ~34-35;
  Capacitor 8 es la versión estable actual que ya apunta a API 36 por
  defecto. Si generas el proyecto Android con la versión vieja, Play
  Console rechazará la subida.
- **`AndroidManifest.xml`**: el requisito de hardware de cámara pasó de
  `required="true"` a `required="false"`. La app funciona sin cámara (tiene
  "Subir imagen" como alternativa), así que exigirla solo le ocultaba la
  app en Play Store a tablets/Chromebooks sin cámara sin necesidad.
- **`docs/privacy.html`**: política de privacidad completa (ES/EN),
  enlazada desde la pantalla de inicio de la app. Escrita en base a una
  revisión real del código: confirmé que no hay analítica, SDKs de
  publicidad, ni servidor propio — el único dato que sale del dispositivo
  es el texto (no la imagen) cuando usas "Traducir".
- **`docs/sw.js`**: cache del service worker actualizado para incluir
  `privacy.html` y `i18n.js`.

## 🔧 Pasos que debes correr tú (requieren Android Studio / SDK)

Estos comandos no se pueden ejecutar en este entorno (no tengo Android SDK
ni acceso a Google/Gradle), pero son los pasos exactos a seguir:

```bash
npm install                 # instala Capacitor 8
npx cap add android         # genera la carpeta android/ por primera vez
npx cap sync                # copia docs/ al proyecto nativo
npx cap open android        # abre Android Studio
```

Dentro de `android/variables.gradle`, confirma que haya quedado:
```
minSdkVersion = 24
compileSdkVersion = 36
targetSdkVersion = 36
```
(Capacitor 8 los pone así por defecto — solo verifícalo, no lo edites a
mano salvo que sepas por qué.)

Si ya tenías una carpeta `android/` generada con Capacitor 6 de una
sesión previa, bórrala y vuelve a correr `npx cap add android` en vez de
intentar migrarla a mano — es mucho más confiable partir de cero con la
plantilla de Capacitor 8.

## 🔑 Firma y compilación de release

1. Genera un keystore si no tienes uno (**guárdalo en un lugar seguro y
   respaldado — si lo pierdes, no podrás volver a actualizar la app en
   Play Store nunca más**):
   ```bash
   keytool -genkey -v -keystore skanix-release.keystore -alias skanix -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Configura la firma en `android/app/build.gradle` (Android Studio te
   puede guiar con *Build → Generate Signed Bundle*).
3. Genera el **Android App Bundle** (`.aab`, no `.apk` — Play Store lo
   exige para apps nuevas): *Build → Generate Signed Bundle / APK →
   Android App Bundle*.

## 📋 Google Play Console — Data Safety (formulario de seguridad de datos)

Este formulario es obligatorio y suele ser donde más tiempo se pierde por
declarar mal algo. Basado en la revisión real del código, así es como debe
llenarse:

| Pregunta de Play Console | Respuesta para Skanix |
|---|---|
| ¿La app recolecta o comparte datos de usuario? | Sí (ver detalle abajo) |
| Fotos e imágenes | **Recolectada**: sí (las fotos que el usuario escanea). **Compartida con terceros**: No. **Procesada en el dispositivo**: Sí. **Opcional**: la cámara es opcional (existe subida de galería como alternativa), pero escanear un documento es la función central de la app. |
| Datos personales → otro texto generado por el usuario | El texto extraído por OCR corre 100% en el dispositivo. Si el usuario usa "Traducir", ese texto (no la imagen) se transmite a un servicio externo de traducción — **compartido con terceros**: Sí, únicamente si el usuario activa esa función, y solo el texto, nunca la imagen. |
| ¿Los datos se cifran en tránsito? | Sí (HTTPS) para la llamada de traducción, que es la única llamada de red que hace la app. |
| ¿El usuario puede pedir que se borren sus datos? | Sí — todo es local; se borra desde la propia app o desinstalando. No aplica un flujo de "solicitud de borrado" porque no hay servidor que retenga nada. |
| ¿Se usa para publicidad? | No |
| ¿Se usa para analítica/rendimiento? | No (verificado: no hay ningún SDK de analítica en el código) |

## 📱 Ficha de la tienda (Store Listing)

Pendiente de tu parte (son assets gráficos/de marketing, no código):

- **Ícono de alta resolución 512×512** — puedes reusar
  `docs/icons/icon-512.png` como base.
- **Gráfico de funciones (feature graphic) 1024×500** — no existe todavía.
  Puedo ayudarte a diseñarlo si quieres.
- **Capturas de pantalla** — mínimo 2 (recomendado 4-8), por cada tipo de
  dispositivo que quieras soportar (teléfono, y opcionalmente tablet de
  7"/10"). Como la app ya tiene 5 idiomas, considera capturas en al menos
  español e inglés.
- **Descripción corta** (80 caracteres) y **descripción larga** (4000
  caracteres).
- **Categoría**: Productividad (coincide con `manifest.json`).
- **URL de política de privacidad**: usa la URL pública donde termines
  publicando `docs/privacy.html` (por ejemplo, vía GitHub Pages, ya que
  `docs/` es tu carpeta web).

## ⚠️ Cosas a las que prestar atención

- **Traducción vía endpoint no oficial de Google**: `ocr.js` usa
  `translate.googleapis.com/translate_a/single`, un endpoint público mucho
  más confiable que MyMemory (lo cambiamos hace unas sesiones porque
  MyMemory devolvía traducciones sin relación con el texto), pero no es una
  API oficial con contrato de soporte — Google podría bloquearla o
  cambiarla sin aviso en cualquier momento. Funciona bien hoy y no es un
  problema de política de Play Store, pero si esta app va a tener mucho
  uso, considera migrar a la Cloud Translation API oficial (de pago) más
  adelante para mayor estabilidad a largo plazo.
- **Cuestionario de clasificación de contenido**: al no tener contenido
  generado por otros usuarios, violencia, ni contenido para adultos, debería
  calificar como "Para todo público" sin complicaciones.
- **Permiso de Cámara**: no es un "permiso restringido" que requiera
  aprobación especial de Google, pero sí debes justificar su uso si Play
  Console lo pregunta — la respuesta corta es "el usuario fotografía
  documentos para escanearlos", ya redactado en `privacy.html`.
