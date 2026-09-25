# Plan técnico: latencia, escala y calidad

Este documento convierte el objetivo de accesibilidad de Nerdearla en decisiones que se pueden medir. Las cifras de latencia de abajo son metas iniciales del proyecto, no resultados ya medidos.

## Diagnóstico de la versión actual

El camino de audio tiene tres rutas configurables:

- **Gemini directo:** captura del navegador → WebSocket directo de Gemini → transcripciones por WebSocket de la app → audiencia. Un token efímero de un solo uso autoriza únicamente el modelo y el idioma de destino. El audio no cruza el servidor de Nerdearla.
- **Gemini contextual:** captura del navegador → servidor → Live Transcribe → traducción Flash-Lite con borradores incrementales → audiencia. Se usa con glosario, porque Live Translate no acepta instrucciones ni vocabulario personalizado.
- **Borrador anticipado:** activa Gemini Live Transcribe más Flash-Lite, porque la ruta Live Translate no entrega texto parcial confiable para esta función. Se puede activar por sesión; muestra traducción provisional desde el parcial y vuelve a traducir cada frase confirmada. Cada sala limita la frecuencia y el servicio pone un máximo global para no crear una cola de traducciones viejas. Consume solicitudes y cuota de texto adicionales.

La variante de proxy para Live Translate también usa un token efímero de un solo uso y el endpoint `BidiGenerateContentConstrained`, pero mantiene el audio en el servidor. La clave permanente se conserva en backend y nunca se entrega al navegador.
- **WhisperLiveKit:** captura del navegador → servidor → servicio local → audiencia. Funciona sin enviar audio a Google, condicionado por modelos y capacidad del equipo.

Si Gemini no completa el enlace directo en 15 s, o falla dos veces durante la reconexión, el cliente cambia a la variante proxy. El proxy añade un salto de red, pero evita que una restricción del navegador o de la red deje la sala en error cuando el servidor sí puede llegar a Gemini. La prueba del recinto debe medir ambas rutas con la red real.

La captura entrega PCM mono de 16 kHz en bloques de 100 ms, el tamaño indicado por la guía de Live Translate. El cliente y el servidor limitan las colas y descartan audio viejo para no convertir una red lenta en subtítulos atrasados. El modo directo limita además el buffer del WebSocket a Gemini a 1,5 segundos y reporta los bytes enviados para la estimación de costo.

La telemetría mide voz→primer texto reconocido, respuesta de traducción, retraso de entrada y confirmación de renderizado en audiencia. La métrica de audiencia usa sincronización aproximada de reloj; ninguna reemplaza la medición de extremo a extremo en la red del recinto.

`gemini-3.5-transcribe-live` documenta un máximo de 10 minutos por sesión. Esa ruta guarda los handles de reanudación y rota la conexión cuando llega `GoAway`; deben medirse charlas de 40 minutos para validar que la reanudación cubra el límite de duración de la sesión. Live Translate tampoco debe asumirse ilimitado: el despliegue mide cierres y reconexiones y conserva el historial local.

