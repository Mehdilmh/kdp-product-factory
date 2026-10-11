import { PageTemplate, type PageTemplateInput } from './schema';

/**
 * Built-in page templates. Each has configurable fields ({{key}} placeholders), predictable
 * pagination (one instance = one page), and printable line weights (≥ 0.5pt).
 */
const defs: PageTemplateInput[] = [
  {
    id: 'lined-journal',
    name: 'Lined journal page',
    category: 'journal',
    description: 'Date field and ruled writing lines.',
    fields: [
      { key: 'prompt', label: 'Optional heading', default: '' },
      { key: 'lineSpacing', label: 'Line spacing (pt)', type: 'number', default: 24 },
    ],
    elements: [
      { id: 'date', type: 'fields', fields: [{ label: 'Date', width: 1 }], rowHeightPt: 22 },
      { id: 'prompt', type: 'heading', text: '{{prompt}}', style: { sizePt: 13, bold: true, align: 'left', font: 'serif' }, marginBottomPt: 4 },
      { id: 'lines', type: 'lines', spacingPt: 24, weightPt: 0.6 },
    ],
  },
  {
    id: 'guided-writing',
    name: 'Guided writing page',
    category: 'journal',
    description: 'A reflective prompt followed by writing lines and a takeaway box.',
    fields: [
      { key: 'prompt', label: 'Prompt', default: 'What is one small thing that went well today, and why?' },
      { key: 'takeawayLabel', label: 'Takeaway label', default: 'One thing to remember' },
    ],
    elements: [
      { id: 'date', type: 'fields', fields: [{ label: 'Date', width: 1 }, { label: 'Mood (1–5)', width: 1 }], rowHeightPt: 22 },
      { id: 'prompt', type: 'text', text: '{{prompt}}', style: { sizePt: 12, italic: true, font: 'serif', align: 'left' }, marginTopPt: 6, marginBottomPt: 6 },
      { id: 'lines', type: 'lines', spacingPt: 22, weightPt: 0.6, height: { mode: 'fill', weight: 4 } },
      { id: 'takeaway', type: 'box', label: '{{takeawayLabel}}', linesInside: 22, height: { mode: 'fill', weight: 1 }, marginTopPt: 8 },
    ],
  },
  {
    id: 'daily-planner',
    name: 'Daily planner',
    category: 'planner',
    fields: [{ key: 'startHour', label: 'First hour', type: 'number', default: 7 }],
    elements: [
      { id: 'date', type: 'fields', fields: [{ label: 'Date', width: 2 }, { label: 'Day', width: 1 }], rowHeightPt: 22 },
      {
        id: 'cols',
        type: 'columns',
        gapPt: 12,
        columns: [
          {
            width: 3,
            elements: [
              { id: 'schedTitle', type: 'heading', text: 'Schedule', style: { sizePt: 10, bold: true, font: 'sans', align: 'left' } },
              {
                id: 'schedule',
                type: 'table',
                columns: [{ header: 'Time', width: 1 }, { header: 'Plan', width: 4 }],
                rows: 0,
                rowHeightPt: 20,
                height: { mode: 'fill', weight: 1 },
              },
            ],
          },
          {
            width: 2,
            elements: [
              { id: 'prioTitle', type: 'heading', text: 'Top priorities', style: { sizePt: 10, bold: true, font: 'sans', align: 'left' } },
              { id: 'prio', type: 'checklist', count: 3, rowHeightPt: 22 },
              { id: 'todoTitle', type: 'heading', text: 'To do', style: { sizePt: 10, bold: true, font: 'sans', align: 'left' }, marginTopPt: 8 },
              { id: 'todo', type: 'checklist', count: 0, rowHeightPt: 20, height: { mode: 'fill', weight: 1 } },
            ],
          },
        ],
      },
      { id: 'notes', type: 'box', label: 'Notes', linesInside: 18, height: { mode: 'fixed', pt: 96 }, marginTopPt: 8 },
    ],
  },
  {
    id: 'weekly-planner',
    name: 'Weekly planner',
    category: 'planner',
    fields: [{ key: 'weekLabel', label: 'Week label', default: 'Week of' }],
    elements: [
      { id: 'week', type: 'fields', fields: [{ label: '{{weekLabel}}', width: 1 }], rowHeightPt: 22 },
      {
        id: 'days',
        type: 'table',
        columns: [{ header: 'Day', width: 1 }, { header: 'Plans & appointments', width: 3 }, { header: 'Done', width: 0.6 }],
        rows: 7,
        cells: [['Monday'], ['Tuesday'], ['Wednesday'], ['Thursday'], ['Friday'], ['Saturday'], ['Sunday']],
        rowHeightPt: 22,
        height: { mode: 'fill', weight: 4 },
      },
      { id: 'focus', type: 'box', label: 'Focus for the week', linesInside: 18, height: { mode: 'fill', weight: 1 }, marginTopPt: 8 },
    ],
  },
  {
    id: 'work-order-log',
    name: 'Work order log',
    category: 'logbook',
    fields: [{ key: 'company', label: 'Company / site', default: '' }],
    elements: [
      { id: 'title', type: 'heading', text: 'Work Order Log', style: { sizePt: 14, bold: true, font: 'sans', align: 'center' } },
      { id: 'site', type: 'fields', fields: [{ label: 'Site', width: 2 }, { label: 'Page ref', width: 1 }], rowHeightPt: 22 },
      {
        id: 'log',
        type: 'table',
        columns: [
          { header: 'WO #', width: 0.8 },
          { header: 'Date', width: 0.9 },
          { header: 'Location / asset', width: 1.6 },
          { header: 'Work performed', width: 2.6 },
          { header: 'Tech', width: 0.8 },
          { header: 'Status', width: 0.8 },
        ],
        rows: 0,
        rowHeightPt: 24,
        height: { mode: 'fill', weight: 1 },
      },
    ],
  },
  {
    id: 'equipment-inspection',
    name: 'Equipment inspection log',
    category: 'logbook',
    fields: [{ key: 'equipment', label: 'Equipment type', default: '' }],
    elements: [
      { id: 'title', type: 'heading', text: 'Equipment Inspection', style: { sizePt: 14, bold: true, font: 'sans', align: 'center' } },
      { id: 'meta', type: 'fields', fields: [{ label: 'Equipment ID', width: 1 }, { label: 'Date', width: 1 }, { label: 'Inspector', width: 1 }], rowHeightPt: 22 },
      {
        id: 'checks',
        type: 'table',
        columns: [{ header: 'Check item', width: 3 }, { header: 'OK', width: 0.6 }, { header: 'Fault', width: 0.6 }, { header: 'Notes', width: 2.5 }],
        rows: 12,
        rowHeightPt: 24,
        height: { mode: 'auto' },
      },
      { id: 'actions', type: 'box', label: 'Corrective actions', linesInside: 20, height: { mode: 'fill', weight: 1 }, marginTopPt: 8 },
      { id: 'sign', type: 'fields', fields: [{ label: 'Signature', width: 2 }, { label: 'Next due', width: 1 }], rowHeightPt: 26, marginTopPt: 6 },
    ],
  },
  {
    id: 'meeting-notes',
    name: 'Meeting notes',
    category: 'notes',
    elements: [
      { id: 'meta', type: 'fields', fields: [{ label: 'Meeting', width: 2 }, { label: 'Date', width: 1 }], rowHeightPt: 22 },
      { id: 'att', type: 'fields', fields: [{ label: 'Attendees', width: 1 }], rowHeightPt: 22 },
      { id: 'agendaT', type: 'heading', text: 'Agenda', style: { sizePt: 10, bold: true, font: 'sans', align: 'left' }, marginTopPt: 6 },
      { id: 'agenda', type: 'lines', spacingPt: 20, height: { mode: 'fixed', pt: 100 } },
      { id: 'notesT', type: 'heading', text: 'Notes', style: { sizePt: 10, bold: true, font: 'sans', align: 'left' }, marginTopPt: 6 },
      { id: 'notes', type: 'lines', spacingPt: 20, height: { mode: 'fill', weight: 2 } },
      { id: 'actionsT', type: 'heading', text: 'Action items', style: { sizePt: 10, bold: true, font: 'sans', align: 'left' }, marginTopPt: 6 },
      { id: 'actions', type: 'checklist', count: 0, rowHeightPt: 20, height: { mode: 'fill', weight: 1 } },
    ],
  },
  {
    id: 'habit-tracker',
    name: 'Monthly habit tracker',
    category: 'tracker',
    fields: [{ key: 'month', label: 'Month label', default: 'Month' }],
    elements: [
      { id: 'title', type: 'heading', text: 'Habit Tracker', style: { sizePt: 16, bold: true, font: 'sans', align: 'center' } },
      { id: 'month', type: 'fields', fields: [{ label: '{{month}}', width: 1 }], rowHeightPt: 22 },
      {
        id: 'grid',
        type: 'table',
        columns: [
          { header: 'Habit', width: 4 },
          ...Array.from({ length: 31 }, (_, i) => ({ header: String(i + 1), width: 1 })),
        ],
        rows: 0,
        rowHeightPt: 20,
        headerStyle: { sizePt: 6, bold: true, font: 'sans', align: 'center' },
        height: { mode: 'fill', weight: 1 },
      },
    ],
  },
  {
    id: 'budget-tracker',
    name: 'Monthly budget tracker',
    category: 'tracker',
    fields: [{ key: 'month', label: 'Month label', default: 'Month' }],
    elements: [
      { id: 'title', type: 'heading', text: 'Monthly Budget', style: { sizePt: 16, bold: true, font: 'sans', align: 'center' } },
      { id: 'meta', type: 'fields', fields: [{ label: '{{month}}', width: 1 }, { label: 'Income', width: 1 }, { label: 'Savings goal', width: 1 }], rowHeightPt: 22 },
      {
        id: 'expenses',
        type: 'table',
        columns: [{ header: 'Category', width: 2 }, { header: 'Budgeted', width: 1 }, { header: 'Actual', width: 1 }, { header: 'Difference', width: 1 }],
        rows: 0,
        rowHeightPt: 22,
        height: { mode: 'fill', weight: 3 },
      },
      { id: 'reflect', type: 'box', label: 'What I learned this month', linesInside: 20, height: { mode: 'fill', weight: 1 }, marginTopPt: 8 },
    ],
  },
  {
    id: 'reading-log',
    name: 'Reading log',
    category: 'tracker',
    elements: [
      { id: 'meta', type: 'fields', fields: [{ label: 'Title', width: 2 }, { label: 'Author', width: 1.4 }], rowHeightPt: 22 },
      { id: 'meta2', type: 'fields', fields: [{ label: 'Started', width: 1 }, { label: 'Finished', width: 1 }, { label: 'Rating (1–5)', width: 1 }], rowHeightPt: 22 },
      { id: 'quotesT', type: 'heading', text: 'Favourite passages', style: { sizePt: 10, bold: true, font: 'sans', align: 'left' }, marginTopPt: 6 },
      { id: 'quotes', type: 'lines', spacingPt: 20, height: { mode: 'fill', weight: 1 } },
      { id: 'thoughtsT', type: 'heading', text: 'My thoughts', style: { sizePt: 10, bold: true, font: 'sans', align: 'left' }, marginTopPt: 6 },
      { id: 'thoughts', type: 'lines', spacingPt: 20, height: { mode: 'fill', weight: 2 } },
    ],
  },
  {
    id: 'workbook-exercise',
    name: 'Workbook exercise',
    category: 'workbook',
    fields: [
      { key: 'exerciseTitle', label: 'Exercise title', default: 'Exercise' },
      { key: 'instructions', label: 'Instructions', default: 'Read the scenario and answer the questions below.' },
      { key: 'q1', label: 'Question 1', default: '' },
      { key: 'q2', label: 'Question 2', default: '' },
      { key: 'q3', label: 'Question 3', default: '' },
    ],
    elements: [
      { id: 'title', type: 'heading', text: '{{exerciseTitle}}', style: { sizePt: 16, bold: true, font: 'sans', align: 'left' } },
      { id: 'instr', type: 'text', text: '{{instructions}}', style: { sizePt: 11, font: 'serif', align: 'left' }, marginTopPt: 4, marginBottomPt: 8 },
      { id: 'q1', type: 'text', text: '1. {{q1}}', style: { sizePt: 11, bold: true, font: 'serif' } },
      { id: 'a1', type: 'lines', spacingPt: 22, height: { mode: 'fill', weight: 1 } },
      { id: 'q2', type: 'text', text: '2. {{q2}}', style: { sizePt: 11, bold: true, font: 'serif' }, marginTopPt: 6 },
      { id: 'a2', type: 'lines', spacingPt: 22, height: { mode: 'fill', weight: 1 } },
      { id: 'q3', type: 'text', text: '3. {{q3}}', style: { sizePt: 11, bold: true, font: 'serif' }, marginTopPt: 6 },
      { id: 'a3', type: 'lines', spacingPt: 22, height: { mode: 'fill', weight: 1 } },
    ],
  },
  {
    id: 'chapter-page',
    name: 'Chapter opener',
    category: 'structure',
    showRunningHeader: false,
    fields: [
      { key: 'chapterLabel', label: 'Label', default: 'Chapter 1' },
      { key: 'chapterTitle', label: 'Title', default: 'Getting Started' },
      { key: 'intro', label: 'Introduction', default: '' },
    ],
    elements: [
      { id: 'sp', type: 'spacer', height: { mode: 'fixed', pt: 120 } },
      { id: 'label', type: 'heading', text: '{{chapterLabel}}', style: { sizePt: 12, font: 'sans', align: 'center', bold: false } },
      { id: 'title', type: 'heading', text: '{{chapterTitle}}', style: { sizePt: 26, bold: true, font: 'serif', align: 'center' }, marginTopPt: 6 },
      { id: 'rule', type: 'divider', weightPt: 0.75, marginTopPt: 12, marginBottomPt: 12 },
      { id: 'intro', type: 'text', text: '{{intro}}', style: { sizePt: 11, font: 'serif', align: 'justify', lineHeight: 1.45 } },
    ],
  },
  {
    id: 'dot-grid',
    name: 'Dot grid page',
    category: 'notebook',
    elements: [{ id: 'dots', type: 'dotGrid', spacingPt: 14.17 }],
  },
  {
    id: 'graph-grid',
    name: 'Graph paper page',
    category: 'notebook',
    elements: [{ id: 'grid', type: 'grid', spacingPt: 14.17, weightPt: 0.5 }],
  },
  {
    id: 'blank',
    name: 'Blank page (intentional)',
    category: 'notebook',
    showPageNumber: false,
    showRunningHeader: false,
    elements: [],
  },
  // Front matter
  {
    id: 'title-page',
    name: 'Title page',
    kind: 'front',
    category: 'front',
    showPageNumber: false,
    showRunningHeader: false,
    fields: [{ key: 'subtitle', label: 'Subtitle', default: '' }],
    elements: [
      { id: 'sp', type: 'spacer', height: { mode: 'fill', weight: 1 } },
      { id: 'title', type: 'heading', text: '{{title}}', style: { sizePt: 28, bold: true, font: 'serif', align: 'center' } },
      { id: 'subtitle', type: 'text', text: '{{subtitle}}', style: { sizePt: 14, italic: true, font: 'serif', align: 'center' }, marginTopPt: 10 },
      { id: 'sp2', type: 'spacer', height: { mode: 'fill', weight: 1 } },
      { id: 'author', type: 'heading', text: '{{author}}', style: { sizePt: 14, font: 'serif', align: 'center', bold: false } },
      { id: 'sp3', type: 'spacer', height: { mode: 'fill', weight: 0.5 } },
    ],
  },
  {
    id: 'copyright-page',
    name: 'Copyright page',
    kind: 'front',
    category: 'front',
    showPageNumber: false,
    showRunningHeader: false,
    fields: [
      { key: 'year', label: 'Year', default: '' },
      { key: 'holder', label: 'Copyright holder', default: '{{author}}' },
      { key: 'isbnLine', label: 'ISBN line (leave blank if none)', default: '' },
      { key: 'extra', label: 'Additional notices', default: '' },
    ],
    elements: [
      { id: 'sp', type: 'spacer', height: { mode: 'fill', weight: 1 } },
      {
        id: 'notice',
        type: 'text',
        text: 'Copyright © {{year}} {{holder}}. All rights reserved.\nNo part of this publication may be reproduced, distributed, or transmitted in any form without prior written permission of the copyright holder, except for brief quotations in reviews.\n{{isbnLine}}\n{{extra}}',
        style: { sizePt: 8.5, font: 'serif', align: 'left', lineHeight: 1.4 },
      },
    ],
  },
  {
    id: 'belongs-to',
    name: 'This book belongs to',
    kind: 'front',
    category: 'front',
    showPageNumber: false,
    showRunningHeader: false,
    elements: [
      { id: 'sp', type: 'spacer', height: { mode: 'fill', weight: 1 } },
      { id: 'h', type: 'heading', text: 'This book belongs to', style: { sizePt: 18, font: 'serif', align: 'center', italic: true, bold: false } },
      { id: 'name', type: 'fields', fields: [{ label: 'Name', width: 1 }], rowHeightPt: 30, marginTopPt: 16 },
      { id: 'contact', type: 'fields', fields: [{ label: 'If found, please contact', width: 1 }], rowHeightPt: 30 },
      { id: 'sp2', type: 'spacer', height: { mode: 'fill', weight: 1.4 } },
    ],
  },
  {
    id: 'how-to-use',
    name: 'How to use this book',
    kind: 'front',
    category: 'front',
    showPageNumber: false,
    fields: [{ key: 'body', label: 'Instructions', default: '' }],
    elements: [
      { id: 'h', type: 'heading', text: 'How to Use This Book', style: { sizePt: 18, bold: true, font: 'serif', align: 'center' }, marginBottomPt: 12 },
      { id: 'b', type: 'text', text: '{{body}}', style: { sizePt: 11, font: 'serif', align: 'justify', lineHeight: 1.45 } },
    ],
  },
  {
    id: 'toc',
    name: 'Table of contents (generated)',
    kind: 'front',
    category: 'front',
    showPageNumber: false,
    showRunningHeader: false,
    elements: [{ id: 'h', type: 'heading', text: 'Contents', style: { sizePt: 18, bold: true, font: 'serif', align: 'center' }, marginBottomPt: 12 }],
  },
  // Back matter
  {
    id: 'notes-page',
    name: 'Notes',
    kind: 'back',
    category: 'back',
    elements: [
      { id: 'h', type: 'heading', text: 'Notes', style: { sizePt: 16, bold: true, font: 'serif', align: 'left' }, marginBottomPt: 6 },
      { id: 'l', type: 'lines', spacingPt: 22 },
    ],
  },
  {
    id: 'about-author',
    name: 'About the author',
    kind: 'back',
    category: 'back',
    fields: [{ key: 'bio', label: 'Biography', default: '' }],
    elements: [
      { id: 'h', type: 'heading', text: 'About the Author', style: { sizePt: 16, bold: true, font: 'serif', align: 'center' }, marginBottomPt: 12 },
      { id: 'b', type: 'text', text: '{{bio}}', style: { sizePt: 11, font: 'serif', align: 'justify', lineHeight: 1.45 } },
    ],
  },
];

export const BUILT_IN_TEMPLATES: PageTemplate[] = defs.map((d) => PageTemplate.parse(d));

export function getTemplate(id: string, extra: PageTemplate[] = []): PageTemplate | undefined {
  return extra.find((t) => t.id === id) ?? BUILT_IN_TEMPLATES.find((t) => t.id === id);
}
