import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
mkdirSync(path.join(root, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(root, 'data', 'crease-capital.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, team_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('ADMIN','USER')), is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS seasons (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, added_amount INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS user_teams (user_id INTEGER PRIMARY KEY REFERENCES users(id), current_purse INTEGER NOT NULL DEFAULT 0, expected_purse INTEGER NOT NULL DEFAULT 0, season_added INTEGER NOT NULL DEFAULT 0, winning_amount INTEGER NOT NULL DEFAULT 0, trade_net INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, cricket_team TEXT NOT NULL, base_wage INTEGER NOT NULL, current_wage INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS user_players (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), player_id INTEGER NOT NULL REFERENCES players(id), source TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_owner ON user_players(player_id) WHERE active = 1;
CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY, season_id INTEGER REFERENCES seasons(id), initiated_by INTEGER NOT NULL REFERENCES users(id), counterparty INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL, message TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT);
CREATE TABLE IF NOT EXISTS trade_players (id INTEGER PRIMARY KEY, trade_id INTEGER NOT NULL REFERENCES trades(id), player_id INTEGER NOT NULL REFERENCES players(id), from_user INTEGER NOT NULL REFERENCES users(id), to_user INTEGER NOT NULL REFERENCES users(id), old_wage INTEGER NOT NULL, new_wage INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY, trade_id INTEGER NOT NULL REFERENCES trades(id), sender_id INTEGER NOT NULL REFERENCES users(id), message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS purse_transactions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), season_id INTEGER REFERENCES seasons(id), type TEXT NOT NULL, amount INTEGER NOT NULL, reference_type TEXT, reference_id INTEGER, description TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS unique_ledger_reference ON purse_transactions(user_id, type, reference_type, reference_id) WHERE reference_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS winner_payouts (id INTEGER PRIMARY KEY, season_id INTEGER NOT NULL REFERENCES seasons(id), user_id INTEGER NOT NULL REFERENCES users(id), position INTEGER NOT NULL, amount INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(season_id,user_id), UNIQUE(season_id,position));
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, read_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY, actor_id INTEGER REFERENCES users(id), action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);

function recalculate(userId: number) {
  const purse = (db.prepare('SELECT COALESCE(SUM(amount),0) total FROM purse_transactions WHERE user_id=?').get(userId) as {total:number}).total;
  const wages = (db.prepare(`SELECT COALESCE(SUM(p.current_wage),0) total FROM user_players up JOIN players p ON p.id=up.player_id WHERE up.user_id=? AND up.active=1`).get(userId) as {total:number}).total;
  db.prepare('UPDATE user_teams SET current_purse=?, expected_purse=? WHERE user_id=?').run(purse, purse - wages, userId);
}

function seed() {
  const count = (db.prepare('SELECT COUNT(*) n FROM users').get() as {n:number}).n;
  if (count) return;
  const password = bcrypt.hashSync('demo123', 10);
  const addUser = db.prepare('INSERT INTO users(username,password_hash,display_name,team_name,role) VALUES(?,?,?,?,?)');
  addUser.run('admin', password, 'Aarav Mehta', 'League Office', 'ADMIN');
  const userIds: number[] = [];
  for (const u of [
    ['royalstrikers','Arjun Rao','Royal Strikers'], ['mumbaimavericks','Meera Shah','Mumbai Mavericks'],
    ['delhidynamos','Kabir Singh','Delhi Dynamos'], ['chennaisuperkings','Nisha Iyer','Chennai Super Kings']
  ]) userIds.push(Number(addUser.run(u[0], password, u[1], u[2], 'USER').lastInsertRowid));
  db.prepare("INSERT INTO seasons(name,status,added_amount) VALUES('Champions League 2026','ACTIVE',500000)").run();
  const playerData: [string,string,number][] = [
    ['Virat Kohli','RCB',1700000],['Jasprit Bumrah','MI',1200000],['Rohit Sharma','MI',1600000],['KL Rahul','DC',1100000],
    ['Hardik Pandya','MI',900000],['Shubman Gill','GT',1250000],['Suryakumar Yadav','MI',1050000],['Ravindra Jadeja','CSK',950000],
    ['Rishabh Pant','LSG',1150000],['Mohammed Siraj','GT',800000],['Sanju Samson','RR',1000000],['Kuldeep Yadav','DC',750000]
  ];
  const addPlayer = db.prepare('INSERT INTO players(name,cricket_team,base_wage,current_wage) VALUES(?,?,?,?)');
  const playerIds = playerData.map(p => Number(addPlayer.run(p[0],p[1],p[2],p[2]).lastInsertRowid));
  userIds.forEach((uid, i) => {
    db.prepare('INSERT INTO user_teams(user_id) VALUES(?)').run(uid);
    db.prepare("INSERT INTO purse_transactions(user_id,season_id,type,amount,reference_type,reference_id,description) VALUES(?,1,'OPENING_BALANCE',3000000,'SEASON',1,'Opening purse')").run(uid);
    db.prepare("INSERT INTO purse_transactions(user_id,season_id,type,amount,reference_type,reference_id,description) VALUES(?,1,'SEASON_CREDIT',500000,'ALLOCATION',1,'Champions League season allocation')").run(uid);
    for (const pid of playerIds.slice(i*3, i*3+3)) db.prepare("INSERT INTO user_players(user_id,player_id,source) VALUES(?,?,'SEASON_ASSIGNMENT')").run(uid,pid);
    db.prepare('UPDATE user_teams SET season_added=500000 WHERE user_id=?').run(uid);
    recalculate(uid);
  });
  const tradeId = Number(db.prepare("INSERT INTO trades(season_id,initiated_by,counterparty,status,message,created_at) VALUES(1,2,3,'PENDING','Looking to reshape my middle order. Interested?','2026-08-28 14:18:00')").run().lastInsertRowid);
  db.prepare('INSERT INTO trade_players(trade_id,player_id,from_user,to_user,old_wage,new_wage) VALUES(?,?,?,?,?,?)').run(tradeId,playerIds[1],userIds[0],userIds[1],1200000,1200000);
  db.prepare("INSERT INTO chat_messages(trade_id,sender_id,message,created_at) VALUES(?,?,?,'2026-08-28 14:18:00')").run(tradeId,userIds[0],'Interested in Bumrah for your pace attack?');
  db.prepare("INSERT INTO notifications(user_id,type,title,message) VALUES(3,'TRADE','New trade request','Royal Strikers sent you a trade proposal')").run();
}
seed();

type TokenUser = { id:number; username:string; displayName:string; teamName:string; role:'ADMIN'|'USER' };
declare global { namespace Express { interface Request { auth?: TokenUser } } }
const secret = process.env.JWT_SECRET || 'local-development-secret-change-me';
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(x=>x.trim()) : true })); app.use(express.json());

