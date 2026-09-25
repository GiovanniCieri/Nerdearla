export function buildGeminiTranscriptionConfig(session, resumeHandle) {
  return {
    responseModalities: ['TEXT'],
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
    inputAudioTranscription: {
      // Leave language identification to Gemini. This keeps the live setup
      // compatible with API/model versions that reject the optional hint.
      ...(session.glossary?.length ? { customVocabulary: session.glossary } : {}),
    },
  };
}
