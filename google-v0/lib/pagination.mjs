export function paginate(items,page=1,size=9){
 const pageSize=[3,6,9,12,18,24,27].includes(size)?size:9;
 const pages=Math.max(1,Math.ceil(items.length/pageSize));
 const current=Math.min(pages,Math.max(1,Number.isFinite(page)?Math.floor(page):1));
 return {page:current,pages,items:items.slice((current-1)*pageSize,current*pageSize)};
}
