import { computeCoverGeometry, ebookCoverGeometry } from './cover/geometry';
import { rasterizeSvg } from './cover/raster';
import { starterCoverDesign } from './cover/starter';
import type { CoverDesign } from './cover/schema';
import type { InteriorDocumentInput, PageInstanceInput } from './interior/schema';
import type { MetadataDraftInput } from './metadata';
import type { PipelineAsset, ProductInput } from './pipeline';

/**
 * Fixture projects used by automated tests and `npm run fixtures`. All text is original.
 * Each fixture targets a different KDP format so that format-specific rules are exercised.
 */

const kw = (keyword: string, evidence: string) => ({ keyword, source: 'Fixture research notes', recordedAt: '2026-10-10', evidence });

/* ------------------------------------------------------------------------------------------ */
/* 1. 100-page 6×9 black & white paperback guided journal                                       */
/* ------------------------------------------------------------------------------------------ */
const JOURNAL_PROMPTS = [
  'What would make this morning feel unhurried?',
  'Name one thing you can let go of today.',
  'Which small task, once done, would make the day lighter?',
  'Describe the first sound you noticed when you woke up.',
  'Who could you thank today, and for what?',
  'What does "enough" look like for today?',
  'Where in your body are you holding tension right now?',
  'What is one boundary you want to keep today?',
  'Recall a recent moment when you felt capable.',
  'What would you do today if you trusted yourself a little more?',
  'Which conversation are you avoiding, and what is the first sentence?',
  'What are you looking forward to this week?',
  'List three things within reach that you are glad to have.',
  'How do you want to feel at the end of today?',
  'What did yesterday teach you?',
  'Which habit is quietly helping you right now?',
  'What is a kind thing you can say to yourself today?',
  'Where could you add five minutes of stillness?',
  'What would a calmer version of you do differently this morning?',
  'Describe the light in the room right now.',
  'What is one decision you can simplify?',
  'Which worry can wait until later?',
  'What are you curious about lately?',
  'What would make tonight restful?',
  'Write about a place where you feel at ease.',
  'What is something you are learning slowly?',
  'Who makes your days easier, and how?',
  'What can you say no to this week?',
  'What is one thing you did well yesterday?',
  'If today had a theme, what would it be?',
  'What would you like to remember about this season of life?',
  'Which small pleasure will you notice today?',
  'What does progress look like for you this month?',
  'What helps you return to calm when you get distracted?',
  'Describe a morning routine you would enjoy.',
  'What can you finish instead of start today?',
  'What are you ready to forgive?',
  'Which promise to yourself matters most this week?',
  'What made you smile recently?',
  'What would you tell a friend who felt the way you feel today?',
  'Which part of your day deserves more attention?',
  'What are you proud of that nobody else noticed?',
  'What would make your workspace feel calmer?',
  'Where do you want to spend your energy today?',
  'What did you notice on your last walk outside?',
  'What question do you want to carry through today?',
  'How have your mornings changed since you started this journal?',
  'What will you keep doing after these pages are full?',
];

