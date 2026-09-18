import { describe, expect, it } from 'vitest';
import {
  auditFingerprint,
  auditSamples,
  parseSamples,
  stepsOfRule,
} from './coverage';
import type { Rule } from './types';

function rule(partial: Partial<Rule> & { id: string }): Rule {
  return {
    name: partial.id,
    enabled: true,
    method: 'ANY',
    host: 'example.com',
    pathTemplate: '/',
    query: [],
    action: { type: 'rewrite', target: '/', status: 302 },
    ...partial,
  };
}

/** 链式重写：/a → /b → /c，最终放行；同一样本对 r1 命中一次、执行一次 */
const CHAIN: Rule[] = [
  rule({ id: 'r1', name: 'a→b', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
  rule({ id: 'r2', name: 'b→c', pathTemplate: '/b', action: { type: 'rewrite', target: '/c', status: 302 } }),
  rule({ id: 'off', name: '停用规则', enabled: false, pathTemplate: '/a', action: { type: 'rewrite', target: '/z', status: 302 } }),
];

describe('parseSamples', () => {
  it('按行解析 METHOD URL，方法规范化大写；忽略空行与纯空白行', () => {
    const { valid, invalid } = parseSamples(
      'get http://example.com/a\n\n  \nPOST http://example.com/b\n',
    );
    expect(valid.map((s) => [s.method, s.url, s.line])).toEqual([
      ['GET', 'http://example.com/a', 1],
      ['POST', 'http://example.com/b', 4],
    ]);
    expect(invalid).toEqual([]);
  });

  it('缺少 URL 段、段数过多、方法不识别都判为非法并给出行号', () => {
    const { valid, invalid } = parseSamples(
      ['GET', 'FETCH http://example.com/a', 'GET http://a.com/ extra', 'get http://ok.com/']
        .join('\n'),
    );
    expect(valid).toHaveLength(1);
    expect(valid[0].method).toBe('GET');
    expect(invalid.map((s) => s.line)).toEqual([1, 2, 3]);
    expect(invalid[0].reason).toContain('方法 + URL');
    expect(invalid[1].reason).toContain('FETCH');
    expect(invalid[2].reason).toContain('空白');
  });

  it('URL 能否解析不在解析阶段判断', () => {
    const { valid } = parseSamples('GET not-a-url');
    expect(valid).toHaveLength(1);
  });
});

describe('auditSamples 规则覆盖统计', () => {
  it('按规则统计命中请求数与执行次数；零命中 / 停用规则也有统计', () => {
    const audit = auditSamples(
      CHAIN,
      [
        'GET http://example.com/a', // r1→r2
        'GET http://example.com/b', // 仅 r2
        'GET http://example.com/c', // 无命中
      ].join('\n'),
    );
    const stats = Object.fromEntries(audit.ruleStats.map((s) => [s.ruleId, s]));
    expect(stats.r1.hitRequests).toBe(1);
    expect(stats.r1.executions).toBe(1);
    expect(stats.r2.hitRequests).toBe(2);
    expect(stats.r2.executions).toBe(2);
    expect(stats.off.hitRequests).toBe(0);
    expect(stats.off.executions).toBe(0);
    expect(stats.r1.sampleIds).toHaveLength(1);
    expect(stats.r2.sampleIds).toHaveLength(2);
  });

  it('同一请求因重写重复命中同一规则：请求数只计一次，执行次数累加', () => {
    // /t 重写到固定的 /t?n=1：第 1 步后 URL 变化，第 2 步仍命中同一规则，
    // 第 3 轮因状态重复判 loop——同一样本命中 1 个请求、执行 2 次
    const rules: Rule[] = [
      rule({
        id: 'self',
        pathTemplate: '/t',
        action: { type: 'rewrite', target: '/t?n=1', status: 302 },
      }),
    ];
    const audit = auditSamples(rules, 'GET http://example.com/t');
    const stat = audit.ruleStats[0];
    expect(stat.hitRequests).toBe(1);
    expect(stat.executions).toBe(2);
    expect(stat.sampleIds).toEqual([audit.runs[0].sample.id]);
    expect(audit.runs[0].sim.status).toBe('loop');
    expect(audit.loops).toHaveLength(1);
  });

  it('超过 20 步上限：每条规则仍按实际命中步累计执行次数', () => {
    const chain: Rule[] = Array.from({ length: 22 }, (_, i) =>
      rule({
        id: `s${i}`,
        pathTemplate: `/s${i}`,
        action: { type: 'rewrite', target: `/s${i + 1}`, status: 302 },
      }),
    );
    const audit = auditSamples(chain, 'GET http://example.com/s0');
    expect(audit.maxSteps).toHaveLength(1);
    expect(audit.maxSteps[0].sim.steps).toHaveLength(20);
    // 20 步命中 s0..s19；s20 / s21 未被执行
    expect(audit.ruleStats.slice(0, 20).every((s) => s.hitRequests === 1)).toBe(true);
    expect(audit.ruleStats.slice(20).every((s) => s.executions === 0)).toBe(true);
  });

  it('未命中任何规则的样本进入 unmatched 桶，轨迹为零步 final', () => {
    const audit = auditSamples(CHAIN, [
      'GET http://example.com/a',
      'GET http://example.com/nope',
      'POST http://other.example.com/a',
    ].join('\n'));
    expect(audit.unmatched).toHaveLength(2);
    expect(audit.unmatched[0].sim.status).toBe('final');
    expect(audit.unmatched[0].sim.steps).toHaveLength(0);
  });

  it('循环样本进入 loops 桶，超限样本进入 maxSteps 桶', () => {
    const loopRules: Rule[] = [
      rule({ id: 'a', host: 'l.com', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({ id: 'b', host: 'l.com', pathTemplate: '/b', action: { type: 'rewrite', target: '/a', status: 302 } }),
    ];
    const longChain: Rule[] = Array.from({ length: 25 }, (_, i) =>
      rule({
        id: `l${i}`,
        host: 'm.com',
        pathTemplate: `/p${i}`,
        action: { type: 'rewrite', target: `/p${i + 1}`, status: 302 },
      }),
    );
    const audit = auditSamples([...loopRules, ...longChain], [
      'GET http://l.com/a',
      'GET http://m.com/p0',
    ].join('\n'));
    expect(audit.loops).toHaveLength(1);
    expect(audit.loops[0].sim.status).toBe('loop');
    expect(audit.maxSteps).toHaveLength(1);
    expect(audit.maxSteps[0].sim.status).toBe('max-steps');
  });

  it('解析非法行与无法解析的 URL 合并进非法输入桶并按行号排序', () => {
    const audit = auditSamples(CHAIN, [
      'GET http://example.com/a', // 行1 正常
      'OOPS', // 行2 解析失败
      'GET http://example.com/b', // 行3 正常
      'GET :::not-a-url', // 行4 运行期 invalid-url
    ].join('\n'));
    expect(audit.invalidInput).toHaveLength(2);
    expect(audit.invalidInput.map((e) => (e.kind === 'parse' ? e.line : e.sample.line))).toEqual([
      2, 4,
    ]);
    expect(audit.invalidInput[0].kind).toBe('parse');
    expect(audit.invalidInput[1]).toMatchObject({ kind: 'run' });
    if (audit.invalidInput[1].kind === 'run') {
      expect(audit.invalidInput[1].sim.status).toBe('invalid-url');
    }
    // 非法输入不作为可运行样本
    expect(audit.runs).toHaveLength(3);
  });

  it('redirect / stopped / invalid-target 视为命中，计入规则统计且不进异常桶', () => {
    const rules: Rule[] = [
      rule({
        id: 'redir',
        pathTemplate: '/go',
        action: { type: 'redirect', target: 'https://n.com/x', status: 301 },
      }),
      rule({
        id: 'stop',
        pathTemplate: '/halt',
        action: { type: 'stop', target: '', status: 302 },
      }),
    ];
    const audit = auditSamples(rules, [
      'GET http://example.com/go',
      'POST http://example.com/halt',
    ].join('\n'));
    expect(audit.unmatched).toHaveLength(0);
    expect(audit.loops).toHaveLength(0);
    expect(audit.ruleStats.map((s) => s.hitRequests)).toEqual([1, 1]);
  });

  it('invalid-target 计入命中规则的统计（属配置问题，不是样本问题）', () => {
    const rules: Rule[] = [
      rule({
        id: 'bad',
        pathTemplate: '/x',
        action: { type: 'rewrite', target: 'http://', status: 302 },
      }),
    ];
    const audit = auditSamples(rules, 'GET http://example.com/x');
    expect(audit.runs[0].sim.status).toBe('invalid-target');
    expect(audit.ruleStats[0].hitRequests).toBe(1);
    expect(audit.ruleStats[0].executions).toBe(1);
    expect(audit.invalidInput).toHaveLength(0);
  });
});

describe('stepsOfRule', () => {
  it('从轨迹中挑出指定规则的全部命中步', () => {
    const audit = auditSamples(CHAIN, 'GET http://example.com/a');
    const run = audit.runs[0];
    expect(stepsOfRule(run.sim, 'r1').map((s) => s.n)).toEqual([1]);
    expect(stepsOfRule(run.sim, 'r2').map((s) => s.n)).toEqual([2]);
    expect(stepsOfRule(run.sim, 'off')).toEqual([]);
  });
});

describe('auditFingerprint', () => {
  it('规则或样本文本变化都会改变指纹', () => {
    const f1 = auditFingerprint(CHAIN, 'GET http://example.com/a');
    expect(auditFingerprint(CHAIN, 'GET http://example.com/a')).toBe(f1);
    expect(auditFingerprint(CHAIN, 'GET http://example.com/b')).not.toBe(f1);
    expect(
      auditFingerprint(CHAIN.map((r) => ({ ...r, name: r.name + '!' })),
        'GET http://example.com/a'),
    ).not.toBe(f1);
  });
});