Gemini Live Translate está diseñado como flujo continuo de traducción, pero acepta audio únicamente y no admite instrucciones o herramientas. Su guía enumera errores de detección con acentos fuertes, idiomas similares y cambios rápidos de idioma; por eso ningún proveedor puede garantizar 100 % de exactitud en una charla técnica improvisada. [Documentación de Live Translate](https://ai.google.dev/gemini-api/docs/live-api/live-translate)

El precio de US$0 del nivel gratuito no garantiza capacidad ni una latencia determinada. Los límites dependen del proyecto y el modelo; Google indica que las variantes preview pueden tener límites más estrictos y que la capacidad real puede variar. Si Gemini devuelve 429 o errores de capacidad, el servicio descarta los borradores parciales, pausa globalmente nuevos borradores con espera creciente y conserva el camino de traducción final para que no se acumulen llamadas viejas. Para 30 salas simultáneas hay que validar la cuota real del proyecto y medir p95; el modo gratuito no debe presentarse como un SLA. [Límites oficiales de Gemini](https://ai.google.dev/gemini-api/docs/rate-limits) · [Precios de Gemini](https://ai.google.dev/gemini-api/docs/pricing)

En la prueba de Nerdearla del 24 de septiembre de 2026 se detectó que la conexión directa intentaba abrir un nuevo WebSocket con un token efímero ya consumido. Ahora renueva el token antes de cada conexión, incluso al reanudar; `GoAway` y `sessionResumption` conservan continuidad. El token del proxy permite 30 minutos de conexión y mantiene una ventana de 2 minutos para iniciar una sesión nueva. La audiencia limita lo visible a una ventana reciente de 440 caracteres y el WebSocket de traducción envía solo cada delta, sin alterar la exportación final.

## Alternativas de arquitectura

| Ruta | Latencia esperada | Calidad y glosario | Costo y red | Para qué sirve |
| --- | --- | --- | --- | --- |
| Gemini Live Translate directo desde el navegador | Implementado; elimina un salto de audio por el backend | Traducción de audio continua; no acepta glosario/instrucciones | Requiere internet del operador hasta Google; token limitado y costo por sala | Perfil de menor demora |
| Gemini Live Transcribe + borradores Flash-Lite | Implementado como opción por sesión; usa audio→servidor→Gemini | Interims de texto, glosario y traducción provisional; cada frase final se traduce de nuevo | Añade solicitudes de texto; tiene cuota global de borradores para mantener acotado el gasto | Cuando importa mostrar una traducción antes del cierre de frase |
| Gemini Live Transcribe + traductor incremental de texto | Algo más de demora por dos etapas | ASR separado, vocabulario técnico y prompt de traducción; admite correcciones | Transcripción de texto más traducción; el texto es barato, pero se suma una etapa | Cuando los términos importan más que la mínima demora |
| WhisperLiveKit autohospedado | Puede ser muy baja con modelo de streaming y GPU suficiente | ASR incremental, contexto/glosario, traducción configurable y diarización | Sin tarifa por minuto a un proveedor; se paga GPU, operación y soporte | Alternativa abierta principal para una prueba comparativa |
| SimulStreaming autohospedado | Streaming incremental; depende de política de salida y hardware | Whisper + EuroLLM, admite terminología de dominio y contexto | Sin tarifa por minuto; pesado para CPU | Ruta abierta centrada en traducción simultánea |
| WhisperLive + faster-whisper | Casi en vivo; carga por GPU/modelo y número de salas | Hotwords y traducción opcional por hilo | Infraestructura local; escalar requiere dimensionar workers | Integración sencilla para ASR y respaldo |
| whisper.cpp + Argos Translate | Variable; útil en un equipo local con modelos pequeños | ASR seguido por MT offline; más riesgo de errores y frases cortadas | Funciona sin internet una vez descargados los modelos | Modo de continuidad offline, con calidad degradada |

### 1. Gemini con el audio directo desde el navegador

La ruta directa emite tokens efímeros de un solo uso desde un endpoint público, limitados al modelo y al idioma de destino. Antes de cada WebSocket solicita un token fresco; si existe un handle válido, envía el handle por separado para reanudar. No hay renovación de token mientras el socket está abierto, porque el token solo autoriza la conexión. El servidor recibe texto, publica subtítulos y calcula uso a partir de bytes enviados por el productor. Esta ruta depende de que el navegador productor alcance a Google y de la cuota de Gemini. [Live API: enfoques de integración](https://ai.google.dev/gemini-api/docs/live-api) · [Tokens efímeros y reanudación](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens)

### 2. Dos etapas para términos técnicos

Mantener ASR en vivo y enviar al traductor el texto parcial, sin esperar la oración completa. Al activar este perfil, la sala pasa de Live Translate al par Live Transcribe + Flash-Lite, porque el proveedor no emite parciales confiables en la ruta de traducción directa. La interfaz ofrece un borrador provisional cada 1,2 segundos como máximo por sala; un límite global configura cuántas salas pueden refrescarse al mismo tiempo. Las entradas parciales se acotan a 600 caracteres, se consolidan por sala y no se encolan cuando quedan desactualizadas. Flash-Lite transmite los tokens del borrador en cuanto llegan y el servidor cancela ese flujo al recibir la frase final, que se traduce de nuevo y reemplaza el borrador. El panel expone el p95 desde el parcial de origen hasta el primer texto traducido.

Para términos, separar dos glosarios: vocabulario de reconocimiento de voz (nombres, acrónimos, nombres de librerías) y guía de traducción (cómo traducir esos términos). Gemini Live Transcribe admite hasta 1.000 frases de vocabulario y recomienda comenzar con no más de 100; Live Translate no acepta prompts. En la opción abierta, WhisperLiveKit y SimulStreaming documentan contexto/terminología. Los nombres de charlas, oradores y proyectos publicados en la agenda pueden precargar el glosario por sala. [Live Transcribe](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)

Esta ruta es la opción de mayor contexto: quitar la cola serial de llamadas por fragmento y pasar a traducción incremental con límites de frecuencia y concurrencia. No se debe presentar una estimación numérica de “confianza” si el proveedor no entrega una probabilidad calibrada; mejor marcar cada línea como provisional/final y mostrar la frescura y la salud de la sala.

### 3. Servicio local abierto

**WhisperLiveKit** merece ser la primera prueba autohospedada: ofrece WebSocket de audio, varias sesiones, salida incremental, contexto por sala, traducción y opciones de ASR; su repositorio publica Dockerfiles y perfiles para CPU/CUDA. Es Apache-2.0 a nivel de código. El repositorio reúne varias rutas experimentales y modelos: hay que fijar versión, revisar la licencia de cada peso y medir con las charlas reales. Sus propios benchmarks no sustituyen una prueba en el hardware del evento. [Repositorio WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit)

**SimulStreaming** es otra prueba fuerte: combina Whisper incremental y EuroLLM, inyecta terminología de dominio y reporta su resultado en IWSLT 2025. El proyecto recomienda al menos 10 GB de VRAM para Whisper large-v3 y advierte que CPU sería demasiado lento para tiempo real. Su código tiene licencia MIT; EuroLLM-9B tiene Apache-2.0. La GPU necesaria para 30 salas no se debe inferir de una demo de una sola sala: se determina midiendo sesiones concurrentes, VRAM, p95 y temperatura del modelo. [Repositorio SimulStreaming](https://github.com/ufal/SimulStreaming) · [EuroLLM-9B](https://huggingface.co/utter-project/EuroLLM-9B)

**WhisperLive** es una integración de menor riesgo para ASR: ofrece faster-whisper, TensorRT y OpenVINO, VAD, hotwords y un hilo opcional de traducción. Su configuración documentada permite 4 clientes por instancia de forma predeterminada. Para más salas hay que ajustar y probar workers; no se debe asumir que un contenedor equivale a 30 sesiones. [Repositorio WhisperLive](https://github.com/collabora/WhisperLive)

**Respaldo sin internet:** `whisper.cpp` permite inferencia local en CPU/GPU; su ejemplo en vivo vuelve a reconocer cada medio segundo, pero por sí solo no resuelve traducción incremental. Argos Translate aporta MT offline. Juntos permiten conservar subtítulos cuando se cae Internet, con un modelo pequeño y salida marcada como “respaldo local”; medir calidad de español técnico antes de prometerla. Revisar la licencia del paquete lingüístico, además de la de la biblioteca. [whisper.cpp](https://github.com/ggml-org/whisper.cpp) · [Argos Translate](https://github.com/argosopentech/argos-translate)

Un servicio local no elimina el costo: cambia la factura por minuto por GPUs, electricidad, capacidad de reserva y operación. Desde el equipo actual sin GPU dedicada no conviene esperar rendimiento de un modelo grande para 30 salas.

## Costo: tamaño del problema

La tabla oficial consultada el 24 de septiembre de 2026 para `gemini-3.5-live-translate-preview` marca nivel gratuito a USD 0, y un estimado de USD 0,0368 por minuto procesando entrada y audio traducido en el nivel pago. Por tanto, 30 salas activas durante una hora son 1.800 minutos de audio: aproximadamente **USD 66,24** al precio publicado. El resultado real depende del consumo contabilizado y los precios pueden cambiar. Gemini 3.5 Transcribe Live estima USD 0,009/min; 30 salas por una hora serían USD 16,20 solo para transcribir, a lo que se suma el traductor de texto. [Precios de Gemini API](https://ai.google.dev/gemini-api/docs/pricing)

El plan gratuito sirve para validar una charla, no para prometer 30 salas. Los límites son por proyecto, más restrictivos en modelos preview y la capacidad efectiva no está garantizada. El precio gratuito también indica que los datos pueden usarse para mejorar productos; no usarlo con contenido privado sin aceptar expresamente ese tratamiento. [Límites de uso](https://ai.google.dev/gemini-api/docs/rate-limits)

Controles para producción:

- Un proveedor de IA por sala activa; los navegadores de audiencia solo reciben el mismo texto y no generan llamadas nuevas.
- Límite de salas simultáneas, gasto diario y presupuesto estimado antes de aceptar una fuente nueva.
- Desactivar la traducción adicional si la charla ya está en el idioma elegido.
- Medir el consumo real por idioma/modelo con una charla de 15 minutos antes de proyectar todo el día.
- Mostrar en producción las salas con error, 429, audio perdido, traducción estancada y costo aproximado acumulado.

## Red y continuidad

- Conectar la salida limpia de consola/mezclador por cable al equipo productor; esto evita que cancelación de eco, música de la web, compresión de streaming o un idioma doblado degraden ASR.
- Mantener WebSocket directo al proveedor cuando sea posible, usar Ethernet del recinto y ensayar por separado la red cableada, Wi-Fi y hotspot de respaldo.
- Mantener cola de audio pequeña y acotada. Si hay atraso, informar el hueco y descartar audio viejo; reproducir varios segundos atrasados convierte un fallo de red en subtítulos obsoletos.
- Reconectar con espera exponencial y variación aleatoria, evitar reintentos ilimitados que abran sesiones cobrables y usar el mecanismo de reanudación de sesión que provea el backend cuando esté disponible.
- Si se pierde Internet y no hay ASR/MT local instalado, no existe traducción nueva en tiempo real: mostrar el estado de desconexión con claridad. Si la continuidad offline es requisito, desplegar el servicio local en el recinto y sincronizar las transcripciones corregidas al recuperar conectividad.

## Métricas para afirmar “tiempo real”

Instrumentar tiempos por evento: `captura`, `ingreso al servidor`, `primer parcial original`, `primer parcial traducido`, `render en audiencia`; agregar bytes en cola, bloques descartados, reconexiones, errores/429, uso de GPU y costo/minuto. Medir en el productor y el backend con reloj monotónico; estimar diferencia de reloj mediante ping para comparar contra el teléfono de audiencia.

Metas iniciales, sujetas a medición en el recinto:

- Traducción visible desde captura: mediana ≤ 2 s y p95 ≤ 4 s en enlace cableado estable.
- Sin cola creciente: ningún proceso puede acumular audio más de 1 s sin marcar pérdida/atraso.
- Concurrencia: prueba de 30 salas por 60 minutos, con espectadores conectados, una sala con red deliberadamente degradada y al menos dos idiomas.
- Calidad: calcular WER/CER de la transcripción original, puntuar la traducción con revisión humana ciega y medir por separado nombres técnicos, números, negaciones y siglas.
- Recuperación: perder y recuperar el enlace del productor; verificar que la UI avise, la sesión retome o cree un nuevo flujo sin duplicar texto ni disparar llamadas ilimitadas.

Usar un conjunto de audios públicos o autorizados de Nerdearla, con texto de referencia preparado. Correr exactamente las mismas muestras en cada arquitectura y publicar p50/p95, calidad, costo por hora y requisitos de hardware. Así la demo muestra una comparación reproducible, no solo una traducción favorable elegida a mano.

## Ruta recomendada para la hackatón

1. **Ahora:** Gemini Live Translate sin glosario como perfil de baja latencia; cola de audio de 1 s y alarma de pérdida; capturar métricas reales desde captura a audiencia.
2. **Siguiente:** endpoint de token efímero con permiso por operador/sala y conexión directa navegador-Gemini; glosario ASR tomado de la agenda y perfil “preciso” que traduce la cola estabilizada.
3. **Comparativa abierta:** desplegar WhisperLiveKit como servicio opcional en una GPU de prueba; sumar SimulStreaming como referencia fuerte para evaluación de calidad/terminología.
4. **Producción:** una capa de adaptadores para proveedores, Redis Pub/Sub para propagar subtítulos entre réplicas, PostgreSQL para exportaciones persistentes y cuotas configurables por sala.
5. **Resiliencia:** perfil local con Whisper/Argos para cortes de Internet, claramente identificado como modo degradado.

Las transcripciones y configuración de sesiones se guardan en el volumen durable de Docker; el audio no se persiste. El servicio sigue diseñado para una réplica: distribuir espectadores o productores entre réplicas requiere almacenamiento y bus compartidos, balanceador con afinidad para los productores y validar permisos/costos. Redis Pub/Sub y PostgreSQL son el siguiente paso cuando se conozcan la cantidad de espectadores y la política de retención.
