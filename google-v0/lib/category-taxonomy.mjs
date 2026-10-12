// One controlled vocabulary for generation and navigation. Legacy terms are
// editorial mappings, not claims that their meanings are identical.
export const taxonomyVersion='categories-v1';
export const categoryKey=value=>String(value).normalize('NFD').replace(/\p{M}/gu,'').trim().replace(/\s+/g,' ').toLocaleLowerCase('pt-BR');
export const categoryDefinitions=Object.freeze([
 ['receitas','Alimentação','Receitas',['receitas','panificacao','culinaria japonesa']],
 ['culinaria','Alimentação','Culinária',['culinaria','gastronomia','culinaria saudavel','dicas de restaurantes']],
 ['nutricao','Alimentação','Nutrição',['nutricao','saude e nutricao','suplementacao','alimentacao saudavel']],
 ['sustentabilidade-alimentar','Alimentação','Sustentabilidade',['alimentacao sustentavel']],
 ['desenvolvimento-software','Tecnologia','Desenvolvimento de software',['programacao','desenvolvimento backend','algoritmos','desenvolvimento de software']],
 ['inteligencia-artificial','Tecnologia','Inteligência artificial',['inteligencia artificial','automacao']],
 ['ferramentas-produtividade','Tecnologia','Ferramentas e produtividade',['ferramentas','produtividade']],
 ['hardware-setup','Tecnologia','Hardware e setup',['hardware','setup','gadgets']],
 ['design-digital','Tecnologia','Design digital',['design']],
 ['tecnologia-geral','Tecnologia','Tecnologia geral',['tecnologia']],
 ['exercicio-fisico','Saúde e bem-estar','Exercício físico',['fitness','hipertrofia','musculacao','saude e fitness']],
 ['bem-estar','Saúde e bem-estar','Bem-estar',['saude e bem-estar']],
 ['marketing-comunicacao','Trabalho e negócios','Marketing e comunicação',['marketing digital','redes sociais','dropshipping','marketing','branding']],
 ['carreira','Trabalho e negócios','Carreira',['carreira']],
 ['casa-decoracao','Casa e estilo','Casa e decoração',['arquitetura e decoracao','decoracao','utilidades domesticas','casa e arquitetura']],
 ['faca-voce-mesmo','Casa e estilo','Faça você mesmo',['faca voce mesmo']],
 ['moda-acessorios','Casa e estilo','Moda e acessórios',['moda','estilo','acessorios']],
 ['destinos-experiencias','Viagens e lugares','Destinos e experiências',['dicas de viagem','rio de janeiro','viagens e turismo','dicas de restaurantes']],
 ['a-organizar','Outros temas','A organizar',[]]
].map(([id,group,name,terms])=>Object.freeze({id,group,name,terms:Object.freeze(terms)})));
export const categoryIds=Object.freeze(categoryDefinitions.map(c=>c.id));
const byId=new Map(categoryDefinitions.map(c=>[c.id,c]));
const aliases=new Map([['productivity','Produtividade'],['tools','Ferramentas'],['receitas culinarias','Receitas'],['comida japonesa','Culinária japonesa']]);
export function categoryLabel(value){
 if(typeof value!=='string'||!value.trim())return null;
 const text=value.trim().replace(/\s+/g,' ');
 return byId.get(text)?.name??aliases.get(categoryKey(text))??text.charAt(0).toLocaleUpperCase('pt-BR')+text.slice(1);
}
const topicTerms=new Set(['paes','cafe da manha','inovacao','esportes','pratos principais','petiscos']);
const broadGroups=new Map([['casa','Casa e estilo'],['negocios','Trabalho e negócios'],['saude','Saúde e bem-estar']]);
const termsById=new Map(categoryDefinitions.map(c=>[c.id,new Set(c.id==='a-organizar'?[categoryKey(c.name)]:c.terms)]));
export function resolveCategories(values=[]){
 const terms=values.map(value=>({value,key:categoryKey(categoryLabel(value)??'')}));
 const found=new Set();
 for(const c of categoryDefinitions)if(terms.some(t=>t.value===c.id||termsById.get(c.id).has(t.key)))found.add(c.id);
 const groups=new Set(categoryDefinitions.filter(c=>found.has(c.id)).map(c=>c.group));
 const topics=[],unresolved=[];
 for(const t of terms){
  if(!t.key)continue;
  if(categoryDefinitions.some(c=>t.value===c.id||termsById.get(c.id).has(t.key)))continue;
  if(topicTerms.has(t.key)){topics.push(t.value);continue;}
  // A broad label does not invent a narrower child. It is covered only when
  // another label already establishes a path in that group.
  if(broadGroups.has(t.key)&&groups.has(broadGroups.get(t.key)))continue;
  unresolved.push(t.value);
 }
 if(unresolved.length||(topics.length&&!found.size))found.add('a-organizar');
 return {ids:categoryIds.filter(id=>found.has(id)),topics,unresolved};
}
export function validateCategoryIds(values){
 if(!Array.isArray(values)||!values.length||values.length>categoryIds.length||values.some(id=>!byId.has(id))||new Set(values).size!==values.length)throw Error('Categorias devem usar identificadores oficiais únicos.');
}
export function categoryOptions(){return categoryDefinitions.map(({id,group,name})=>({id,group,name}));}
