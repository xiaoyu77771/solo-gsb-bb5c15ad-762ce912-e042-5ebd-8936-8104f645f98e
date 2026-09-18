import { describe, expect, it } from 'vitest';
import {
  MAX_STEPS,
  matchHost,
  matchPath,
  matchQuery,
  resolveTarget,
  simulate,
  substitute,
} from './engine';
import type { QueryCondition, Rule } from './types';
import { validateRules } from './validate';

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

function cond(partial: Partial<QueryCondition> & { name: string }): QueryCondition {
  return { op: 'exists', value: '', ...partial };
}

describe('matchHost', () => {
  it('精确匹配，忽略大小写', () => {
    expect(matchHost('Example.com', 'example.com')).toBe(true);
    expect(matchHost('example.com', 'sub.example.com')).toBe(false);
  });

  it('通配子域：匹配任意层级子域，但不匹配裸域', () => {
    expect(matchHost('*.example.com', 'a.example.com')).toBe(true);
    expect(matchHost('*.example.com', 'a.b.example.com')).toBe(true);
    expect(matchHost('*.example.com', 'example.com')).toBe(false);
    expect(matchHost('*.example.com', 'notexample.com')).toBe(false);
  });

  it('星号匹配任意主机，空模式不匹配', () => {
    expect(matchHost('*', 'anything.dev')).toBe(true);
    expect(matchHost('', 'anything.dev')).toBe(false);
  });
});

describe('matchPath', () => {
  it('字面段与参数段', () => {
    expect(matchPath('/users/:id', '/users/42')).toEqual({ id: '42' });
    expect(matchPath('/users/:id', '/users/42/extra')).toBeNull();
    expect(matchPath('/users/:id', '/groups/42')).toBeNull();
  });

  it('根路径与末尾斜杠', () => {
    expect(matchPath('/', '/')).toEqual({});
    expect(matchPath('/users', '/users/')).toEqual({});
  });

  it('空模板与 * 匹配任意路径', () => {
    expect(matchPath('', '/any/thing')).toEqual({});
    expect(matchPath('*', '/any/thing')).toEqual({});
  });

  it('参数捕获会解码', () => {
    expect(matchPath('/p/:v', '/p/a%20b')).toEqual({ v: 'a b' });
  });
});

describe('matchQuery', () => {
  const params = (search: string) => new URL(`http://example.com/${search}`).searchParams;

  it('空条件数组命中任意查询串', () => {
    expect(matchQuery([], params(''))).toBe(true);
    expect(matchQuery([], params('?a=1&b=2'))).toBe(true);
  });

  it('exists：参数出现即命中（含空值），不出现则不命中', () => {
    const conds = [cond({ name: 'debug' })];
    expect(matchQuery(conds, params('?debug=1'))).toBe(true);
    expect(matchQuery(conds, params('?debug='))).toBe(true);
    expect(matchQuery(conds, params('?debug'))).toBe(true);
    expect(matchQuery(conds, params('?other=1'))).toBe(false);
    expect(matchQuery(conds, params(''))).toBe(false);
  });

  it('not-exists：参数完全不出现才命中', () => {
    const conds = [cond({ name: 'debug', op: 'not-exists' })];
    expect(matchQuery(conds, params(''))).toBe(true);
    expect(matchQuery(conds, params('?other=1'))).toBe(true);
    expect(matchQuery(conds, params('?debug='))).toBe(false);
    expect(matchQuery(conds, params('?debug=1'))).toBe(false);
  });

  it('equals：同名参数任一值相等即命中', () => {
    const conds = [cond({ name: 'env', op: 'equals', value: 'canary' })];
    expect(matchQuery(conds, params('?env=canary'))).toBe(true);
    // 多值参数：任一值相等即命中
    expect(matchQuery(conds, params('?env=prod&env=canary'))).toBe(true);
    expect(matchQuery(conds, params('?env=prod'))).toBe(false);
    expect(matchQuery(conds, params('?other=canary'))).toBe(false);
    expect(matchQuery(conds, params(''))).toBe(false);
  });

  it('equals 按解码后的原文精确比较（大小写敏感、百分号解码）', () => {
    const conds = [cond({ name: 'q', op: 'equals', value: 'a b' })];
    expect(matchQuery(conds, params('?q=a%20b'))).toBe(true);
    expect(matchQuery(conds, params('?q=a+b'))).toBe(true);
    expect(matchQuery(conds, params('?q=A%20B'))).toBe(false);
    // 参数名同样区分大小写
    expect(matchQuery([cond({ name: 'Q', op: 'equals', value: 'x' })], params('?q=x'))).toBe(false);
  });

  it('多条条件按 AND 组合：全部满足才命中', () => {
    const conds = [
      cond({ name: 'debug' }),
      cond({ name: 'token', op: 'not-exists' }),
      cond({ name: 'env', op: 'equals', value: 'canary' }),
    ];
    expect(matchQuery(conds, params('?debug=1&env=canary'))).toBe(true);
    expect(matchQuery(conds, params('?debug=1&env=canary&x=1'))).toBe(true);
    // 缺 debug
    expect(matchQuery(conds, params('?env=canary'))).toBe(false);
    // 带了 token
    expect(matchQuery(conds, params('?debug=1&env=canary&token=t'))).toBe(false);
    // env 值不等
    expect(matchQuery(conds, params('?debug=1&env=prod'))).toBe(false);
  });
});

