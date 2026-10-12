import test from 'node:test';
import assert from 'node:assert/strict';
import {categoryTree,hierarchyMatches,categoryPaths,categoryName} from '../lib/category-display.mjs';
test('hierarchy deduplicates counts, preserves categories and retains unknown themes',()=>{
 const videos=[{analysis:{categories:['Receitas','Receitas Culinárias','Nutrição']}},{analysis:{categories:['Programação','Productivity']}},{analysis:{categories:['Tema novo']}}];
 const original=JSON.stringify(videos),tree=categoryTree(videos);
 assert.equal(tree.find(g=>g.name==='Alimentação').count,1);
 assert.equal(tree.find(g=>g.name==='Alimentação').children.find(c=>c.name==='Receitas').count,1);
 assert.ok(hierarchyMatches(videos[0],'Alimentação','Nutrição'));
 assert.ok(!hierarchyMatches(videos[1],'Alimentação'));
 assert.ok(hierarchyMatches(videos[2],'Outros temas','A organizar'));
 assert.equal(JSON.stringify(videos),original);
});


// Fictional sources only: these fixtures contain no pilot content or identifiers.
const video=categories=>({analysis:{categories}});
const path=(group,name)=>({group,name});
const development=path('Tecnologia','Desenvolvimento de software');
const marketing=path('Trabalho e negócios','Marketing e comunicação');
const fallback=path('Outros temas','A organizar');

test('approved labels use the broader branch names without becoming aliases',()=>{
 assert.deepEqual(categoryPaths(video(['Desenvolvimento de Software'])),[development]);
 assert.deepEqual(categoryPaths(video(['Marketing'])),[marketing]);
 assert.equal(categoryName('Programação'),'Programação');
 assert.equal(categoryName('Marketing digital'),'Marketing digital');
 assert.equal(categoryName('Marketing'),'Marketing');
});

test('existing terms retain coverage under the renamed branches',()=>{
 for(const term of ['Programação','Desenvolvimento backend','Algoritmos'])
  assert.deepEqual(categoryPaths(video([term])),[development]);
 for(const term of ['Marketing digital','Redes sociais','Dropshipping'])
  assert.deepEqual(categoryPaths(video([term])),[marketing]);
 assert.deepEqual(categoryPaths(video(['productivity'])),[path('Tecnologia','Ferramentas e produtividade')]);
 assert.deepEqual(categoryPaths(video(['Comida japonesa'])),[path('Alimentação','Receitas')]);
});

test('comparison normalizes case, accents and spaces and counts each source once',()=>{
 const videos=[video(['  DESENVOLVIMENTO   DE SOFTWARE  ','Programação','programacao','Algoritmos']),
  video([' MARKETING ','marketing digital','Redes sociais','Marketing'])];
 assert.deepEqual(categoryPaths(videos[0]),[development]);
 assert.deepEqual(categoryPaths(videos[1]),[marketing]);
 const tree=categoryTree(videos);
 assert.equal(tree.find(g=>g.name==='Tecnologia').count,1);
 assert.deepEqual(tree.find(g=>g.name==='Tecnologia').children,[{name:development.name,count:1}]);
 assert.equal(tree.find(g=>g.name==='Trabalho e negócios').count,1);
 assert.deepEqual(tree.find(g=>g.name==='Trabalho e negócios').children,[{name:marketing.name,count:1}]);
 assert.ok(hierarchyMatches(videos[0],development.group,development.name));
 assert.ok(hierarchyMatches(videos[1],marketing.group,marketing.name));
});

test('mixed domains retain unknown-label fallback and empty categories stay empty',()=>{
 const mixed=video(['Desenvolvimento de Software','Marketing','Tema fictício não coberto']);
 assert.deepEqual(categoryPaths(mixed),[development,marketing,fallback]);
 assert.deepEqual(categoryPaths(video(['Negócios','Branding'])),[fallback]);
 assert.deepEqual(categoryPaths(video([])),[]);
 assert.deepEqual(categoryPaths({}),[]);
 const tree=categoryTree([mixed]);
 assert.ok(tree.every(g=>g.count===1&&g.children.every(c=>c.count===1)));
});

test('navigation leaves all source data, candidate analysis and supplement untouched',()=>{
 const record={id:'fictional-source',transcript:'Fictional transcript',source_caption:{text:'Fictional caption'},
  analysis:{categories:['Marketing','Programação','Tema fictício'],knowledge:{context:'technology',
   fields:[{kind:'tool',name:'Fictional tool',value:'Fictional value',evidence:[{source:'caption',excerpt:'Fictional caption'}]}],
   keywords:[{term:'Fictional keyword'}]}},
  analysis_candidate:{categories:['Candidate only']},knowledge_supplement:{fields:[{value:'Supplement only'}]}};
 const snapshot=JSON.stringify(record);
 const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}};
 freeze(record);
 assert.deepEqual(categoryPaths(record),[development,marketing,fallback]);
 categoryTree([record]);hierarchyMatches(record,marketing.group,marketing.name);
 assert.equal(JSON.stringify(record),snapshot);
});
