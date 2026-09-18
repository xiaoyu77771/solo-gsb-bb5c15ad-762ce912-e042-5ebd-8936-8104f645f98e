import type { Rule, Simulation, SimulationStatus, Step } from './types';
import { REQUEST_METHODS } from './types';
import { simulate } from './engine';

/** 一条粘贴进来的原始样本行 */
export interface CoverageSample {
  id: string;
  /** 行号（1 起，按文本中的物理行计，含空行），仅用于展示定位 */
  line: number;
  /** 去掉首尾空白后的原始行文本 */
  raw: string;
}

/** 解析成功、可运行的样本 */
export interface ParsedSample extends CoverageSample {
  method: string;
  url: string;
}

/** 解析失败的样本：方法无法识别 / 缺少 URL / 段数不对 */
export interface InvalidSample extends CoverageSample {
  reason: string;
}

export interface SampleParseResult {
  valid: ParsedSample[];
  invalid: InvalidSample[];
}

let seq = 0;
/** 仅当前会话内使用的样本行 id（内存，不持久化） */
export function sampleId(): string {
  seq += 1;
  return `cov-${Date.now().toString(36)}-${seq}`;
}

/**
 * 把多行文本解析为样本：
 * - 空行（含纯空白）忽略，不报错也不参与统计；
 * - 每行按空白切分，恰好「方法 + URL」两段；超过两段视为格式非法
 *   （URL 中不允许出现空白）；
 * - 方法大小写不敏感，规范化为大写，必须是 simulate 支持的具体方法；
 * - 缺少 URL 段视为非法输入。
 * 不在这里校验 URL 能否解析：URL 解析交给 simulate，其 invalid-url 结果
 * 归入「非法输入」桶，保证与模拟语义完全一致。
 */
export function parseSamples(text: string): SampleParseResult {
  const valid: ParsedSample[] = [];
  const invalid: InvalidSample[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const raw = line.trim();
    if (raw === '') return;
    const base: CoverageSample = { id: sampleId(), line: i + 1, raw };
    const parts = raw.split(/\s+/);
    if (parts.length < 2) {
      invalid.push({ ...base, reason: '无法识别的样本：每行需要「方法 + URL」两段' });
      return;
    }
    if (parts.length > 2) {
      invalid.push({ ...base, reason: '无法识别的样本：URL 中不允许包含空白字符' });
      return;
    }
    const method = parts[0].toUpperCase();
    if (!(REQUEST_METHODS as readonly string[]).includes(method)) {
      invalid.push({
        ...base,
        reason: `无法识别的请求方法：${parts[0]}（支持 ${REQUEST_METHODS.join(' / ')}）`,
      });
      return;
    }
    valid.push({ ...base, method, url: parts[1] });
  });
  return { valid, invalid };
}

/** 审计中按失败 / 特殊状态分桶的样本分类 */
export type AuditBucket = 'unmatched' | 'loop' | 'max-steps' | 'invalid-input';

export interface SampleRun {
  sample: ParsedSample;
  sim: Simulation;
  /**
   * 非成功分类：
   * - unmatched：零命中（simulate 的 final 且 steps 为空，即没有任何规则命中）
   * - loop / max-steps：对应失败状态
   * - invalid-input：invalid-url（输入 URL 无法解析）
   * null 表示至少命中过一条规则（含 redirect / stopped / 正常 final / invalid-target）
   */
  bucket: AuditBucket | null;
}

/** 每条规则的覆盖统计 */
export interface RuleCoverage {
  ruleId: string;
  /** 运行时刻的规则名称快照（规则之后被改名 / 删除时仍可展示） */
  ruleName: string;
  /** 运行时刻规则是否启用（停用规则不参与匹配，统计恒为零） */
  enabled: boolean;
  /** 运行时刻的规则序号（1 起，展示用） */
  ruleNumber: number;
  /** 命中请求数：同一请求在重写链中多次命中本规则只计一次 */
  hitRequests: number;
  /** 执行次数：该规则在全部样本轨迹中的命中步总数（重复命中累加） */
  executions: number;
  /** 命中本规则的样本 id（去重，保持样本顺序） */
  sampleIds: string[];
}

/** 解析阶段就失败的非法输入行 */
export interface ParseInvalidEntry {
  kind: 'parse';
  line: number;
  raw: string;
  reason: string;
}

