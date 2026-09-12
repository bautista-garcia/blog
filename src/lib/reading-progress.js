const progressBar = document.querySelector('[data-reading-progress]');
const article = document.querySelector('[data-reading-article]');

if (progressBar instanceof HTMLElement && article instanceof HTMLElement) {
  const track = progressBar.querySelector('[role="progressbar"]');
  const remaining = progressBar.querySelector('[data-reading-remaining]');
  const totalMinutes = Number(progressBar.dataset.readingMinutes);
  let frame = 0;

  const update = () => {
    frame = 0;

    const articleTop = article.getBoundingClientRect().top + window.scrollY;
    const progressHeight = progressBar.offsetHeight;
    const readableHeight = window.innerHeight - progressHeight;
    const scrollableDistance = Math.max(1, article.offsetHeight - readableHeight);
    const distanceRead = window.scrollY + progressHeight - articleTop;
    const progress = Math.min(1, Math.max(0, distanceRead / scrollableDistance));
    const percentage = Math.round(progress * 100);
    const minutesLeft = Math.max(1, Math.round(totalMinutes * (1 - progress)));

    progressBar.style.setProperty('--reading-progress', String(progress));

    if (track instanceof HTMLElement) {
      track.setAttribute('aria-valuenow', String(percentage));
      track.setAttribute('aria-valuetext', `${percentage}% read`);
    }

    if (remaining instanceof HTMLElement) {
      if (percentage >= 99) {
        remaining.textContent = 'Finished';
      } else if (progress >= 0.9) {
        remaining.textContent = 'Less than 1 min left';
      } else {
        remaining.textContent = `${minutesLeft} min left`;
      }
    }
  };

  const requestUpdate = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(update);
  };

  window.addEventListener('scroll', requestUpdate, { passive: true });
  window.addEventListener('resize', requestUpdate, { passive: true });
  update();
}