function auth(req:Request,res:Response,next:NextFunction) {
  try { req.auth = jwt.verify((req.headers.authorization||'').replace('Bearer ',''), secret) as TokenUser; next(); }
  catch { res.status(401).json({error:'Your session has expired. Please sign in again.'}); }
}
function admin(req:Request,res:Response,next:NextFunction) { if(req.auth?.role!=='ADMIN') return res.status(403).json({error:'Admin access required'}); next(); }
function transaction<T>(fn:()=>T):T { db.exec('BEGIN IMMEDIATE'); try { const x=fn(); db.exec('COMMIT'); return x; } catch(e) { db.exec('ROLLBACK'); throw e; } }
const audit=(actor:number,action:string,type:string,id:number,detail='')=>db.prepare('INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?)').run(actor,action,type,id,detail);
const notify=(uid:number,type:string,title:string,message:string)=>db.prepare('INSERT INTO notifications(user_id,type,title,message) VALUES(?,?,?,?)').run(uid,type,title,message);

app.post('/api/auth/login',(req,res)=>{
  const parsed=z.object({username:z.string().min(1),password:z.string().min(1)}).safeParse(req.body);
  if(!parsed.success) return res.status(400).json({error:'Enter a username and password'});
  const row=db.prepare('SELECT * FROM users WHERE username=? AND is_active=1').get(parsed.data.username) as any;
  if(!row || !bcrypt.compareSync(parsed.data.password,row.password_hash)) return res.status(401).json({error:'Incorrect username or password'});
  const user:TokenUser={id:row.id,username:row.username,displayName:row.display_name,teamName:row.team_name,role:row.role};
  res.json({token:jwt.sign(user,secret,{expiresIn:'12h'}),user});
});
app.get('/api/auth/me',auth,(req,res)=>res.json(req.auth));

