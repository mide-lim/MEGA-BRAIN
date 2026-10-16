import {authenticated} from '../lib/server.mjs';
import Workspace from './reels/workspace.jsx';
export const dynamic='force-dynamic';
export default async function Page(){
 if(!await authenticated())return <main className="login"><div className="brand"><span className="brand-mark">M</span><span>MEGA<span>BRAIN</span></span></div><h1>Seu conhecimento, organizado.</h1><p>Explore seu acervo de Reels, acompanhe as filas e encontre o que você quer lembrar.</p><a className="button primary" href="/auth/login">Entrar com Google</a><small>Acesso exclusivo: midelim.dev@gmail.com</small><span className="login-label">MEGABRAIN - Reels</span></main>;
 return <Workspace/>;
}
