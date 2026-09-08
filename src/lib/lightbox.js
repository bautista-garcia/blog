// Click-to-zoom lightbox for images and diagrams inside post content.
// Opens the image at up to near-viewport size; click anywhere or Esc closes.

function openLightbox(img) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', img.alt || 'Image preview');

  const zoomed = document.createElement('img');
  zoomed.src = img.currentSrc || img.src;
  zoomed.alt = img.alt || '';
  if (
    img.classList.contains('excalidraw-diagram') ||
    (img.getAttribute('src')?.includes('/assets/diagrams/') && /\.svg(?:$|[?#])/i.test(img.getAttribute('src')))
  ) {
    zoomed.classList.add('excalidraw-diagram');
  }
  // The width attribute constrains the inline copy; the zoom should be free.
  // (fresh element — no width/height attributes are set)
  overlay.appendChild(zoomed);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  const close = () => {
    overlay.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
}

document.addEventListener('click', (e) => {
  const img = e.target.closest?.('.prose img');
  if (img) openLightbox(img);
});
