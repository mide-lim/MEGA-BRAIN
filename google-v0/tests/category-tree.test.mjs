import test from 'node:test';
import assert from 'node:assert/strict';
import {categoryTree,hierarchyMatches} from '../lib/category-display.mjs';
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