describe('substitute / resolveTarget', () => {
  it('替换已捕获参数并重新编码，未知占位符保留', () => {
    expect(substitute('/u/:id/:missing', { id: 'a b' })).toBe('/u/a%20b/:missing');
  });

  it('相对路径保留源，绝对 URL 整体替换', () => {
    const cur = new URL('http://a.com/x/y');
    expect(resolveTarget('/z', cur).toString()).toBe('http://a.com/z');
    expect(resolveTarget('https://b.com/q', cur).toString()).toBe('https://b.com/q');
  });

  it('目标不含查询串时保留原查询串', () => {
    const cur = new URL('http://a.com/x?debug=1');
    expect(resolveTarget('/y', cur).toString()).toBe('http://a.com/y?debug=1');
    expect(resolveTarget('/y?a=1', cur).toString()).toBe('http://a.com/y?a=1');
  });
});

describe('simulate', () => {
  it('无规则命中：按原始请求放行', () => {
    const sim = simulate([], 'GET', 'http://example.com/a?x=1');
    expect(sim.status).toBe('final');
    expect(sim.ok).toBe(true);
    expect(sim.finalUrl).toBe('http://example.com/a?x=1');
    expect(sim.steps).toHaveLength(0);
  });

  it('首条命中规则生效，重写后从第一条重新匹配', () => {
    const rules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({ id: 'r2', pathTemplate: '/a', action: { type: 'rewrite', target: '/never', status: 302 } }),
      rule({ id: 'r3', pathTemplate: '/b', action: { type: 'rewrite', target: '/c', status: 302 } }),
    ];
    const sim = simulate(rules, 'GET', 'http://example.com/a');
    expect(sim.steps.map((s) => s.rule.id)).toEqual(['r1', 'r3']);
    expect(sim.status).toBe('final');
    expect(sim.finalUrl).toBe('http://example.com/c');
  });

  it('重写目标可引用路径参数，方法 ANY 与具体方法均可命中', () => {
    const rules = [
      rule({
        id: 'r1',
        method: 'POST',
        pathTemplate: '/users/:id',
        query: [],
        action: { type: 'rewrite', target: '/internal/:id', status: 302 },
      }),
    ];
    const sim = simulate(rules, 'POST', 'http://example.com/users/7');
    expect(sim.finalUrl).toBe('http://example.com/internal/7');
    expect(sim.steps[0].params).toEqual({ id: '7' });
    // 方法不匹配则不命中
    const miss = simulate(rules, 'GET', 'http://example.com/users/7');
    expect(miss.steps).toHaveLength(0);
  });

  it('重定向立即终止，后续规则不再执行', () => {
    const rules = [
      rule({
        id: 'r1',
        pathTemplate: '/old/:slug',
        query: [],
        action: { type: 'redirect', target: 'https://new.com/:slug', status: 301 },
      }),
      rule({ id: 'r2', pathTemplate: '/old/:slug', action: { type: 'stop', target: '', status: 302 } }),
    ];
    const sim = simulate(rules, 'GET', 'http://example.com/old/hello');
    expect(sim.status).toBe('redirect');
    expect(sim.ok).toBe(true);
    expect(sim.redirectStatus).toBe(301);
    expect(sim.redirectLocation).toBe('https://new.com/hello');
    expect(sim.steps).toHaveLength(1);
  });

  it('停止动作立即终止', () => {
    const rules = [rule({ id: 'r1', pathTemplate: '/admin', action: { type: 'stop', target: '', status: 302 } })];
    const sim = simulate(rules, 'GET', 'http://example.com/admin');
    expect(sim.status).toBe('stopped');
    expect(sim.ok).toBe(true);
  });

  it('未启用的规则被跳过', () => {
    const rules = [rule({ id: 'r1', enabled: false, pathTemplate: '/a', action: { type: 'stop', target: '', status: 302 } })];
    const sim = simulate(rules, 'GET', 'http://example.com/a');
    expect(sim.status).toBe('final');
  });

  it('查询条件不满足时跳过该规则，命中后续规则', () => {
    const rules = [
      rule({
        id: 'gray',
        pathTemplate: '/a',
        query: [cond({ name: 'env', op: 'equals', value: 'canary' })],
        action: { type: 'rewrite', target: 'https://gray.example.com/a', status: 302 },
      }),
      rule({ id: 'normal', pathTemplate: '/a', action: { type: 'rewrite', target: '/done', status: 302 } }),
    ];
    // 不带 env=canary：跳过 gray，命中 normal
    const prod = simulate(rules, 'GET', 'http://example.com/a?env=prod');
    expect(prod.steps.map((s) => s.rule.id)).toEqual(['normal']);
    expect(prod.finalUrl).toBe('http://example.com/done?env=prod');
    // 带 env=canary：首条即命中 gray
    const canary = simulate(rules, 'GET', 'http://example.com/a?env=canary');
    expect(canary.steps.map((s) => s.rule.id)).toEqual(['gray']);
    expect(canary.finalUrl).toBe('https://gray.example.com/a?env=canary');
  });

  it('重写保留查询串后，下一步仍按查询条件匹配', () => {
    const rules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({
        id: 'r2',
        pathTemplate: '/b',
        query: [cond({ name: 'debug' })],
        action: { type: 'rewrite', target: '/debug', status: 302 },
      }),
      rule({ id: 'r3', pathTemplate: '/b', action: { type: 'rewrite', target: '/done', status: 302 } }),
    ];
    // /a?debug=1 → /b?debug=1（保留查询串）→ r2 的 exists(debug) 命中
    const withDebug = simulate(rules, 'GET', 'http://example.com/a?debug=1');
    expect(withDebug.steps.map((s) => s.rule.id)).toEqual(['r1', 'r2']);
    expect(withDebug.finalUrl).toBe('http://example.com/debug?debug=1');
    // 无 debug：r2 不命中，落到 r3
    const plain = simulate(rules, 'GET', 'http://example.com/a');
    expect(plain.steps.map((s) => s.rule.id)).toEqual(['r1', 'r3']);
    expect(plain.finalUrl).toBe('http://example.com/done');
  });

  it('not-exists 条件可区分带参 / 不带参请求', () => {
    const rules = [
      rule({
        id: 'bare',
        pathTemplate: '/a',
        query: [cond({ name: 'token', op: 'not-exists' })],
        action: { type: 'stop', target: '', status: 302 },
      }),
    ];
    expect(simulate(rules, 'GET', 'http://example.com/a').status).toBe('stopped');
    expect(simulate(rules, 'GET', 'http://example.com/a?token=t').status).toBe('final');
  });

  it('自我重写被判定为循环，不返回成功结果', () => {
    const rules = [rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/a', status: 302 } })];
    const sim = simulate(rules, 'GET', 'http://example.com/a');
    expect(sim.status).toBe('loop');
    expect(sim.ok).toBe(false);
    expect(sim.finalUrl).toBeUndefined();
  });

  it('A↔B 往返被判定为循环', () => {
    const rules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({ id: 'r2', pathTemplate: '/b', action: { type: 'rewrite', target: '/a', status: 302 } }),
    ];
    const sim = simulate(rules, 'GET', 'http://example.com/a');
    expect(sim.status).toBe('loop');
    expect(sim.ok).toBe(false);
  });

  it('状态以方法+URL 区分：不同方法不构成循环', () => {
    // 规则把 /a 重写到 /a?m=1，再把 /a?m=1 重写到 /done —— 正常终止
    const rules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/a?m=1', status: 302 } }),
      rule({ id: 'r2', pathTemplate: '/a', action: { type: 'rewrite', target: '/done', status: 302 } }),
    ];
    // r1 会先命中 /a 与 /a?m=1（匹配忽略查询串），导致 /a?m=1 → /a?m=1 自我循环
    const sim = simulate(rules, 'GET', 'http://example.com/a');
    expect(sim.status).toBe('loop');
    expect(sim.reason).toContain('GET http://example.com/a?m=1');
  });

  it(`超过 ${MAX_STEPS} 步判定超限`, () => {
    const rules: Rule[] = Array.from({ length: MAX_STEPS + 5 }, (_, i) =>
      rule({
        id: `r${i}`,
        pathTemplate: `/s${i}`,
        query: [],
        action: { type: 'rewrite', target: `/s${i + 1}`, status: 302 },
      }),
    );
    const sim = simulate(rules, 'GET', 'http://example.com/s0');
    expect(sim.status).toBe('max-steps');
    expect(sim.ok).toBe(false);
    expect(sim.steps).toHaveLength(MAX_STEPS);
  });

  it('非法输入 URL 直接失败', () => {
    const sim = simulate([], 'GET', 'not a url');
    expect(sim.status).toBe('invalid-url');
    expect(sim.ok).toBe(false);
  });
});