const calculationQuery=`SELECT u.id,u.username,u.display_name displayName,u.team_name teamName,ut.current_purse currentPurse,ut.expected_purse expectedPurse,ut.season_added seasonAdded,ut.winning_amount winningAmount,ut.trade_net tradeNet,(SELECT COALESCE(SUM(p.current_wage),0) FROM user_players up JOIN players p ON p.id=up.player_id WHERE up.user_id=u.id AND up.active=1) totalWages FROM users u JOIN user_teams ut ON ut.user_id=u.id WHERE u.id=?`;
function calc(uid:number){ const summary=db.prepare(calculationQuery).get(uid) as any; const players=db.prepare(`SELECT p.id,p.name,p.cricket_team team,p.current_wage wage,up.source FROM user_players up JOIN players p ON p.id=up.player_id WHERE up.user_id=? AND up.active=1 ORDER BY p.current_wage DESC`).all(uid); return {...summary,players}; }
app.get('/api/calculations/me',auth,(req,res)=>res.json(calc(req.auth!.id)));
app.get('/api/admin/calculations',auth,admin,(_req,res)=>{ const ids=db.prepare("SELECT id FROM users WHERE role='USER' AND is_active=1").all() as {id:number}[]; res.json(ids.map(x=>calc(x.id))); });
app.get('/api/users/eligible',auth,(req,res)=>res.json(db.prepare("SELECT id,display_name displayName,team_name teamName FROM users WHERE role='USER' AND is_active=1 AND id<>? ORDER BY team_name").all(req.auth!.id)));
app.get('/api/admin/users',auth,admin,(_req,res)=>res.json(db.prepare("SELECT id,username,display_name displayName,team_name teamName,role,is_active isActive,created_at createdAt FROM users ORDER BY role,team_name").all()));
app.post('/api/admin/users',auth,admin,(req,res)=>{
  const p=z.object({username:z.string().min(3),password:z.string().min(6),displayName:z.string().min(2),teamName:z.string().min(2),role:z.enum(['ADMIN','USER'])}).parse(req.body);
  try { const id=Number(transaction(()=>{ const r=db.prepare('INSERT INTO users(username,password_hash,display_name,team_name,role) VALUES(?,?,?,?,?)').run(p.username,bcrypt.hashSync(p.password,10),p.displayName,p.teamName,p.role); if(p.role==='USER') db.prepare('INSERT INTO user_teams(user_id) VALUES(?)').run(r.lastInsertRowid); audit(req.auth!.id,'USER_CREATED','USER',Number(r.lastInsertRowid)); return r.lastInsertRowid;})); res.status(201).json({id}); } catch { res.status(409).json({error:'That username is already in use'}); }
});
app.patch('/api/admin/users/:id/status',auth,admin,(req,res)=>{ const id=Number(req.params.id); db.prepare('UPDATE users SET is_active=? WHERE id=?').run(req.body.active?1:0,id); audit(req.auth!.id,'USER_STATUS_CHANGED','USER',id); res.json({ok:true}); });

