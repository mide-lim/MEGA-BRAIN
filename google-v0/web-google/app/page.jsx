import {authenticated}from '../lib/server.mjs';import Library from './library.jsx';
export const dynamic='force-dynamic';
export default async function Page(){
  if(!await authenticated())return <main className="login"><div className="brand">MEGA <span>BRAIN</span></div><p>Seu acervo de conhecimento no Google.</p><a className="button" href="/auth/login">Entrar com Google</a><small>Acesso exclusivo à sua conta. Ambiente Google v0.</small></main>;
  return <Library/>;
}
