export function paginate(items,page=1,size=6){
 const pageSize=[6,12,24].includes(size)?size:6;
 const pages=Math.max(1,Math.ceil(items.length/pageSize));
 const current=Math.min(pages,Math.max(1,Number.isFinite(page)?Math.floor(page):1));
 return {page:current,pages,items:items.slice((current-1)*pageSize,current*pageSize)};
}