app.get('/api/trades',auth,(req,res)=>{
  const where=req.auth!.role==='ADMIN'?'1=1':'(t.initiated_by=? OR t.counterparty=?)'; const params=req.auth!.role==='ADMIN'?[]:[req.auth!.id,req.auth!.id];
  const rows=db.prepare(`SELECT t.id,t.status,t.message,t.created_at createdAt,t.initiated_by initiatedBy,t.counterparty,u1.team_name fromTeam,u2.team_name toTeam,u1.display_name fromName,u2.display_name toName FROM trades t JOIN users u1 ON u1.id=t.initiated_by JOIN users u2 ON u2.id=t.counterparty WHERE ${where} ORDER BY t.created_at DESC`).all(...params) as any[];
  for(const t of rows) t.players=db.prepare('SELECT tp.*,p.name FROM trade_players tp JOIN players p ON p.id=tp.player_id WHERE tp.trade_id=?').all(t.id);
  res.json(rows);
});
app.post('/api/trades',auth,(req,res)=>{
  const p=z.object({counterparty:z.number().int(),playerIds:z.array(z.number().int()).min(1),message:z.string().max(500).optional()}).parse(req.body); if(p.counterparty===req.auth!.id) return res.status(400).json({error:'Choose another team'});
  try { const id=Number(transaction(()=>{ const season=db.prepare("SELECT id FROM seasons WHERE status='ACTIVE' ORDER BY id DESC LIMIT 1").get() as {id:number}; const owned=db.prepare(`SELECT up.player_id,p.current_wage FROM user_players up JOIN players p ON p.id=up.player_id WHERE up.user_id=? AND up.active=1 AND up.player_id IN (${p.playerIds.map(()=>'?').join(',')})`).all(req.auth!.id,...p.playerIds) as any[]; if(owned.length!==p.playerIds.length) throw new Error('Player ownership changed. Refresh and try again.'); const r=db.prepare("INSERT INTO trades(season_id,initiated_by,counterparty,status,message) VALUES(?,?,?,'PENDING',?)").run(season.id,req.auth!.id,p.counterparty,p.message||''); for(const x of owned) db.prepare('INSERT INTO trade_players(trade_id,player_id,from_user,to_user,old_wage,new_wage) VALUES(?,?,?,?,?,?)').run(r.lastInsertRowid,x.player_id,req.auth!.id,p.counterparty,x.current_wage,x.current_wage); notify(p.counterparty,'TRADE','New trade request',`${req.auth!.teamName} sent you a proposal`); audit(req.auth!.id,'TRADE_CREATED','TRADE',Number(r.lastInsertRowid)); return r.lastInsertRowid;})); res.status(201).json({id}); } catch(e:any) { res.status(400).json({error:e.message}); }
});
app.post('/api/trades/:id/:action',auth,(req,res)=>{
  const id=Number(req.params.id), action=String(req.params.action); if(!['accept','decline','negotiate'].includes(action)) return res.status(404).end();
  try { transaction(()=>{ const t=db.prepare('SELECT * FROM trades WHERE id=?').get(id) as any; if(!t || t.counterparty!==req.auth!.id) throw new Error('You cannot act on this trade'); if(!['PENDING','NEGOTIATING'].includes(t.status)) throw new Error('This trade is already closed'); if(action==='decline'){ db.prepare("UPDATE trades SET status='DECLINED' WHERE id=?").run(id); notify(t.initiated_by,'TRADE','Trade declined',`${req.auth!.teamName} declined your proposal`); }
    else if(action==='negotiate'){db.prepare("UPDATE trades SET status='NEGOTIATING' WHERE id=?").run(id);}
    else { const items=db.prepare('SELECT * FROM trade_players WHERE trade_id=?').all(id) as any[]; let out=0; for(const x of items){ const own=db.prepare('SELECT id FROM user_players WHERE player_id=? AND user_id=? AND active=1').get(x.player_id,x.from_user) as any; if(!own) throw new Error('A player in this trade has changed owners'); db.prepare('UPDATE user_players SET active=0 WHERE id=?').run(own.id); db.prepare("INSERT INTO user_players(user_id,player_id,source) VALUES(?,?,'TRADE')").run(x.to_user,x.player_id); out+=x.new_wage; }
      db.prepare("INSERT INTO purse_transactions(user_id,season_id,type,amount,reference_type,reference_id,description) VALUES(?,?,'TRADE_CREDIT',?,'TRADE',?,'Wage released through trade')").run(t.initiated_by,t.season_id,out,id); db.prepare("INSERT INTO purse_transactions(user_id,season_id,type,amount,reference_type,reference_id,description) VALUES(?,?,'TRADE_DEBIT',?,'TRADE',?,'Wage assumed through trade')").run(t.counterparty,t.season_id,-out,id); db.prepare('UPDATE user_teams SET trade_net=trade_net+? WHERE user_id=?').run(out,t.initiated_by); db.prepare('UPDATE user_teams SET trade_net=trade_net-? WHERE user_id=?').run(out,t.counterparty); recalculate(t.initiated_by); recalculate(t.counterparty); db.prepare("UPDATE trades SET status='COMPLETED',completed_at=CURRENT_TIMESTAMP WHERE id=?").run(id); notify(t.initiated_by,'TRADE','Trade completed',`${req.auth!.teamName} accepted your proposal`); }
    audit(req.auth!.id,`TRADE_${action.toUpperCase()}`,'TRADE',id);
  }); res.json({ok:true}); } catch(e:any){res.status(400).json({error:e.message});}
});
app.get('/api/trades/:id/messages',auth,(req,res)=>{ const id=Number(req.params.id); const t=db.prepare('SELECT * FROM trades WHERE id=?').get(id) as any; if(!t || (req.auth!.role!=='ADMIN'&&![t.initiated_by,t.counterparty].includes(req.auth!.id))) return res.status(403).end(); res.json(db.prepare('SELECT m.id,m.message,m.created_at createdAt,m.sender_id senderId,u.display_name senderName FROM chat_messages m JOIN users u ON u.id=m.sender_id WHERE trade_id=? ORDER BY m.id').all(id)); });
app.post('/api/trades/:id/messages',auth,(req,res)=>{ const id=Number(req.params.id), message=z.string().min(1).max(1000).parse(req.body.message); const t=db.prepare('SELECT * FROM trades WHERE id=?').get(id) as any; if(!t || ![t.initiated_by,t.counterparty].includes(req.auth!.id)) return res.status(403).end(); const r=db.prepare('INSERT INTO chat_messages(trade_id,sender_id,message) VALUES(?,?,?)').run(id,req.auth!.id,message); const other=t.initiated_by===req.auth!.id?t.counterparty:t.initiated_by; notify(other,'CHAT','New negotiation message',`${req.auth!.displayName}: ${message.slice(0,80)}`); res.status(201).json({id:Number(r.lastInsertRowid)}); });

