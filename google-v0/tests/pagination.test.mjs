import test from 'node:test';import assert from 'node:assert/strict';import {paginate} from '../lib/pagination.mjs';
test('pages retain every item exactly once including the last partial page',()=>{const items=Array.from({length:20},(_,i)=>i);assert.deepEqual([1,2,3,4].flatMap(p=>paginate(items,p,6).items),items);assert.equal(paginate(items,4,6).items.length,2);});
test('a reduced filter clamps the previous page and empty results stay navigable',()=>{assert.deepEqual(paginate([1,2],8),{page:1,pages:1,items:[1,2]});assert.deepEqual(paginate([],0),{page:1,pages:1,items:[]});assert.equal(paginate([1],NaN,999).page,1);});

test("nine-item pages form three rows and clamp the last page",()=>{const items=Array.from({length:20},(_,i)=>i);assert.equal(paginate(items).items.length,9);assert.equal(paginate(items,3).items.length,2);});
