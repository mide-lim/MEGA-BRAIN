const aliases=new Map([['productivity','Produtividade'],['tools','Ferramentas'],['receitas culinarias','Receitas'],['comida japonesa','Culinária japonesa']]);
const key=value=>String(value).normalize('NFD').replace(/\p{M}/gu,'').trim().replace(/\s+/g,' ').toLocaleLowerCase('pt-BR');
export function categoryName(value){if(typeof value!=='string'||!value.trim())return null;const text=value.trim().replace(/\s+/g,' ');return aliases.get(key(text))??text.charAt(0).toLocaleUpperCase('pt-BR')+text.slice(1);}
export function categoryList(videos){const names=new Map();for(const v of videos)for(const c of v.analysis?.categories??[]){const name=categoryName(c);if(name&&!names.has(key(name)))names.set(key(name),name);}return [...names.values()].sort((a,b)=>a.localeCompare(b,'pt-BR'));}
export function categoryMatches(video,selected){return selected==='Todos'||(video.analysis?.categories??[]).some(c=>key(categoryName(c))===key(selected));}
