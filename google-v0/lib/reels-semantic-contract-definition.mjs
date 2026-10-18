// Shared wire semantics. Vertex schema describes supported constraints; server guards remain authoritative.
export const semanticContractSpec=Object.freeze({
 version:'semantic-contract-v2',outputVersion:1,
 contexts:['recipe','technology','health','travel','business','home','general'],
 groupKinds:['context','format','facet','segment'],
 facetDimensions:['ingredient','tool','method','place','purpose','other'],
 formats:['single_recipe','recipe_collection'],
 profileStates:['proposed','unknown','inconclusive'],unitTypes:['recipe','concept','place','other'],
 completeness:['complete','partial','unknown'],roles:['central','supporting','mentioned','unknown'],
 verdicts:['supported','inconclusive','invalid'],mergeDecisions:['keep','merge','reject'],
 regexes:{unitId:'^[A-Za-z0-9_-]{1,80}$',groupKey:'^[a-z][a-z0-9_-]{2,80}$'},
 limits:{groups:24,units:32,evidence:8,profileReason:3000,excerpt:1600,groupName:120,groupDefinition:2400,label:500,negativeReason:1000,resolutionReason:3000,verifierReason:3000,unitId:80,groupKey:81,outputCharacters:800000},
 formatRules:{single_recipe:{context:'recipe',minimumCompleteUnits:1,maximumCompleteUnits:1,completeSourceRequired:true},recipe_collection:{context:'recipe',minimumCompleteUnits:2,completeSourceRequired:false}}
});