/** 运行阶段 simulate 判为 invalid-url 的非法输入样本 */
export interface RunInvalidEntry {
  kind: 'run';
  sample: ParsedSample;
  sim: Simulation;
}

export type InvalidInputEntry = ParseInvalidEntry | RunInvalidEntry;

export interface CoverageAudit {
  /** 全部可运行样本的运行结果（保持输入顺序） */
  runs: SampleRun[];
  /** 解析失败与 URL 无法解析合并后的非法输入（按行号排序） */
  invalidInput: InvalidInputEntry[];
  /** 每条当前规则一条统计（含零命中），顺序与规则表一致 */
  ruleStats: RuleCoverage[];
  /** 未命中任何规则的样本（simulate 语义：零步 final 放行） */
  unmatched: SampleRun[];
  loops: SampleRun[];
  maxSteps: SampleRun[];
}

const FAIL_BUCKETS: Partial<Record<SimulationStatus, AuditBucket>> = {
  loop: 'loop',
  'max-steps': 'max-steps',
  'invalid-url': 'invalid-input',
};

/**
 * 批量运行访问样本覆盖审计：
 * 复用 {@link simulate} 的全部语义（首条命中、重写后从第一条规则重新匹配、
 * 循环 / 20 步上限、非法 URL / 目标判定），只做统计聚合，不改变执行结果。
 *
 * 同一请求因重写而重复命中同一条规则时：命中请求数只计一次，执行次数按步累加。
 * invalid-target（动作目标无法解析）属于规则配置问题，请求仍命中过该规则，
 * 计入规则统计，不进任何异常桶。
 */
export function auditSamples(rules: Rule[], text: string): CoverageAudit {
  const { valid, invalid } = parseSamples(text);

  const runs: SampleRun[] = valid.map((sample) => {
    const sim = simulate(rules, sample.method, sample.url);
    const bucket: AuditBucket | null =
      sim.status === 'final' && sim.steps.length === 0
        ? 'unmatched'
        : (FAIL_BUCKETS[sim.status] ?? null);
    return { sample, sim, bucket };
  });

  const ruleStats: RuleCoverage[] = rules.map((rule, index) => ({
    ruleId: rule.id,
    ruleName: rule.name,
    enabled: rule.enabled,
    ruleNumber: index + 1,
    hitRequests: 0,
    executions: 0,
    sampleIds: [],
  }));
  const statById = new Map(ruleStats.map((s) => [s.ruleId, s]));

  for (const run of runs) {
    // 同一样本（请求）内的去重集合：决定命中请求数；执行次数不受影响
    const hitInThisRequest = new Set<string>();
    for (const step of run.sim.steps) {
      const stat = statById.get(step.rule.id);
      if (!stat) continue; // 理论不可达：step.rule 是刚运行时的规则快照
      stat.executions += 1;
      if (!hitInThisRequest.has(stat.ruleId)) {
        hitInThisRequest.add(stat.ruleId);
        stat.hitRequests += 1;
        stat.sampleIds.push(run.sample.id);
      }
    }
  }

  const invalidInput: InvalidInputEntry[] = [
    ...invalid.map<ParseInvalidEntry>((s) => ({
      kind: 'parse',
      line: s.line,
      raw: s.raw,
      reason: s.reason,
    })),
    ...runs
      .filter((r) => r.bucket === 'invalid-input')
      .map<RunInvalidEntry>((r) => ({ kind: 'run', sample: r.sample, sim: r.sim })),
  ].sort((a, b) => {
    const la = a.kind === 'parse' ? a.line : a.sample.line;
    const lb = b.kind === 'parse' ? b.line : b.sample.line;
    return la - lb;
  });

  return {
    runs,
    invalidInput,
    ruleStats,
    unmatched: runs.filter((r) => r.bucket === 'unmatched'),
    loops: runs.filter((r) => r.bucket === 'loop'),
    maxSteps: runs.filter((r) => r.bucket === 'max-steps'),
  };
}

/** 取出某条规则在指定样本轨迹中的命中步骤（保持步骤顺序） */
export function stepsOfRule(sim: Simulation, ruleId: string): Step[] {
  return sim.steps.filter((s) => s.rule.id === ruleId);
}

/** 审计输入指纹：规则或样本文本变化后，上次结果即过期 */
export function auditFingerprint(rules: Rule[], text: string): string {
  return JSON.stringify({ rules, text });
}