export function journalFixture(): ProductInput {
  const body: PageInstanceInput[] = [];
  JOURNAL_PROMPTS.forEach((prompt, i) => {
    body.push({ id: `g${i + 1}`, templateId: 'guided-writing', fields: { prompt, takeawayLabel: i % 7 === 6 ? 'Weekly reflection' : 'One thing to remember' } });
    body.push({ id: `l${i + 1}`, templateId: 'lined-journal', fields: { prompt: '' } });
  });
  const document: InteriorDocumentInput = {
    settings: { title: 'Quiet Mornings', author: 'Ava Lindqvist', margins: { insideIn: 0.5, outsideIn: 0.5, topIn: 0.55, bottomIn: 0.5 } },
    frontMatter: [
      { id: 'title', templateId: 'title-page', fields: { subtitle: 'A guided journal for calmer, more intentional starts' } },
      { id: 'copyright', templateId: 'copyright-page', fields: { year: '2026', extra: 'This journal is not a substitute for professional advice.' } },
      {
        id: 'howto',
        templateId: 'how-to-use',
        fields: {
          body: 'Each spread pairs a short prompt with open lined space. Write for five minutes before checking your phone. There is no wrong answer and no need to fill every line. Every seventh prompt invites a weekly reflection, so you can notice patterns over time.\n\nIf a prompt does not fit your day, skip it and use the lined page freely.',
        },
      },
      { id: 'belongs', templateId: 'belongs-to' },
    ],
    body: { kind: 'pages', pages: body },
  };
  const metadata: MetadataDraftInput = {
    title: 'Quiet Mornings',
    subtitle: 'A guided journal for calmer, more intentional starts',
    author: 'Ava Lindqvist',
    description:
      'Quiet Mornings pairs 48 reflective prompts with open lined pages for people who want a gentler start to the day. Each prompt takes about five minutes, and weekly reflection pages help you notice what is changing.',
    categories: ['Self-Help > Journal Writing'],
    keywords: [kw('morning journal for women', 'Observed as a common search phrasing in manual autocomplete check'), kw('guided reflection prompts', 'Matches book content; reader survey phrasing'), kw('mindful writing notebook', 'Manual autocomplete check')],
    language: 'English',
    lowContent: false,
  };
  return {
    projectId: 'fixture-journal',
    format: 'PAPERBACK',
    trimId: '6x9',
    ink: 'BLACK_WHITE',
    paper: 'CREAM',
    bleed: false,
    contentClass: 'MEDIUM',
    category: 'GUIDED_JOURNAL',
    document,
    metadata,
    cover: null,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* 2. 8.5×11 paperback workbook                                                                */
/* ------------------------------------------------------------------------------------------ */
const AREAS: { name: string; intro: string; checks: string[]; questions: [string, string, string] }[] = [
  {
    name: 'Kitchen',
    intro: 'The kitchen combines heat, water, and appliances that run every day, which makes it a good place to start. Work through the checklist with the appliances off.',
    checks: ['Refrigerator door seal closes on a sheet of paper', 'Freezer has no frost build-up', 'Oven door seal is intact', 'Dishwasher runs only when full', 'Range hood vents outdoors', 'Faucet aerator fitted', 'No drips under the sink'],
    questions: ['Which appliance in your kitchen is the oldest, and how often is it used?', 'Where could you reduce standby power (chargers, displays, coffee makers)?', 'What one change could you make this week at no cost?'],
  },
  {
    name: 'Bathroom',
    intro: 'Bathrooms use the most hot water in many homes. Small fixes here often pay back quickly.',
    checks: ['Shower head flow measured (bucket test)', 'Toilet does not run after flushing', 'Extractor fan clears steam within 15 minutes', 'Hot water pipes insulated where visible', 'No condensation damage on window frames'],
    questions: ['How long is a typical shower in your household?', 'Is your water heater temperature set higher than needed?', 'Which repair here would you ask a professional to quote?'],
  },
  {
    name: 'Living areas',
    intro: 'Drafts and lighting dominate in living spaces. Choose a windy day to find air leaks with a lit incense stick or a strip of tissue.',
    checks: ['Window frames checked for drafts', 'Door sweeps in place on exterior doors', 'Curtains close fully at night', 'Lighting uses efficient bulbs', 'Entertainment devices on a switchable power strip'],
    questions: ['Where did you feel the strongest draft?', 'Which rooms are heated but rarely used?', 'What would make this room comfortable at a lower thermostat setting?'],
  },
  {
    name: 'Attic and roof space',
    intro: 'Heat rises, so attic insulation matters. Only enter an attic if it is safe to do so, and never step between joists.',
    checks: ['Insulation depth measured in three places', 'Loft hatch insulated and sealed', 'No daylight visible through the roof', 'Pipes and tanks insulated', 'Vents not blocked by insulation'],
    questions: ['What insulation depth did you measure, and where was it thinnest?', 'Is there evidence of moisture or pests?', 'Would this job need a contractor, and what would you ask them?'],
  },
  {
    name: 'Heating and cooling',
    intro: 'Heating and cooling systems need regular maintenance to run efficiently. Record model numbers so service visits are faster.',
    checks: ['Filter replaced within the recommended interval', 'Thermostat schedule matches your routine', 'Radiators or vents unobstructed', 'Outdoor unit clear of leaves', 'Service date recorded'],
    questions: ['When was the system last serviced?', 'Does the thermostat schedule match when people are home?', 'Which rooms are hardest to keep comfortable?'],
  },
  {
    name: 'Exterior',
    intro: 'Walk around the outside of the home slowly. Gaps around pipes, cables, and vents are common sources of drafts.',
    checks: ['Gaps around pipes and cables sealed', 'Gutters clear', 'External doors close firmly', 'Window sills in good condition', 'Outdoor lights on timers or sensors'],
    questions: ['Which gaps did you find, and what size were they?', 'What seasonal maintenance should go on your calendar?', 'What will you tackle first, and when?'],
  },
];

export function workbookFixture(): ProductInput {
  const pages: PageInstanceInput[] = [];
  AREAS.forEach((a, i) => {
    pages.push({ id: `ch${i + 1}`, templateId: 'chapter-page', fields: { chapterLabel: `Part ${i + 1}`, chapterTitle: a.name, intro: a.intro } });
    pages.push({
      id: `chk${i + 1}`,
      templateId: null,
      elements: [
        { id: 'h', type: 'heading', text: `${a.name} checklist`, style: { sizePt: 18, bold: true, font: 'sans', align: 'left' } },
        { id: 'meta', type: 'fields', fields: [{ label: 'Date', width: 1 }, { label: 'Checked by', width: 1.5 }] },
        {
          id: 't',
          type: 'table',
          columns: [{ header: 'Check', width: 4 }, { header: 'OK', width: 0.6 }, { header: 'Fix', width: 0.6 }, { header: 'Notes', width: 3 }],
          rows: a.checks.length + 3,
          rowHeightPt: 30,
          cells: a.checks.map((c) => [c]),
          height: { mode: 'auto' },
          marginTopPt: 8,
        },
        { id: 'n', type: 'box', label: 'Observations', linesInside: 24, height: { mode: 'fill', weight: 1 }, marginTopPt: 12 },
      ],
    });
    pages.push({ id: `ex${i + 1}`, templateId: 'workbook-exercise', fields: { exerciseTitle: `${a.name}: reflect and plan`, instructions: 'Answer in your own words. Short notes are fine.', q1: a.questions[0], q2: a.questions[1], q3: a.questions[2] } });
    pages.push({
      id: `plan${i + 1}`,
      templateId: null,
      elements: [
        { id: 'h', type: 'heading', text: `${a.name}: action plan`, style: { sizePt: 18, bold: true, font: 'sans', align: 'left' } },
        { id: 't', type: 'table', columns: [{ header: 'Action', width: 4 }, { header: 'Cost estimate', width: 1.4 }, { header: 'Target date', width: 1.4 }, { header: 'Done', width: 0.8 }], rows: 0, rowHeightPt: 30, height: { mode: 'fill', weight: 1 }, marginTopPt: 8 },
      ],
    });
  });
  const document: InteriorDocumentInput = {
    settings: { title: 'The Home Energy Check-Up Workbook', author: 'Marcus Oyelaran', margins: { insideIn: 0.75, outsideIn: 0.6, topIn: 0.6, bottomIn: 0.6 }, pageNumbers: { enabled: true, position: 'outside' } },
    frontMatter: [
      { id: 'title', templateId: 'title-page', fields: { subtitle: 'A room-by-room workbook for finding drafts, waste, and easy savings' } },
      { id: 'copyright', templateId: 'copyright-page', fields: { year: '2026', extra: 'Safety: switch off power before inspecting electrical items and consult a qualified professional for repairs.' } },
      {
        id: 'howto',
        templateId: 'how-to-use',
        fields: {
          body: 'Each part covers one area of the home. Start with the checklist, then answer the reflection questions, then turn what you found into an action plan with dates and costs. Revisit the workbook each season and compare your notes.',
        },
      },
      { id: 'toc', templateId: 'toc' },
    ],
    body: { kind: 'pages', pages },
    backMatter: [
      { id: 'notes1', templateId: 'notes-page' },
      { id: 'notes2', templateId: 'notes-page' },
    ],
  };
  return {
    projectId: 'fixture-workbook',
    format: 'PAPERBACK',
    trimId: '8.5x11',
    ink: 'BLACK_WHITE',
    paper: 'WHITE',
    bleed: false,
    contentClass: 'MEDIUM',
    category: 'WORKBOOK',
    document,
    metadata: {
      title: 'The Home Energy Check-Up Workbook',
      subtitle: 'A room-by-room workbook for finding drafts, waste, and easy savings',
      author: 'Marcus Oyelaran',
      description: 'A practical workbook that walks homeowners and renters through six areas of the home with checklists, reflection questions, and action plans.',
      categories: ['House & Home > Energy Efficiency'],
      keywords: [kw('home energy audit checklist', 'Matches content'), kw('draft proofing workbook', 'Matches content')],
      language: 'English',
    },
    cover: null,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* 3. 6×9 hardcover maintenance logbook                                                        */
/* ------------------------------------------------------------------------------------------ */
export function hardcoverFixture(): ProductInput {
  const pages: PageInstanceInput[] = [];
  for (let i = 0; i < 116; i++) pages.push({ id: `p${i + 1}`, templateId: i % 4 === 3 ? 'equipment-inspection' : 'work-order-log', fields: {} });
  return {
    projectId: 'fixture-hardcover',
    format: 'HARDCOVER',
    trimId: '6x9',
    ink: 'BLACK_WHITE',
    paper: 'WHITE',
    bleed: false,
    contentClass: 'LOW',
    category: 'LOGBOOK',
    document: {
      settings: { title: 'Workshop Maintenance Log', author: 'Northbank Press', margins: { insideIn: 0.6, outsideIn: 0.5, topIn: 0.5, bottomIn: 0.5 } },
      frontMatter: [
        { id: 'title', templateId: 'title-page', fields: { subtitle: 'Work orders and equipment inspections for small workshops' } },
        { id: 'copyright', templateId: 'copyright-page', fields: { year: '2026' } },
        { id: 'howto', templateId: 'how-to-use', fields: { body: 'Log every job on a work-order page and complete an inspection page each week for each critical machine. Keep this book with the equipment so the history travels with it.' } },
        { id: 'belongs', templateId: 'belongs-to' },
      ],
      body: { kind: 'pages', pages },
    },
    // EXAMPLE geometry for automated tests only. For a real hardcover, enter the values from
    // KDP's cover calculator for the exact trim and final page count.
    officialCover: { fullWidthIn: 13.917, fullHeightIn: 10.25, spineWidthIn: 0.5, wrapIn: 0.51, hingeIn: 0.4, pageCount: 120, sourceNote: 'EXAMPLE values for tests — replace with KDP cover calculator output', importedAt: '2026-10-10' },
    metadata: {
      title: 'Workshop Maintenance Log',
      subtitle: 'Work orders and equipment inspections for small workshops',
      author: 'Northbank Press',
      description: 'A durable hardcover log for recording work orders and weekly equipment inspections in small workshops and maker spaces.',
      categories: ['Business > Operations'],
      keywords: [kw('equipment maintenance log book', 'Matches content')],
      language: 'English',
      lowContent: true,
    },
    cover: null,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* 4. Reflowable Kindle eBook                                                                   */
/* ------------------------------------------------------------------------------------------ */
export function ebookFixture(): ProductInput {
  const p = (text: string) => ({ type: 'paragraph' as const, text });
  return {
    projectId: 'fixture-ebook',
    format: 'EBOOK',
    trimId: '6x9',
    ink: 'BLACK_WHITE',
    paper: 'WHITE',
    bleed: false,
    contentClass: 'FULL',
    category: 'NONFICTION',
    document: {
      settings: { title: 'Balcony Harvest', author: 'Lena Moreau' },
      frontMatter: [],
      body: {
        kind: 'flow',
        chapters: [
          {
            id: 'c1',
            title: 'Start With the Light You Have',
            blocks: [
              p('Before buying a single seed, spend one ordinary day watching your balcony. Note when direct sun arrives, when it leaves, and which corners stay bright but shaded. A small notebook and three time checks — morning, midday, and late afternoon — are enough.'),
              p('Most fruiting vegetables want six or more hours of direct sun. Leafy greens and many herbs will tolerate three or four. If your space faces north, that is not a failure; it is information, and it points you toward lettuce, chard, mint, and parsley rather than tomatoes.[^1]'),
              { type: 'heading', text: 'Reading wind and reflected heat', level: 2 },
              p('Balconies are often windier than gardens at ground level, and walls can bounce heat back onto plants. A plant that thrives on a sheltered patio may scorch beside a pale wall. Move a container a few steps and the conditions can change completely.'),
              { type: 'list', items: ['Record sun hours for one day per season.', 'Check whether railings funnel wind.', 'Touch the wall at mid-afternoon to feel stored heat.'] },
            ],
            notes: ['Exact light needs vary by variety; seed packets usually state the minimum.'],
          },
          {
            id: 'c2',
            title: 'Containers That Work Hard',
            blocks: [
              p('A container is a small, closed world. It needs drainage, enough volume to buffer heat and drought, and a weight your balcony can safely carry. Before filling large pots, check any building rules about load and water runoff.'),
              p('Fabric pots breathe and cool by evaporation; glazed ceramic holds moisture longer; plastic is light and cheap. None is perfect. Choose by what you can lift, what you can water consistently, and what will survive your winters.'),
              { type: 'quote', text: 'The best container is the one you will still be watering in August.' },
              p('Group pots so that thirsty plants share a spot near the door. You will check them more often simply because you pass them every day.'),
            ],
            notes: [],
          },
          {
            id: 'c3',
            title: 'Soil, Water, and Feeding',
            blocks: [
              p('Garden soil compacts in pots. Use a peat-free potting mix, refresh the top few centimetres each spring, and add compost if you have it. Water deeply and less often rather than a splash every day; roots follow moisture downward.'),
              p('A simple test beats any schedule: push a finger into the mix up to the second knuckle. If it is dry there, water until it runs from the drainage holes. In heat waves, check twice a day.'),
              { type: 'sectionBreak' },
              p('Container plants run out of nutrients faster than plants in the ground. A balanced liquid feed every two weeks during the growing season keeps leafy crops productive; fruiting crops benefit from a feed higher in potassium once flowers appear.'),
            ],
            notes: [],
          },
          {
            id: 'c4',
            title: 'A First Season Plan',
            blocks: [
              p('Start smaller than you think. Three containers you look after well will teach you more than twelve you rush past. A good first set is one pot of mixed salad leaves, one of a compact herb such as thyme, and one fruiting plant suited to your light.'),
              { type: 'list', ordered: true, items: ['Early spring: sow salad leaves indoors on a bright windowsill.', 'Mid spring: move hardy herbs outside.', 'After the last frost: plant out tender crops.', 'Summer: harvest little and often.', 'Autumn: sow winter greens and clean empty pots.'] },
              p('Keep notes as you go. A single line per week — what you sowed, what you harvested, what struggled — becomes next year’s best guide.'),
            ],
            notes: [],
          },
        ],
      },
      backMatter: [],
    },
    metadata: {
      title: 'Balcony Harvest',
      subtitle: 'Growing food in small spaces, one container at a time',
      author: 'Lena Moreau',
      description: 'A short, practical guide to growing salad leaves, herbs, and compact vegetables on a balcony: reading light and wind, choosing containers, watering, feeding, and planning a first season.',
      categories: ['Crafts, Hobbies & Home > Gardening > Container'],
      keywords: [kw('balcony vegetable garden', 'Matches content'), kw('container gardening for beginners', 'Matches content')],
      language: 'English',
    },
    cover: null,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* 5. Bleed-enabled illustrated paperback (8.5×8.5, premium color)                              */
/* ------------------------------------------------------------------------------------------ */
const STORY = [
  'Pip lived at the edge of a quiet town, where the hills folded into the sky.',
  'Every evening, Pip carried a small paper lantern up the hill to watch the moon rise.',
  'One night the moon did not come. The sky stayed dark and very still.',
  'Pip asked the owl. "Have you seen the moon?" The owl only blinked, slowly.',
  'Pip asked the fox, who was busy and said, "Try the river. Rivers remember things."',
  'At the river, Pip found the moon’s reflection, shy and wobbling on the water.',
  '"I was tired," whispered the reflection. "It is a long way up for one small light."',
  'So Pip held up the paper lantern, and the river carried its glow to the sky.',
  'Little by little, the moon climbed back above the hills, glowing softly.',
  'Now, every evening, the whole town brings lanterns, so the moon is never lonely.',
  'And Pip still walks up the hill, to say goodnight to an old friend.',
  'The End.',
];

function illustrationSvg(i: number, wPx: number, hPx: number): string {
  const sky = [['#1B2541', '#3B4A7A'], ['#24324F', '#5E6FA3'], ['#0E1730', '#2C3C66'], ['#2A1F45', '#5B4B8A']][i % 4];
  const hill = ['#2F5D50', '#3C6E5A', '#285246', '#41725F'][i % 4];
  const moonX = 0.2 + ((i * 0.13) % 0.6);
  const lanterns = Array.from({ length: (i % 5) + 1 }, (_, k) => `<circle cx="${(0.15 + k * 0.17) * wPx}" cy="${(0.62 - (k % 2) * 0.04) * hPx}" r="${0.018 * wPx}" fill="#F6C85F"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${wPx}" height="${hPx}" viewBox="0 0 ${wPx} ${hPx}">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient></defs>
<rect width="${wPx}" height="${hPx}" fill="url(#s)"/>
${i === 2 ? '' : `<circle cx="${moonX * wPx}" cy="${0.25 * hPx}" r="${0.09 * wPx}" fill="#F4EBC8"/>`}
<path d="M0 ${0.7 * hPx} Q ${0.3 * wPx} ${0.55 * hPx} ${0.6 * wPx} ${0.68 * hPx} T ${wPx} ${0.62 * hPx} V ${hPx} H 0 Z" fill="${hill}"/>
<path d="M0 ${0.82 * hPx} Q ${0.4 * wPx} ${0.72 * hPx} ${wPx} ${0.85 * hPx} V ${hPx} H 0 Z" fill="#1F3F37"/>
${lanterns}
</svg>`;
}

export function illustratedFixture(): ProductInput {
  // 8.5" × 8.5" with bleed: media is 8.625" × 8.75". Rendering at 320 DPI keeps every image ≥ 300 DPI.
  const wPx = Math.ceil(8.625 * 320);
  const hPx = Math.ceil(8.75 * 320);
  const assets: Record<string, PipelineAsset> = {};
  const pages: PageInstanceInput[] = [];
  STORY.forEach((line, i) => {
    const id = `illus-${i + 1}`;
    assets[id] = { bytes: rasterizeSvg(illustrationSvg(i, wPx, hPx), wPx), mimeType: 'image/png', source: 'SYSTEM', licenseNote: 'Generated procedurally by the fixture; original.' };
    pages.push({ id: `img${i + 1}`, templateId: null, elements: [{ id: 'art', type: 'image', assetId: id, fit: 'cover', fullBleed: true }] });
    pages.push({
      id: `txt${i + 1}`,
      templateId: null,
      elements: [
        { id: 'sp', type: 'spacer', height: { mode: 'fill', weight: 1 } },
        { id: 't', type: 'text', text: line, style: { font: 'serif', sizePt: 22, align: 'center', lineHeight: 1.4 } },
        { id: 'sp2', type: 'spacer', height: { mode: 'fill', weight: 1.3 } },
      ],
    });
  });
  return {
    projectId: 'fixture-illustrated',
    format: 'PAPERBACK',
    trimId: '8.5x8.5',
    ink: 'PREMIUM_COLOR',
    paper: 'WHITE',
    bleed: true,
    contentClass: 'MEDIUM',
    category: 'ILLUSTRATED',
    document: {
      settings: { title: 'Pip and the Lantern Moon', author: 'Rosa Kettering', margins: { insideIn: 0.5, outsideIn: 0.5, topIn: 0.5, bottomIn: 0.5 }, pageNumbers: { enabled: false } },
      frontMatter: [
        { id: 'title', templateId: 'title-page', fields: { subtitle: 'A bedtime story about kindness and light' } },
        { id: 'copyright', templateId: 'copyright-page', fields: { year: '2026', extra: 'Illustrations created for this edition.' } },
        { id: 'ded', templateId: null, elements: [{ id: 'sp', type: 'spacer', height: { mode: 'fill', weight: 1 } }, { id: 'd', type: 'text', text: 'For everyone who has ever kept a light on for someone else.', style: { italic: true, align: 'center', sizePt: 14 } }, { id: 'sp2', type: 'spacer', height: { mode: 'fill', weight: 1 } }] },
        { id: 'blank1', templateId: 'blank' },
      ],
      body: { kind: 'pages', pages },
    },
    assets,
    metadata: {
      title: 'Pip and the Lantern Moon',
      subtitle: 'A bedtime story about kindness and light',
      author: 'Rosa Kettering',
      description: 'When the moon is too tired to rise, a child named Pip finds a gentle way to help. A calm bedtime picture book about kindness, community, and light.',
      categories: ["Children's Books > Bedtime & Dreaming"],
      keywords: [kw('bedtime story picture book', 'Matches content')],
      language: 'English',
      readingAgeMin: 3,
      readingAgeMax: 7,
    },
    cover: null,
  };
}

export const FIXTURES = {
  journal: journalFixture,
  workbook: workbookFixture,
  hardcover: hardcoverFixture,
  ebook: ebookFixture,
  illustrated: illustratedFixture,
} as const;
export type FixtureName = keyof typeof FIXTURES;

/**
 * Attach a starter cover once the final page count is known (cover geometry depends on it).
 * Mirrors the application flow: interior first, then cover.
 */
export function withStarterCover(input: ProductInput, pageCount: number, themeId = 'midnight'): ProductInput {
  const m = input.metadata as MetadataDraftInput;
  const geom =
    input.format === 'EBOOK'
      ? ebookCoverGeometry()
      : computeCoverGeometry({ format: input.format, trimId: input.trimId, pageCount, ink: input.ink, paper: input.paper, direction: input.direction, official: input.officialCover ?? null });
  const cover: CoverDesign = starterCoverDesign(geom, { title: m.title ?? '', subtitle: m.subtitle, author: m.author ?? '', backText: m.description, themeId });
  return { ...input, cover };
}
