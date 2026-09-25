# Evaluación de calidad y latencia

Guardá referencias autorizadas como JSON Lines. Una charla se puede dividir en fragmentos alineados por tiempo; usá los mismos audios y glosarios al comparar modelos.

```json
{"session":"track-a-01","language":"en","reference":"Kubernetes schedules containers across nodes.","hypothesis":"Kubernetes schedules containers across nodes.","terms":["Kubernetes"],"latencyMs":1850,"humanTranslationScore":4}
```

Campos requeridos: `reference` y `hypothesis`. `terms`, `latencyMs` y `humanTranslationScore` son opcionales. El puntaje humano sugerido es de 1 a 5, con evaluadores que no sepan qué motor generó cada traducción.

```sh
node scripts/evaluate-quality.mjs benchmarks/references.jsonl
```

El informe calcula WER, recall de nombres y términos requeridos, p50/p95 de latencia y promedio de evaluación humana cuando hay puntuaciones. WER mide reconocimiento; no sustituye una revisión semántica de la traducción. No guardes datos privados en el conjunto de evaluación sin autorización.

Para aceptación operativa, hacé un soak de 30 salas por la duración máxima prevista, usá una muestra de espectadores basada en el aforo del evento y registrá resultados separados para red estable y red degradada. La aplicación ofrece ahora medición en vivo; esta evaluación compara la calidad de los textos exportados.
