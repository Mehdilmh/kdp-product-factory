import { Field, Select, Textarea } from '@/components/ui/basic';
import type { StyleProfile } from './coloring-types';

const LEVELS = ['VERY_LOW', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'];
const OPTIONS: { key: keyof StyleProfile; label: string; values: string[] }[] = [
  { key: 'outlineThickness', label: 'Outline thickness', values: ['THIN', 'MEDIUM', 'THICK', 'EXTRA_THICK'] },
  { key: 'detail', label: 'Detail', values: LEVELS },
  { key: 'complexity', label: 'Complexity', values: LEVELS },
  { key: 'subjectSize', label: 'Subject size', values: ['SMALL', 'MEDIUM', 'LARGE', 'FILL'] },
  { key: 'whiteSpace', label: 'White space', values: LEVELS },
  { key: 'subjects', label: 'Number of subjects', values: ['ONE', 'FEW', 'MANY'] },
  { key: 'background', label: 'Background', values: ['NONE', 'SIMPLE', 'DETAILED', 'PATTERN'] },
  { key: 'composition', label: 'Composition', values: ['CENTERED', 'SCENE', 'FULL_PAGE_PATTERN', 'FRAMED'] },
  { key: 'aspect', label: 'Image aspect', values: ['TRIM', 'SQUARE', 'PORTRAIT', 'LANDSCAPE'] },
];
const label = (v: string) => v.toLowerCase().replace(/_/g, ' ');

export function StyleControls({ style, styles, onChange, disabled }: { style: StyleProfile; styles: { id: string; label: string }[]; onChange: (s: StyleProfile) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="Style" htmlFor="st-style">
        <Select id="st-style" disabled={disabled} value={style.styleId} onChange={(e) => onChange({ ...style, styleId: e.target.value })}>
          {styles.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </Select>
      </Field>
      {OPTIONS.map((o) => (
        <Field key={o.key} label={o.label} htmlFor={`st-${o.key}`}>
          <Select id={`st-${o.key}`} disabled={disabled} value={String(style[o.key])} onChange={(e) => onChange({ ...style, [o.key]: e.target.value })}>
            {o.values.map((v) => <option key={v} value={v}>{label(v)}</option>)}
          </Select>
        </Field>
      ))}
      <Field label="Extra art direction" htmlFor="st-extra" className="sm:col-span-2 lg:col-span-3" hint="Appended to every prompt. Do not name trademarked characters or brands.">
        <Textarea id="st-extra" disabled={disabled} rows={2} value={style.extraDirection} onChange={(e) => onChange({ ...style, extraDirection: e.target.value })} />
      </Field>
    </div>
  );
}
