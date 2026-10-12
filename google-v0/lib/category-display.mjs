import {categoryDefinitions,categoryKey,categoryLabel,resolveCategories} from './category-taxonomy.mjs';
export const categoryName=categoryLabel;
export function categoryList(videos){const names=new Map();for(const v of videos)for(const c of v.analysis?.categories??[]){const name=categoryName(c);if(name&&!names.has(categoryKey(name)))names.set(categoryKey(name),name);}return [...names.values()].sort((a,b)=>a.localeCompare(b,'pt-BR'));}
export function categoryMatches(video,selected){return selected==='Todos'||(video.analysis?.categories??[]).some(c=>categoryKey(categoryName(c))===categoryKey(categoryName(selected)));}

// Reads legacy labels and new official IDs without rewriting either analysis.
export function categoryPaths(video){
 const {primaryId}=resolveCategories(video.analysis?.categories??[]);
 return categoryDefinitions.filter(c=>c.id===primaryId).map(({group,name})=>({group,name}));
}
export function categoryTree(videos){
 const paths=videos.map(categoryPaths);
 return [...new Set(categoryDefinitions.map(c=>c.group))].map(group=>{
  const matching=paths.filter(items=>items.some(p=>p.group===group));
  const names=categoryDefinitions.filter(c=>c.group===group&&matching.some(items=>items.some(p=>p.name===c.name))).map(c=>c.name);
  return {name:group,count:matching.length,children:names.map(name=>({name,count:matching.filter(items=>items.some(p=>p.group===group&&p.name===name)).length}))};
 }).filter(g=>g.count);
}
export function hierarchyMatches(video,group,child='Todos'){
 return group==='Todos'||categoryPaths(video).some(p=>p.group===group&&(child==='Todos'||p.name===child));
}
