import test from 'node:test';
import assert from 'node:assert/strict';
import {categoryIds,categoryDefinitions,categoryOptions,resolveCategories,validateCategoryIds,taxonomyVersion} from '../lib/category-taxonomy.mjs';
import {categoryPaths,categoryTree,categoryName,hierarchyMatches} from '../lib/category-display.mjs';
import {buildAnalysisRequest,reviewAnalysis} from '../lib/analysis.mjs';
const video=categories=>({analysis:{categories}});
const record={id:'Synthetic_1',duration_seconds:20,media_verified:true,transcript:''};
const report=categories=>({title:'Synthetic',summary:'Synthetic',categories,useful_information:[],visual_observations:[],limitations:[],transcript_quality:{assessment:'Unknown',uncertain_segments:[]}});
test('every generated ID has a readable navigation path, including fallback',()=>{
 assert.equal(new Set(categoryIds).size,categoryIds.length);
 for(const c of categoryDefinitions){
  const v=video([c.id]);assert.equal(categoryName(c.id),c.name);
  assert.deepEqual(categoryPaths(v),[{group:c.group,name:c.name}]);
  assert.ok(hierarchyMatches(v,c.group,c.name));
 }
 assert.throws(()=>validateCategoryIds(['unknown']));
 assert.throws(()=>validateCategoryIds(['receitas','receitas']));
 assert.throws(()=>validateCategoryIds([]));
 assert.throws(()=>validateCategoryIds(['Receitas']));
});
test('legacy decisions reuse existing branches and keep narrower subjects as topics',()=>{
 const routes=[['Casa e Arquitetura',['casa-decoracao']],['Alimentação Saudável',['nutricao']],['Viagens e Turismo',['destinos-experiencias']],['Dicas de Restaurantes',['onde-comer']],['Gadgets',['hardware-setup']],['Branding',['marketing-comunicacao']]];
 for(const [term,ids] of routes)assert.deepEqual(resolveCategories([term]).ids,ids,term);
 for(const term of ['Pães','Café da Manhã','Inovação','Esportes','Pratos Principais','Petiscos']){
  const r=resolveCategories(['receitas',term]);
  assert.deepEqual(r.ids,['receitas']);assert.deepEqual(r.topics,[term]);
  assert.deepEqual(resolveCategories([term]).ids,['a-organizar']);
 }
});
test('broad labels never invent narrow categories, and new unknown labels stay pending',()=>{
 for(const term of ['Casa','Negócios','Saúde'])assert.deepEqual(resolveCategories([term]).ids,['a-organizar']);
 assert.deepEqual(resolveCategories(['Negócios','Branding']).ids,['marketing-comunicacao']);
 assert.deepEqual(resolveCategories(['Casa','Faça você mesmo']).ids,['faca-voce-mesmo']);
 assert.deepEqual(resolveCategories(['Saúde','Fitness']).ids,['exercicio-fisico']);
 assert.deepEqual(resolveCategories(['Saúde','Nutrição']).ids,['nutricao']);
 assert.deepEqual(resolveCategories(['Tema desconhecido','Marketing']).ids,['marketing-comunicacao']);
 // Broad sustainability must not silently acquire a food-specific route.
 assert.deepEqual(resolveCategories(['Sustentabilidade']).ids,['a-organizar']);
});
test('mixed old and new labels deduplicate source counts without changing source data',()=>{
 const records=[video(['receitas','Receitas','Receitas Culinárias','Petiscos']),video(['marketing-comunicacao','Marketing','Negócios','Branding']),video(['a-organizar','Tema desconhecido','Inovação'])];
 const copy=structuredClone(records),tree=categoryTree(records);
 assert.equal(tree.find(g=>g.name==='Alimentação').count,1);
 assert.equal(tree.find(g=>g.name==='Trabalho e negócios').children[0].count,1);
 assert.equal(tree.find(g=>g.name==='Outros temas').count,1);
 assert.deepEqual(records,copy);
});
test('request, runtime and navigation use the same catalog while legacy review stays compatible',()=>{
 const request=buildAnalysisRequest({record,bucket:'synthetic-bucket',preset:{version:'synthetic',system_instruction:'Synthetic',user_instruction:'Synthetic'}});
 const schema=request.generationConfig.responseSchema.properties.categories;
 assert.deepEqual([...new Set(schema.anyOf.flatMap(branch=>branch.items.enum))].sort(),[...categoryIds].sort());
 const prompt=JSON.parse(request.contents[0].parts[1].text);
 assert.deepEqual(prompt.category_options,categoryOptions());
 assert.equal(prompt.category_taxonomy_version,taxonomyVersion);
 assert.match(request.systemInstruction.parts[0].text,/a-organizar/);
 const original=report(['receitas','nutricao']),copy=structuredClone(original);
 const reviewed=reviewAnalysis(original,record,{requireCategoryIds:true});
 assert.equal(reviewed.category_taxonomy_version,taxonomyVersion);
 assert.deepEqual(original,copy);
 assert.throws(()=>reviewAnalysis(report(['Invented']),record,{requireCategoryIds:true}),/identificadores/);
 assert.throws(()=>reviewAnalysis(report(['receitas','receitas']),record,{requireCategoryIds:true}));
 assert.doesNotThrow(()=>reviewAnalysis(report(['Legacy label']),record));
 assert.doesNotThrow(()=>reviewAnalysis(report(['a-organizar']),record,{requireCategoryIds:true}));
});

