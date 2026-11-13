import test from 'node:test';
import assert from 'node:assert/strict';
import {csvText} from '../src/api.js';
import {alertMatches} from '../shared/time.js';
test('CSV 保留代码前导零、负数、引号与公式注入保护',()=>{
 const text=csvText([{symbol:'sz000001',code:'000001',name:'=危险,"文本"',price:10,changePct:-2,amount:1e8,quoteDate:'2026-10-29'}]);
 assert.ok(text.startsWith('\ufeff'));assert.ok(text.includes('000001.SZ'));assert.ok(text.includes('"-2"'));assert.ok(text.includes("'=危险"));assert.ok(text.includes('""文本""'));assert.equal(text.split('\r\n').length,2);
});
test('盘中阈值边界与无效阈值',()=>{
 const now='2026-10-30T02:00:00Z',q={quoteAt:'2026-10-30T01:59:30Z',changePct:3};
 assert.equal(alertMatches(q,3,now),true);assert.equal(alertMatches(q,4,now),false);
 for(const t of ['',NaN,Infinity,31,-31])assert.equal(alertMatches(q,t,now),false);
 assert.equal(alertMatches({...q,quoteAt:'2026-10-29T07:00:00Z'},0,now),false);
});
