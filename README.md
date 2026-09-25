# Nerdearla Live Captions

**Subtítulos y traducción simultánea para conferencias, en tiempo real y con código abierto.**

Nerdearla Live Captions recibe el audio de cada sala, genera transcripción y traducción, y distribuye los subtítulos a una página de audiencia. Está pensado para que una conferencia pueda operar varias salas desde un panel común y publicar el sistema con sus propios recursos.

> **Versión 1 · Nerdearla Vibeathon 2026.** Es un prototipo funcional para evaluar el flujo completo. No reemplaza a intérpretes profesionales ni promete una latencia o precisión fija.

**English summary:** An open-source live captioning and translation system for conference sessions. Each room has an independent audio stream; audiences can view original or translated captions in a web page, OBS browser source, or desktop overlay.

## Qué resuelve

Las conferencias necesitan subtitular varias charlas al mismo tiempo sin multiplicar operadores ni contratar un servicio comercial por sala. Este proyecto ofrece una ruta desplegable con Docker, un panel de producción, una página pública de audiencia y una integración principal con Gemini Live. También incluye una ruta local opcional basada en WhisperLiveKit para experimentar con procesamiento autohospedado.

Cada sesión procesa una fuente de audio y transmite el texto resultante a todos sus espectadores. Los espectadores no crean solicitudes adicionales al proveedor.

## Estado de la v1

| Necesidad | Estado en esta versión |
| --- | --- |
| Audio en vivo | Micrófono/consola o audio de una pestaña compatible del navegador, compartida explícitamente por quien opera. |
| Transcripción y traducción | Flujo Gemini Live recomendado; cada sesión configura el idioma de entrada y un destino de traducción. La audiencia puede alternar entre original y ese destino. |
| Varias salas | Sesiones independientes. Se comprobó manualmente en Brave la captura simultánea de dos pestañas de stream (Olga y Luzu). La integración automatizada también comprueba dos sesiones con proveedores simulados; ninguna de estas pruebas demuestra capacidad para 30 salas reales con Gemini. |
| Audiencia | Página web por sala con subtítulos recientes. En esta v1, la persona elige entre el audio original y el único idioma de traducción configurado para esa sesión. |
| Código abierto | Licencia MIT incluida en [`LICENSE`](LICENSE). |
| Glosario y borradores | Disponibles como opciones; implican una ruta contextual con más etapas y consumo de texto. |
| Exportación | VTT, SRT y texto, tanto original como traducido. |
| Producción | Métricas de audio, sesiones, latencia, errores y costo estimado. |
| Overlay | Página transparente para OBS/vMix y overlay nativo de escritorio con Electron. |
| Procesamiento local | Perfil opcional de WhisperLiveKit; diarización opcional con Sortformer. Requiere dimensionar y probar el hardware. |

### Latencia y precisión

En una comprobación manual de una sesión de Gran Sala, la telemetría registró aproximadamente **1,0 s hasta el primer texto reconocido** y **1,2 s hasta la primera traducción** desde el comienzo de la voz. Es una observación puntual de una sala y una conexión; no es un benchmark reproducible ni un SLA.

La latencia y la calidad dependen del modelo seleccionado, el idioma, la red, el micrófono o mezcla de consola, el ruido, los acentos, la cuota disponible y la cantidad de sesiones concurrentes. Gemini Live Translate puede equivocarse en nombres, siglas, cifras, acentos o frases técnicas. Para esta v1 se prioriza demostrar el flujo funcional; mejorar rapidez y precisión requiere comparar modelos y configuraciones con el mismo corpus de audio y revisar los resultados con personas.

## Cómo funciona

```mermaid
flowchart LR
  A[Micrófono, extensión Chromium por tabId, o pestaña compartida] --> B[AudioWorklet: PCM mono 16 kHz]
  B --> C[WebSocket de la sesión]
  C --> D{Motor elegido}
  D -->|Predeterminado| E[Gemini Live Translate]
  D -->|Opcional| F[WhisperLiveKit local]
  E --> G[Transcripción y traducción]
  F --> G
  G --> H[WebSocket de audiencia]
  H --> I[Página de subtítulos]
  H --> J[OBS/vMix o overlay de escritorio]
  C --> K[Métricas y estimación de costo]
```