app.post('/api/admin/seasons/start',auth,admin,(req,res)=>{
  const p=z.object({name:z.string().min(3),amount:z.number().int().nonnegative()}).parse(req.body);
  try { const sid=Number(transaction(()=>{db.prepare("UPDATE seasons SET status='COMPLETED' WHERE status='ACTIVE'").run(); const r=db.prepare("INSERT INTO seasons(name,status,added_amount) VALUES(?,'ACTIVE',?)").run(p.name,p.amount); const users=db.prepare("SELECT id FROM users WHERE role='USER' AND is_active=1").all() as {id:number}[]; for(const u of users){ db.prepare("INSERT INTO purse_transactions(user_id,season_id,type,amount,reference_type,reference_id,description) VALUES(?,?,'SEASON_CREDIT',?,'ALLOCATION',?,'New season allocation')").run(u.id,r.lastInsertRowid,p.amount,r.lastInsertRowid); db.prepare('UPDATE user_teams SET season_added=?,winning_amount=0,trade_net=0 WHERE user_id=?').run(p.amount,u.id); recalculate(u.id);} audit(req.auth!.id,'SEASON_STARTED','SEASON',Number(r.lastInsertRowid),p.name); return r.lastInsertRowid;})); res.status(201).json({id:sid}); } catch(e:any){res.status(400).json({error:e.message});}
});
app.post('/api/admin/winners/apply',auth,admin,(req,res)=>{
  const entries=z.array(z.object({userId:z.number().int(),position:z.number().int().positive(),amount:z.number().int().nonnegative()})).min(1).parse(req.body.entries);
  try { transaction(()=>{const season=db.prepare("SELECT id FROM seasons WHERE status='ACTIVE' ORDER BY id DESC LIMIT 1").get() as {id:number}; for(const e of entries){ const r=db.prepare('INSERT INTO winner_payouts(season_id,user_id,position,amount) VALUES(?,?,?,?)').run(season.id,e.userId,e.position,e.amount); db.prepare("INSERT INTO purse_transactions(user_id,season_id,type,amount,reference_type,reference_id,description) VALUES(?,?,'WINNER_CREDIT',?,'WINNER',?,'Winner payout')").run(e.userId,season.id,e.amount,r.lastInsertRowid); db.prepare('UPDATE user_teams SET winning_amount=winning_amount+? WHERE user_id=?').run(e.amount,e.userId); recalculate(e.userId);} audit(req.auth!.id,'WINNERS_APPLIED','SEASON',season.id);}); res.json({ok:true});}catch(e:any){res.status(400).json({error:'Payouts have already been applied, or rankings contain duplicates.'});}
});
app.get('/api/notifications',auth,(req,res)=>res.json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 20').all(req.auth!.id)));
app.get('/api/dashboard',auth,(req,res)=>{ const season=db.prepare("SELECT * FROM seasons WHERE status='ACTIVE' ORDER BY id DESC LIMIT 1").get(); if(req.auth!.role==='ADMIN'){res.json({season,users:(db.prepare("SELECT COUNT(*) n FROM users WHERE role='USER' AND is_active=1").get() as any).n,players:(db.prepare('SELECT COUNT(*) n FROM players WHERE active=1').get() as any).n,pending:(db.prepare("SELECT COUNT(*) n FROM trades WHERE status IN ('PENDING','NEGOTIATING')").get() as any).n,completed:(db.prepare("SELECT COUNT(*) n FROM trades WHERE status='COMPLETED'").get() as any).n});}else res.json({season,calculation:calc(req.auth!.id),pending:(db.prepare("SELECT COUNT(*) n FROM trades WHERE counterparty=? AND status IN ('PENDING','NEGOTIATING')").get(req.auth!.id) as any).n}); });

app.use((err:any,_req:Request,res:Response,_next:NextFunction)=>{console.error(err); res.status(400).json({error:err?.issues?.[0]?.message||err.message||'Something went wrong'});});
if(process.env.NODE_ENV==='production'){app.use(express.static(path.join(root,'dist'))); app.use((_req,res)=>res.sendFile(path.join(root,'dist','index.html')));}
const port = Number(process.env.PORT || 4000);
app.listen(port, '0.0.0.0',()=>console.log(`API ready on port ${port}`));
