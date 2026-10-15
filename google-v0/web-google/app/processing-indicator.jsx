export default function ProcessingIndicator({indicator}){
 if(!indicator)return null;
 return <dl className="processing-indicator" aria-label="Situação do processamento"><div><dt>Etapa</dt><dd>{indicator.stage_label}</dd></div><div><dt>Motivo</dt><dd>{indicator.reason}</dd></div><div><dt>Ação segura</dt><dd>{indicator.action}</dd></div>{indicator.unknown&&<div><dt>Não confirmado</dt><dd>{indicator.unknown}</dd></div>}</dl>;
}
