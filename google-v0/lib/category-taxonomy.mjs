// Controlled destinations. Original labels and secondary subjects remain in the analysis.
export const taxonomyVersion='categories-v2';
export const categoryKey=value=>String(value).normalize('NFD').replace(/\p{M}/gu,'').trim().replace(/\s+/g,' ').toLocaleLowerCase('pt-BR');
export const categoryDefinitions=Object.freeze([
 ['receitas','Alimentação','Receitas e preparo',['receitas','panificacao','culinaria japonesa','culinaria','culinaria saudavel','receitas e preparo'],'Ensinar receitas e técnicas de preparo. Ingredientes saudáveis não tornam uma receita uma aula de nutrição.'],
 ['nutricao','Alimentação','Nutrição e suplementação',['nutricao','saude e nutricao','suplementacao','alimentacao saudavel','nutricao e suplementacao'],'Explicar alimentação, nutrientes, dietas ou suplementos; não apenas mencionar ingredientes de uma receita.'],
 ['sustentabilidade-alimentar','Alimentação','Sustentabilidade',['alimentacao sustentavel'],'Ensinar redução de desperdício e impacto ambiental da alimentação.'],
 ['desenvolvimento-software','Tecnologia','Desenvolvimento de software',['programacao','desenvolvimento backend','algoritmos','desenvolvimento de software'],'Ensinar programação, arquitetura ou projetos de software.'],
 ['inteligencia-artificial','Tecnologia','Inteligência artificial',['inteligencia artificial','automacao'],'Explicar ou construir sistemas de IA; o mero uso de IA em marketing não basta.'],
 ['ferramentas-produtividade','Tecnologia','Ferramentas e produtividade',['ferramentas','produtividade'],'Organizar trabalho e aumentar produtividade com ferramentas de uso geral.'],
 ['hardware-setup','Tecnologia','Hardware e setup',['hardware','setup','gadgets'],'Apresentar ou montar equipamentos e acessórios tecnológicos.'],
 ['design-digital','Tecnologia','Design digital',['design'],'Criar ou inspecionar tipografia, cores e interfaces, inclusive com ferramentas de design.'],
 ['tecnologia-geral','Tecnologia','Tecnologia geral',['tecnologia'],'Conteúdo tecnológico sem um destino específico adequado; não acumular com outro destino.'],
 ['exercicio-fisico','Saúde e bem-estar','Exercício físico',['fitness','hipertrofia','musculacao','saude e fitness'],'Ensinar exercícios, treino e execução de movimentos. Suplementos pertencem a Nutrição e suplementação.'],
 ['bem-estar','Saúde e bem-estar','Bem-estar',['saude e bem-estar'],'Práticas de bem-estar; não incluir receitas apenas por serem descritas como saudáveis.'],
 ['marketing-comunicacao','Trabalho e negócios','Marketing e comunicação',['marketing digital','redes sociais','dropshipping','marketing','branding'],'Ensinar anúncios, comunicação e crescimento de marcas, inclusive usando ferramentas de IA.'],
 ['carreira','Trabalho e negócios','Carreira',['carreira'],'Orientar decisões de carreira e busca de trabalho; projetos técnicos permanecem em Desenvolvimento de software.'],
 ['casa-decoracao','Casa e estilo','Casa e decoração',['arquitetura e decoracao','decoracao','utilidades domesticas','casa e arquitetura'],'Apresentar soluções para espaços, arquitetura e decoração.'],
 ['faca-voce-mesmo','Casa e estilo','Faça você mesmo',['faca voce mesmo'],'Ensinar a fabricar ou reparar objetos; a aplicação decorativa pode ser assunto secundário.'],
 ['moda-acessorios','Casa e estilo','Moda e acessórios',['moda','estilo','acessorios','moda e estilo','estilo pessoal','beleza e cuidados pessoais','cuidados pessoais','cabelo e barba','cortes de cabelo','barbearia'],'Ensinar estilo pessoal e aparência: uso, combinação ou escolha de roupas e acessórios, cabelo, barba e cuidados pessoais estéticos. Diagnóstico e tratamento de saúde pertencem a Bem-estar; estratégia de marca pertence a Marketing.'],
 ['destinos-experiencias','Viagens e lugares','Destinos e experiências',['dicas de viagem','rio de janeiro','viagens e turismo'],'Recomendar destinos, passeios e experiências; estabelecimentos para comer têm destino próprio.'],
 ['onde-comer','Viagens e lugares','Onde comer',['dicas de restaurantes','restaurantes','onde comer'],'Recomendar restaurantes, cafés e estabelecimentos; preparo de pratos pertence a Receitas e preparo.'],
 ['a-organizar','Outros temas','A organizar',[],'Usar sozinho e somente quando nenhum destino servir.']
].map(([id,group,name,terms,scope])=>Object.freeze({id,group,name,terms:Object.freeze(terms),scope})));
export const categoryIds=Object.freeze(categoryDefinitions.map(c=>c.id));
// This contract is shared by provider generation and local validation.
export const genericCategoryIds=Object.freeze(['tecnologia-geral','a-organizar']);
export function categorySelectionSchema(additionalIds=[]){
 const specific=[...new Set([...categoryIds,...additionalIds])].filter(id=>!genericCategoryIds.includes(id));
 return {anyOf:[
  {type:'ARRAY',minItems:1,maxItems:1,items:{type:'STRING',enum:[...genericCategoryIds]}},
  {type:'ARRAY',minItems:1,maxItems:2,items:{type:'STRING',enum:specific}}
 ]};
}
const byId=new Map(categoryDefinitions.map(c=>[c.id,c]));
const aliases=new Map([['productivity','Produtividade'],['tools','Ferramentas'],['receitas culinarias','Receitas'],['comida japonesa','Culinária japonesa']]);
export function categoryLabel(value){
 if(typeof value!=='string'||!value.trim())return null;
 const raw=value.trim().replace(/\s+/g,' '),text=aliases.get(categoryKey(raw))??raw;
 const id=categoryKey(text)==='culinaria'?'receitas':categoryKey(text);
 return byId.get(id)?.name??text.charAt(0).toLocaleUpperCase('pt-BR')+text.slice(1);
}
const topicTerms=new Set(['paes','cafe da manha','inovacao','esportes','pratos principais','petiscos']);
const broadGroups=new Map([['casa','Casa e estilo'],['negocios','Trabalho e negócios'],['saude','Saúde e bem-estar']]);
// A display label can be broader than its destination's scope. Keep those
// labels unresolved unless an explicit alias supplies the missing context.
const ambiguousDisplayNames=new Set(['sustentabilidade']);
const termsById=new Map(categoryDefinitions.map(c=>[c.id,new Set([...(ambiguousDisplayNames.has(categoryKey(c.name))?[]:[categoryKey(c.name)]),...c.terms.map(categoryKey)])]));
export function resolveCategories(values=[]){
 const terms=values.map(value=>({value,key:categoryKey(categoryLabel(value)??'')}));
 const ordered=[];
 for(const t of terms)for(const c of categoryDefinitions)if(t.value===c.id||termsById.get(c.id).has(t.key))if(!ordered.includes(c.id))ordered.push(c.id);
 const found=new Set(ordered.filter(id=>id!=='a-organizar'));
 const groups=new Set(categoryDefinitions.filter(c=>found.has(c.id)).map(c=>c.group));
 const topics=[],unresolved=[];
 for(const t of terms){
  if(!t.key)continue;
  if(categoryDefinitions.some(c=>t.value===c.id||termsById.get(c.id).has(t.key)))continue;
  if(topicTerms.has(t.key)){topics.push(t.value);continue;}
  if(broadGroups.has(t.key)&&groups.has(broadGroups.get(t.key)))continue;
  unresolved.push(t.value);
 }
 // Label review is separate from navigation: unresolved labels never add a
 // second destination to an already classified source.
 if(!found.size&&terms.some(t=>t.key))found.add('a-organizar');
 // Legacy categories were ordered broad-to-specific. Prefer a specific route
 // over the two generic destinations; otherwise preserve source order.
 const specific=ordered.filter(id=>found.has(id)&&id!=='tecnologia-geral'&&!(id==='destinos-experiencias'&&found.has('onde-comer')));
 const primaryId=specific[0]??ordered.find(id=>found.has(id))??(found.has('a-organizar')?'a-organizar':null);
 return {ids:categoryIds.filter(id=>found.has(id)),primaryId,topics,unresolved};
}
export function validateCategoryIds(values,{additionalIds=[]}={}){
 const allowed=new Set([...categoryIds,...additionalIds]);
 if(!Array.isArray(values)||!values.length||values.length>2||values.some(id=>!allowed.has(id))||new Set(values).size!==values.length)throw Error('Categorias devem usar identificadores oficiais únicos ou destinos editoriais autorizados; no máximo dois.');
 if(values.length>1&&(values.some(id=>genericCategoryIds.includes(id))))throw Error('Categorias gerais devem ser usadas sozinhas.');
}
export function categoryOptions(){return categoryDefinitions.map(({id,group,name,scope})=>({id,group,name,scope}));}

// A known fallback adds no destination when the other official ID is already
// specific within Technology. Never reinterpret an unknown or cross-group label.
export function normalizedCategoryIds(values){
 if(!Array.isArray(values)||values.length!==2||new Set(values).size!==2||values.some(id=>!byId.has(id)))return values;
 if(values.includes('tecnologia-geral')){
  const specific=values.find(id=>id!=='tecnologia-geral');
  if(byId.get(specific).group==='Tecnologia')return [specific];
 }
 return values;
}

