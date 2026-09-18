import { useMemo, useState } from 'react';
import type { Rule } from '../types';
import {
  auditFingerprint,
  auditSamples,
  parseSamples,
  stepsOfRule,
  type CoverageAudit,
  type InvalidInputEntry,
  type RuleCoverage,
  type SampleRun,
} from '../coverage';
import { StepCard } from './TraceView';

interface LastRun {
  fingerprint: string;
  audit: CoverageAudit;
}

/** 异常桶的展示元信息 */
const BUCKET_META = [
  { key: 'unmatched', title: '未命中任何规则', icon: '⚪', cls: 'warn' },
  { key: 'loops', title: '循环', icon: '🔁', cls: 'error' },
  { key: 'maxSteps', title: '超过步数上限', icon: '⚠️', cls: 'error' },
  { key: 'invalidInput', title: '非法输入样本', icon: '❌', cls: 'error' },
] as const;

function SampleTag({ run }: { run: SampleRun }) {
  return (
    <>
      <span className="tag cov-method">{run.sample.method}</span>
      <code className="cov-sample-url" title={`第 ${run.sample.line} 行`}>
        {run.sample.url}
      </code>
    </>
  );
}

/** 异常样本列表：未命中 / 循环 / 超限三个桶共用 */
function RunBucket({
  icon,
  cls,
  title,
  runs,
}: {
  icon: string;
  cls: string;
  title: string;
  runs: SampleRun[];
}) {
  if (runs.length === 0) return null;
  return (
    <div className={`cov-bucket cov-bucket-${cls}`}>
      <h4>
        {icon} {title}（{runs.length}）
      </h4>
      <ul>
        {runs.map((r) => (
          <li key={r.sample.id}>
            <span className="cov-line-no">第 {r.sample.line} 行</span>
            <SampleTag run={r} />
            <span className={`tag status-${r.sim.status}`}>{r.sim.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 非法输入桶：解析失败行与运行期 invalid-url 样本混合，按行号排序 */
function InvalidInputBucket({ entries }: { entries: InvalidInputEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="cov-bucket cov-bucket-error">
      <h4>
        ❌ 非法输入样本（{entries.length}）
      </h4>
      <ul>
        {entries.map((e, i) =>
          e.kind === 'parse' ? (
            <li key={`p-${i}`}>
              <span className="cov-line-no">第 {e.line} 行</span>
              <code className="cov-sample-url">{e.raw}</code>
              <span className="cov-reason">{e.reason}</span>
            </li>
          ) : (
            <li key={`r-${e.sample.id}`}>
              <span className="cov-line-no">第 {e.sample.line} 行</span>
              <SampleTag run={{ sample: e.sample, sim: e.sim, bucket: 'invalid-input' }} />
              <span className="cov-reason">{e.sim.reason}</span>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

/** 规则下某条命中样本：默认只列出命中该规则的步骤，可展开完整轨迹 */
function HitSampleRow({
  run,
  ruleId,
  expanded,
  onToggle,
}: {
  run: SampleRun;
  ruleId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hits = stepsOfRule(run.sim, ruleId);
  return (
    <div className="cov-hit-sample">
      <header>
        <button type="button" className="trace-toggle" onClick={onToggle}>
          {expanded ? '收起 ▲' : '展开 ▼'}
        </button>
        <SampleTag run={run} />
        <span className="cov-hit-count">
          本规则命中 {hits.length} 次 / 全程 {run.sim.steps.length} 步
        </span>
        <span className={`tag status-${run.sim.status}`}>{run.sim.status}</span>
      </header>
      {expanded && (
        <div className="cov-hit-steps">
          {run.sim.steps.map((s) => (
            <div
              key={s.n}
              className={`cov-step-wrap${s.rule.id === ruleId ? ' is-hit' : ''}`}
            >
              {s.rule.id === ruleId ? (
                <StepCard step={s} />
              ) : (
                <div className="cov-other-step">
                  <span className="step-n">步骤 {s.n}</span>
                  命中规则 #{s.ruleIndex + 1}「{s.rule.name}」
                  <span className={`tag action-${s.rule.action.type}`}>
                    {s.rule.action.type}
                  </span>
                  <code className="url-from">{s.urlBefore}</code>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 单条规则的覆盖卡片，点击行展开命中样本与步骤 */
function RuleCoverageRow({
  stat,
  runById,
  exists,
  expanded,
  onToggle,
  expandedSamples,
  onToggleSample,
}: {
  stat: RuleCoverage;
  runById: Map<string, SampleRun>;
  /** 当前规则表中是否仍存在该规则（删除后旧结果里的卡片需标注） */
  exists: boolean;
  expanded: boolean;
  onToggle: () => void;
  expandedSamples: ReadonlySet<string>;
  onToggleSample: (sampleId: string) => void;
}) {
  return (
    <div
      className={`cov-rule${stat.hitRequests > 0 ? '' : ' zero-hit'}${
        !exists ? ' rule-gone' : ''
      }${!stat.enabled ? ' rule-disabled' : ''}`}
    >
      <header
        className="cov-rule-head"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="cov-caret">{expanded ? '▼' : '▶'}</span>
        <span className="cov-rule-no">#{stat.ruleNumber}</span>
        <span className="cov-rule-name">{stat.ruleName}</span>
        {!exists && <span className="tag tag-gone">规则已删除</span>}
        {!stat.enabled && <span className="tag tag-off">停用</span>}
        <span className="cov-rule-stats">
          <strong>{stat.hitRequests}</strong> 个请求命中 ·{' '}
          <strong>{stat.executions}</strong> 次执行
        </span>
      </header>
      {expanded && (
        <div className="cov-rule-body">
          {stat.sampleIds.length === 0 ? (
            <p className="empty">本批样本没有任何请求命中该规则。</p>
          ) : (
            stat.sampleIds.map((sid) => {
              const run = runById.get(sid);
              if (!run) return null;
              return (
                <HitSampleRow
                  key={sid}
                  run={run}
                  ruleId={stat.ruleId}
                  expanded={expandedSamples.has(sid)}
                  onToggle={() => onToggleSample(sid)}
                />
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  rules: Rule[];
}

export function CoveragePanel({ rules }: Props) {
  // 样本文本与最近一次结果都只保留在当前页面会话（内存），刻意不写 localStorage
  const [text, setText] = useState('');
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [expandedRules, setExpandedRules] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedSamples, setExpandedSamples] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const parsed = useMemo(() => parseSamples(text), [text]);
  const validCount = parsed.valid.length;
  const invalidParseCount = parsed.invalid.length;
  const lineCount = useMemo(
    () => text.split('\n').filter((l) => l.trim() !== '').length,
    [text],
  );

  // 规则或样本变化即标记上次结果过期（与规则回归面板同款指纹思路）
  const fingerprint = useMemo(() => auditFingerprint(rules, text), [rules, text]);
  const stale = lastRun !== null && lastRun.fingerprint !== fingerprint;

  const run = () => {
    if (text.trim() === '') return;
    setLastRun({ fingerprint, audit: auditSamples(rules, text) });
    setExpandedRules(new Set());
    setExpandedSamples(new Set());
  };

  const fillExample = () =>
    setText(
      [
        'GET http://api.example.com/v1/users/42?debug=1',
        'POST http://api.example.com/v1/users/7',
        'get http://blog.example.com/posts/hello-world',
        'GET http://img.cdn.example.com/assets/logo.png',
        'GET http://api.example.com/v1/users/42?env=canary',
        'GET http://no-rule.example.com/whatever',
        'OOPS http://bad.example.com/a',
      ].join('\n'),
    );

  const toggleRule = (id: string) =>
    setExpandedRules((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleSample = (id: string) =>
    setExpandedSamples((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const audit = lastRun?.audit ?? null;
  const runById = useMemo(() => {
    const map = new Map<string, SampleRun>();
    audit?.runs.forEach((r) => map.set(r.sample.id, r));
    return map;
  }, [audit]);

  const totalProblems = audit
    ? audit.unmatched.length +
      audit.loops.length +
      audit.maxSteps.length +
      audit.invalidInput.length
    : 0;

  return (
    <section className="panel coverage-panel">
      <div className="panel-title">
        <h2>访问样本覆盖审计</h2>
        <div className="toolbar">
          <button type="button" onClick={fillExample}>
            填入示例样本
          </button>
          <button
            type="button"
            className="primary"
            onClick={run}
            disabled={text.trim() === ''}
          >
            批量运行{validCount + invalidParseCount > 0 ? `（${validCount} 条可运行）` : ''}
          </button>
        </div>
      </div>
      <p className="cov-hint">
        每行粘贴一条「METHOD URL」样本（空行忽略），批量运行复用与单次「运行」完全一致的
        simulate 语义。统计每条规则的<strong>命中请求数</strong>（同一请求在重写链中重复命中只计一次）
        与<strong>执行次数</strong>（重复命中累加）；点击规则可展开命中样本及对应步骤。
        样本文本与最近一次结果仅保存在当前页面会话，刷新即清空。
      </p>
      <textarea
        className="cov-input"
        rows={7}
        spellCheck={false}
        placeholder={
          'GET http://api.example.com/v1/users/42\nPOST http://api.example.com/users\n…'
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {text.trim() !== '' && (
        <div className="cov-input-meta">
          {lineCount} 行非空样本：{validCount} 条可运行
          {invalidParseCount > 0 && (
            <span className="cov-meta-warn">，{invalidParseCount} 行格式非法</span>
          )}
        </div>
      )}

      {audit && (
        <div className="cov-results">
          {stale && (
            <div className="banner warn">
              ⚠️ 规则或样本在上次运行后已变更，以下审计结果已过期，请重新批量运行。
            </div>
          )}
          <h3 className="reg-subtitle">
            审计结果：{audit.runs.length} 条样本参与运行，
            {totalProblems === 0 ? (
              <span className="ok-text">全部命中且正常终止</span>
            ) : (
              <span className="changed-text">{totalProblems} 条需关注</span>
            )}
          </h3>

          <div className="cov-summary">
            {BUCKET_META.map((b) => {
              const n =
                b.key === 'invalidInput'
                  ? audit.invalidInput.length
                  : audit[b.key].length;
              return (
                <span key={b.key} className={`cov-summary-item cov-sum-${b.cls}`}>
                  {b.icon} {b.title} <strong>{n}</strong>
                </span>
              );
            })}
          </div>

          <InvalidInputBucket entries={audit.invalidInput} />
          <RunBucket
            icon="🔁"
            cls="error"
            title="循环"
            runs={audit.loops}
          />
          <RunBucket
            icon="⚠️"
            cls="error"
            title="超过步数上限"
            runs={audit.maxSteps}
          />
          <RunBucket
            icon="⚪"
            cls="warn"
            title="未命中任何规则"
            runs={audit.unmatched}
          />

          <h3 className="reg-subtitle">规则覆盖（按规则表顺序，点击展开命中样本）</h3>
          {audit.ruleStats.map((stat) => (
            <RuleCoverageRow
              key={stat.ruleId}
              stat={stat}
              runById={runById}
              exists={rules.some((r) => r.id === stat.ruleId)}
              expanded={expandedRules.has(stat.ruleId)}
              onToggle={() => toggleRule(stat.ruleId)}
              expandedSamples={expandedSamples}
              onToggleSample={toggleSample}
            />
          ))}
          {audit.ruleStats.length === 0 && (
            <p className="empty">当前规则表为空，所有样本都不会命中规则。</p>
          )}
        </div>
      )}
    </section>
  );
}
