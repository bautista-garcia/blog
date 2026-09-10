import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import sharp from 'sharp';

interface SocialCardProps {
  title: string;
  date: Date;
  tags: string[];
}

export async function getStaticPaths() {
  const posts = await getCollection('posts', ({ data }) =>
    import.meta.env.PROD ? !data.draft : true,
  );

  return posts.map((post) => ({
    params: { slug: post.id },
    props: {
      title: post.data.title,
      date: post.data.date,
      tags: post.data.tags,
    } satisfies SocialCardProps,
  }));
}

const escapeXml = (value: string) =>
  value.replace(/[<>&"']/g, (character) => {
    const entities: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      '"': '&quot;',
      "'": '&apos;',
    };
    return entities[character];
  });

function wrapTitle(title: string, maxCharacters: number) {
  const words = title.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];

  for (const word of words) {
    const current = lines.at(-1);
    if (!current || `${current} ${word}`.length > maxCharacters) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
  }

  if (lines.length > 3) {
    lines[2] = lines.slice(2).join(' ');
    return lines.slice(0, 3);
  }

  return lines;
}

function renderCard({ title, date, tags }: SocialCardProps) {
  const fontSize = title.length > 60 ? 68 : title.length > 34 ? 80 : 92;
  const maxCharacters = title.length > 60 ? 30 : title.length > 34 ? 27 : 23;
  const lines = wrapTitle(title, maxCharacters);
  const lineHeight = Math.round(fontSize * 1.04);
  const blockHeight = lines.length * lineHeight;
  const firstBaseline = 150 + Math.round((330 - blockHeight) / 2) + Math.round(fontSize * 0.82);
  const titleMarkup = lines
    .map(
      (line, index) =>
        `<tspan x="76" y="${firstBaseline + index * lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join('');
  const formattedDate = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
    .format(date)
    .toUpperCase();
  const topic = (tags[0] ?? 'LLM SYSTEMS').replace(/-/g, ' ').toUpperCase();

  return `
    <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="paper" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="3" seed="11" />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer><feFuncA type="table" tableValues="0 0.055" /></feComponentTransfer>
        </filter>
      </defs>
      <rect width="1200" height="630" fill="#f4f1e9" />
      <rect width="1200" height="630" filter="url(#paper)" opacity="0.55" />

      <g fill="none" stroke="#d8d5cc" stroke-width="1" stroke-dasharray="5 6" opacity="0.78">
        <path d="M76 488H1124" />
        <path d="M768 120V552" />
        <path d="M930 120V552" />
        <path d="M1080 120V552" />
      </g>

      <path d="M76 70H118" stroke="#992f20" stroke-width="2" />
      <text x="136" y="77" fill="#992f20" font-family="Arial, sans-serif" font-size="18" font-weight="700" letter-spacing="4">ENGINEERING NOTE</text>

      <text fill="#171916" font-family="Georgia, 'Times New Roman', serif" font-size="${fontSize}" font-weight="600" letter-spacing="-2">${titleMarkup}</text>

      <path d="M630 486C812 486 925 480 1000 453C1052 434 1088 414 1124 410" fill="none" stroke="#992f20" stroke-width="2" />
      <circle cx="1124" cy="410" r="6" fill="#992f20" />
      <path d="M76 552H1124" stroke="#bdbab0" stroke-width="1" />
      <text x="76" y="591" fill="#72746c" font-family="Arial, sans-serif" font-size="17" font-weight="700" letter-spacing="2">${escapeXml(topic)} · ${formattedDate}</text>
      <text x="1124" y="591" text-anchor="end" fill="#992f20" font-family="Arial, sans-serif" font-size="17" font-weight="700" letter-spacing="2">READ THE BLOG ↗</text>
    </svg>
  `;
}

export const GET: APIRoute = async ({ props }) => {
  const png = await sharp(Buffer.from(renderCard(props as SocialCardProps)))
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();

  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