El cliente captura audio y lo convierte en PCM mono de 16 kHz en bloques cortos. El backend mantiene sesiones independientes, limita las colas y evita procesar audio demasiado atrasado. Si la conexión se degrada, puede descartar bloques viejos para conservar subtítulos actuales; eso protege la latencia, pero puede perder una parte de lo dicho.

## Requisitos

- Docker Desktop con Docker Compose, recomendado para empezar.
- Una clave de Gemini con acceso al modelo Live que se vaya a usar. La cuota gratuita es limitada y no garantiza disponibilidad ni capacidad para múltiples salas.
- Chrome o Brave actualizado si se va a compartir el audio de una pestaña.
- Node.js 22.12 o posterior y `pnpm` solo para ejecutar fuera de Docker o desarrollar.
- Micrófono, entrada de consola o una pestaña que esté reproduciendo audio.

Para compartir la aplicación con otros dispositivos se necesita HTTPS y soporte de WebSocket en el proxy. En `localhost`, el navegador permite probar la captura sin configurar un certificado.

## Inicio rápido con Docker

En PowerShell, desde la carpeta del proyecto:

```powershell
Copy-Item .env.example .env
notepad .env
```

En `.env`, agregá la clave sin comillas y configurá el nivel de facturación de tu proyecto:

```dotenv
GEMINI_API_KEY=PEGAR_LA_CLAVE_LOCALMENTE
GEMINI_BILLING_TIER=free
```

No publiques ni agregues `.env` al repositorio. Está excluido por `.gitignore`; compartí únicamente `.env.example`, que no contiene claves.

Construí e iniciá la aplicación:

```powershell
docker compose up --build -d
docker compose ps
docker compose logs -f captions
```

