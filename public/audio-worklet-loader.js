const workletLoadsByContext = new WeakMap();

/**
 * AudioWorklet modules belong to one AudioContext. Cache each load on its
 * context so multiple independent room captures can initialize in parallel.
 */
export function loadAudioWorklet(audioContext, moduleUrl) {
  let loading = workletLoadsByContext.get(audioContext);
  if (!loading) {
    loading = audioContext.audioWorklet.addModule(moduleUrl);
    workletLoadsByContext.set(audioContext, loading);
  }
  return loading.catch((error) => {
    workletLoadsByContext.delete(audioContext);
    throw error;
  });
}