describe('validateRules', () => {
  it('接受合法规则并补全默认值', () => {
    const rules = validateRules([
      {
        method: 'GET',
        host: 'a.com',
        pathTemplate: '/x/:id',
        action: { type: 'rewrite', target: '/y/:id', status: 302 },
      },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].enabled).toBe(true);
    expect(rules[0].id).toBeTruthy();
  });

  it('旧数据缺省 query 字段时回退为空条件', () => {
    const rules = validateRules([{ host: 'a.com', action: { target: '/y' } }]);
    expect(rules[0].query).toEqual([]);
  });

  it('解析查询条件：三种操作符与默认值补全', () => {
    const rules = validateRules([
      {
        host: 'a.com',
        action: { target: '/y' },
        query: [
          { name: 'debug' },
          { name: 'token', op: 'not-exists' },
          { name: ' env ', op: 'equals', value: 'canary' },
        ],
      },
    ]);
    expect(rules[0].query).toEqual([
      { name: 'debug', op: 'exists', value: '' },
      { name: 'token', op: 'not-exists', value: '' },
      { name: 'env', op: 'equals', value: 'canary' },
    ]);
  });

  it('查询条件类型错误给出定位信息', () => {
    expect(() => validateRules([{ query: 'x=1' }])).toThrow('第 1 条规则的 query 必须是数组');
    expect(() => validateRules([{ query: ['x'] }])).toThrow('第 1 条规则的第 1 条查询条件不是对象');
    expect(() => validateRules([{ query: [{ name: 1 }] }])).toThrow('name 必须是字符串');
    expect(() => validateRules([{ query: [{ name: '  ' }] }])).toThrow('参数名不能为空');
    expect(() => validateRules([{ query: [{ name: 'a', op: 'like' }] }])).toThrow(
      'op 必须是 exists / not-exists / equals 之一',
    );
    expect(() => validateRules([{ query: [{ name: 'a', op: 'equals', value: 1 }] }])).toThrow(
      'value 必须是字符串',
    );
  });

  it('同一规则内查询参数名重复时给出定位错误', () => {
    expect(() =>
      validateRules([
        { host: 'a.com', action: { target: '/y' } },
        {
          host: 'b.com',
          action: { target: '/z' },
          query: [
            { name: 'env', op: 'exists' },
            { name: 'other', op: 'exists' },
            { name: 'env', op: 'equals', value: 'x' },
          ],
        },
      ]),
    ).toThrow('第 2 条规则的查询条件存在重复参数名「env」');
  });

  it('拒绝非法输入', () => {
    expect(() => validateRules({})).toThrow('数组');
    expect(() => validateRules([{ method: 'FOO' }])).toThrow('method');
    expect(() =>
      validateRules([{ action: { type: 'rewrite', target: '' } }]),
    ).toThrow('target');
    expect(() =>
      validateRules([{ action: { type: 'redirect', target: '/x', status: 200 } }]),
    ).toThrow('status');
  });
});
