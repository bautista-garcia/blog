// Scrollspy for the post-page table of contents: marks the link of the
// section currently at the top of the viewport.
const links = [...document.querySelectorAll('.toc a[href^="#"]')];

if (links.length) {
  const byHeading = new Map();
  for (const link of links) {
    const heading = document.getElementById(decodeURIComponent(link.hash.slice(1)));
    if (heading) byHeading.set(heading, link);
  }

  const onScroll = () => {
    let current = null;
    for (const heading of byHeading.keys()) {
      if (heading.getBoundingClientRect().top <= 120) current = heading;
      else break; // headings are in document order
    }
    for (const link of links) {
      link.classList.toggle('active', link === byHeading.get(current));
    }
  };

  document.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}