test('a destination is not duplicated by unresolved labels or the explicit fallback',()=>{
 for(const categories of [['Saúde','Esportes','Nutrição'],['a-organizar','nutricao','Unknown']]){
  assert.deepEqual(categoryPaths(video(categories)),[{group:'Alimentação',name:'Nutrição e suplementação'}]);
  assert.ok(resolveCategories(categories).unresolved.length);
 }
 assert.deepEqual(resolveCategories(['Unknown']).ids,['a-organizar']);
 assert.deepEqual(resolveCategories(['Unknown']).unresolved,['Unknown']);
});
test('navigation follows purpose with broad legacy labels and secondary subjects preserved',()=>{
 const cases=[
  [['Receitas','Culinária','Alimentação Saudável'],'receitas'],
  [['Receitas','Saúde e Bem-Estar'],'receitas'],
  [['Viagens e Turismo','Gastronomia','Dicas de Restaurantes'],'onde-comer'],
  [['Negócios','Tecnologia','Marketing'],'marketing-comunicacao'],
  [['Tecnologia','Desenvolvimento de Software','Carreira'],'desenvolvimento-software'],
  [['Casa','Faça você mesmo','Decoração'],'faca-voce-mesmo'],
  [['Negócios','Marketing','Moda'],'marketing-comunicacao'],
  [['nutricao','receitas'],'nutricao'],
  [['culinaria'],'receitas'],
  [['Tecnologia'],'tecnologia-geral'],
  [['Viagens e Turismo'],'destinos-experiencias'],
  [['Gastronomia'],'a-organizar']
 ];
 const sources=cases.map(([labels])=>video(labels)),copy=structuredClone(sources);
 for(const [labels,id] of cases){
  assert.equal(resolveCategories(labels).primaryId,id);
  assert.equal(categoryPaths(video(labels)).length,1);
 }
 assert.equal(categoryTree(sources).reduce((sum,g)=>sum+g.count,0),sources.length);
 assert.equal(categoryTree(sources).flatMap(g=>g.children).reduce((sum,c)=>sum+c.count,0),sources.length);
 assert.deepEqual(sources,copy);
});
test('generation bounds additional categories and keeps general destinations exclusive',()=>{
 assert.throws(()=>validateCategoryIds(['a-organizar','nutricao']));
 assert.throws(()=>validateCategoryIds(['tecnologia-geral','design-digital']));
 assert.throws(()=>validateCategoryIds(['receitas','nutricao','bem-estar']));
 assert.throws(()=>validateCategoryIds(['culinaria']));
 assert.doesNotThrow(()=>validateCategoryIds(['nutricao','exercicio-fisico']));
 const req=buildAnalysisRequest({record,bucket:'synthetic-bucket',preset:{version:'synthetic',system_instruction:'Synthetic',user_instruction:'Synthetic'}});
 assert.equal(Math.max(...req.generationConfig.responseSchema.properties.categories.anyOf.map(branch=>branch.maxItems)),2);
 assert.ok(categoryOptions().every(c=>c.scope));
});
