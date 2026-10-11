import { RULES, RULESET_VERSION } from './rules';
import { PREFLIGHT_DISCLAIMER, type CheckResult, type CheckStatus, type PreflightContext, type PreflightReport, type RuleDefinition } from './types';

export function evaluateRule(rule: RuleDefinition, ctx: PreflightContext): CheckResult {
  const applies = rule.appliesTo.includes('ALL') || rule.appliesTo.includes(ctx.format);
  let outcome: { status: CheckStatus; evidence: string; suggestion?: string };
  if (!applies) {
    outcome = { status: 'NOT_APPLICABLE', evidence: `Rule applies to ${rule.appliesTo.join(', ')}.` };
  } else {
    try {
      outcome = rule.check(ctx);
    } catch (e) {
      // A crashing check must never silently pass.
      outcome = { status: 'NEEDS_HUMAN_REVIEW', evidence: `Check could not run: ${(e as Error).message}` };
    }
  }
  const review = ctx.reviews?.[rule.id] ?? null;
  return {
    ruleId: rule.id,
    ruleVersion: rule.version,
    title: rule.title,
    category: rule.category,
    severity: rule.severity,
    status: outcome.status,
    evidence: outcome.evidence,
    suggestion: outcome.status === 'PASS' || outcome.status === 'NOT_APPLICABLE' ? '' : (outcome.suggestion ?? rule.defaultSuggestion),
    applicableFormats: rule.appliesTo,
    format: ctx.format,
    source: rule.source,
    sourceVerification: rule.sourceVerification,
    lastVerified: rule.lastVerified,
    blocking: rule.blocking && outcome.status === 'FAIL',
    review: outcome.status === 'NEEDS_HUMAN_REVIEW' || outcome.status === 'WARNING' || (outcome.status === 'FAIL' && !rule.blocking) ? review : null,
  };
}

export function runPreflight(ctx: PreflightContext, opts: { now?: Date; rules?: RuleDefinition[] } = {}): PreflightReport {
  const results = (opts.rules ?? RULES).map((r) => evaluateRule(r, ctx));
  const summary: Record<CheckStatus, number> = { PASS: 0, WARNING: 0, FAIL: 0, NEEDS_HUMAN_REVIEW: 0, NOT_APPLICABLE: 0 };
  for (const r of results) summary[r.status]++;
  const blockingRuleIds = results.filter((r) => r.blocking).map((r) => r.ruleId);
  return {
    rulesetVersion: RULESET_VERSION,
    specVersion: ctx.spec.version,
    format: ctx.format,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    results,
    summary,
    blocked: blockingRuleIds.length > 0,
    blockingRuleIds,
    disclaimer: PREFLIGHT_DISCLAIMER,
  };
}

/** Items a human must still look at before final export (unreviewed NEEDS_HUMAN_REVIEW). */
export function pendingReviews(report: PreflightReport): CheckResult[] {
  return report.results.filter((r) => r.status === 'NEEDS_HUMAN_REVIEW' && !r.review);
}

/** Self-contained HTML rendering of a report for the export bundle. */
export function reportToHtml(report: PreflightReport, title: string): string {
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
  const color: Record<CheckStatus, string> = { PASS: '#137333', WARNING: '#B06000', FAIL: '#C5221F', NEEDS_HUMAN_REVIEW: '#6B3FA0', NOT_APPLICABLE: '#5F6368' };
  const rows = report.results
    .map(
      (r) =>
        `<tr><td><code>${r.ruleId}</code> v${r.ruleVersion}</td><td>${esc(r.title)}</td><td style="color:${color[r.status]};font-weight:600">${r.status.replace(/_/g, ' ')}${r.blocking ? ' (blocking)' : ''}</td><td>${r.severity}</td><td>${esc(r.evidence)}${r.suggestion ? `<br><em>Fix: ${esc(r.suggestion)}</em>` : ''}${r.review ? `<br><strong>Review:</strong> ${esc(r.review.decision)} — ${esc(r.review.note)} (${esc(r.review.reviewer)})` : ''}</td><td><a href="${esc(r.source.startsWith('http') ? r.source : '#')}">${esc(r.source.startsWith('http') ? 'KDP help' : r.source)}</a><br>${r.sourceVerification}, ${r.lastVerified}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preflight — ${esc(title)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#202124}table{border-collapse:collapse;width:100%}td,th{border:1px solid #dadce0;padding:6px 8px;vertical-align:top;text-align:left}th{background:#f1f3f4}.d{background:#fef7e0;padding:10px;border-radius:6px}</style></head><body>
<h1>Preflight report — ${esc(title)}</h1>
<p>Format: <strong>${report.format}</strong> · Spec: <code>${report.specVersion}</code> · Rules: <code>${report.rulesetVersion}</code> · Generated ${report.generatedAt}</p>
<p>Summary: ${Object.entries(report.summary).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')} — <strong>${report.blocked ? 'EXPORT BLOCKED by: ' + report.blockingRuleIds.join(', ') : 'No blocking technical failures'}</strong></p>
<p class="d">${esc(report.disclaimer)}</p>
<table><thead><tr><th>Rule</th><th>Check</th><th>Result</th><th>Severity</th><th>Evidence / correction</th><th>Source</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>`;
}
