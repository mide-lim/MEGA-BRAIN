const aliases=new Map([['productivity','Produtividade'],['tools','Ferramentas'],['receitas culinarias','Receitas'],['comida japonesa','Culinária japonesa']]);
const key=value=>String(value).normalize('NFD').replace(/\p{M}/gu,'').trim().replace(/\s+/g,' ').toLocaleLowerCase('pt-BR');
export function categoryName(value){if(typeof value!=='string'||!value.trim())return null;const text=value.trim().replace(/\s+/g,' ');return aliases.get(key(text))??text.charAt(0).toLocaleUpperCase('pt-BR')+text.slice(1);}
export function categoryList(videos){const names=new Map();for(const v of videos)for(const c of v.analysis?.categories??[]){const name=categoryName(c);if(name&&!names.has(key(name)))names.set(key(name),name);}return [...names.values()].sort((a,b)=>a.localeCompare(b,'pt-BR'));}
export function categoryMatches(video,selected){return selected==='Todos'||(video.analysis?.categories??[]).some(c=>key(categoryName(c))===key(selected));}

// Navigation taxonomy only: original AI categories remain intact.
const taxonomy=[
 ['Alimentação',[
  ['Receitas',['receitas','panificacao','culinaria japonesa']],
  ['Culinária',['culinaria','gastronomia','culinaria saudavel']],
  ['Nutrição',['nutricao','saude e nutricao','suplementacao']],
  ['Sustentabilidade',['alimentacao sustentavel']]]],
 ['Tecnologia',[
  ['Programação',['programacao','desenvolvimento backend','algoritmos']],
  ['Inteligência artificial',['inteligencia artificial','automacao']],
  ['Ferramentas e produtividade',['ferramentas','produtividade']],
  ['Hardware e setup',['hardware','setup']],
  ['Design digital',['design']],
  ['Tecnologia geral',['tecnologia']]]],
 ['Saúde e bem-estar',[
  ['Exercício físico',['fitness','hipertrofia','musculacao','saude e fitness']],
  ['Bem-estar',['saude e bem-estar']]]],
 ['Trabalho e negócios',[
  ['Marketing e redes sociais',['marketing digital','redes sociais','dropshipping']],
  ['Carreira',['carreira']]]],
 ['Casa e estilo',[
  ['Casa e decoração',['arquitetura e decoracao','decoracao','utilidades domesticas']],
  ['Faça você mesmo',['faca voce mesmo']],
  ['Moda e acessórios',['moda','estilo','acessorios']]]],
 ['Viagens e lugares',[
  ['Destinos e experiências',['dicas de viagem','rio de janeiro']]]]
];
export function categoryPaths(video){
 const tags=(video.analysis?.categories??[]).map(c=>key(categoryName(c)));
 const paths=[];
 for(const [group,children] of taxonomy)for(const [name,terms] of children)
  if(terms.some(t=>tags.includes(t)))paths.push({group,name});
 const known=new Set(taxonomy.flatMap(([,children])=>children.flatMap(([,terms])=>terms)));
 if(tags.some(t=>t&&!known.has(t)))paths.push({group:'Outros temas',name:'A organizar'});
 return paths;
}
export function categoryTree(videos){
 return [...taxonomy.map(([group])=>group),'Outros temas'].map(group=>{
  const matching=videos.filter(v=>categoryPaths(v).some(p=>p.group===group));
  const names=[...new Set(matching.flatMap(v=>categoryPaths(v).filter(p=>p.group===group).map(p=>p.name)))];
  return {name:group,count:matching.length,children:names.map(name=>({name,count:matching.filter(v=>categoryPaths(v).some(p=>p.group===group&&p.name===name)).length}))};
 }).filter(g=>g.count);
}
export function hierarchyMatches(video,group,child='Todos'){
 return group==='Todos'||categoryPaths(video).some(p=>p.group===group&&(child==='Todos'||p.name===child));
}
