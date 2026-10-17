import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreCatalog,categoryPath,categoryRows,createResourceClient} from '../web-google/lib/reels-query-state.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const nodes=[{id:'food',name:'Alimentação',parentId:null},{id:'recipe',name:'Receitas',parentId:'food'},{id:'single',name:'Receita única',parentId:'recipe'},{id:'tech',name:'Tecnologia',parentId:null}];
test('category search keeps the matching child and ancestors without unrelated roots',()=>{
 const rows=categoryRows(nodes,'única');
 assert.deepEqual(rows.get(null).map(n=>n.id),['food']);assert.deepEqual(rows.get('food').map(n=>n.id),['recipe']);assert.deepEqual(rows.get('recipe').map(n=>n.id),['single']);
 assert.deepEqual(categoryRows(nodes,'naoexiste').size,0);assert.deepEqual(categoryPath(nodes,'single').map(n=>n.id),['food','recipe','single']);
 assert.deepEqual(categoryPath([{id:'a',parentId:'b'},{id:'b',parentId:'a'}],'a').length,2);
});
test('restored library context retains filters, expansion, pagination, list and scroll',()=>{
 const saved={filters:{category:'recipe',q:'frango',language:'pt',unexpected:'ignored'},search:'frango',limit:'25',view:'list',expanded:['food','recipe'],scope:'all',attentionKind:'uncertain',treeSearch:'receita',scroll:876,pagination:{signature:'x',cursor:'next',history:['']}};
 const restored=restoreCatalog(saved);assert.equal(restored.filters.category,'recipe');assert.equal(restored.filters.unexpected,undefined);assert.deepEqual(restored.expanded,['food','recipe']);assert.equal(restored.scroll,876);assert.equal(restored.view,'list');assert.equal(restored.pagination.cursor,'next');
 assert.equal(restoreCatalog({limit:'10000',scroll:-10}).limit,'50');assert.equal(restoreCatalog({}).scope,'ready');assert.equal(restoreCatalog({}).attentionKind,'confirmed');
});
test('same path and revision share a request and expose cached data',async()=>{
 let calls=0,clock=1;const pending=deferred(),client=createResourceClient(()=>{calls++;return pending.promise;},{now:()=>clock});const offA=client.subscribe('/categories',()=>{}),offB=client.subscribe('/categories',()=>{});
 const a=client.load('/categories',1),b=client.load('/categories',1);await Promise.resolve();assert.equal(calls,1);pending.resolve({nodes:[]});await Promise.all([a,b]);assert.deepEqual(client.peek('/categories').data,{nodes:[]});assert.equal(calls,1);offA();offB();
});
test('background reads retain last good data and errors never blank the page',async()=>{
 const requests=[];const client=createResourceClient(()=>{const r=deferred();requests.push(r);return r.promise;});const off=client.subscribe('/items',()=>{});const first=client.load('/items',1);await Promise.resolve();requests[0].resolve({items:[{id:'ok'}]});await first;
 const refresh=client.load('/items',2);assert.deepEqual(client.peek('/items').data.items,[{id:'ok'}]);assert.equal(client.peek('/items').loading,true);await Promise.resolve();requests[1].reject(new Error('offline'));await refresh;assert.equal(client.peek('/items').error.message,'offline');assert.deepEqual(client.peek('/items').data.items,[{id:'ok'}]);off();
});
test('an older response cannot overwrite a newer response even if transport ignores abort',async()=>{
 const requests=[];const client=createResourceClient((path,options)=>{const r=deferred();requests.push({...r,signal:options.signal});return r.promise;});const off=client.subscribe('/items',()=>{});const old=client.load('/items',1);await Promise.resolve();const fresh=client.load('/items',2);await Promise.resolve();assert.equal(requests[0].signal.aborted,true);requests[1].resolve({value:'new'});await fresh;requests[0].resolve({value:'old'});await old;assert.equal(client.peek('/items').data.value,'new');off();
});
test('unmount cancels an unobserved request and two paths stay isolated',async()=>{
 const requests=[];const client=createResourceClient((path,options)=>{const r=deferred();requests.push({...r,path,signal:options.signal});return r.promise;});const off=client.subscribe('/old',()=>{});const old=client.load('/old',1);await Promise.resolve();off();assert.equal(requests[0].signal.aborted,true);requests[0].resolve({value:'ignored'});await old;assert.equal(client.peek('/old').data,null);
 const offNew=client.subscribe('/new',()=>{}),fresh=client.load('/new',1);await Promise.resolve();requests[1].resolve({value:'new'});await fresh;assert.equal(client.peek('/new').data.value,'new');offNew();
});
