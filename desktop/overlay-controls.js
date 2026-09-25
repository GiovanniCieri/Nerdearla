const sessionId = new URL(location.href).searchParams.get('session') || '';
const moveButton = document.querySelector('#moveOverlay');
const closeButton = document.querySelector('#closeOverlay');

moveButton.addEventListener('click', async () => {
  moveButton.disabled = true;
  const result = await window.nerdearlaDesktop.controlCaptionOverlay(sessionId, 'toggle-move');
  moveButton.disabled = false;
  if (!result?.ok) return;
  const label = result.clickThrough ? 'Mover' : 'Fijar';
  moveButton.querySelector('span').textContent = label;
  moveButton.title = result.clickThrough
    ? 'Habilitar movimiento de los subtítulos'
    : 'Fijar la posición y volver a dejar pasar los clics';
});

closeButton.addEventListener('click', async () => {
  closeButton.disabled = true;
  const result = await window.nerdearlaDesktop.controlCaptionOverlay(sessionId, 'close');
  if (!result?.ok) closeButton.disabled = false;
});