Abrí [http://localhost:3001](http://localhost:3001). El puerto del equipo es `3001` por defecto y el contenedor escucha en `3000`. Para cambiar el puerto del equipo, configurá `HOST_PORT` en `.env`.

Para detener el servicio sin borrar las transcripciones guardadas:

```powershell
docker compose down
```

Las sesiones y transcripciones se guardan en el volumen `caption-data`. **No uses `docker compose down -v` si querés conservarlas**, porque también elimina el volumen.

### Ejecución local sin Docker

Instalá Node.js 22.12+, habilitá Corepack y ejecutá:

```powershell
corepack enable
pnpm install
pnpm start
```

Configurá `GEMINI_API_KEY` en `.env` antes de iniciar una sesión real. Esta modalidad usa `http://localhost:3000`. Para desarrollo con recarga automática, ejecutá `pnpm dev`.

Sin Gemini o sin WhisperLiveKit, se puede recorrer el panel con la demo, pero la demo no procesa audio real.

## Flujo recomendado: panel web y varias salas en Brave

El flujo de operación comprobado para trabajar con varias transmisiones usa **dos ventanas del mismo Brave**: una queda dedicada al panel de Nerdearla Live y otra contiene las pestañas de las transmisiones. No hace falta abrir `Nerdearla Live.exe`.

1. Iniciá Docker y abrí el panel web en Brave: [http://localhost:3001](http://localhost:3001).
2. Abrí una **ventana nueva** de Brave. En esa segunda ventana, abrí una pestaña por cada transmisión; por ejemplo, una para el stream de Olga y otra para el de Luzu. Iniciá sesión en los sitios que lo requieran y comprobá que cada video reproduzca sonido.
3. Instalá una vez la extensión de captura siguiendo [Instalar la extensión en Brave](#instalar-la-extension-en-brave). Dejá el panel en la primera ventana y usá la segunda para operar las pestañas fuente.
4. En la pestaña del stream de Olga, abrí **Nerdearla Captura** desde el ícono de extensiones. Creá una sesión llamada Olga (o elegí una sesión pausada), seleccioná el idioma hablado y el destino, y pulsá **Conectar esta pestaña**.
5. Volvé a la pestaña del stream de Luzu y repetí el proceso con su propia sesión. Cada sesión queda asociada a su pestaña y conserva un flujo de audio separado.
6. Volvé al panel de la primera ventana. Confirmá que ambas salas estén activas y que reciban audio y subtítulos. Abrí la vista de audiencia de cada sesión para revisar la salida.
7. Para detener una fuente, volvé a su pestaña y pulsá **Detener audio de esta pestaña**. La otra sala sigue conectada.

En la prueba manual que logró mantener dos streams en paralelo, se usó este montaje de ventanas en Brave. La extensión toma el ID de la pestaña activa con `chrome.tabCapture`; no depende del selector de pantalla ni de **Compartir esta pestaña** de la barra del navegador. Usá el botón de la extensión dentro de cada pestaña fuente para iniciar o detener solo esa sala.

La misma configuración sirve para YouTube, Swapcard y otras páginas web que reproduzcan audio accesible al navegador. Iniciá la reproducción antes de conectar. DRM, audio bloqueado por el sitio, políticas del navegador o restricciones de la red pueden impedir la captura. Para streams que exijan cuenta, iniciá sesión en Brave antes de conectar la pestaña.

### Instalar la extensión en Brave

En la computadora que ejecuta Brave:

1. Desde el repositorio, ejecutá Docker y configurá `.env` con la clave del proveedor, siguiendo [Inicio rápido con Docker](#inicio-rápido-con-docker).
2. Abrí `brave://extensions`, activá **Modo desarrollador** y elegí **Cargar descomprimida**.
3. Seleccioná la carpeta `extension` de este repositorio. La extensión requiere Brave/Chromium 116 o posterior. El ID esperado es `hihbplbemkhehapigojnjdhcilndcjeg`; Docker ya está configurado para ese ID.
4. Fijá **Nerdearla Captura** en la barra de extensiones para encontrarla en cada pestaña fuente.

El popup muestra la dirección del servidor, la pestaña activa, las sesiones guardadas y el estado de conexión. En una instalación local, usá `http://localhost:3001`. Si configurás otro dominio, guardalo en el popup y aceptá el permiso que solicita Brave. Para un servidor remoto necesitás HTTPS/WSS.

Si cambiás el ID de la extensión en `extension/manifest.json`, actualizá `CAPTURE_EXTENSION_ID` en `.env` y recreá el contenedor. La extensión envía solo el audio capturado al backend; no almacena el audio en disco. Usa las APIs oficiales de Chrome [`tabCapture`](https://developer.chrome.com/docs/extensions/reference/api/tabCapture) y [`offscreen`](https://developer.chrome.com/docs/extensions/reference/api/offscreen).

Cada pestaña fuente necesita su propia sesión. La extensión evita capturar dos veces el mismo tab ID; el número de sesiones simultáneas que el equipo puede sostener depende de la CPU, la red y las cuotas y límites del motor elegido. Dos salas funcionando no implica que una cuenta gratuita pueda procesar treinta a la vez. Antes de un evento, probá la cantidad de salas prevista y observá señal, subtítulos, latencia, errores y costo en el panel.

En esta v1, el idioma destino se configura al crear cada sesión; la página de audiencia ofrece el audio original o esa traducción. No permite cambiar a un segundo idioma destino mientras la sesión sigue corriendo. La identificación de idioma del modelo también puede confundir idiomas cercanos, como español y portugués, incluso cuando el audio parece claro; revisá las primeras líneas antes de publicar la vista de audiencia.

### Aplicación nativa para Windows (opcional)

El instalador abre el panel de producción como una app de escritorio. No hace falta abrir el panel en Chrome/Brave. Para generar el instalador desde el repositorio:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm desktop:win
```

El ejecutable portable aparece en `dist/Nerdearla-Live-win32-x64-v1.0.0/Nerdearla Live.exe` y el paquete completo en `dist/Nerdearla-Live-win32-x64-v1.0.0.zip`. Descomprimí el ZIP sin mover el `.exe` fuera de su carpeta y abrilo con doble clic. La app se conecta al servidor Docker de `http://localhost:3001`; primero iniciá el servicio con `docker compose up -d` y configurá `.env` como se describe arriba.

En la app nativa, elegí **Nueva sesión**, pegá el link de la transmisión (YouTube, Swapcard u otra página) y configurá idioma y traducción. El botón abre ese link en una ventana Chromium con un perfil aislado; cada sala tiene su propia captura y puede funcionar al mismo tiempo que las demás. El paquete incluye la extensión y la carga automáticamente. En esa ventana abrí **Nerdearla Captura** y elegí **Conectar esta pestaña**. Si la fuente requiere iniciar sesión, hacelo en el perfil que abrió esa sala; se conserva para reconexiones posteriores.

Se necesita un navegador compatible con extensiones Manifest V3 y `tabCapture` (Chromium, Brave, Edge o Chrome, versión 116 o posterior). El ejecutable busca Chromium sin marca primero, seguido de Brave y Edge. En Windows, si no tenés uno, ejecutá `scripts/install-chromium-win.ps1`; descarga una compilación oficial de desarrollo de Chromium en `%LOCALAPPDATA%\Nerdearla\Chromium`. Esa instantánea no se actualiza sola, así que para producción conviene mantener actualizado un navegador compatible. El panel, los subtítulos de audiencia y los overlays funcionan dentro de la app nativa; el navegador abre cada fuente y captura su audio.

El paquete portable incluye el runtime de Electron, la app nativa y la extensión; no necesita Node.js instalado. El backend sigue ejecutándose en Docker, y Google Chrome 116+ reproduce las fuentes de audio. `dist/` no contiene claves ni el archivo `.env`.

### Captura alternativa desde el panel

El panel también permite usar un micrófono/consola o abrir el selector estándar para compartir una pestaña. Es útil para una prueba rápida o una fuente, pero para varias salas en Brave usá la extensión siguiendo el flujo anterior. No uses el botón del aviso superior **Compartir esta pestaña** para sumar salas: opera sobre la captura estándar activa.

## Funciones opcionales

### Glosario y traducción anticipada

Se pueden cargar hasta 100 términos por charla: nombres, siglas, proyectos y vocabulario técnico. El glosario usa una ruta contextual con etapas adicionales; puede mejorar términos propios, pero normalmente agrega latencia y consumo. Los borradores anticipados son provisionales y se vuelven a traducir cuando se confirma la frase.

No se presenta una puntuación de “confianza” sin calibración del proveedor. Para precisión, compará transcripciones con una referencia humana y revisá por separado nombres, cifras, negaciones y terminología.

### Subtítulos en OBS o vMix

La sesión ofrece una URL de audiencia que puede agregarse como **Browser Source**. El modo overlay usa fondo transparente y solo muestra las líneas recientes. Reemplazá el ID por el de la sesión:

```text
http://localhost:3001/audience.html?session=ID_DE_SESION&lang=translation&overlay=1
```

Si OBS/vMix está en otro equipo, reemplazá `localhost` por el host accesible y configurá HTTPS/WebSocket. Ajustá resolución, posición y escala desde la fuente del navegador.

### Ventana aparte y escritorio transparente

En la vista de audiencia, **Subtítulos flotantes** ofrece una página aparte y el modo transparente nativo. Para iniciar el cliente de escritorio local:

```powershell
$env:NERDEARLA_URL = 'http://localhost:3001'
pnpm desktop
```

El modo nativo está implementado con Electron y depende del compositor del sistema operativo. En Windows, iniciar la aplicación registra el enlace local usado por el navegador; macOS/Linux necesitan registrar el protocolo al empaquetar el cliente. Un navegador no puede lanzar comandos de consola ocultos. La página aparte funciona como alternativa sin instalar Electron.

El overlay nativo muestra una barra pequeña independiente con **Mover/Fijar** y **Cerrar**. La capa de subtítulos conserva fondo transparente. Pulsá **Mover**, arrastrá las letras a la posición deseada y pulsá **Fijar** para que los clics vuelvan al video. **Cerrar** retira ambas ventanas. La barra sigue disponible aunque los atajos globales estén ocupados por otra app.

### WhisperLiveKit local y diarización

El perfil local se despliega por separado. La primera compilación descarga modelos; el perfil CPU sirve para evaluar integración y salas pequeñas, **no** demuestra capacidad para una conferencia:

```powershell
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build -d
```

Para activar el respaldo automático cuando Gemini se cae, configurá `AUTO_FALLBACK_TO_LOCAL=true` en `.env`. Para probar diarización con Sortformer:

```powershell
docker compose -f docker-compose.yml -f docker-compose.local.yml -f docker-compose.diarization.yml up --build -d
```

La diarización separa voces como “Voz 1” y “Voz 2”. La sugerencia de nombre requiere una presentación explícita que coincida con la lista de oradores, y producción debe confirmarla. No identifica biométricamente a una persona por su voz. Sortformer y ASR compiten por CPU/GPU; medí memoria y latencia con el hardware final y revisá las licencias de cada modelo descargado.

## Costo, capacidad y escalado

El panel actualiza cada dos segundos una **estimación** basada en audio, modelo y tokens registrados. Presenta minutos procesados, estimación facturable según el nivel configurado, equivalente a tarifa paga y presupuesto diario opcional. No consulta la factura de Google ni garantiza cuota disponible. Los precios y límites cambian; verificá la consola y la documentación del proveedor antes de un evento.

La cuota gratuita puede agotarse o limitar la concurrencia. El audio de Gemini se envía al proveedor; el proyecto no guarda el audio, pero sí persiste transcripciones y estado en el volumen. En nivel gratuito aplican las condiciones de tratamiento de datos de Google. Como no hay autenticación, cualquiera con acceso al servidor puede ver sesiones, textos y costos, e iniciar o eliminar sesiones. No expongas el servicio accidentalmente a Internet.

`MAX_ACTIVE_SESSIONS=30` es un **límite de admisión configurable**, no una promesa de que una instancia o la cuota gratuita puedan sostener 30 salas. La v1 corre en un único proceso: conexiones de modelos y espectadores se mantienen en esa instancia.

Para escalar de manera comprobable:

1. Medí una sala durante una charla real; después probá 2, 5, 10 y 30 fuentes durante períodos representativos, con audiencia conectada.
2. Registrá p50/p95/p99 de captura→primer texto, captura→primera traducción y entrega a audiencia; medí WER, revisión humana, pérdida de paquetes y costo por sala/hora.
3. Comprobá cuota, límites de solicitudes, duración/reconexión del modelo y gasto con el plan real. Ajustá `MAX_ACTIVE_SESSIONS` a la menor capacidad comprobada o cuota disponible.
4. Para varias réplicas, agregá un bus compartido (por ejemplo Redis Pub/Sub), almacenamiento compartido y persistente, afinidad para WebSockets productores y límites de costo por sala.
5. Para ASR/MT local, dimensioná workers y GPU según modelo, VRAM y concurrencia medida; el costo pasa de tarifa por minuto a infraestructura y operación.
6. Probá red degradada, desconexión del productor, 429, reinicio del contenedor y recuperación. La cola corta evita que el retraso siga creciendo, pero la continuidad completa requiere ensayos en el recinto.

## Configuración

Las variables de [`.env.example`](.env.example) incluyen:

| Variable | Para qué sirve |
| --- | --- |
| `GEMINI_API_KEY` | Clave del backend para Gemini. No se expone a la audiencia. |
| `CAPTURE_EXTENSION_ID` | ID Chromium autorizado para CORS y WebSocket; coincide con la extensión incluida. |
| `GEMINI_BILLING_TIER` | `free` o nivel pago; cambia cómo se estima el costo mostrado. |
| `HOST_PORT` | Puerto del equipo para Docker; predeterminado `3001`. |
| `MAX_ACTIVE_SESSIONS` | Máximo de sesiones admitidas por instancia. |
| `MAX_AUDIO_QUEUE_CHUNKS` | Cola de audio antes de descartar bloques atrasados. |
| `DAILY_BUDGET_USD` | Presupuesto diario estimado; `0` lo desactiva. |
| `DRAFT_TRANSLATION_INTERVAL_MS` | Cadencia mínima de borradores. |
| `LOCAL_ASR_WS_URL`, `LOCAL_ASR_TOKEN` | Conexión opcional al servicio local. |
| `AUTO_FALLBACK_TO_LOCAL` | Respaldo a WhisperLiveKit si el perfil local está instalado. |
| `LOCAL_ASR_INFRA_USD_PER_MINUTE` | Tarifa local para la estimación. |
| `LOCAL_SPEAKER_DIARIZATION`, `HF_TOKEN` | Diarización y acceso a pesos si el modelo lo requiere. |
| `TRANSCRIBE_MODEL`, `LIVE_TRANSLATION_MODEL`, `TRANSLATION_MODEL` | Modelos para transcripción, Live Translate y traducción contextual. |

También hay tarifas configurables. No pegues credenciales en issues, capturas, README ni commits.

## API y pruebas

- `GET /api/health`: estado básico del servidor.
- `GET /api/config`: motores y configuración disponibles.
- `GET /api/sessions` y `GET /api/sessions/:id`: sesiones y métricas.
- `GET /api/metrics`, `GET /api/metrics/cost`: monitoreo y estimación.
- `GET /api/sessions/:id/export?format=vtt|srt|txt&language=original|translation`: exportación.
- `WS /ws`: audio del productor y eventos para producción/audiencia.

Comandos de validación:

```powershell
pnpm test
pnpm test:integration
pnpm desktop:smoke
```

La prueba de integración usa proveedores locales simulados: recorre WebSocket, dos sesiones activas, audio PCM, backpressure, diarización, métricas, costos, exportación y persistencia. No consume Gemini y no equivale a una prueba de carga de modelos reales. `pnpm smoke:gemini-setup` verifica Live con Google sin enviar audio, pero sí contacta la API. Para comparar precisión y latencia, seguí [`benchmarks/README.md`](benchmarks/README.md) con audio autorizado y referencias humanas.

## Licencia

El código se publica bajo licencia [MIT](LICENSE). Dependencias, pesos de modelos y servicios externos conservan sus propias condiciones de uso; verificá cada una antes de redistribuir o desplegar.

## Demo y envío a la competencia

**Demo en video (1–2 minutos):** pendiente de grabar y enlazar antes de enviar. Conviene mostrar una fuente real, transcripción original, traducción, selector entre audio original y destino configurado, y, si alcanza el tiempo, OBS/overlay. Para jurados que no hablan español, agregá subtítulos en inglés.

El link del repositorio público y el del proyecto en Devpost se agregan al realizar esos envíos; no se inventan aquí.

## Autor y contacto

**Giovanni Cieri**

- Teléfono: [+54 9 11 4889-9531](tel:+5491148899531)
- Email: [giovannicieri1@gmail.com](mailto:giovannicieri1@gmail.com)
- LinkedIn: [linkedin.com/in/giovanni-cieri](https://www.linkedin.com/in/giovanni-cieri/)

## Documentación adicional

- [Implementaciones y decisiones tomadas](docs/implementaciones.md)
- [Latencia, calidad y opciones de escalado](docs/latencia-escala-y-calidad.md)
- [Cómo preparar un corpus de evaluación](benchmarks/README.md)
