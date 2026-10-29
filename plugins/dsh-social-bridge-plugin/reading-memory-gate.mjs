import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function safeFile(file,max){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw Error('unsafe_file');return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
function verifyDirectory(dir){let p=dir;for(;;){try{const stat=fs.lstatSync(p);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('unsafe_directory');}catch(error){if(error.code!=='ENOENT')throw error;}const parent=path.dirname(p);if(parent===p)break;p=parent;}}
// Reserves before dispatch. A crash or denial later consumes the reservation;
// it is deliberately never retried without an operation-associated receipt.
export function reserveReadingMemory({root,account,key,eventId,isAllowed}){
 if(!/^[a-f0-9]{64}$/.test(account??'')||!/^wechat:private:[1-9]\d{0,15}$/.test(key??'')||!/^[A-Za-z0-9-]{1,80}$/.test(eventId??'')||!isAllowed())throw Error('memory_scope_denied');
 verifyDirectory(path.join(root,'config'));const config=safeFile(path.join(root,'config','bili-reading.json'),32768);if(config.enabled!==true||config.memoryEnabled!==true||config.conversationKey!==key)throw Error('memory_disabled');
 const folder=path.join(root,'state','accounts',account),archiveDir=path.join(folder,'bili-archive');verifyDirectory(archiveDir);
 const archive=safeFile(path.join(archiveDir,hash(account+'\0'+key)+'.json'),8*1024*1024);
 if(archive.version!==1||!Array.isArray(archive.entries)||!archive.entries.some(item=>item.id===eventId))throw Error('reading_experience_missing');
 verifyDirectory(folder);const file=path.join(folder,'bili-memory-reservations.json'),lock=file+'.lock',token=crypto.randomUUID();let fd;
 try{fd=fs.openSync(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw Error('memory_busy');throw error;}
 try{
  fs.writeFileSync(fd,token);fs.closeSync(fd);fd=undefined;
  let ledger;try{ledger=safeFile(file,1024*1024);}catch(error){if(error.code!=='ENOENT')throw error;ledger={version:1,operations:[]};}
  if(ledger.version!==1||!Array.isArray(ledger.operations)||ledger.operations.length>=10000)throw Error('invalid_memory_ledger');
  if(ledger.operations.some(item=>item.key===key&&item.eventId===eventId))throw Error('memory_already_reserved');
  const today=day();if(ledger.operations.some(item=>item.key===key&&item.day===today))throw Error('memory_daily_quota');
  if(!isAllowed())throw Error('memory_scope_denied');ledger.operations.push({key,eventId,day:today,state:'reserved'});
  const temp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temp,JSON.stringify(ledger),{flag:'wx',mode:0o600});verifyDirectory(folder);fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
 }finally{if(fd!==undefined)fs.closeSync(fd);try{const stat=fs.lstatSync(lock);if(stat.isFile()&&!stat.isSymbolicLink()&&fs.readFileSync(lock,'utf8')===token)fs.unlinkSync(lock);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
